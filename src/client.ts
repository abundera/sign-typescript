import { randomUUID } from "node:crypto";
import type {
  AuditTrail,
  Envelope,
  EnvelopeCreate,
  EnvelopeCreateResult,
  EnvelopeList,
  EvidenceChecklist,
  Template,
  TemplateCreate,
  TemplateList,
  VerifyResult,
  Webhook,
  WebhookDelivery,
  Pagination,
  ApiError,
} from "./types.js";

const DEFAULT_BASE_URL = "https://sign.abundera.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
// 429 + 5xx + 409 (a retryable write conflict) — never other 4xx.
const RETRY_STATUS = new Set([409, 429, 500, 502, 503, 504]);
// Full-jitter backoff (AWS Architecture Blog canonical): delay = rand(0, min(cap,
// base * 2**attempt)). Spreads retries so many clients don't retry in lockstep.
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 20_000;

export interface ClientOptions {
  /** Product-scoped API key (`abnd_sign_…`). */
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
  fetch?: typeof fetch;
}

/**
 * Per-call override for the auto-generated `Idempotency-Key` on a mutating
 * POST. Supplying one makes retries idempotent across process restarts; omit
 * it and one is auto-generated (stable across this call's internal retries).
 */
export interface IdempotentRequestOptions {
  idempotencyKey?: string;
}

export class AbunderaError extends Error implements ApiError {
  status: number;
  code: string;
  request_id?: string;
  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
  ) {
    super(message);
    this.name = "AbunderaError";
    this.status = status;
    this.code = code;
    this.request_id = requestId;
  }
}

