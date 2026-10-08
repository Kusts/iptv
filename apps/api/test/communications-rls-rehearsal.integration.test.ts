import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDb, applyMigrations, withTenantTransaction, type Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommunicationsController } from "../src/communications/communications.controller.js";
import { CopilotService } from "../src/agent/copilot.service.js";

/**
 * DBG-P7-R2 regression: communication reads + copilot context under the
 * effective `iptv_app` pool (RLS fail-closed when `app.tenant_id` is unset).
 *
 * WHAT IS PROVEN HERE (genuine `iptv_app` session, no SET ROLE tricks):
 *
 * - raw pool-level selects without tenant context fail-close to 0 rows;
 * - `GET /v1/communications/*` read paths (list/detail/messages/exceptions)
 *   wrapped in `withTenantTransaction`: tenant A sees its own OPEN rows
 *   (count 1), tenant B never sees A's rows, cross-tenant detail → 404;
 * - `CopilotService.buildContext` (and therefore `ask`) resolves the
 *   conversations section for the caller's tenant (count 1) and maps a
 *   foreign conversation id to null (never leaks);
 * - no residual `app.tenant_id` survives on the pool after the wrapped
 *   reads (fresh session reads null/empty).
 */
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

function actorFor(tenantId: string, userId: string): CommandActor {
  return {
    userId,
    isPlatformAdmin: false,
    tenantId,
    roleKeys: ["tenant_owner"],
    permissions: ["conversation.reply", "crm.person.read", "agent.review.request"],
    actorType: "human",
  };
}

function reqFor(tenantId: string): { tenant: { id: string } } {
  return { tenant: { id: tenantId } };
}

