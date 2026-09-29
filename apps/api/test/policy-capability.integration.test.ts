import { join, dirname } from "node:path";
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
import { PolicyResolver, KyselyPolicyRepository } from "../src/policy/policy-resolver.js";
import { ActionGate, KyselyCapabilityStore } from "../src/capabilities/capability-registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

describe.skipIf(!hasDb)("policy + capability foundations (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  const user = { email: email("w1-pol"), password: "correct-horse-8" };
  let token = "";
  let tenantId = "";
  let userId = "";

  let bus: CommandBus;
  let gate: ActionGate;
  let store: KyselyCapabilityStore;

  // Unique per run: the integration DB is shared across suite runs, so fixed
  // keys would collide with rows from previous runs. Use the RANDOM tail of
  // the uuidv7 (the leading hex chars are timestamp bits — constant for days).
  const suffix = () => newId().replace(/-/g, "").slice(-12);
  const FAMILY = `w1-demo-family-${suffix()}`;
  const CAP_KEY = `w1.demo.${suffix()}.action`;

  function ownerActor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: [
        "crm.person.read",
        "crm.lead.write",
        "conversation.reply",
        "settings.manage",
        "tenant.member.manage",
        "billing.read",
        "audit.read",
        "support.ticket.write",
        "agent.review.request",
        "agent.review.decide",
      ],
      actorType: "human",
    };
  }

  function platformActor(): CommandActor {
    return { ...ownerActor(), isPlatformAdmin: true, roleKeys: ["platform_admin"] };
  }

  /** Actor without `billing.read` (proves UNAVAILABLE denies before permission checks). */
  function unprivilegedActor(): CommandActor {
    return {
      ...ownerActor(),
      permissions: ["crm.person.read"],
      roleKeys: ["tenant_operator"],
    };
  }

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    /** Tenant-context precondition; defaults to "0" with a token, `null` omits it. */
    revision?: string | null;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      if (opts.revision !== null) {
        headers["x-tenant-context-revision"] = opts.revision ?? "0";
      }
    }
    if (opts.idempotencyKey !== undefined) {
      headers["idempotency-key"] = opts.idempotencyKey;
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

  async function setPlatformAdmin(on: boolean): Promise<void> {
    await db.updateTable("control.users").set({ is_platform_admin: on }).where("id", "=", userId).execute();
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    gate = new ActionGate(new PolicyResolver(new KyselyPolicyRepository(db)));
    store = new KyselyCapabilityStore(db);

    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: user.email, password: user.password, tenantName: "Policy Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it("publishes platform + tenant policies and resolves with precedence", async () => {
    await setPlatformAdmin(true);
    try {
      const invariant = await inject({
        method: "POST",
        url: "/v1/policies/publish",
        token,
        payload: {
          family: FAMILY,
          scope: "PLATFORM",
          class: "PLATFORM_INVARIANT",
          document: { max_autonomy: "APPROVAL" },
        },
      });
      expect(invariant.statusCode).toBe(201);
      const platform = await inject({
        method: "POST",
        url: "/v1/policies/publish",
        token,
        payload: {
          family: FAMILY,
          scope: "PLATFORM",
          class: "PLATFORM_POLICY",
          document: { autonomy: "AUTO", platform_note: "pilot" },
        },
      });
      expect(platform.statusCode).toBe(201);
    } finally {
      await setPlatformAdmin(false);
    }
    const tenant = await inject({
      method: "POST",
      url: "/v1/policies/publish",
      token,
      payload: {
        family: FAMILY,
        scope: "TENANT",
        class: "TENANT_POLICY",
        document: { autonomy: "AUTO", tenant_note: "tenant" },
      },
    });
    expect(tenant.statusCode).toBe(201);
    expect(tenant.json<{ version: number }>().version).toBe(1);

    // Scope/class mismatch is rejected without writing.
    const mismatch = await inject({
      method: "POST",
      url: "/v1/policies/publish",
      token,
      payload: { family: FAMILY, scope: "TENANT", class: "PLATFORM_POLICY", document: {} },
    });
    expect(mismatch.statusCode).toBe(400);

    const registered = await bus.execute<{ key: string }>(platformActor(), "capability.register", {
      key: CAP_KEY,
      ownerContext: "demo",
      policyFamily: FAMILY,
      permissions: ["billing.read"],
    });
    expect(registered.ok).toBe(true);

    // Tenant asks AUTO; the invariant max clamps to APPROVAL.
    const resolved = await inject({ method: "GET", url: `/v1/capabilities/${CAP_KEY}/resolve`, token });
    expect(resolved.statusCode).toBe(200);
    const body = resolved.json<{
      key: string;
      action: string;
      degraded: boolean;
      reason: string;
      provenance: Array<{ source: string; ref: string }>;
    }>();
    expect(body).toMatchObject({ key: CAP_KEY, action: "APPROVAL", degraded: false });
    expect(body.provenance.map((s) => s.source)).toEqual([
      "PLATFORM_INVARIANT",
      "PLATFORM_POLICY",
      "TENANT_POLICY",
    ]);
  });

  it("lists capabilities tenant-scoped with an allowed-actions overview", async () => {
    const listed = await inject({ method: "GET", url: "/v1/capabilities", token });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json<{ capabilities: Array<{ key: string; action: string; degraded: boolean }> }>().capabilities;
    const found = rows.find((r) => r.key === CAP_KEY);
    expect(found).toMatchObject({ key: CAP_KEY, action: "APPROVAL", degraded: false });
  });

  it("denies UNAVAILABLE before the permission check and flags DEGRADED", async () => {
    const down = await bus.execute(platformActor(), "capability.set_availability", {
      key: CAP_KEY,
      availability: "UNAVAILABLE",
      reason: "provider outage",
    });
    expect(down.ok).toBe(true);

    // Even an actor WITHOUT the capability permission gets `unavailable`
    // (not `forbidden`): availability is evaluated first.
    const cap = await store.get(CAP_KEY);
    const denied = await gate.resolve(
      cap,
      { userId, isPlatformAdmin: false, tenantId, permissions: ["crm.person.read"] },
      { tenantId },
    );
    expect(denied).toMatchObject({ action: "DENY", reason: "unavailable", degraded: false });

    const httpDenied = await inject({ method: "GET", url: `/v1/capabilities/${CAP_KEY}/resolve`, token });
    expect(httpDenied.statusCode).toBe(200);
    expect(httpDenied.json<{ action: string; reason: string }>().action).toBe("DENY");

    const degraded = await bus.execute(platformActor(), "capability.set_availability", {
      key: CAP_KEY,
      availability: "DEGRADED",
      reason: "provider latency",
    });
    expect(degraded.ok).toBe(true);
    const flagged = await gate.resolve(cap && { ...cap, availability: "DEGRADED" }, unprivilegedActor(), {
      tenantId,
    });
    // Unprivileged actor lacks billing.read → forbidden, but still flagged degraded.
    expect(flagged).toMatchObject({ action: "DENY", reason: "forbidden", degraded: true });
    const httpFlagged = await inject({ method: "GET", url: `/v1/capabilities/${CAP_KEY}/resolve`, token });
    expect(httpFlagged.json<{ action: string; degraded: boolean }>()["degraded"]).toBe(true);

    const up = await bus.execute(platformActor(), "capability.set_availability", {
      key: CAP_KEY,
      availability: "AVAILABLE",
      reason: "recovered",
    });
    expect(up.ok).toBe(true);
  });

  it("treats published documents and capability events as append-only", async () => {
    const published = await db
      .selectFrom("platform.policy_documents")
      .select(["id"])
      .where("family", "=", FAMILY)
      .where("status", "=", "PUBLISHED")
      .limit(1)
      .executeTakeFirstOrThrow();
    await expect(
      db.updateTable("platform.policy_documents").set({ document: {} }).where("id", "=", published.id).execute(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.deleteFrom("platform.policy_documents").where("id", "=", published.id).execute(),
    ).rejects.toThrow(/immutable/);
    const event = await db
      .selectFrom("platform.capability_events")
      .select(["id"])
      .where("capability_key", "=", CAP_KEY)
      .limit(1)
      .executeTakeFirstOrThrow();
    await expect(
      db.updateTable("platform.capability_events").set({ reason: "rewrite" }).where("id", "=", event.id).execute(),
    ).rejects.toThrow(/append-only/);
    // History is preserved: three published versions + three availability events.
    const docs = await db
      .selectFrom("platform.policy_documents")
      .select(["version"])
      .where("family", "=", FAMILY)
      .where("status", "=", "PUBLISHED")
      .execute();
    expect(docs).toHaveLength(3);
    const events = await db
      .selectFrom("platform.capability_events")
      .select(["to_availability"])
      .where("capability_key", "=", CAP_KEY)
      .orderBy("occurred_at", "asc")
      .execute();
    expect(events.map((e) => e.to_availability)).toEqual(["UNAVAILABLE", "DEGRADED", "AVAILABLE"]);
  });
});
