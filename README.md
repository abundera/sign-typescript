# @abundera/sign

Official TypeScript SDK for [Abundera Sign](https://sign.abundera.ai).

E-signatures with cryptographic evidence: hash-chained audit trails, RFC 3161
timestamps, independent anchors, and public verification.

Targets the Abundera Sign **v1** API (`/api/v1/*`). The client speaks the canonical
`{ ok, data, error, request_id }` envelope for you — methods return the unwrapped resource
on success and throw `AbunderaError` (carrying `code` / `message` / `request_id`) on
failure, so you never touch the envelope directly.

## Install

Not yet on the public npm registry. Install directly from GitHub (builds on install):

```bash
npm install github:abundera/sign-typescript
```

## Quickstart

```ts
import { AbunderaSignClient } from "@abundera/sign";

const client = new AbunderaSignClient({
  apiKey: process.env.ABUNDERA_SIGN_API_KEY!, // abnd_sign_…
});

// Send a document for signature
const envelope = await client.createEnvelope({
  template_id: "nda-simple",
  signers: [{ email: "alex@example.com", name: "Alex Rivera" }],
  fields: { company_name: "Acme Co" },
  callback_url: "https://example.com/hooks/sign",
});

// Track it
const status = await client.getEnvelope(envelope.id);

// Nudge pending signers
await client.remind(envelope.id);

// Pull the hash-chain-verified audit trail
const audit = await client.getAuditTrail(envelope.id);
console.log(audit.chain_valid, audit.event_count);
```

## Surface

| Area | Methods |
| --- | --- |
| Envelopes | `createEnvelope`, `listEnvelopes`, `getEnvelope`, `updateEnvelope`, `voidEnvelope`, `archiveEnvelope`, `remind`, `getAuditTrail`, `getEvidenceChecklist`, `getDeclarationPdf` |
| Templates | `listTemplates`, `getTemplate`, `listTemplateCategories`, `createTemplate`, `updateTemplate`, `deleteTemplate` |
| Webhooks | `listWebhooks`, `createWebhook`, `deleteWebhook`, `pingWebhook`, `listWebhookDeliveries`, `getWebhookDelivery` |
| Verification | `verifyDocument` (public, by `vrf_…` ID or document SHA-256) |

Every list endpoint returns the API's pagination block (`limit`, `total`,
`next_cursor`); pass `cursor` back to page forward.

## Webhook verification

Abundera Sign signs deliveries with the [Standard Webhooks](https://www.standardwebhooks.com/)
scheme: headers `webhook-id`, `webhook-timestamp`, `webhook-signature`, signed content
`{id}.{timestamp}.{rawBody}`. Symmetric signatures are `v1,<base64(HMAC-SHA256)>` against
your `whsec_…` secret; Business+ tenants can opt into asymmetric `v1a,<base64(Ed25519)>`
signatures verified with the account's `whpk_…` public key.

```ts
import { verifyWebhookSignature } from "@abundera/sign";

app.post("/hooks/sign", (req, res) => {
  try {
    verifyWebhookSignature({
      webhookId: req.header("webhook-id")!,
      webhookTimestamp: req.header("webhook-timestamp")!,
      webhookSignature: req.header("webhook-signature")!,
      body: req.rawBody, // the exact raw string, before JSON.parse
      secret: process.env.SIGN_WEBHOOK_SECRET!, // whsec_…
      // publicKey: process.env.SIGN_WEBHOOK_PUBKEY, // whpk_… (v1a, optional)
    });
  } catch {
    return res.status(400).end();
  }
  const event = JSON.parse(req.rawBody);
  // handle event.event, event.envelope_id, …
  res.status(200).end();
});
```

Verification uses constant-time comparison, enforces a ±5 minute timestamp window,
and accepts multiple space-separated signature tokens (zero-downtime secret rotation).

## Errors, retries, timeouts

- Non-2xx responses throw `AbunderaError` with `status`, `code` (the API's frozen
  error vocabulary, e.g. `validation_error`, `rate_limited`), `message`, `request_id`.
- `429` and `5xx` responses are retried up to `maxRetries` (default 3) with exponential
  backoff, honoring `Retry-After`.
- Every request is bounded by `timeoutMs` (default 30 s).

## Development

```bash
npm test        # vitest — client + webhook-verification suites
npm run build   # tsc → dist/
```

MIT © Abundera, Inc.
