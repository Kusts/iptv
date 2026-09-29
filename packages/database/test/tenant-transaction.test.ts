import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Transaction } from "kysely";
import {
  applyMigrations,
  assertTenantId,
  createDb,
  readTenantSetting,
  withTenantTransaction,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const TA = "11111111-1111-4111-8111-111111111111";
const TB = "22222222-2222-4222-8222-222222222222";

async function currentSettingOutsideTx(db: ReturnType<typeof createDb>): Promise<string | null> {
  const result = await sql<{ value: string | null }>`
    SELECT nullif(current_setting('app.tenant_id', true), '') AS value
  `.execute(db);
  return result.rows[0]?.value ?? null;
}

describe.skipIf(!hasDb)("tenant transaction context (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("rejects non-uuid tenant ids before touching the database", async () => {
    expect(() => assertTenantId("11111111-1111-4111-8111-111111111111")).not.toThrow();
    expect(() => assertTenantId("")).toThrow();
    expect(() => assertTenantId("tenant-a")).toThrow();
    expect(() => assertTenantId("11111111-1111-4111-8111-111111111111'; DROP TABLE x; --")).toThrow();
    await expect(
      withTenantTransaction(db, "not-a-uuid", async () => "unreached"),
    ).rejects.toThrow();
  });

  it("exposes the tenant context inside the transaction only", async () => {
    const seen = await withTenantTransaction(db, TA, async (trx) => readTenantSetting(trx));
    expect(seen).toBe(TA);
    expect(await currentSettingOutsideTx(db)).toBeNull();
  });

  it("does not leak context across sequential transactions", async () => {
    const first = await withTenantTransaction(db, TA, async (trx) => readTenantSetting(trx));
    const second = await withTenantTransaction(db, TB, async (trx) => readTenantSetting(trx));
    expect(first).toBe(TA);
    expect(second).toBe(TB);
    expect(await currentSettingOutsideTx(db)).toBeNull();
  });

  it("isolates crm.customers per tenant for the app role through the wrapper", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
    const tenants = [
      { id: tenantA, slug: `rls-w-${suffix}-a`, person: randomUUID() },
      { id: tenantB, slug: `rls-w-${suffix}-b`, person: randomUUID() },
    ];
    for (const t of tenants) {
      await db
        .insertInto("control.tenants")
        .values({
          id: t.id,
          slug: t.slug,
          name: "RLS wrapper Tenant",
          status: "ACTIVE",
          default_currency: "BRL",
          timezone: "America/Sao_Paulo",
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      await db
        .insertInto("identity.persons")
        .values({
          id: t.person,
          tenant_id: t.id,
          status: "ACTIVE",
          canonical_name: null,
          locale: null,
          timezone: null,
          created_at: new Date(),
          updated_at: new Date(),
          anonymized_at: null,
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      await db
        .insertInto("crm.customers")
        .values({
          id: t.person,
          tenant_id: t.id,
          person_id: t.person,
          status: "ACTIVE",
          customer_since: new Date(),
          last_reactivated_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    }
    try {
      const countAsAppRole = async (trx: Transaction<Database>): Promise<number> => {
        const result = await sql<{ n: string }>`
          SELECT count(*) AS n FROM crm.customers
        `.execute(trx);
        return Number(result.rows[0]?.n ?? 0);
      };
      const seenA = await withTenantTransaction(db, tenantA, async (trx) => {
        await sql`SET LOCAL ROLE iptv_app`.execute(trx);
        return countAsAppRole(trx);
      });
      const seenB = await withTenantTransaction(db, tenantB, async (trx) => {
        await sql`SET LOCAL ROLE iptv_app`.execute(trx);
        return countAsAppRole(trx);
      });
      expect(seenA).toBe(1);
      expect(seenB).toBe(1);
      const seenWithoutContext = await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE iptv_app`.execute(trx);
        return countAsAppRole(trx as Transaction<Database>);
      });
      expect(seenWithoutContext).toBe(0);
      expect(await currentSettingOutsideTx(db)).toBeNull();
    } finally {
      for (const t of tenants) {
        await db.deleteFrom("crm.customers").where("tenant_id", "=", t.id).execute();
        await db.deleteFrom("identity.persons").where("tenant_id", "=", t.id).execute();
        await db.deleteFrom("control.tenants").where("id", "=", t.id).execute();
      }
    }
  });
});
