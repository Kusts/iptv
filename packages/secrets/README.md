# @iptv/secrets

Secrets port (ADR-0014): domain tables store a `secret_ref` **string**, never a
secret value. This package is the only place that turns a ref into a value —
and the only place allowed to write tenant secrets (S1 self-service writer).

## What it is

- `SecretsPort` — the read port (`name` + `getSecret(ref)`). Unchanged by the
  writer facet so existing read-only implementations keep compiling.
- `SecretsWriterPort` — the writer facet (`extends SecretsPort`):
  `putSecret(input)` + `deleteSecret(ref)` under the backend-owned
  `integrations/<tenantId>/<provider>` namespace. Use `asSecretsWriter` to
  narrow and `resolveSecretsWriterPort` for env-gated selection.
- `rotateSecret(port, input)` — orchestrated domain function (not an opaque
  port op): stage `<KEY>__next` → read-only `probe` → cutover live key →
  best-effort stage cleanup. Any failure is fail-closed (probe rejection
  throws `ROTATE_FAILED` with the live ref preserved; never mark connected).
- `NoopSecretsPort` — the default. `getSecret`/`putSecret`/`deleteSecret`
  throw a typed `SecretsError` with code `CONFIG`; it never returns a fake
  value, so boot succeeds and secret consumption fails loudly.
- `InfisicalSecretsAdapter` — env-gated Universal Auth login + raw secret
  read AND write (create POST with PATCH-on-409 upsert, DELETE by ref)
  against the self-hosted Infisical instance.
- `resolveSecretsPort(env)` — builds the Infisical adapter only when all four
  `INFISICAL_*` connection vars are present; otherwise the Noop port. Never
  throws for missing env (no boot crash).
- `parseSecretRef(ref)` — the ref grammar, used to validate stored refs.
- `buildIntegrationSecretRef(target)` / `parseIntegrationSecretRef(ref)` —
  the controlled namespace: refs are produced ONLY by the backend from
  validated `{ tenantId, provider, environment, key }` targets. Free-form
  paths/keys are rejected with `MALFORMED_REF` before any network call.

## Usage

```ts
import { resolveSecretsPort, resolveSecretsWriterPort, rotateSecret } from "@iptv/secrets";

const secrets = resolveSecretsPort(); // env-gated selection
const value = await secrets.getSecret("infisical://dev/browser-worker/CINEVISION_URL");

// Server-side provisioning (never in the browser): the ref is derived from
// the validated target, never from client input.
const writer = resolveSecretsWriterPort();
const { ref } = await writer.putSecret({
  tenantId: "tenant-1",
  provider: "asaas",
  environment: "sandbox",
  key: "ASAAS_API_KEY",
  value: "<key provided server-side>",
  requestId: "req-stable-1", // optional idempotency key, forwarded as X-Request-Id
});
// Rotation: stage → read-only probe → cutover → stage cleanup (fail-closed).
await rotateSecret(writer, {
  tenantId: "tenant-1",
  provider: "asaas",
  environment: "sandbox",
  key: "ASAAS_API_KEY",
  value: "<candidate provided server-side>",
  probe: async (stagedRef) => {
    /* read-only provider check resolving stagedRef; throw to abort */
  },
});
```

Consumers in this repo: `apps/api/src/provider/provider-secret-gate.ts`,
`apps/api/src/provider/provider-dispatcher.service.ts` and
`apps/api/src/fulfillment/fulfillment.commands.ts` (API side, `INFISICAL_*`)
and `apps/browser-worker/src/secrets.ts` (worker side, its own
`BROWSER_INFISICAL_*` identity). Both go through the same adapter; the worker
never reads the API vars and the API never reads the worker vars.

## Ref format

```
infisical://<environment>/<key>
infisical://<environment>/<path...>/<key>
```

- `<environment>` is the Infisical environment slug and is **authoritative for
  the request** — the adapter's configured default is not consulted.
- `<key>` is the secret name (last `/` segment); middle segments become the
  secret path (`/browser-worker`).
- Anything else throws `SecretsError(MALFORMED_REF)`; `.`/`..` segments and
  empty segments are rejected.

## Env

| Var | Required | Notes |
| --- | --- | --- |
| `INFISICAL_SITE_URL` | yes for the real adapter | Absolute `https://` URL. Plain `http://` only for `localhost`/`127.0.0.1` local dev; anything else is a `CONFIG` error. |
| `INFISICAL_PROJECT_ID` | yes | Sent as `workspaceId`. |
| `INFISICAL_CLIENT_ID` | yes | Universal Auth machine identity. |
| `INFISICAL_CLIENT_SECRET` | yes | Universal Auth machine identity. |
| `INFISICAL_ENVIRONMENT` | no (`development`) | Fallback only; refs carry their own environment. |

The Browser Worker uses a separate `BROWSER_INFISICAL_SITE_URL` /
`_PROJECT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` set resolved by
`apps/browser-worker/src/config.ts` and passed explicitly to
`InfisicalSecretsAdapter`.

## Notes

- Endpoints: `POST {site}/api/v1/auth/universal-auth/login` then
  `GET {site}/api/v3/secrets/raw/{secretName}?workspaceId=…&environment=…&secretPath=…`.
  Writes: `POST {site}/api/v3/secrets/raw/{secretName}` (create;
  `PATCH` on 409 for upsert) and `DELETE` with the same query params.
  The access token is cached in memory and refreshed 30s (or 10% of TTL)
  before expiry; a 401 triggers exactly one re-login + retry (reads and
  writes alike — no blind retries on 5xx/transport).
- Error codes: `MALFORMED_REF`, `NOT_FOUND`, `UNAUTHORIZED`, `TRANSPORT`,
  `CONFIG`, `ROTATE_FAILED` (probe rejected the rotation candidate; live ref
  preserved), `SERVER`. Secret values and tokens are never logged, thrown
  inside messages, or attached to telemetry; the debug sink receives
  presence/length metadata plus the FNV-1a hash of the ref — never the value,
  key, path or token.
- Integration namespace: `infisical://<env>/integrations/<tenantId>/<provider>/<KEY>`
  with per-provider key allowlists (`asaas`: `ASAAS_API_KEY`,
  `ASAAS_WEBHOOK_TOKEN`; `cinevision`: `CINEVISION_USER`, `CINEVISION_PASS`;
  `whatsapp`: `WAHA_WEBHOOK_SECRET`) and `<KEY>__next` reserved for rotation
  staging. Anything else is rejected before any network call.
- CINEVISION/MK Ativador credentials are stored **in Infisical** as refs; the
  raw values stay in the operator's vault and never in this repo's `.env`.
  Rationale and rollout: `docs/06-decisions/ADR-0014-infisical-secrets.md`.
- Manual smoke against real credentials:
  `node packages/secrets/scripts/infisical-smoke.mjs [SECRET_KEY] [ENVIRONMENT]`
  prints only presence/length, never the value.