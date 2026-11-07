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