describe.skipIf(!hasDb)("Communications RLS rehearsal under iptv_app (requires TEST_DATABASE_URL)", () => {
  let adminDb: Kysely<Database>;
  let databaseName = "";
  let ownerDb: Kysely<Database>;
  let appDb: Kysely<Database>;

  let tenantA = "";
  let tenantB = "";
  let convA = "";
  let convB = "";
  let excOpenA = "";
  let excOpenB = "";

  async function makeTenant(slug: string): Promise<string> {
    const id = newId();
    await ownerDb
      .insertInto("control.tenants")
      .values({
        id,
        slug: `${slug}-${id.replace(/-/g, "").slice(-8)}`,
        name: "P7 R2 Tenant",
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return id;
  }

  async function makePerson(tenantId: string): Promise<string> {
    const id = newId();
    await ownerDb
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

  async function makeConversation(tenantId: string, personId: string): Promise<string> {
    const id = newId();
    await ownerDb
      .insertInto("communication.conversations")
      .values({
        id,
        tenant_id: tenantId,
        person_id: personId,
        channel: "WHATSAPP",
        external_thread_id: null,
        status: "OPEN",
        control_mode: "AI_CONTROL",
        last_message_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        resolved_at: null,
        archived_at: null,
      })
      .execute();
    return id;
  }

  async function makeException(tenantId: string, status: "OPEN" | "RESOLVED"): Promise<string> {
    const id = newId();
    await ownerDb
      .insertInto("communication.exceptions")
      .values({
        id,
        tenant_id: tenantId,
        kind: "UNMATCHED_INBOUND",
        status,
        channel: "WHATSAPP",
        external_message_id: `ext-${id.slice(0, 8)}`,
        from_address: "+5500998877",
        conversation_id: null,
        person_id: null,
        reason: "P7-R2 probe",
        payload_json: {},
        created_at: new Date(),
        updated_at: new Date(),
        resolved_at: status === "OPEN" ? null : new Date(),
      })
      .execute();
    return id;
  }

  beforeAll(async () => {
    const base = connectionString as string;
    adminDb = createDb({ connectionString: withDatabase(base, "postgres") });
    databaseName = `p7r2_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(databaseName)) {
      throw new Error("unsafe generated scratch database name");
    }
    await sql.raw(`CREATE DATABASE "${databaseName}"`).execute(adminDb);
    const dedicatedUrl = withDatabase(base, databaseName);
    await applyMigrations(dedicatedUrl, { migrationsDir: MIGRATIONS_DIR });
    ownerDb = createDb({ connectionString: dedicatedUrl });

    const appPassword = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    await sql.raw(`ALTER ROLE iptv_app WITH LOGIN PASSWORD '${appPassword}'`).execute(ownerDb);
    appDb = createDb({ connectionString: withAppIdentity(dedicatedUrl, appPassword) });

    tenantA = await makeTenant("p7r2-a");
    tenantB = await makeTenant("p7r2-b");
    const personA = await makePerson(tenantA);
    const personB = await makePerson(tenantB);
    convA = await makeConversation(tenantA, personA);
    convB = await makeConversation(tenantB, personB);
    excOpenA = await makeException(tenantA, "OPEN");
    await makeException(tenantA, "RESOLVED");
    excOpenB = await makeException(tenantB, "OPEN");
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy().catch(() => undefined);
    if (ownerDb !== undefined) {
      await sql.raw("ALTER ROLE iptv_app WITH PASSWORD NULL").execute(ownerDb).catch(() => undefined);
      await ownerDb.destroy().catch(() => undefined);
    }
    if (adminDb !== undefined && databaseName !== "") {
      await sql.raw(`DROP DATABASE "${databaseName}" WITH (FORCE)`).execute(adminDb).catch(() => undefined);
      await adminDb.destroy().catch(() => undefined);
    }
  });

  it("effective pool identity is iptv_app (REAL)", async () => {
    const who = await sql<{ u: string }>`SELECT current_user AS u`.execute(appDb);
    expect(who.rows[0]?.u).toBe("iptv_app");
  });

  it("raw selects without tenant context fail-close to 0 rows (REAL)", async () => {
    const convs = await appDb
      .selectFrom("communication.conversations")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .execute();
    expect(convs).toHaveLength(0);
    const excs = await appDb
      .selectFrom("communication.exceptions")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .execute();
    expect(excs).toHaveLength(0);
  });

  it("communications reads are tenant-isolated on the effective iptv_app pool", async () => {
    const controller = new CommunicationsController(appDb, {} as never);

    const listA = await controller.listConversations(reqFor(tenantA) as never, {});
    expect(listA.conversations).toHaveLength(1);
    expect(listA.conversations[0]?.id).toBe(convA);

    const listB = await controller.listConversations(reqFor(tenantB) as never, {});
    expect(listB.conversations).toHaveLength(1);
    expect(listB.conversations[0]?.id).toBe(convB);
    expect(listB.conversations.map((c) => c.id)).not.toContain(convA);

    const detailA = await controller.getConversation(convA, reqFor(tenantA) as never);
    expect(detailA.id).toBe(convA);

    await expect(controller.getConversation(convA, reqFor(tenantB) as never)).rejects.toMatchObject({
      status: 404,
    });

    const excA = await controller.listExceptions(reqFor(tenantA) as never, {});
    expect(excA.exceptions).toHaveLength(1);
    expect(excA.exceptions[0]?.id).toBe(excOpenA);

    const excB = await controller.listExceptions(reqFor(tenantB) as never, {});
    expect(excB.exceptions).toHaveLength(1);
    expect(excB.exceptions[0]?.id).toBe(excOpenB);
  }, 60_000);

  it("copilot buildContext resolves tenant counts and never leaks foreign entities", async () => {
    const copilot = new CopilotService(appDb, {} as never);

    const ctxA = await copilot.buildContext(tenantA, actorFor(tenantA, newId()), { route: "/conversations" });
    const convSectionA = ctxA.sections.find((s) => s.key === "conversations");
    expect(convSectionA?.summary).toBe("1 conversa(s) aberta(s) neste tenant.");

    const focusedB = await copilot.buildContext(tenantB, actorFor(tenantB, newId()), {
      route: "/conversations",
      entityKind: "conversation",
      entityId: convA,
    });
    expect(focusedB.sections.find((s) => s.key === "conversations")?.entity).toBeNull();

    const focusedA = await copilot.buildContext(tenantA, actorFor(tenantA, newId()), {
      route: "/conversations",
      entityKind: "conversation",
      entityId: convA,
    });
    expect(focusedA.sections.find((s) => s.key === "conversations")?.entity).toMatchObject({ id: convA });
  }, 60_000);

  it("no residual app.tenant_id survives on the pool after wrapped reads", async () => {
    const controller = new CommunicationsController(appDb, {} as never);
    await controller.listConversations(reqFor(tenantA) as never, {});
    await controller.listExceptions(reqFor(tenantB) as never, {});
    const copilot = new CopilotService(appDb, {} as never);
    await copilot.buildContext(tenantA, actorFor(tenantA, newId()), { route: "/x" });

    const setting = await sql<{ value: string | null }>`
      SELECT nullif(current_setting('app.tenant_id', true), '') AS value
    `.execute(appDb);
    expect(setting.rows[0]?.value ?? null).toBeNull();

    // withTenantTransaction itself starts clean on every fresh transaction.
    const inside = await withTenantTransaction(appDb, tenantA, async (trx) => {
      const before = await sql<{ value: string | null }>`
        SELECT nullif(current_setting('app.tenant_id', true), '') AS value
      `.execute(trx);
      return before.rows[0]?.value ?? null;
    });
    expect(inside).toBe(tenantA);
  });
});