export class AbunderaSignClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private userAgent: string;
  private _fetch: typeof fetch;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) throw new Error("apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.userAgent = opts.userAgent ?? "abundera-sign-js/0.1.0";
    this._fetch = opts.fetch ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
    accept = "application/json",
    idempotencyKey?: string,
  ): Promise<T> {
    // v1: every product endpoint lives under /api/v1/*. Callers pass /api/*;
    // rewrite centrally so the per-method paths stay readable.
    const v1Path =
      path.startsWith("/api/") && !path.startsWith("/api/v1/")
        ? path.replace(/^\/api\//, "/api/v1/")
        : path;
    const url = new URL(this.baseUrl + v1Path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": this.userAgent,
      Accept: accept,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Auto-generate a stable idempotency key for mutating POSTs so an internal
    // retry (network blip / 5xx / 409) replays the server's cached response
    // instead of creating a second resource. Generated ONCE, outside the
    // retry loop below, so every attempt of this logical call carries the
    // same key. Callers may override via a per-call `idempotencyKey` option;
    // never sent on non-POST methods.
    if (method === "POST") {
      headers["Idempotency-Key"] = idempotencyKey ?? `abnd-${randomUUID()}`;
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this._fetch(url.toString(), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.ok) {
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const parsed = (await res.json()) as unknown;
            // v1 envelope: { ok, data, request_id } → return the inner payload.
            if (parsed && typeof parsed === "object" && "ok" in parsed) {
              return (parsed as unknown as { data: T }).data;
            }
            return parsed as T;
          }
          if (accept !== "application/json" && !ct.includes("text/")) {
            return (await res.arrayBuffer()) as unknown as T;
          }
          return (await res.text()) as unknown as T;
        }

        if (RETRY_STATUS.has(res.status) && attempt < this.maxRetries) {
          const retryAfterMs = parseRetryAfterMs(
            res.headers.get("retry-after"),
          );
          const jittered = backoffDelayMs(attempt);
          await sleep(
            retryAfterMs !== null
              ? Math.max(jittered, retryAfterMs)
              : jittered,
          );
          continue;
        }

        let code = "http_error";
        let message = `HTTP ${res.status}`;
        let requestId = res.headers.get("x-request-id") ?? undefined;
        try {
          const j = (await res.json()) as {
            code?: string;
            message?: string;
            request_id?: string;
            error?: { code?: string; message?: string };
          };
          // v1 envelope: { ok:false, error:{ code, message }, request_id }.
          // Fall back to a flat { code, message } so a legacy body still parses.
          const e = j.error ?? j;
          code = e.code ?? code;
          message = e.message ?? message;
          requestId = j.request_id ?? requestId;
        } catch {}
        throw new AbunderaError(res.status, code, message, requestId);
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (e instanceof AbunderaError) throw e;
        if (attempt >= this.maxRetries) break;
        await sleep(backoffDelayMs(attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("request failed");
  }

  // --- Envelopes -----------------------------------------------------------

  createEnvelope(data: EnvelopeCreate, opts?: IdempotentRequestOptions) {
    return this.request<EnvelopeCreateResult>(
      "POST",
      "/api/envelopes",
      data,
      undefined,
      "application/json",
      opts?.idempotencyKey,
    );
  }
  listEnvelopes(params?: {
    status?: string;
    template?: string;
    source?: string;
    folder_id?: string;
    org_id?: string;
    include_archived?: boolean;
    page?: number;
    limit?: number;
    sort?: string;
    order?: string;
    cursor?: string;
  }) {
    return this.request<EnvelopeList>(
      "GET",
      "/api/envelopes",
      undefined,
      params,
    );
  }
  getEnvelope(id: string) {
    return this.request<Envelope>(
      "GET",
      `/api/envelopes/${encodeURIComponent(id)}`,
    );
  }
  updateEnvelope(id: string, patch: { allow_negotiation: boolean }) {
    return this.request<{ id: string; allow_negotiation: boolean }>(
      "PATCH",
      `/api/envelopes/${encodeURIComponent(id)}`,
      patch,
    );
  }
  voidEnvelope(envelopeId: string) {
    return this.request<{
      id: string;
      status: string;
      notified_signers: number;
    }>("POST", "/api/void-envelope", { envelope_id: envelopeId });
  }
  archiveEnvelope(envelopeId: string, action: "archive" | "unarchive") {
    return this.request<{ id: string; status: string; archived_at?: string }>(
      "POST",
      "/api/archive-envelope",
      { envelope_id: envelopeId, action },
    );
  }
  /** Re-send the signing email to all pending signers (or one, if given). */
  remind(envelopeId: string, signerId?: string) {
    return this.request<{
      envelope_id: string;
      reminded: Array<{ id: string; email: string; name?: string }>;
      count: number;
    }>("POST", "/api/remind", {
      envelope_id: envelopeId,
      ...(signerId ? { signer_id: signerId } : {}),
    });
  }
  /** Hash-chain-verified audit trail for an envelope. */
  getAuditTrail(id: string) {
    return this.request<AuditTrail>(
      "GET",
      `/api/envelopes/${encodeURIComponent(id)}/audit`,
    );
  }
  /** Evidence-completeness checklist for a completed envelope. */
  getEvidenceChecklist(id: string) {
    return this.request<EvidenceChecklist>(
      "GET",
      `/api/envelopes/${encodeURIComponent(id)}/evidence`,
    );
  }
  /** Court-ready declaration PDF (Professional+). Resolves to the PDF bytes. */
  getDeclarationPdf(id: string): Promise<ArrayBuffer> {
    return this.request<ArrayBuffer>(
      "GET",
      `/api/envelopes/${encodeURIComponent(id)}/declaration`,
      undefined,
      undefined,
      "application/pdf",
    );
  }

  // --- Templates -----------------------------------------------------------

  listTemplates(params?: {
    category?: string;
    tag?: string;
    search?: string;
    signers?: number;
    org_id?: string;
    mine?: boolean;
    sort?: "az" | "za" | "newest" | "category";
    limit?: number;
    offset?: number;
    cursor?: string;
  }) {
    return this.request<TemplateList>(
      "GET",
      "/api/templates",
      undefined,
      params,
    );
  }
  getTemplate(id: string) {
    return this.request<Template>(
      "GET",
      `/api/templates/${encodeURIComponent(id)}`,
    );
  }
  listTemplateCategories() {
    return this.request<{ categories: string[] }>(
      "GET",
      "/api/templates/categories",
    );
  }
  createTemplate(data: TemplateCreate, opts?: IdempotentRequestOptions) {
    return this.request<Template>(
      "POST",
      "/api/templates",
      data,
      undefined,
      "application/json",
      opts?.idempotencyKey,
    );
  }
  updateTemplate(id: string, data: Partial<TemplateCreate>) {
    return this.request<Template>(
      "PUT",
      `/api/templates/${encodeURIComponent(id)}`,
      data,
    );
  }
  deleteTemplate(id: string) {
    return this.request<{ deleted: boolean }>(
      "DELETE",
      `/api/templates/${encodeURIComponent(id)}`,
    );
  }

  // --- Webhooks (account-level) ---------------------------------------------

  listWebhooks() {
    return this.request<{ webhooks: Webhook[] }>("GET", "/api/webhooks/manage");
  }
  /**
   * Register an account-level webhook. The returned `secret` (`whsec_…`) is
   * shown in full only once — store it; `verifyWebhookSignature` needs it.
   */
  createWebhook(
    data: { url: string; events?: string[]; secret?: string },
    opts?: IdempotentRequestOptions,
  ) {
    return this.request<{ webhook: Webhook }>(
      "POST",
      "/api/webhooks/manage",
      data,
      undefined,
      "application/json",
      opts?.idempotencyKey,
    );
  }
  deleteWebhook(webhookId: string) {
    return this.request<{ id: string; deleted: boolean }>(
      "DELETE",
      "/api/webhooks/manage",
      { webhook_id: webhookId },
    );
  }
  /** Send a signed test delivery so an endpoint can be validated end-to-end. */
  pingWebhook(webhookId: string) {
    return this.request<{
      delivered: boolean;
      webhook_id: string;
      event_id: string;
    }>("POST", "/api/webhooks/manage/ping", { webhook_id: webhookId });
  }
  listWebhookDeliveries(params?: {
    webhook_id?: string;
    event?: string;
    status?: string;
    envelope_id?: string;
    limit?: number;
    offset?: number;
    cursor?: string;
  }) {
    return this.request<{
      deliveries: WebhookDelivery[];
      pagination: Pagination;
    }>("GET", "/api/webhooks/manage/deliveries", undefined, params);
  }
  getWebhookDelivery(id: string) {
    return this.request<WebhookDelivery>(
      "GET",
      `/api/webhooks/manage/deliveries/${encodeURIComponent(id)}`,
    );
  }

  // --- Public verification ---------------------------------------------------

  /**
   * Public document verification by verification ID (`vrf_…`) or document
   * SHA-256 hash. Works without authentication; authenticated calls may see
   * the fuller disclosure tier.
   */
  verifyDocument(params: { id?: string; hash?: string }) {
    if (!params.id && !params.hash) {
      throw new Error("verifyDocument requires id or hash");
    }
    return this.request<VerifyResult>("GET", "/api/verify", undefined, params);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Full-jitter backoff (AWS Architecture Blog canonical):
 * `delay = rand(0, min(cap, base * 2**attempt))`.
 */
function backoffDelayMs(attempt: number): number {
  return Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

/** Delta-seconds `Retry-After` → milliseconds, or `null` if absent/invalid. */
function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}
