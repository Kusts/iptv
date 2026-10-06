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
    ).rejects.toThrow(/42501|row-level security|insufficient_privilege|permission denied|belongs to tenant/i);

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
    ).rejects.toThrow(/42501|row-level security|insufficient_privilege|permission denied|belongs to tenant/i);

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
    ).rejects.toThrow(/42501|row-level security|insufficient_privilege|permission denied|belongs to tenant/i);
  });

  it("enrolls control.tenant_memberships + control.membership_roles with tenant_isolation", async () => {
    // Migration 049 closed the 047 pre-context exception: both tables carry
    // RLS + the plain tenant template; pre-context reads go through the
    // SECURITY DEFINER resolvers (covered below and in db/tests/013).
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
      WHERE n.nspname = 'control' AND c.relname IN ('tenant_memberships', 'membership_roles')
      GROUP BY c.relname, c.relrowsecurity
      ORDER BY c.relname
    `.execute(db);

    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.rowsecurity, `${row.table_name} must have RLS enabled`).toBe(true);
      expect(row.policies, `${row.table_name} must carry tenant_isolation`).toContain("tenant_isolation");
    }
  });

  it("resolves pre-context membership reads through the 049 functions as iptv_app", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const now = new Date();
    const userId = newId();
    await db
      .insertInto("control.users")
      .values({
        id: userId,
        auth_subject: `email:rls-mem-${userId.slice(-8)}@example.com`,
        display_name: "RLS Membership User",
        status: "ACTIVE",
        is_platform_admin: false,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const membershipId = newId();
    await db
      .insertInto("control.tenant_memberships")
      .values({
        id: membershipId,
        tenant_id: tenantA,
        user_id: userId,
        role_key: "tenant_owner",
        status: "ACTIVE",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("control.membership_roles")
      .values({
        id: newId(),
        tenant_id: tenantA,
        membership_id: membershipId,
        role_key: "tenant_admin",
        created_at: now,
      })
      .execute();
    // SUSPENDED membership in tenant B: resolvers must ignore it.
    await db
      .insertInto("control.tenant_memberships")
      .values({
        id: newId(),
        tenant_id: tenantB,
        user_id: userId,
        role_key: "tenant_operator",
        status: "SUSPENDED",
        created_at: now,
        updated_at: now,
      })
      .execute();
    const tokenHash = `rls-mem-hash-${userId.replace(/-/g, "").slice(-12)}`;
    await db
      .insertInto("control.auth_sessions")
      .values({
        id: newId(),
        user_id: userId,
        token_hash: tokenHash,
        active_tenant_id: tenantA,
        tenant_context_revision: "0",
        expires_at: new Date(Date.now() + 3600_000),
        created_at: now,
        last_seen_at: now,
      })
      .execute();

    try {
      // No tenant context anywhere below: the exact pre-context state the
      // login/switch/guard paths run in.
      const listed = await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE iptv_app`.execute(trx);
        const result = await sql<{
          tenant_id: string;
          tenant_slug: string;
          tenant_name: string;
          role_key: string;
          status: string;
        }>`select * from control.list_memberships_for_session(${tokenHash})`.execute(trx);
        return result.rows;
      });
      // F4 parity: the listing is ALL-statuses session-bound (like the pre-049
      // auth.listMemberships) — the SUSPENDED row in tenant B is visible again,
      // while the switch/guard checks below stay ACTIVE-only. Sorted: the
      // resolver orders by tenant created_at, which sequential fixtures may tie.
      expect(listed.map((r) => [r.tenant_id, r.role_key, r.status]).sort()).toEqual(
        [
          [tenantA, "tenant_owner", "ACTIVE"],
          [tenantB, "tenant_operator", "SUSPENDED"],
        ].sort(),
      );

      const activeCheck = await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE iptv_app`.execute(trx);
        const own = await sql<{ active: boolean }>`
          SELECT control.check_membership_active(${userId}::uuid, ${tenantA}::uuid) AS active
        `.execute(trx);
        const suspended = await sql<{ active: boolean }>`
          SELECT control.check_membership_active(${userId}::uuid, ${tenantB}::uuid) AS active
        `.execute(trx);
        return { own: own.rows[0]?.active, suspended: suspended.rows[0]?.active };
      });
      expect(activeCheck.own).toBe(true);
      expect(activeCheck.suspended).toBe(false);

      const resolved = await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE iptv_app`.execute(trx);
        const result = await sql<{
          membership_id: string;
          base_role_key: string;
          extra_role_keys: string[];
        }>`select * from control.resolve_membership_roles(${userId}::uuid, ${tenantA}::uuid)`.execute(trx);
        return result.rows;
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.membership_id).toBe(membershipId);
      expect(resolved[0]?.base_role_key).toBe("tenant_owner");
      expect(resolved[0]?.extra_role_keys).toContain("tenant_admin");

      // Direct reads stay fail-closed without context, even though rows exist.
      const directWithoutContext = await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE iptv_app`.execute(trx);
        const memberships = await trx.selectFrom("control.tenant_memberships").select("id").execute();
        const bindings = await trx.selectFrom("control.membership_roles").select("id").execute();
        return { memberships: memberships.length, bindings: bindings.length };
      });
      expect(directWithoutContext).toEqual({ memberships: 0, bindings: 0 });
    } finally {
      // Owner connection: bypasses RLS, so cleanup sees every fixture row.
      await db.deleteFrom("control.auth_sessions").where("user_id", "=", userId).execute();
      await db.deleteFrom("control.membership_roles").where("tenant_id", "=", tenantA).execute();
      await db.deleteFrom("control.membership_roles").where("tenant_id", "=", tenantB).execute();
      await db.deleteFrom("control.tenant_memberships").where("user_id", "=", userId).execute();
      await db.deleteFrom("control.users").where("id", "=", userId).execute();
    }
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