/**
 * Secrets port (ADR-0014, PostgreSQL replacement).
 *
 * Domain tables store `secret_ref` — never secret values. Runtime
 * implementations:
 * - `PostgresSecretsAdapter` (default): AES-256-GCM ciphertext in
 *   `platform.secret_values`, keyed by `(tenant, ref)`, with the single
 *   256-bit key supplied by `SECRETS_ENCRYPTION_KEY` from the environment.
 * - `NoopSecretsPort`: fail-closed default for tests/unconfigured programs;
 *   `getSecret` throws a typed CONFIG error (never a fake value).
 *
 * The same adapter serves the self-service writer facet
 * (`SecretsWriterPort`: `putSecret`/`deleteSecret` under the
 * backend-owned `integrations/<tenantId>/<provider>` namespace, plus the
 * orchestrated `rotateSecret` domain flow).
 *
 * SECURITY: secret VALUES, key material and ciphertext never appear in
 * logs, error messages or telemetry. Error messages may name the
 * environment (and, for NOT_FOUND, the key) but never the value.
 *
 * This package has no network or database dependency: the API supplies a
 * `SecretRowStore` bound to the tenant transaction and the key loaded from
 * the environment.
 */

export { SecretsError } from "./errors.js";
export type { SecretsErrorCode } from "./errors.js";

export {
  LEGACY_SECRETS_REF_SCHEME,
  SECRETS_REF_SCHEME,
  SECRET_NAMESPACE_ROOT,
  SECRET_STAGED_SUFFIX,
  buildIntegrationSecretRef,
  deriveIntegrationSecretRef,
  parseIntegrationSecretRef,
  parseSecretRef,
  secretRefSchemeOf,
} from "./refs.js";
export type { IntegrationRefScheme } from "./refs.js";

export type {
  IntegrationProvider,
  IntegrationSecretBinding,
  IntegrationSecretTarget,
  ParsedSecretRef,
  PutSecretInput,
  PutSecretResult,
  RotateSecretInput,
  RotateSecretResult,
  SecretsPort,
  SecretsWriterPort,
} from "./types.js";

export { NoopSecretsPort, asSecretsWriter, rotateSecret } from "./writer.js";

export {
  SECRETS_KEY_ENV,
  SECRET_CIPHER_VERSION,
  SECRET_KEY_BYTES,
  decryptSecret,
  encryptSecret,
  isSecretsConfigured,
  loadEncryptionKey,
  parseEncryptionKey,
  secretAad,
} from "./crypto.js";

export { PostgresSecretsAdapter } from "./postgres-adapter.js";
export type { PostgresSecretsOptions, SecretRowStore } from "./postgres-adapter.js";
