import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Transaction } from "kysely";
import { applyMigrations, createDb } from "@iptv/database";
import type { Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import { KyselyCommandDb } from "../src/commands/kysely-command-db.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

describe.skipIf(!hasDb)("RLS tenant context on the command path (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const commandDb = new KyselyCommandDb(db);
  const tenantIds: string[] = [];

  async function makeTenant(): Promise<string> {
    const id = newId();
    const suffix = id.replace(/-/g, "").slice(-8);
    await db
      .insertInto("control.tenants")
      .values({
        id,
        slug: `rls-ctx-${suffix}`,
        name: "RLS Context Tenant",
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    tenantIds.push(id);
    return id;
  }

  async function makePerson(tenantId: string): Promise<string> {
    const id = newId();
    await db
      .insertInto("identity.persons")
      .values({
        id,
        tenant_id: tenantId,
        status: "ACTIVE",
        canonical_name: null,
        locale: null,
        timezone: null,
        created_at: new Date(),
        updated_at: new Date(),
        anonymized_at: null,
      })
      .execute();
    return id;
  }

  function trxOf(tx: { innerDb(): unknown }): Transaction<Database> {
    return tx.innerDb() as Transaction<Database>;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await db.deleteFrom("crm.customers").where("tenant_id", "=", tenantId).execute();
      await db.deleteFrom("identity.persons").where("tenant_id", "=", tenantId).execute();
      await db.deleteFrom("control.tenants").where("id", "=", tenantId).execute();
    }
    await db.destroy();
  });

  it("sets app.tenant_id for every command transaction", async () => {
    const tenantId = await makeTenant();
    const seen = await commandDb.withTransaction(tenantId, async (tx) => {
      const trx = trxOf(tx);
      const result = await sql<{ value: string | null }>`
        SELECT nullif(current_setting('app.tenant_id', true), '') AS value
      `.execute(trx);
      return result.rows[0]?.value ?? null;
    });
    expect(seen).toBe(tenantId);
  });

  it("keeps crm.customers writes and reads tenant-scoped without leaking across tenants", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const personA = await makePerson(tenantA);
    const personB = await makePerson(tenantB);

    const customerA = await commandDb.withTransaction(tenantA, async (tx) => {
      const trx = trxOf(tx);
      const inserted = await trx
        .insertInto("crm.customers")
        .values({
          id: randomUUID(),
          tenant_id: tenantA,
          person_id: personA,
          status: "ACTIVE",
          customer_since: new Date(),
          last_reactivated_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const visible = await trx
        .selectFrom("crm.customers")
        .select(["id", "tenant_id"])
        .where("tenant_id", "=", tenantA)
        .execute();
      return { insertedId: inserted.id, visibleIds: visible.map((r) => r.id) };
    });
    expect(customerA.visibleIds).toContain(customerA.insertedId);

    const customerB = await commandDb.withTransaction(tenantB, async (tx) => {
      const trx = trxOf(tx);
      const settingResult = await sql<{ value: string | null }>`
        SELECT nullif(current_setting('app.tenant_id', true), '') AS value
      `.execute(trx);
      const ownBefore = await trx
        .selectFrom("crm.customers")
        .select("id")
        .where("tenant_id", "=", tenantB)
        .execute();
      const inserted = await trx
        .insertInto("crm.customers")
        .values({
          id: randomUUID(),
          tenant_id: tenantB,
          person_id: personB,
          status: "ACTIVE",
          customer_since: new Date(),
          last_reactivated_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const ownAfter = await trx
        .selectFrom("crm.customers")
        .select("id")
        .where("tenant_id", "=", tenantB)
        .execute();
      return {
        setting: settingResult.rows[0]?.value ?? null,
        beforeIds: ownBefore.map((r) => r.id),
        insertedId: inserted.id,
        afterIds: ownAfter.map((r) => r.id),
      };
    });
    expect(customerB.setting).toBe(tenantB);
    expect(customerB.beforeIds).toEqual([]);
    expect(customerB.afterIds).toEqual([customerB.insertedId]);
  });

  it("enforces the pilot policy for the app role on the command path", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const personA = await makePerson(tenantA);
    await makePerson(tenantB);
    await db
      .insertInto("crm.customers")
      .values({
        id: randomUUID(),
        tenant_id: tenantA,
        person_id: personA,
        status: "ACTIVE",
        customer_since: new Date(),
        last_reactivated_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    const seenA = await commandDb.withTransaction(tenantA, async (tx) => {
      const trx = trxOf(tx);
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      const rows = await trx.selectFrom("crm.customers").select("id").execute();
      return rows.length;
    });
    const seenB = await commandDb.withTransaction(tenantB, async (tx) => {
      const trx = trxOf(tx);
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      const rows = await trx.selectFrom("crm.customers").select("id").execute();
      return rows.length;
    });
    expect(seenA).toBe(1);
    expect(seenB).toBe(0);
  });
});
