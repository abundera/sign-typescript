/**
 * Cross-implementation contract: signatures produced by the PLATFORM's own
 * signer (functions/lib/webhook-delivery.js — the code that signs every real
 * delivery) must verify with this SDK's verifier, for both schemes. If either
 * side drifts (signed-content format, prefix handling, base64 variant), this
 * suite goes red before a customer's webhook does.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS platform module, no type declarations.
import {
  generateWebhookSecret,
  signWebhookHmac,
  generateWebhookKeypair,
  signWebhookEd25519,
} from "../../../functions/lib/webhook-delivery.js";
import { verifyWebhookSignature } from "../src/webhook.js";

const BODY = JSON.stringify({ event: "envelope.completed", envelope_id: "env_ct" });
const ID = "msg_contract";

describe("SDK verifier ⇄ platform signer contract", () => {
  it("verifies a platform-signed v1 (HMAC-SHA256) delivery", async () => {
    const secret = generateWebhookSecret();
    const ts = String(Math.floor(Date.now() / 1000));
    const header = await signWebhookHmac(secret, ID, ts, BODY);
    expect(
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: ts,
        webhookSignature: header,
        body: BODY,
        secret,
      }),
    ).toBe(true);
  });

  it("verifies a platform-signed v1a (Ed25519) delivery", async () => {
    const { keyPair, publicKey } = await generateWebhookKeypair();
    const ts = String(Math.floor(Date.now() / 1000));
    const header = await signWebhookEd25519(keyPair.privateKey, ID, ts, BODY);
    expect(
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: ts,
        webhookSignature: header,
        body: BODY,
        publicKey,
      }),
    ).toBe(true);
  });

  it("verifies a rotation header carrying both platform schemes at once", async () => {
    const secret = generateWebhookSecret();
    const { keyPair, publicKey } = await generateWebhookKeypair();
    const ts = String(Math.floor(Date.now() / 1000));
    const header =
      (await signWebhookHmac(secret, ID, ts, BODY)) +
      " " +
      (await signWebhookEd25519(keyPair.privateKey, ID, ts, BODY));
    expect(
      verifyWebhookSignature({
        webhookId: ID,
        webhookTimestamp: ts,
        webhookSignature: header,
        body: BODY,
        secret,
        publicKey,
      }),
    ).toBe(true);
  });
});
