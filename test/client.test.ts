import { describe, expect, it, vi } from "vitest";
import { AbunderaSignClient, AbunderaError } from "../src/client.js";

const KEY = "abnd_sign_test_key";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function clientWith(fetchImpl: typeof fetch, opts: Record<string, unknown> = {}) {
  return new AbunderaSignClient({ apiKey: KEY, fetch: fetchImpl, ...opts });
}

describe("AbunderaSignClient", () => {
  it("requires an apiKey", () => {
    expect(() => new AbunderaSignClient({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("unwraps the { ok, data, request_id } envelope", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, data: { id: "env_1", status: "sent" }, request_id: "req_1" }),
    );
    const c = clientWith(fetchMock as unknown as typeof fetch);
    const env = await c.getEnvelope("env_1");
    expect(env).toEqual({ id: "env_1", status: "sent" });
  });

  it("rewrites /api/* to /api/v1/* and sends bearer auth + UA", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://sign.abundera.ai/api/v1/envelopes?limit=2");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(headers["User-Agent"]).toMatch(/^abundera-sign-js\//);
      return jsonResponse({ ok: true, data: { envelopes: [], pagination: { limit: 2, total: 0 } }, request_id: "r" });
    });
    const c = clientWith(fetchMock as unknown as typeof fetch);
    await c.listEnvelopes({ limit: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps the fail envelope to AbunderaError with code + request_id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { ok: false, error: { code: "validation_error", message: "template_id is required" }, request_id: "req_9" },
        400,
      ),
    );
    const c = clientWith(fetchMock as unknown as typeof fetch);
    const err = await c.createEnvelope({ template_id: "", signers: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(AbunderaError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("validation_error");
    expect(err.request_id).toBe("req_9");
  });

  it("retries 429 honoring Retry-After, then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ ok: false, error: { code: "rate_limited", message: "slow down" } }, 429, {
          "Retry-After": "0.01",
        });
      }
      return jsonResponse({ ok: true, data: { id: "env_2" }, request_id: "r" });
    });
    const c = clientWith(fetchMock as unknown as typeof fetch);
    const env = await c.getEnvelope("env_2");
    expect(env).toEqual({ id: "env_2" });
    expect(calls).toBe(2);
  });

  it("gives up after maxRetries on persistent 5xx", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: false, error: { code: "internal_error", message: "boom" } }, 503),
    );
    const c = clientWith(fetchMock as unknown as typeof fetch, { maxRetries: 1 });
    const err = await c.getEnvelope("env_3").catch((e) => e);
    expect(err).toBeInstanceOf(AbunderaError);
    expect(err.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("does NOT retry a 400", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: false, error: { code: "validation_error", message: "bad" } }, 400),
    );
    const c = clientWith(fetchMock as unknown as typeof fetch);
    await expect(c.getEnvelope("x")).rejects.toBeInstanceOf(AbunderaError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends DELETE with a JSON body for webhook deletion", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://sign.abundera.ai/api/v1/webhooks/manage");
      expect(init.method).toBe("DELETE");
      expect(JSON.parse(String(init.body))).toEqual({ webhook_id: "wh_1" });
      return jsonResponse({ ok: true, data: { id: "wh_1", deleted: true }, request_id: "r" });
    });
    const c = clientWith(fetchMock as unknown as typeof fetch);
    const out = await c.deleteWebhook("wh_1");
    expect(out.deleted).toBe(true);
  });

  it("returns binary bytes for the declaration PDF", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const fetchMock = vi.fn(
      async () =>
        new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } }),
    );
    const c = clientWith(fetchMock as unknown as typeof fetch);
    const buf = await c.getDeclarationPdf("env_4");
    expect(new Uint8Array(buf).slice(0, 4)).toEqual(pdf);
  });

  it("verifyDocument requires id or hash", () => {
    const c = clientWith(vi.fn() as unknown as typeof fetch);
    expect(() => c.verifyDocument({})).toThrow(/id or hash/);
  });

  it("URL-encodes path parameters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/api/v1/envelopes/a%2Fb");
      return jsonResponse({ ok: true, data: { id: "a/b" }, request_id: "r" });
    });
    const c = clientWith(fetchMock as unknown as typeof fetch);
    await c.getEnvelope("a/b");
  });
});
