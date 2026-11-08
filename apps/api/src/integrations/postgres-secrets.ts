/**
 * API-side wiring for the PostgreSQL secrets adapter.
 *
 * The adapter is always bound to the request's tenant transaction, so a
 * secret write and the provider binding that references it commit or roll
 * back together. `loadEncryptionKey()` reads the single 256-bit key from
 * `SECRETS_ENCRYPTION_KEY` (process environment, never the database).
 */

import { PostgresSecretsAdapter, loadEncryptionKey } from "@iptv/secrets";
import { createSecretRowStore, type SecretStoreExecutor } from "./secret-row-store.js";

export function createPostgresSecretsAdapter(
  executor: SecretStoreExecutor,
  tenantId: string,
): PostgresSecretsAdapter {
  return new PostgresSecretsAdapter({
    store: createSecretRowStore(executor),
    tenantId,
    key: loadEncryptionKey(),
  });
}

/**
 * SecretsPort already bound to the caller's tenant context *without*
 * calling `getSecret`. Reuses `createPostgresSecretsAdapter`; the caller
 * owns binding the adapter to the correct transaction/pool. Returns null
 * when `SECRETS_ENCRYPTION_KEY` is unavailable so callers can distinguish
 * "no vault" from "vault present" without throwing. Tenant isolation is
 * inherited from the underlying store (tenant_id + RLS), so a port created
 * for tenant A can never read tenant B's secret.
 */
export function tryCreatePostgresSecretsAdapter(
  executor: SecretStoreExecutor,
  tenantId: string,
): PostgresSecretsAdapter | null {
  try {
    return createPostgresSecretsAdapter(executor, tenantId);
  } catch {
    return null;
  }
}
