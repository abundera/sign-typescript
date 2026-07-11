# Changelog

All notable changes to this SDK are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [0.1.0] - 2026-07-08

Initial release.

- Typed models for the core API surface (envelopes, templates, webhooks, audit
  trail, evidence checklist, public verification).
- Bearer-token auth (`abnd_sign_…`) with exponential-backoff retry on 429 and
  5xx responses (honors `Retry-After`), per-request timeout.
- Canonical `{ ok, data, error, request_id }` envelope unwrapped on every call;
  failures throw `AbunderaError` with the API's error code and request id.
- `verifyWebhookSignature(...)` for the Standard Webhooks scheme: `v1`
  HMAC-SHA256 (`whsec_…`) and opt-in `v1a` Ed25519 (`whpk_…`), constant-time
  comparison, ±5 min replay window, rotation-friendly multi-token headers.
- Binary support for the court-ready declaration PDF.
- MIT licensed; zero runtime dependencies (Node 18+ built-ins only).
