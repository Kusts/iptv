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
  "support.ticket.read",
  "support.ticket.write",
  "experiments.read",
  "experiments.write",
];

const VARIANTS = [
  { key: "control", weightBps: 5000 },
  { key: "treatment", weightBps: 5000 },
];

describe.skipIf(!hasDb)("Wave 16 Experiments instrumentation (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let otherToken = "";
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

  function otherActor(): CommandActor {
    return { ...actor(), tenantId: otherTenantId, permissions: PERMISSIONS };
  }
  let otherTenantId = "";

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

  async function eventTypesFor(aggregateId: string): Promise<string[]> {
    const rows = await db
      .selectFrom("platform.domain_events")
      .select("event_type")
      .where("aggregate_id", "=", aggregateId)
      .execute();
    return rows.map((r) => r.event_type);
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w16"), password: "correct-horse-16", tenantName: "Wave16 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;

    const other = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w16other"), password: "correct-horse-16", tenantName: "Wave16 Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherBody = other.json<{ token: string; activeTenantId: string }>();
    otherToken = otherBody.token;
    otherTenantId = otherBody.activeTenantId;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("creates experiments as DRAFT and rejects duplicate keys per tenant", async () => {
    const created = await ok<{ id: string; status: string }>(
      await bus.execute(actor(), "experiments.create", {
        key: "w16-checkout-copy",
        name: "Checkout copy test",
        hypothesis: "New copy lifts conversion.",
        variants: VARIANTS,
        primaryMetricRef: "REF-04",
        guardrailRefs: ["FIN-04"],
      }),
      "experiments.create",
    );
    expect(created.status).toBe("DRAFT");
    expect(await eventTypesFor(created.id)).toContain("experiment.created.v1");

    const duplicate = await bus.execute(actor(), "experiments.create", {
      key: "w16-checkout-copy",
      name: "Duplicate",
      variants: VARIANTS,
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.code).toBe("precondition_failed");
    }
  });

  it("starts experiments idempotently and assigns stably on replay", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "experiments.create", {
        key: "w16-assign-stable",
        name: "Stable assignment",
        variants: VARIANTS,
      }),
      "create",
    );
    const started = await ok<{ status: string }>(await bus.execute(actor(), "experiments.start", {
      experimentId: created.id,
    }), "start");
    expect(started.status).toBe("RUNNING");
    const restarted = await ok<{ status: string }>(await bus.execute(actor(), "experiments.start", {
      experimentId: created.id,
    }), "restart");
    expect(restarted.status).toBe("RUNNING");

    const first = await ok<{
      variant: string;
      persisted: boolean;
      fallback: boolean;
      assignmentId: string | null;
    }>(
      await bus.execute(actor(), "experiments.assign", {
        experimentId: created.id,
        subjectType: "PERSON",
        subjectId: "person-stable-1",
      }),
      "assign",
    );
    expect(first.persisted).toBe(true);
    expect(first.fallback).toBe(false);

    const replay = await ok<{ variant: string; assignmentId: string | null }>(
      await bus.execute(actor(), "experiments.assign", {
        experimentId: created.id,
        subjectType: "PERSON",
        subjectId: "person-stable-1",
      }),
      "assign replay",
    );
    expect(replay.variant).toBe(first.variant);
    expect(replay.assignmentId).toBe(first.assignmentId);
    const assignedEvents = (await eventTypesFor(first.assignmentId as string)).filter(
      (t) => t === "experiment.assigned.v1",
    );
    expect(assignedEvents).toHaveLength(1);
  });

  it("records exposures idempotently and gates the aggregate on minimum evidence", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "experiments.create", {
        key: "w16-exposure-idem",
        name: "Exposure idempotency",
        variants: VARIANTS,
      }),
      "create",
    );
    await ok(await bus.execute(actor(), "experiments.start", { experimentId: created.id }), "start");
    const assigned = await ok<{ assignmentId: string | null; variant: string }>(
      await bus.execute(actor(), "experiments.assign", {
        experimentId: created.id,
        subjectType: "PERSON",
        subjectId: "person-exposed-1",
      }),
      "assign",
    );

    const first = await ok<{ exposureId: string; already: boolean }>(
      await bus.execute(actor(), "experiments.record_exposure", {
        experimentId: created.id,
        subjectType: "PERSON",
        subjectId: "person-exposed-1",
        exposurePoint: "checkout.hero",
      }),
      "expose",
    );
    expect(first.already).toBe(false);
    const replay = await ok<{ exposureId: string; already: boolean }>(
      await bus.execute(actor(), "experiments.record_exposure", {
        experimentId: created.id,
        subjectType: "PERSON",
        subjectId: "person-exposed-1",
        exposurePoint: "checkout.hero",
      }),
      "expose replay",
    );
    expect(replay.exposureId).toBe(first.exposureId);
    expect(replay.already).toBe(true);
    const exposedEvents = (await eventTypesFor(assigned.assignmentId as string)).filter(
      (t) => t === "experiment.exposed.v1",
    );
    expect(exposedEvents).toHaveLength(1);

    // Default minimum (100 exposures): a single exposure is not evidence.
    const aggregate = await injectRaw({ method: "GET", url: `/v1/experiments/${created.id}/aggregate`, token });
    expect(aggregate.statusCode).toBe(200);
    const body = aggregate.json<{
      evidence: string;
      comparisons: null;
      totalExposures: number;
      byVariant: Array<{ variant: string; assignments: number; exposures: number }>;
    }>();
    expect(body.evidence).toBe("INSUFFICIENT_EVIDENCE");
    expect(body.comparisons).toBeNull();
    expect(body.totalExposures).toBe(1);
    expect(body.byVariant.find((c) => c.variant === assigned.variant)?.exposures).toBe(1);
  });

  it("answers READY_FOR_REVIEW past the minimum without inventing statistics", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "experiments.create", {
        key: "w16-ready",
        name: "Ready aggregate",
        variants: VARIANTS,
        minimumEvidenceExposures: 1,
      }),
      "create",
    );
    await ok(await bus.execute(actor(), "experiments.start", { experimentId: created.id }), "start");
    await ok(
      await bus.execute(actor(), "experiments.assign", {
        experimentId: created.id,
        subjectType: "PERSON",
        subjectId: "person-ready-1",
      }),
      "assign",
    );
    await ok(
      await bus.execute(actor(), "experiments.record_exposure", {
        experimentId: created.id,
        subjectType: "PERSON",
        subjectId: "person-ready-1",
        exposurePoint: "checkout.hero",
      }),
      "expose",
    );
    const aggregate = await injectRaw({ method: "GET", url: `/v1/experiments/${created.id}/aggregate`, token });
    expect(aggregate.statusCode).toBe(200);
    const body = aggregate.json<{ evidence: string; comparisons: null }>();
    expect(body.evidence).toBe("READY_FOR_REVIEW");
    expect(body.comparisons).toBeNull();
  });

  it("stop and complete are terminal: assign falls back to control afterwards", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "experiments.create", {
        key: "w16-stop-control",
        name: "Stop falls back",
        variants: VARIANTS,
      }),
      "create",
    );
    await ok(await bus.execute(actor(), "experiments.start", { experimentId: created.id }), "start");
    const stopped = await ok<{ status: string }>(
      await bus.execute(actor(), "experiments.stop", { experimentId: created.id, reason: "guardrail trip" }),
      "stop",
    );
    expect(stopped.status).toBe("STOPPED");
    expect(await eventTypesFor(created.id)).toContain("experiment.stopped.v1");

    const afterStop = await ok<{ variant: string; persisted: boolean; fallback: boolean }>(
      await bus.execute(actor(), "experiments.assign", {
        experimentId: created.id,
        subjectType: "PERSON",
        subjectId: "person-after-stop",
      }),
      "assign after stop",
    );
    expect(afterStop.variant).toBe("control");
    expect(afterStop.persisted).toBe(false);
    expect(afterStop.fallback).toBe(true);

    const second = await ok<{ id: string }>(
      await bus.execute(actor(), "experiments.create", {
        key: "w16-complete-control",
        name: "Complete falls back",
        variants: VARIANTS,
      }),
      "create",
    );
    await ok(await bus.execute(actor(), "experiments.start", { experimentId: second.id }), "start");
    const completed = await ok<{ status: string }>(
      await bus.execute(actor(), "experiments.complete", { experimentId: second.id }),
      "complete",
    );
    expect(completed.status).toBe("COMPLETED");
    expect(await eventTypesFor(second.id)).toContain("experiment.completed.v1");
    const afterComplete = await ok<{ variant: string; fallback: boolean }>(
      await bus.execute(actor(), "experiments.assign", {
        experimentId: second.id,
        subjectType: "PERSON",
        subjectId: "person-after-complete",
      }),
      "assign after complete",
    );
    expect(afterComplete.variant).toBe("control");
    expect(afterComplete.fallback).toBe(true);
  });

  it("fails open to control for unknown experiments and requires assignment for exposure", async () => {
    const fallback = await ok<{ variant: string; fallback: boolean }>(
      await bus.execute(actor(), "experiments.assign", {
        experimentId: newId(),
        subjectType: "PERSON",
        subjectId: "person-unknown-exp",
      }),
      "assign unknown",
    );
    expect(fallback.variant).toBe("control");
    expect(fallback.fallback).toBe(true);

    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "experiments.create", {
        key: "w16-exposure-guard",
        name: "Exposure guard",
        variants: VARIANTS,
      }),
      "create",
    );
    await ok(await bus.execute(actor(), "experiments.start", { experimentId: created.id }), "start");
    const unassigned = await bus.execute(actor(), "experiments.record_exposure", {
      experimentId: created.id,
      subjectType: "PERSON",
      subjectId: "person-never-assigned",
      exposurePoint: "checkout.hero",
    });
    expect(unassigned.ok).toBe(false);
    if (!unassigned.ok) {
      expect(unassigned.code).toBe("precondition_failed");
    }
  });

  it("isolates experiments per tenant", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "experiments.create", {
        key: "w16-tenant-iso",
        name: "Tenant isolation",
        variants: VARIANTS,
      }),
      "create",
    );
    const foreignGet = await injectRaw({ method: "GET", url: `/v1/experiments/${created.id}`, token: otherToken });
    expect(foreignGet.statusCode).toBe(404);
    const foreignAssign = await bus.execute<{ variant: string; fallback: boolean }>(otherActor(), "experiments.assign", {
      experimentId: created.id,
      subjectType: "PERSON",
      subjectId: "person-foreign",
    });
    // Cross-tenant assign sees nothing: fail-open control, no row leaked.
    expect(foreignAssign.ok).toBe(true);
    if (foreignAssign.ok) {
      expect(foreignAssign.data.fallback).toBe(true);
    }
    const foreignAggregate = await injectRaw({
      method: "GET",
      url: `/v1/experiments/${created.id}/aggregate`,
      token: otherToken,
    });
    expect(foreignAggregate.statusCode).toBe(404);
  });

  it("bridges feature flags to running experiments and defaults otherwise", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "experiments.create", {
        key: "w16-flag-bridge",
        name: "Flag bridge",
        variants: VARIANTS,
      }),
      "create",
    );
    await db
      .insertInto("control.feature_flags")
      .values({
        id: newId(),
        tenant_id: tenantId,
        flag_key: "w16.checkout.hero",
        enabled: false,
        config_json: JSON.stringify({ experimentKey: "w16-flag-bridge", experimentVariant: "treatment" }),
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    // DRAFT experiment: flag default wins (fail-open to the flag).
    const before = await injectRaw({
      method: "GET",
      url: "/v1/feature-flags/w16.checkout.hero/evaluate?subjectType=PERSON&subjectId=person-flag-1",
      token,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json<{ enabled: boolean; fallback: boolean }>().fallback).toBe(true);

    await ok(await bus.execute(actor(), "experiments.start", { experimentId: created.id }), "start");
    const assigned = await ok<{ variant: string }>(
      await bus.execute(actor(), "experiments.assign", {
        experimentId: created.id,
        subjectType: "PERSON",
        subjectId: "person-flag-1",
      }),
      "assign",
    );
    const evaluated = await injectRaw({
      method: "GET",
      url: "/v1/feature-flags/w16.checkout.hero/evaluate?subjectType=PERSON&subjectId=person-flag-1",
      token,
    });
    expect(evaluated.statusCode).toBe(200);
    const verdict = evaluated.json<{ enabled: boolean; source: string; variant: string; fallback: boolean }>();
    expect(verdict.source).toBe("experiment");
    expect(verdict.fallback).toBe(false);
    expect(verdict.variant).toBe(assigned.variant);
    expect(verdict.enabled).toBe(assigned.variant === "treatment");

    // Stopped experiment: back to the flag default, never stuck enabled.
    await ok(await bus.execute(actor(), "experiments.stop", { experimentId: created.id }), "stop");
    const after = await injectRaw({
      method: "GET",
      url: "/v1/feature-flags/w16.checkout.hero/evaluate?subjectType=PERSON&subjectId=person-flag-1",
      token,
    });
    expect(after.statusCode).toBe(200);
    expect(after.json<{ enabled: boolean; fallback: boolean }>()).toMatchObject({ enabled: false, fallback: true });

    // Plain flags without a bridge keep answering their stored value.
    await db
      .insertInto("control.feature_flags")
      .values({
        id: newId(),
        tenant_id: tenantId,
        flag_key: "w16.plain.flag",
        enabled: true,
        config_json: JSON.stringify({}),
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const plain = await injectRaw({
      method: "GET",
      url: "/v1/feature-flags/w16.plain.flag/evaluate",
      token,
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.json<{ enabled: boolean; source: string; fallback: boolean }>()).toMatchObject({
      enabled: true,
      source: "flag",
      fallback: false,
    });
  });

  it("keeps the sales-adjacent flow usable when experiments fail (F14)", async () => {
    // A failed experiment command leaves every other aggregate usable:
    // the support flow still opens tickets afterwards.
    const failed = await bus.execute(actor(), "experiments.start", { experimentId: newId() });
    expect(failed.ok).toBe(false);
    const personId = (
      await ok<{ id: string }>(
        await bus.execute(actor(), "person.register", { canonicalName: "W16 After Failure" }),
        "person after failure",
      )
    ).id;
    const ticket = await ok<{ id: string }>(
      await bus.execute(actor(), "support.ticket.open", { personId, priority: "NORMAL", summary: "Vendas seguem ok" }),
      "ticket after experiments failure",
    );
    expect(ticket.id).toBeTruthy();
  });
});
