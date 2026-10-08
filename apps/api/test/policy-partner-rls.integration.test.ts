import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { applyMigrations, createDb, withTenantTransaction } from "@iptv/database";
import type { Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { KyselyCommandDb } from "../src/commands/kysely-command-db.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { KyselyPolicyRepository, PolicyResolver } from "../src/policy/policy-resolver.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function withAppIdentity(base: string, password: string): string {
  const url = new URL(base);
  url.username = "iptv_app";
  url.password = password;
  return url.toString();
}

/**
 * WHAT IS PROVEN HERE (effective `iptv_app` pool, migrations 001-053 fresh):
 *
 * - FIX 2 (MEDIUM PARTNER): a platform admin in tenant A context publishes a
 *   PARTNER document targeting tenant B (`partnerTenantId` != context) --
 *   accepted with version+1 across publishes (the version counter and the
 *   insert run scoped to the TARGET tenant; pre-fix this threw 42501 under
 *   RLS). Resolution with the named partner (`listPublished(family, A, B)`)
 *   layers B's PARTNER document -- pre-fix the layer was silently dropped.
 * - Validation stays explicit: non-admin PARTNER publish => forbidden;
 *   `partnerTenantId` outside PARTNER scope => validation_failed.
 * - No generic cross-tenant opening: resolving WITHOUT the partner names
 *   nothing, and a direct cross-tenant SELECT under tenant A context still
 *   returns 0 rows (RLS).
 */
describe.skipIf(!hasDb)("Policy PARTNER narrow path under iptv_app (requires TEST_DATABASE_URL)", () => {
  let adminDb: Kysely<Database>;
  let databaseName = "";
  let ownerDb: Kysely<Database>;
  let appDb: Kysely<Database>;
  let bus: CommandBus;
  let resolver: PolicyResolver;

  let tenantA = "";
  let tenantB = "";
  const family = `partner-rls-${newId().replace(/-/g, "").slice(-12)}`;

  function platformAdmin(): CommandActor {
    return {
      userId: newId(),
      isPlatformAdmin: true,
      tenantId: tenantA,
      roleKeys: [],
      permissions: [],
      actorType: "human",
    };
  }

  function tenantAdmin(): CommandActor {
    return {
      userId: newId(),
      isPlatformAdmin: false,
      tenantId: tenantA,
      roleKeys: ["tenant_admin"],
      permissions: ["settings.manage"],
      actorType: "human",
    };
  }

  beforeAll(async () => {
    const base = connectionString as string;
    adminDb = createDb({ connectionString: withDatabase(base, "postgres") });
    databaseName = `p12_fix1_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(databaseName)) {
      throw new Error("unsafe generated scratch database name");
    }
    await sql.raw(`CREATE DATABASE "${databaseName}"`).execute(adminDb);
    const dedicatedUrl = withDatabase(base, databaseName);
    await applyMigrations(dedicatedUrl, { migrationsDir: MIGRATIONS_DIR });
    ownerDb = createDb({ connectionString: dedicatedUrl });
    const appPassword = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    if (!/^[0-9a-f]{16,}$/.test(appPassword)) {
      throw new Error("unsafe generated app password");
    }
    await sql.raw(`ALTER ROLE iptv_app WITH LOGIN PASSWORD '${appPassword}'`).execute(ownerDb);
    appDb = createDb({ connectionString: withAppIdentity(dedicatedUrl, appPassword) });

    tenantA = newId();
    tenantB = newId();
    await ownerDb
      .insertInto("control.tenants")
      .values([
        {
          id: tenantA,
          slug: `p12-a-${tenantA.replace(/-/g, "").slice(-8)}`,
          name: "P12 Tenant A",
          status: "ACTIVE",
          default_currency: "BRL",
          timezone: "America/Sao_Paulo",
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: tenantB,
          slug: `p12-b-${tenantB.replace(/-/g, "").slice(-8)}`,
          name: "P12 Tenant B",
          status: "ACTIVE",
          default_currency: "BRL",
          timezone: "America/Sao_Paulo",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ])
      .execute();

    bus = new CommandBus(new KyselyCommandDb(appDb));
    registerPolicyCommands(bus);
    resolver = new PolicyResolver(new KyselyPolicyRepository(appDb));
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy().catch(() => undefined);
    if (ownerDb !== undefined) {
      await sql
        .raw("ALTER ROLE iptv_app WITH PASSWORD NULL")
        .execute(ownerDb)
        .catch(() => undefined);
      await ownerDb.destroy().catch(() => undefined);
    }
    if (adminDb !== undefined && databaseName !== "") {
      await sql
        .raw(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
        .execute(adminDb)
        .catch(() => undefined);
      await adminDb.destroy().catch(() => undefined);
    }
  });

  it("platform admin publishes PARTNER for another tenant with version+1", async () => {
    const first = await bus.execute<{ id: string; version: number }>(platformAdmin(), "policy.publish", {
      family,
      scope: "PARTNER",
      class: "PARTNER_POLICY",
      document: { partner: true, autonomy: "AUTO" },
      partnerTenantId: tenantB,
    });
    expect(first).toEqual({ ok: true, data: { id: expect.any(String), version: 1 } });
    const second = await bus.execute<{ id: string; version: number }>(platformAdmin(), "policy.publish", {
      family,
      scope: "PARTNER",
      class: "PARTNER_POLICY",
      document: { partner: true, autonomy: "APPROVAL" },
      partnerTenantId: tenantB,
    });
    expect(second).toEqual({ ok: true, data: { id: expect.any(String), version: 2 } });
  });

  it("rejects PARTNER publish for non-admins and partnerTenantId outside PARTNER scope", async () => {
    const forbidden = await bus.execute(tenantAdmin(), "policy.publish", {
      family,
      scope: "PARTNER",
      class: "PARTNER_POLICY",
      document: {},
      partnerTenantId: tenantB,
    });
    expect(forbidden.ok ? null : forbidden.code).toBe("forbidden");
    const misScoped = await bus.execute(platformAdmin(), "policy.publish", {
      family,
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: {},
      partnerTenantId: tenantB,
    });
    expect(misScoped.ok ? null : misScoped.code).toBe("validation_failed");
  });

  it("resolves the named partner layer, and nothing without the partner", async () => {
    const withPartner = await resolver.resolve(family, { tenantId: tenantA, partnerId: tenantB });
    expect(withPartner.configured).toBe(true);
    expect(withPartner.value).toMatchObject({ partner: true });
    expect(withPartner.provenance.map((s) => s.source)).toContain("PARTNER_POLICY");

    const withoutPartner = await resolver.resolve(family, { tenantId: tenantA });
    expect(withoutPartner.configured).toBe(false);

    const cross = await withTenantTransaction(appDb, tenantA, async (trx) =>
      trx
        .selectFrom("platform.policy_documents")
        .select("id")
        .where("family", "=", family)
        .where("tenant_id", "=", tenantB)
        .execute(),
    );
    expect(cross).toHaveLength(0);
  });
});
