/**
 * Kysely implementation of the secrets storage boundary.
 *
 * One row per `(tenant, secret_ref)` in `platform.secret_values`, holding
 * AES-256-GCM ciphertext only. The caller supplies the request's tenant
 * transaction so a secret write and the provider binding that references it
 * commit or roll back together.
 */

import type { SecretRowStore } from "@iptv/secrets";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "@iptv/database";

export type SecretStoreExecutor = Kysely<Database> | Transaction<Database>;

export function createSecretRowStore(executor: SecretStoreExecutor): SecretRowStore {
  return {
    async get(tenantId, ref) {
      const row = await executor
        .selectFrom("platform.secret_values")
        .select(["ciphertext"])
        .where("tenant_id", "=", tenantId)
        .where("secret_ref", "=", ref)
        .executeTakeFirst();
      return row ? { ciphertext: row.ciphertext } : undefined;
    },
    async upsert({ tenantId, ref, ciphertext }) {
      const existed = await executor
        .selectFrom("platform.secret_values")
        .select(["secret_ref"])
        .where("tenant_id", "=", tenantId)
        .where("secret_ref", "=", ref)
        .executeTakeFirst();
      await executor
        .insertInto("platform.secret_values")
        .values({
          tenant_id: tenantId,
          secret_ref: ref,
          ciphertext,
          created_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .onConflict((oc) =>
          oc.columns(["tenant_id", "secret_ref"]).doUpdateSet({ ciphertext, updated_at: sql`now()` }),
        )
        .execute();
      return !existed;
    },
    async remove(tenantId, ref) {
      const row = await executor
        .deleteFrom("platform.secret_values")
        .where("tenant_id", "=", tenantId)
        .where("secret_ref", "=", ref)
        .returning(["secret_ref"])
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
