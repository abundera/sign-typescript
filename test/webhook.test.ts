import { describe, expect, it } from "vitest";
import {
  createHmac,
  generateKeyPairSync,
  sign as edSign,
  randomBytes,
} from "node:crypto";
import { verifyWebhookSignature } from "../src/webhook.js";

const BODY = JSON.stringify({ event: "envelope.completed", envelope_id: "env_1" });
const ID = "msg_2f9b1c";

function makeSecret() {
  return "whsec_" + randomBytes(32).toString("base64");
}

function hmacToken(secret: string, id: string, ts: string, body: string) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}

function nowSec() {
  return String(Math.floor(Date.now() / 1000));
}

describe("verifyWebhookSignature (v1 HMAC)", () => {
  it("accepts a valid signature", () => {
    const secret = makeSecret();
    const ts = nowSec();
    expect(
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: ts,
        webhookSignature: hmacToken(secret, ID, ts, BODY),
        body: BODY,
        secret,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const secret = makeSecret();
    const ts = nowSec();
    expect(() =>
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: ts,
        webhookSignature: hmacToken(secret, ID, ts, BODY),
        body: BODY.replace("completed", "voided"),
        secret,
      }),
    ).toThrow(/mismatch/);
  });

  it("rejects a signature under the wrong secret", () => {
    const ts = nowSec();
    expect(() =>
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: ts,
        webhookSignature: hmacToken(makeSecret(), ID, ts, BODY),
        body: BODY,
        secret: makeSecret(),
      }),
    ).toThrow(/mismatch/);
  });

  it("rejects a stale timestamp beyond tolerance", () => {
    const secret = makeSecret();
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect(() =>
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: stale,
        webhookSignature: hmacToken(secret, ID, stale, BODY),
        body: BODY,
        secret,
      }),
    ).toThrow(/tolerance/);
  });

  it("accepts any valid token during secret rotation (multi-token header)", () => {
    const oldSecret = makeSecret();
    const newSecret = makeSecret();
    const ts = nowSec();
    const header = `${hmacToken(oldSecret, ID, ts, BODY)} ${hmacToken(newSecret, ID, ts, BODY)}`;
    expect(
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: ts,
        webhookSignature: header,
        body: BODY,
        secret: newSecret,
      }),
    ).toBe(true);
  });

  it("requires secret and/or publicKey", () => {
    expect(() =>
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: nowSec(),
        webhookSignature: "v1,AAAA",
        body: BODY,
      }),
    ).toThrow(/secret and\/or publicKey/);
  });
});

describe("verifyWebhookSignature (v1a Ed25519)", () => {
  function makeKeypair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
    return { privateKey, whpk: "whpk_" + raw.toString("base64") };
  }

  it("accepts a valid Ed25519 signature", () => {
    const { privateKey, whpk } = makeKeypair();
    const ts = nowSec();
    const sig = edSign(null, Buffer.from(`${ID}.${ts}.${BODY}`), privateKey);
    expect(
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: ts,
        webhookSignature: `v1a,${sig.toString("base64")}`,
        body: BODY,
        publicKey: whpk,
      }),
    ).toBe(true);
  });

  it("rejects an Ed25519 signature from the wrong key", () => {
    const signer = makeKeypair();
    const other = makeKeypair();
    const ts = nowSec();
    const sig = edSign(null, Buffer.from(`${ID}.${ts}.${BODY}`), signer.privateKey);
    expect(() =>
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: ts,
        webhookSignature: `v1a,${sig.toString("base64")}`,
        body: BODY,
        publicKey: other.whpk,
      }),
    ).toThrow(/mismatch/);
  });

  it("verifies v1a when both v1 and v1a tokens are present but only publicKey is held", () => {
    const { privateKey, whpk } = makeKeypair();
    const ts = nowSec();
    const sig = edSign(null, Buffer.from(`${ID}.${ts}.${BODY}`), privateKey);
    const header = `v1,${randomBytes(32).toString("base64")} v1a,${sig.toString("base64")}`;
    expect(
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: ts,
        webhookSignature: header,
        body: BODY,
        publicKey: whpk,
      }),
    ).toBe(true);
  });
});
