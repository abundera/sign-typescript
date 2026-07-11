/**
 * Cross-implementation contract: sdks/fixtures/webhook-signatures.json holds
 * signatures produced by the REAL platform signer
 * (functions/lib/webhook-delivery.js), committed once and shared byte-for-byte
 * across every language SDK's test suite (see sdks/ruby/test/test_contract.rb,
 * sdks/python/tests/test_contract.py). This SDK's verifier must accept those
 * exact bytes without re-deriving an "expected signature" by hand.
 *
 * server-contract.test.ts (same directory) instead imports the LIVE signer and
 * signs fresh — keep both: this file proves parity with the committed
 * platform-signed fixture, that one proves parity with today's signer code.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWebhookSignature, type VerifyOptions } from "../src/webhook.js";

interface FixtureCase {
  name: string;
  scheme: string;
  webhook_signature: string;
  body_override?: string;
  verifies_with: "secret" | "public_key" | "secret_or_public_key";
  expect: boolean;
}

interface Fixture {
  webhook_id: string;
  webhook_timestamp: string;
  body: string;
  secret: string;
  secret_prefix: string;
  public_key: string;
  pubkey_prefix: string;
  cases: FixtureCase[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "webhook-signatures.json",
);

const fixture = JSON.parse(
  readFileSync(FIXTURE_PATH, "utf8"),
) as Fixture;

describe("SDK verifier ⇄ shared platform-signed fixtures", () => {
  // Pin `now` to the fixture timestamp so the ±300s skew guard doesn't reject
  // a deliberately-fixed historical timestamp. The fixture timestamp is unix
  // SECONDS; `VerifyOptions.now` returns milliseconds (it stands in for
  // `Date.now()`), so convert once here.
  const nowMs = Number.parseInt(fixture.webhook_timestamp, 10) * 1000;

  for (const c of fixture.cases) {
    it(`${c.name} (${c.scheme})`, () => {
      const body = c.body_override ?? fixture.body;
      const opts: VerifyOptions = {
        webhookId: fixture.webhook_id,
        webhookTimestamp: fixture.webhook_timestamp,
        webhookSignature: c.webhook_signature,
        body,
        now: () => nowMs,
      };
      // Provide whichever key material the case needs (rotation → both).
      // Prepend the canonical prefix so this also exercises prefix-stripping
      // against real platform-signed bytes (fixtures store key material
      // prefix-less; see secret_prefix/pubkey_prefix).
      if (c.verifies_with.includes("secret")) {
        opts.secret = fixture.secret_prefix + fixture.secret;
      }
      if (c.verifies_with.includes("public_key")) {
        opts.publicKey = fixture.pubkey_prefix + fixture.public_key;
      }

      if (c.expect) {
        expect(verifyWebhookSignature(opts)).toBe(true);
      } else {
        expect(() => verifyWebhookSignature(opts)).toThrow();
      }
    });
  }
});
