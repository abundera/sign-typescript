import { createHmac, timingSafeEqual, verify as edVerify } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyOptions {
  /** Value of the `webhook-id` header. */
  webhookId: string;
  /** Value of the `webhook-timestamp` header (unix seconds). */
  webhookTimestamp: string;
  /** Value of the `webhook-signature` header (`v1,<base64>` and/or `v1a,<base64>`). */
  webhookSignature: string;
  /** Raw request body string (before JSON.parse). */
  body: string;
  /** `whsec_<base64>` signing secret returned at webhook creation (for `v1`). */
  secret?: string;
  /**
   * `whpk_<base64>` Ed25519 public key (for `v1a`, the opt-in asymmetric
   * scheme on Business+). Supply `secret`, `publicKey`, or both.
   */
  publicKey?: string;
  toleranceSeconds?: number;
  now?: () => number;
}

/**
 * Verify a Standard Webhooks signature from Abundera Sign.
 *
 * Expected headers:
 *   `webhook-id`        — per-event idempotency key
 *   `webhook-timestamp` — unix seconds
 *   `webhook-signature` — space-separated `v1,<base64(HMAC-SHA256)>` and/or
 *                          `v1a,<base64(Ed25519)>` tokens
 *
 * Signed content: `{webhook-id}.{webhook-timestamp}.{rawBody}`
 *
 * `v1` verifies against `secret` (`whsec_…`, HMAC-SHA256, constant-time
 * compare). `v1a` verifies against `publicKey` (`whpk_…`, raw Ed25519).
 * Multiple tokens in one header support zero-downtime secret rotation.
 *
 * Throws on bad signature, timestamp skew > tolerance, or missing key material.
 */
export function verifyWebhookSignature(opts: VerifyOptions): true {
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!opts.secret && !opts.publicKey) {
    throw new Error("verifyWebhookSignature requires secret and/or publicKey");
  }

  const ts = Number.parseInt(opts.webhookTimestamp, 10);
  if (!Number.isFinite(ts)) throw new Error("invalid webhook-timestamp");
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > tolerance) {
    throw new Error("webhook-timestamp outside tolerance");
  }

  const signedContent = `${opts.webhookId}.${opts.webhookTimestamp}.${opts.body}`;

  let expectedHmac: Buffer | null = null;
  if (opts.secret) {
    const secretB64 = opts.secret.startsWith("whsec_")
      ? opts.secret.slice("whsec_".length)
      : opts.secret;
    expectedHmac = createHmac("sha256", Buffer.from(secretB64, "base64"))
      .update(signedContent)
      .digest();
  }

  let edKey: Buffer | null = null;
  if (opts.publicKey) {
    const pkB64 = opts.publicKey.startsWith("whpk_")
      ? opts.publicKey.slice("whpk_".length)
      : opts.publicKey;
    edKey = Buffer.from(pkB64, "base64");
  }

  for (const token of opts.webhookSignature.split(/\s+/)) {
    const [ver, b64] = token.split(",", 2);
    if (!b64) continue;
    const sig = Buffer.from(b64, "base64");
    if (ver === "v1" && expectedHmac) {
      if (
        sig.length === expectedHmac.length &&
        timingSafeEqual(sig, expectedHmac)
      ) {
        return true;
      }
    } else if (ver === "v1a" && edKey) {
      // Raw 32-byte Ed25519 public key → SPKI DER wrapper for node:crypto.
      const spki = Buffer.concat([ED25519_SPKI_PREFIX, edKey]);
      const key = {
        key: spki,
        format: "der" as const,
        type: "spki" as const,
      };
      try {
        if (edVerify(null, Buffer.from(signedContent), key, sig)) return true;
      } catch {
        /* malformed key/signature → keep trying other tokens */
      }
    }
  }
  throw new Error("webhook signature mismatch");
}

// SPKI DER prefix for a raw Ed25519 public key (RFC 8410): SEQUENCE →
// AlgorithmIdentifier(id-Ed25519) → BIT STRING header.
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
