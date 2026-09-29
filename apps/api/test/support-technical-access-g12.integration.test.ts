import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { CommandBus } from "../src/commands/command-bus.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(-12)}@example.com`;
}

const PERMISSIONS = [
  "crm.lead.write",
  "trial.read",
  "trial.write",
  "support.ticket.read",
  "support.ticket.write",
  "support.incident.write",
];

describe.skipIf(!hasDb)("G12 technical access for ex-customer (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let bus: CommandBus;

  function actor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: PERMISSIONS,
      actorType: "human",
    };
  }

  function injectRaw(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    revision?: string | null;
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      if (opts.revision !== null && headers["x-tenant-context-revision"] === undefined) {
        headers["x-tenant-context-revision"] = opts.revision ?? "0";
      }
    }
    const options: {
      method: "GET" | "POST";
      url: string;
      headers: Record<string, string>;
      payload?: Record<string, unknown>;
    } = { method: opts.method, url: opts.url, headers };
    if (opts.payload !== undefined) {
      options.payload = opts.payload;
    }
    return app.getHttpAdapter().getInstance().inject(options);
  }

  async function ok<T>(result: { ok: boolean; data?: T; message?: string }, what: string): Promise<T> {
    if (!result.ok) {
      throw new Error(`${what} failed: ${(result as { message: string }).message}`);
    }
    return (result as { ok: true; data: T }).data;
  }

  async function makePerson(): Promise<string> {
    return (
      await ok<{ id: string }>(
        await bus.execute(actor(), "person.register", { canonicalName: "G12 Ex Customer" }),
        "person.register",
      )
    ).id;
  }

  async function trialCountForPerson(personId: string): Promise<number> {
    const rows = await db
      .selectFrom("trial.trials")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", personId)
      .execute();
    return rows.length;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["PROVIDER_OPS_ADAPTER"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("g12"), password: "correct-horse-12", tenantName: "G12 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("grants technical access on a ticket without creating a commercial trial", async () => {
    const personId = await makePerson();
    const opened = await ok<{ id: string; status: string }>(
      await bus.execute(actor(), "support.ticket.open", {
        personId,
        priority: "HIGH",
        summary: "Ex-cliente sem sinal apos retorno",
      }),
      "ticket.open",
    );
    const ticketId = opened.id;
    const reason = "ex-cliente com falha tecnica apos retorno, acesso temporario para diagnostico";

    const missingTicket = await bus.execute(actor(), "support.technical_access.grant", {
      personId,
      ticketId: newId(),
      reason,
      durationMinutes: 180,
    });
    expect(missingTicket.ok).toBe(false);

    const missingReason = await bus.execute(actor(), "support.technical_access.grant", {
      personId,
      ticketId,
      reason: "   ",
      durationMinutes: 180,
    });
    expect(missingReason.ok).toBe(false);
    if (!missingReason.ok) {
      expect(missingReason.code).toBe("validation_failed");
    }

    const otherPerson = await makePerson();
    const mismatched = await bus.execute(actor(), "support.technical_access.grant", {
      personId: otherPerson,
      ticketId,
      reason,
      durationMinutes: 180,
    });
    expect(mismatched.ok).toBe(false);

    const granted = await ok<{
      id: string;
      status: string;
      personId: string;
      ticketId: string;
      expiresAt: string;
    }>(
      await bus.execute(actor(), "support.technical_access.grant", {
        personId,
        ticketId,
        reason,
        durationMinutes: 180,
      }),
      "technical_access.grant",
    );
    expect(granted.status).toBe("ACTIVE");
    expect(granted.personId).toBe(personId);
    expect(granted.ticketId).toBe(ticketId);
    expect(new Date(granted.expiresAt).getTime()).toBeGreaterThan(Date.now());

    expect(await trialCountForPerson(personId)).toBe(0);

    const stored = await db
      .selectFrom("support.technical_access_grants")
      .select(["id", "person_id", "support_ticket_id", "reason", "status", "expires_at"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", granted.id)
      .executeTakeFirst();
    expect(stored).toBeDefined();
    expect(stored?.person_id).toBe(personId);
    expect(stored?.support_ticket_id).toBe(ticketId);
    expect(stored?.reason).toBe(reason);
    expect(stored?.status).toBe("ACTIVE");

    const events = await db
      .selectFrom("platform.domain_events")
      .select(["event_type"])
      .where("tenant_id", "=", tenantId)
      .where("aggregate_id", "=", granted.id)
      .execute();
    expect(events.filter((e) => e.event_type.startsWith("trial."))).toHaveLength(0);

    const fetched = await injectRaw({ method: "GET", url: `/v1/technical-access/${granted.id}`, token });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<{ ticketId: string; reason: string; status: string }>()).toMatchObject({
      ticketId,
      reason,
      status: "ACTIVE",
    });

    const listed = await injectRaw({
      method: "GET",
      url: `/v1/technical-access?personId=${personId}`,
      token,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json<{ grants: Array<{ id: string }> }>().grants.map((g) => g.id),
    ).toContain(granted.id);
  });
});
