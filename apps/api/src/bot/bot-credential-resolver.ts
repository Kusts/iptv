import { sql, type Kysely } from "kysely";
import type { Database } from "@iptv/database";

export type ResolvedBotCredential = {
  credentialId: string;
  tenantId: string;
  scopes: string[];
};

export async function resolveBotCredential(
  db: Kysely<Database>,
  tokenHash: string,
): Promise<ResolvedBotCredential | null> {
  const result = await sql<{
    credential_id: string;
    tenant_id: string;
    scopes: string[];
  }>`select * from platform.resolve_bot_credential(${tokenHash})`.execute(db);
  const row = result.rows[0];
  return row ? {
    credentialId: row.credential_id,
    tenantId: row.tenant_id,
    scopes: row.scopes,
  } : null;
}
