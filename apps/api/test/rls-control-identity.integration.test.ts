import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Transaction } from "kysely";
import { applyMigrations, createDb, withTenantTransaction } from "@iptv/database";
import type { Database } from "@iptv/database";
import { newId } from "@iptv/domain";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

/** Tables migration 047 enrolls with the plain tenant template. */
const IDENTITY_TENANT_TABLES = [
  "identity.persons",
  "identity.identities",
  "identity.identity_merge_reviews",
] as const;

describe.skipIf(!hasDb)("RLS enrollment on control + identity (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const tenantIds: string[] = [];

  async function makeTenant(): Promise<string> {
    const id = newId();
    const suffix = id.replace(/-/g, "").slice(-8);
    await db
      .insertInto("control.tenants")
      .values({
        id,
        slug: `rls-ci-${suffix}`,
        name: "RLS Control Identity Tenant",
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

  /** Run `fn` inside a transaction that has already become `iptv_app`. */
  async function asAppRole<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return withTenantTransaction(db, "00000000-0000-4000-8000-000000000000", async (trx) => {
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      return fn(trx);
    });
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // Owner connection: bypasses RLS, so cleanup sees every fixture row.
      await db.deleteFrom("control.feature_flags").where("tenant_id", "=", tenantId).execute();
      await db.deleteFrom("identity.identities").where("tenant_id", "=", tenantId).execute();
      await db.deleteFrom("identity.persons").where("tenant_id", "=", tenantId).execute();
      await db.deleteFrom("control.tenant_memberships").where("tenant_id", "=", tenantId).execute();
      await db.deleteFrom("control.tenants").where("id", "=", tenantId).execute();
    }
    await db
      .deleteFrom("control.feature_flags")
      .where("flag_key", "=", "rls-ci.global-fixture")
      .execute();
    await db.destroy();
  });

  it("enables RLS with a tenant_isolation policy on every identity tenant-scoped table", async () => {
    const rows = await sql<{ table_name: string; rowsecurity: boolean; policies: string[] }>`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rowsecurity,
             coalesce(
               array_agg(p.policyname) FILTER (WHERE p.policyname IS NOT NULL),
               ARRAY[]::text[]
             ) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policies p
        ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'identity' AND c.relkind = 'r'
      GROUP BY c.relname, c.relrowsecurity
      ORDER BY c.relname
    `.execute(db);

    for (const table of IDENTITY_TENANT_TABLES) {
      const row = rows.rows.find((r) => r.table_name === table.split(".")[1]);
      expect(row, `pg catalog must expose ${table}`).toBeDefined();
      expect(row?.rowsecurity, `${table} must have RLS enabled`).toBe(true);
      expect(row?.policies, `${table} must carry tenant_isolation`).toContain("tenant_isolation");
    }
    // No identity table may slip through unenrolled.
    expect(rows.rows.length).toBe(IDENTITY_TENANT_TABLES.length);
  });

  it("enforces hybrid global+own isolation on control.feature_flags", async () => {
    // Migration 048 split the single all-command policy (047) into per-command
    // policies: a global row must be READABLE but never claimable via UPDATE
    // nor deletable by the app role.
    const policies = await sql<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }>`
      SELECT p.policyname, p.cmd, p.qual, p.with_check
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'control' AND c.relname = 'feature_flags'
      ORDER BY p.policyname
    `.execute(db).then((r) => r.rows);
    const byName = new Map(policies.map((p) => [p.policyname, p]));
    // Postgres normalizes the stored expressions with parentheses/uppercase.
    const ownOnly = /\(tenant_id = \(NULLIF\(current_setting\('app\.tenant_id'/;
    const selectPolicy = byName.get("feature_flags_select");
    expect(selectPolicy?.cmd).toBe("SELECT");
    expect(selectPolicy?.qual ?? "").toMatch(/\(tenant_id IS NULL\) OR \(tenant_id =/);
    expect(selectPolicy?.with_check).toBeNull();
    const insertPolicy = byName.get("feature_flags_insert");
    expect(insertPolicy?.cmd).toBe("INSERT");
    expect(insertPolicy?.qual).toBeNull();
    expect(insertPolicy?.with_check ?? "").toMatch(ownOnly);
    expect(insertPolicy?.with_check ?? "").not.toMatch(/IS NULL/);
    const updatePolicy = byName.get("feature_flags_update");
    expect(updatePolicy?.cmd).toBe("UPDATE");
    expect(updatePolicy?.qual ?? "").toMatch(ownOnly);
    expect(updatePolicy?.with_check ?? "").toMatch(ownOnly);
    const deletePolicy = byName.get("feature_flags_delete");
    expect(deletePolicy?.cmd).toBe("DELETE");
    expect(deletePolicy?.qual ?? "").toMatch(ownOnly);
    expect(deletePolicy?.with_check).toBeNull();

    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    await makePerson(tenantA);
    await makePerson(tenantB);
    const globalKey = "rls-ci.global-fixture";
    const now = new Date();
    await db
      .insertInto("control.feature_flags")
      .values({
        id: newId(),
        tenant_id: null,
        flag_key: globalKey,
        enabled: false,
        config_json: {},
        updated_by_user_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("control.feature_flags")
      .values({
        id: newId(),
        tenant_id: tenantA,
        flag_key: "rls-ci.own-fixture",
        enabled: true,
        config_json: {},
        updated_by_user_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("control.feature_flags")
      .values({
        id: newId(),
        tenant_id: tenantB,
        flag_key: "rls-ci.own-fixture",
        enabled: false,
        config_json: {},
        updated_by_user_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const seenByA = await withTenantTransaction(db, tenantA, async (trx) => {
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      const rows = await trx
        .selectFrom("control.feature_flags")
        .select(["flag_key", "tenant_id", "enabled"])
        .where("flag_key", "in", [globalKey, "rls-ci.own-fixture"])
        .execute();
      // GLOBAL (null tenant) first, then the tenant override.
      return rows.sort((a, b) => (a.tenant_id === null ? -1 : 1) - (b.tenant_id === null ? -1 : 1));
    });
    // Own override + GLOBAL default; never tenant B's row.
    expect(seenByA.map((r) => [r.flag_key, r.enabled])).toEqual([
      [globalKey, false],
      ["rls-ci.own-fixture", true],
    ]);

    // 048 regression (behavioral): a global row can be neither claimed via
    // UPDATE nor deleted by the app role; own-tenant UPDATE still works.
    await withTenantTransaction(db, tenantA, async (trx) => {
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      const claimed = await trx
        .updateTable("control.feature_flags")
        .set({ tenant_id: tenantA })
        .where("flag_key", "=", globalKey)
        .where("tenant_id", "is", null)
        .executeTakeFirst();
      expect(Number(claimed?.numUpdatedRows ?? 0)).toBe(0);
      const deleted = await trx
        .deleteFrom("control.feature_flags")
        .where("flag_key", "=", globalKey)
        .where("tenant_id", "is", null)
        .executeTakeFirst();
      expect(Number(deleted?.numDeletedRows ?? 0)).toBe(0);
      const ownUpdate = await trx
        .updateTable("control.feature_flags")
        .set({ enabled: false })
        .where("flag_key", "=", "rls-ci.own-fixture")
        .where("tenant_id", "=", tenantA)
        .executeTakeFirst();
      expect(Number(ownUpdate?.numUpdatedRows ?? 0)).toBe(1);
    });
  });

  it("isolates identity.persons per tenant for iptv_app and fails closed without context", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    await makePerson(tenantA);
    await makePerson(tenantB);

    const seenA = await withTenantTransaction(db, tenantA, async (trx) => {
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      const rows = await trx
        .selectFrom("identity.persons")
        .select(["id", "tenant_id"])
        .execute();
      return rows;
    });
    expect(seenA).toHaveLength(1);
    expect(seenA[0]?.tenant_id).toBe(tenantA);

    const seenB = await withTenantTransaction(db, tenantB, async (trx) => {
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      const rows = await trx
        .selectFrom("identity.persons")
        .select(["id", "tenant_id"])
        .execute();
      return rows;
    });
    expect(seenB).toHaveLength(1);
    expect(seenB[0]?.tenant_id).toBe(tenantB);

    // No tenant context at all: the app role sees nothing (fail-closed).
    const seenWithoutContext = await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      return trx.selectFrom("identity.persons").select("id").execute();
    });
    expect(seenWithoutContext).toHaveLength(0);
  });

  it("blocks cross-tenant identity writes but allows own-tenant writes", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const personA = await makePerson(tenantA);
    const personB = await makePerson(tenantB);

    const ownInsert = await withTenantTransaction(db, tenantA, async (trx) => {
      await sql`SET LOCAL ROLE iptv_app`.execute(trx);
      const now = new Date();
      const inserted = await trx
        .insertInto("identity.persons")
        .values({
          id: newId(),
          tenant_id: tenantA,
          status: "ACTIVE",
          canonical_name: null,
          locale: null,
          timezone: null,
          created_at: now,
          updated_at: now,
          anonymized_at: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const visible = await trx.selectFrom("identity.persons").select("id").execute();
      return { insertedId: inserted.id, visibleCount: visible.length };
    });
    expect(ownInsert.visibleCount).toBe(2);

    await expect(
      withTenantTransaction(db, tenantA, async (trx) => {
        await sql`SET LOCAL ROLE iptv_app`.execute(trx);
        const now = new Date();
        await trx
          .insertInto("identity.persons")
          .values({
            id: newId(),
            tenant_id: tenantB,
            status: "ACTIVE",
            canonical_name: null,
            locale: null,
            timezone: null,
            created_at: now,
            updated_at: now,
            anonymized_at: null,
          })
          .execute();
      }),
    ).rejects.toThrow();

    await expect(
      withTenantTransaction(db, tenantA, async (trx) => {
        await sql`SET LOCAL ROLE iptv_app`.execute(trx);
        const now = new Date();
        await trx
          .insertInto("identity.identities")
          .values({
            id: newId(),
            tenant_id: tenantB,
            person_id: personB,
            identity_type: "EMAIL",
            normalized_value: `cross-${personA}`,
            external_provider: null,
            external_id: null,
            verification_status: "UNVERIFIED",
            link_confidence: null,
            metadata_json: {},
            created_at: now,
            verified_at: null,
            detached_at: null,
          })
          .execute();
      }),
    ).rejects.toThrow();

    // The app role must never be able to write a GLOBAL feature flag.
    await expect(
      asAppRole(async (trx) => {
        const now = new Date();
        await trx
          .insertInto("control.feature_flags")
          .values({
            id: newId(),
            tenant_id: null,
            flag_key: "rls-ci.attempted-global",
            enabled: true,
            config_json: {},
            updated_by_user_id: null,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }),
    ).rejects.toThrow();
  });

  it("keeps the owner connection as the RLS bypass (sees every tenant)", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    await makePerson(tenantA);
    await makePerson(tenantB);

    const seenByOwner = await db
      .selectFrom("identity.persons")
      .select(["tenant_id"])
      .where("tenant_id", "in", [tenantA, tenantB])
      .execute();
    expect(seenByOwner.map((r) => r.tenant_id).sort()).toEqual([tenantA, tenantB].sort());

    const bypass = await sql<{ rolbypassrls: boolean }>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app'
    `.execute(db);
    expect(bypass.rows[0]?.rolbypassrls).toBe(false);
  });
});