# @iptv/secrets

Secrets port: domain tables store a `secret_ref` **string**, never a secret
value. This package is the only place that turns a ref into a value — and the
only place allowed to write tenant secrets (self-service writer).

Runtime storage is **PostgreSQL**: one row per `(tenant, secret_ref)` in
`platform.secret_values` holding AES-256-GCM ciphertext. There is no external
secret manager in the MVP runtime path.

## What it is

- `SecretsPort` — the read port (`name` + `getSecret(ref)`).
- `SecretsWriterPort` — the writer facet (`extends SecretsPort`):
  `putSecret(input)` + `deleteSecret(ref)` under the backend-owned
  `integrations/<tenantId>/<provider>` namespace. Use `asSecretsWriter` to
  narrow a read-only port.
- `PostgresSecretsAdapter` — the runtime implementation. It composes a
  `SecretRowStore` (the API supplies a Kysely store bound to the request's
  tenant transaction) with the encryption key from the environment. The
  adapter enforces ref validation, tenant isolation and ciphertext framing.
- `rotateSecret(port, input)` — orchestrated domain function: stage
  `<KEY>__next` → read-only `probe` → cutover live key → best-effort stage
  cleanup. Any failure is fail-closed (probe rejection throws `ROTATE_FAILED`
  with the live ref preserved).
- `NoopSecretsPort` — fail-closed default for tests/unconfigured programs.
  `getSecret`/`putSecret`/`deleteSecret` throw a typed `SecretsError(CONFIG)`;
  it never returns a fake value.
- `parseSecretRef(ref)` — the ref grammar, used to validate stored refs.
- `buildIntegrationSecretRef(target)` / `parseIntegrationSecretRef(ref)` —
  the controlled namespace: refs are produced ONLY by the backend from
  validated `{ tenantId, provider, environment, key }` targets. Free-form
  paths/keys are rejected with `MALFORMED_REF` before any storage call.

## Crypto

- AES-256-GCM via `node:crypto`.
- Payload: `v1.<iv>.<authTag>.<ciphertext>` (base64url, no padding).
- Fresh 12-byte IV per encryption; 16-byte auth tag.
- AAD binds the ciphertext to `(tenantId, ref)`: a row copied to another
  tenant/ref fails authentication.
- The single 256-bit key lives in the API process environment as
  `SECRETS_ENCRYPTION_KEY` (base64, 32 bytes). It is never stored in the
  database or Git and must be backed up separately from the PostgreSQL dump.
- Decryption failure (wrong key, tampered row, wrong binding) throws
  `SecretsError(SERVER)`; there is no plaintext fallback.

## Usage

```ts
import { PostgresSecretsAdapter, rotateSecret } from "@iptv/secrets";

// The API builds one adapter per request, bound to the tenant transaction:
const secrets = new PostgresSecretsAdapter({
  store: createSecretRowStore(trx),
  tenantId: ctx.tenantId,
  key: loadEncryptionKey(),
});

const value = await secrets.getSecret(ref);

// Server-side provisioning (never in the browser): the ref is derived from
// the validated target, never from client input.
const { ref } = await secrets.putSecret({
  tenantId: "tenant-1",
  provider: "asaas",
  environment: "SANDBOX",
  key: "ASAAS_API_KEY",
  value: "<key provided server-side>",
  requestId: "req-stable-1",
});

// Rotation: stage → read-only probe → cutover → stage cleanup (fail-closed).
await rotateSecret(secrets, {
  tenantId: "tenant-1",
  provider: "asaas",
  environment: "SANDBOX",
  key: "ASAAS_API_KEY",
  value: "<candidate provided server-side>",
  probe: async (stagedRef) => {
    /* read-only provider check resolving stagedRef; throw to abort */
  },
});
```

## Ref format

```
pgsecret://<environment>/integrations/<tenantId>/<provider>/<KEY>
infisical://<environment>/integrations/<tenantId>/<provider>/<KEY>   (legacy)
```

- New writes use `pgsecret://`. The legacy `infisical://` scheme stays
  parse-compatible so rows migrated from the previous vault keep resolving by
  their exact stored `secret_ref`.
- `<environment>` is `SANDBOX` or `PRODUCTION` for tenant integrations.
- Per-provider key allowlists: `asaas`: `ASAAS_API_KEY`,
  `ASAAS_WEBHOOK_TOKEN`; `cinevision`: `CINEVISION_USER`, `CINEVISION_PASS`;
  `whatsapp`: `WAHA_WEBHOOK_SECRET`. `<KEY>__next` is reserved for rotation
  staging.
- Anything else throws `SecretsError(MALFORMED_REF)`; `.`/`..` segments and
  empty segments are rejected.

## Env

| Var | Required | Notes |
| --- | --- | --- |
| `SECRETS_ENCRYPTION_KEY` | yes for runtime reads/writes | Base64 of exactly 32 random bytes. Absent = fail closed at use time (boot still succeeds). |

## Notes

- The Browser Worker never reads this store and never touches the database.
  The API decrypts the tenant binding and passes `CINEVISION_EMAIL` +
  `CINEVISION_PASSWORD` for that invocation; the panel URL is the non-secret
  `CINEVISION_ALLOWED_ORIGIN`.
- Secret values, key material and ciphertext are never logged, thrown inside
  messages, or attached to telemetry.
- One-time cutover from the previous vault:
  `node packages/database/scripts/migrate-secrets-to-postgres.mjs` (dry run by
  default; `--apply` writes). It reads legacy values, encrypts them with the
  API key and upserts by the exact stored ref. It never deletes the old vault.
