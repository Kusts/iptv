import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, applyMigrations } from "@iptv/database";
import { sql } from "kysely";
import { resolveBotCredential } from "../src/bot/bot-credential-resolver.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "db", "migrations");
const connectionString = process.env["TEST_DATABASE_URL"];

describe.skipIf(!connectionString)("bot service credentials (integration)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const tenantId = "71000000-0000-4000-8000-000000000001";
  const inactiveTenantId = "71000000-0000-4000-8000-000000000002";
  const activeHash = "a".repeat(64);
  const expiredHash = "b".repeat(64);
  const revokedHash = "c".repeat(64);
  const inactiveHash = "d".repeat(64);

  async function seed(hash: string, tenant: string, expiry = "2099-01-01T00:00:00Z") {
    await sql`insert into platform.bot_service_credentials
      (id, tenant_id, label, token_hash, token_prefix, scopes, created_at, expires_at)
      values (gen_random_uuid(), ${tenant}::uuid, 'test', ${hash}, '12345678',
        ARRAY['bot.streammax.execute'], '1990-01-01T00:00:00Z'::timestamptz, ${expiry}::timestamptz)`.execute(db);
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir });
    await sql`insert into control.tenants (id, slug, name, status)
      values (${tenantId}::uuid, 'bot-credential-test', 'Bot credential test', 'ACTIVE')
      on conflict (id) do update set status = 'ACTIVE'`.execute(db);
    await sql`insert into control.tenants (id, slug, name, status)
      values (${inactiveTenantId}::uuid, 'bot-credential-inactive-test', 'Bot credential inactive test', 'SUSPENDED')
      on conflict (id) do update set status = 'SUSPENDED'`.execute(db);
    await seed(activeHash, tenantId);
    await seed(expiredHash, tenantId, "2000-01-01T00:00:00Z");
    await seed(revokedHash, tenantId);
    await seed(inactiveHash, inactiveTenantId);
    await sql`update platform.bot_service_credentials set revoked_at = now() where token_hash = ${revokedHash}`.execute(db);
  });

  afterAll(async () => { await db.destroy(); });

  it("resolves an active credential with its tenant and scopes", async () => {
    const found = await resolveBotCredential(db, activeHash);
    expect(found).toMatchObject({ tenantId, scopes: ["bot.streammax.execute"] });
    expect(found?.credentialId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([expiredHash, revokedHash, inactiveHash, "e".repeat(64)])("returns no row for invalid/inactive credential", async (hash) => {
    expect(await resolveBotCredential(db, hash)).toBeNull();
  });

  it("rejects unsupported scopes", async () => {
    await expect(sql`insert into platform.bot_service_credentials
      (tenant_id, label, token_hash, token_prefix, scopes, expires_at)
      values (${tenantId}::uuid, 'bad scope', ${"f".repeat(64)}, '12345678',
        ARRAY['admin'], now() + interval '1 day')`.execute(db)).rejects.toThrow();
  });

  it("does not grant iptv_app table writes and enforces append-only revocation", async () => {
    await db.transaction().execute(async (trx) => {
      await sql`set local role iptv_app`.execute(trx);
      const allowed = await sql<{ can_insert: boolean; can_update: boolean; can_delete: boolean }>`
        select has_table_privilege(current_user, 'platform.bot_service_credentials', 'INSERT') as can_insert,
        has_table_privilege(current_user, 'platform.bot_service_credentials', 'UPDATE') as can_update,
        has_table_privilege(current_user, 'platform.bot_service_credentials', 'DELETE') as can_delete
      `.execute(trx);
      expect(allowed.rows[0]).toEqual({ can_insert: false, can_update: false, can_delete: false });
      const result = await resolveBotCredential(trx as never, activeHash);
      expect(result?.tenantId).toBe(tenantId);
    });

    await expect(sql`update platform.bot_service_credentials set label = 'changed' where token_hash = ${activeHash}`.execute(db)).rejects.toThrow();
    await expect(sql`delete from platform.bot_service_credentials where token_hash = ${activeHash}`.execute(db)).rejects.toThrow();
    await expect(sql`update platform.bot_service_credentials set revoked_at = now() where token_hash = ${activeHash}`.execute(db)).resolves.toBeDefined();
  });
});
