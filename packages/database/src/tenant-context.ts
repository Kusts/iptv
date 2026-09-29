import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "./schema.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertTenantId(tenantId: string): void {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`invalid tenant id for RLS context: ${tenantId}`);
  }
}

export async function readTenantSetting(
  trx: Transaction<Database>,
): Promise<string | null> {
  const result = await sql<{ value: string | null }>`
    SELECT nullif(current_setting('app.tenant_id', true), '') AS value
  `.execute(trx);
  return result.rows[0]?.value ?? null;
}

export async function withTenantTransaction<T>(
  db: Kysely<Database>,
  tenantId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  assertTenantId(tenantId);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(
      trx,
    );
    return fn(trx);
  });
}
