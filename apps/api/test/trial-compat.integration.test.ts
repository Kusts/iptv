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
import { OutboxDrainer } from "../src/outbox/outbox-drainer.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

const PERMISSIONS = [
  "crm.person.read",
  "crm.lead.write",
  "trial.read",
  "trial.write",
  "provider.operation.read",
  "provider.operation.write",
  "agent.review.request",
  "agent.review.decide",
];

describe.skipIf(!hasDb)("Wave 4 Trials + Compatibility (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let bus: CommandBus;
  let drainer: OutboxDrainer;

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

  function inject(opts: { method: "GET" | "POST"; url: string; token?: string; payload?: Record<string, unknown> }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
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

  async function makePerson(): Promise<string> {
    const result = await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName: "Wave4 Person" });
    if (!result.ok) {
      throw new Error(`person.register failed: ${result.message}`);
    }
    return result.data.id;
  }

  async function requestTrial(personId: string, durationMinutes = 60): Promise<string> {
    const result = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
      personId,
      durationMinutes,
    });
    if (!result.ok || result.data.id === null) {
      throw new Error(`trial.request failed: ${JSON.stringify(result)}`);
    }
    return result.data.id;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["PROVIDER_OPS_ADAPTER"];
    delete process.env["PROVIDER_ECHO_OUTCOME"];
    delete process.env["PROVIDER_READBACK_EFFECT"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);

    const register = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w4"), password: "correct-horse-8", tenantName: "Wave4 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
  });

  afterAll(async () => {
    delete process.env["PROVIDER_READBACK_EFFECT"];
    if (hasDb && drainer !== undefined) {
      // Leave no PENDING outbox rows behind for sibling suites.
      await drainer.drain(1000).catch(() => undefined);
    }
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  it("happy path: request -> provisioning(echo) -> ACTIVE -> technical PASSED -> trust renewal -> ENDED", async () => {
    const personId = await makePerson();
    const trialId = await requestTrial(personId);

    const provisioned = await bus.execute<{ status: string; operationId: string }>(
      actor(),
      "trial.begin_provisioning",
      { trialId, adapter: "echo" },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "ACTIVE" } });

    const technical = await bus.execute(actor(), "trial.record_technical_result", {
      trialId,
      installationSuccess: true,
      authenticationSuccess: true,
      playbackSuccess: true,
      bufferingObserved: false,
      summaryOutcome: "PASSED",
    });
    expect(technical.ok).toBe(true);

    // The 60-minute trial expires well within the default 3-day threshold.
    const renewed = await bus.execute<{ expiresAt: string }>(actor(), "trial.apply_trust_renewal", { trialId });
    expect(renewed.ok).toBe(true);

    const got = await inject({ method: "GET", url: `/v1/trials/${trialId}`, token });
    expect(got.statusCode).toBe(200);
    const detail = got.json<{ lifecycleStatus: string; technicalOutcome: string; expiresAt: string }>();
    expect(detail.lifecycleStatus).toBe("ACTIVE");
    expect(detail.technicalOutcome).toBe("PASSED");
    expect(typeof detail.expiresAt).toBe("string");

    const tech = await inject({ method: "GET", url: `/v1/trials/${trialId}/technical-result`, token });
    expect(tech.statusCode).toBe(200);
    expect(tech.json<{ summaryOutcome: string }>().summaryOutcome).toBe("PASSED");

    const ended = await bus.execute<{ status: string }>(actor(), "trial.end", { trialId });
    expect(ended).toMatchObject({ ok: true, data: { status: "ENDED" } });
  });

  it("retrial after INVALIDATED goes through human review, then provisions", async () => {
    const personId = await makePerson();
    const trialId = await requestTrial(personId);
    await bus.execute(actor(), "trial.begin_provisioning", { trialId, adapter: "echo" });
    const invalidated = await bus.execute(actor(), "trial.invalidate", {
      trialId,
      reason: "unusable on customer device",
    });
    expect(invalidated.ok).toBe(true);

    const parked = await bus.execute<{ id: string | null; status: string; reviewRequestId?: string }>(
      actor(),
      "trial.request_retrial",
      { previousTrialId: trialId, reason: "incident fixed, customer asked again" },
    );
    expect(parked).toMatchObject({ ok: true, data: { status: "PENDING_REVIEW" } });
    if (!parked.ok || parked.data.reviewRequestId === undefined) {
      throw new Error("expected a review request");
    }
    const approved = await bus.execute(actor(), "human_review.approve", {
      requestId: parked.data.reviewRequestId,
    });
    expect(approved.ok).toBe(true);

    const retrial = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request_retrial", {
      previousTrialId: trialId,
      reason: "incident fixed, customer asked again",
      approvedReviewId: parked.data.reviewRequestId,
    });
    expect(retrial).toMatchObject({ ok: true, data: { status: "REQUESTED" } });
    if (!retrial.ok || retrial.data.id === null) {
      throw new Error("expected a retrial id");
    }
    const provisioned = await bus.execute<{ status: string }>(actor(), "trial.begin_provisioning", {
      trialId: retrial.data.id,
      adapter: "echo",
    });
    expect(provisioned).toMatchObject({ ok: true, data: { status: "ACTIVE" } });
  });

  it("HUMAN_REQUIRED provisioning resolves to ACTIVE via the provider operator path", async () => {
    const personId = await makePerson();
    const trialId = await requestTrial(personId);
    const provisioned = await bus.execute<{ status: string; operationId: string }>(
      actor(),
      "trial.begin_provisioning",
      { trialId, adapter: "manual" },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING" } });
    if (!provisioned.ok) {
      throw new Error("expected provisioning to park");
    }
    const opId = provisioned.data.operationId;

    const op = await inject({ method: "GET", url: `/v1/provider/operations/${opId}`, token });
    expect(op.statusCode).toBe(200);
    expect(op.json<{ status: string; effectCertainty: string }>().status).toBe("HUMAN_REQUIRED");

    const resolved = await inject({
      method: "POST",
      url: `/v1/provider/operations/${opId}/resolve`,
      token,
      payload: { outcome: "SUCCEEDED", note: "created by hand in the portal" },
    });
    expect(resolved.statusCode).toBe(201);
    expect(resolved.json<{ status: string; resumedTrial: boolean }>().resumedTrial).toBe(true);

    const got = await inject({ method: "GET", url: `/v1/trials/${trialId}`, token });
    expect(got.json<{ lifecycleStatus: string }>().lifecycleStatus).toBe("ACTIVE");
  });

  it("UNKNOWN effect reconciles without blind retry (both readback answers)", async () => {
    const personId = await makePerson();
    const trialId = await requestTrial(personId);
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId,
      adapter: "echo",
      echoOutcome: "unknown",
    });
    if (!provisioned.ok) {
      throw new Error("expected VERIFYING park");
    }
    const opId = provisioned.data.operationId;

    process.env["PROVIDER_READBACK_EFFECT"] = "NOT_APPLIED";
    const reconciled = await bus.execute<{ status: string; effectApplied: boolean }>(actor(), "provider.reconcile", {
      operationId: opId,
    });
    expect(reconciled).toMatchObject({ ok: true, data: { status: "FAILED", effectApplied: false } });
    const backToRequested = await inject({ method: "GET", url: `/v1/trials/${trialId}`, token });
    expect(backToRequested.json<{ lifecycleStatus: string }>().lifecycleStatus).toBe("REQUESTED");

    const personId2 = await makePerson();
    const trialId2 = await requestTrial(personId2);
    const parked2 = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId: trialId2,
      adapter: "echo",
      echoOutcome: "unknown",
    });
    if (!parked2.ok) {
      throw new Error("expected VERIFYING park");
    }
    process.env["PROVIDER_READBACK_EFFECT"] = "APPLIED";
    const reconciled2 = await bus.execute<{ status: string }>(actor(), "provider.reconcile", {
      operationId: parked2.data.operationId,
    });
    expect(reconciled2).toMatchObject({ ok: true, data: { status: "SUCCEEDED" } });
    const active = await inject({ method: "GET", url: `/v1/trials/${trialId2}`, token });
    expect(active.json<{ lifecycleStatus: string }>().lifecycleStatus).toBe("ACTIVE");
    delete process.env["PROVIDER_READBACK_EFFECT"];
  });

  it("trust renewal boundary: 4 days denied, 3 days allowed", async () => {
    const personId = await makePerson();
    const trialId = await requestTrial(personId);
    await bus.execute(actor(), "trial.begin_provisioning", { trialId, adapter: "echo" });

    // Test seam: move the expiration directly; the command only reads it.
    await db
      .updateTable("trial.trials")
      .set({ expires_at: new Date(Date.now() + 4 * 86_400_000) })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", trialId)
      .execute();
    const denied = await inject({ method: "POST", url: `/v1/trials/${trialId}/trust-renewal`, token, payload: {} });
    expect(denied.statusCode).toBe(403);

    await db
      .updateTable("trial.trials")
      .set({ expires_at: new Date(Date.now() + 3 * 86_400_000) })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", trialId)
      .execute();
    const allowed = await inject({ method: "POST", url: `/v1/trials/${trialId}/trust-renewal`, token, payload: {} });
    expect(allowed.statusCode).toBe(201);
    expect(typeof allowed.json<{ expiresAt: string }>().expiresAt).toBe("string");
  });

  it("rejects a second primary trial with 409 and keeps tenants isolated", async () => {
    const personId = await makePerson();
    const trialId = await requestTrial(personId);

    const duplicate = await inject({
      method: "POST",
      url: "/v1/trials/request",
      token,
      payload: { personId, durationMinutes: 60 },
    });
    expect(duplicate.statusCode).toBe(409);

    const stranger = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w4-stranger"), password: "correct-horse-8", tenantName: "Wave4 Stranger" },
    });
    expect(stranger.statusCode).toBe(201);
    const strangerToken = stranger.json<{ token: string }>().token;
    const foreign = await inject({ method: "GET", url: `/v1/trials/${trialId}`, token: strangerToken });
    expect(foreign.statusCode).toBe(404);

    const listed = await inject({ method: "GET", url: `/v1/trials?personId=${personId}`, token });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ trials: unknown[] }>().trials).toHaveLength(1);
  });

  it("rejects incoherent provider status/certainty pairs at the database", async () => {
    const personId = await makePerson();
    const trialId = await requestTrial(personId);
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId,
      adapter: "manual",
    });
    if (!provisioned.ok) {
      throw new Error("expected provisioning to park");
    }
    // HUMAN_REQUIRED + UNKNOWN is the only coherent shape here: claiming
    // SUCCEEDED with UNKNOWN effect must fail the SQL CHECK.
    await expect(
      db
        .updateTable("provider.provider_operations")
        .set({ status: "SUCCEEDED", effect_certainty: "UNKNOWN" })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", provisioned.data.operationId)
        .execute(),
    ).rejects.toThrow();
  });

  it("expires due trials through the scheduler seam and cancels cleanly", async () => {
    const personId = await makePerson();
    const trialId = await requestTrial(personId);
    await bus.execute(actor(), "trial.begin_provisioning", { trialId, adapter: "echo" });
    // Test seam: move both timestamps back together so the
    // `trials_activation_time_check` (expires_at > activated_at) still holds.
    await db
      .updateTable("trial.trials")
      .set({ activated_at: new Date(Date.now() - 2 * 3_600_000), expires_at: new Date(Date.now() - 60_000) })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", trialId)
      .execute();

    const expired = await inject({ method: "POST", url: "/v1/trials/expire-due", token, payload: { limit: 100 } });
    expect(expired.statusCode).toBe(201);
    expect(expired.json<{ expired: string[] }>().expired).toContain(trialId);

    const personId2 = await makePerson();
    const trialId2 = await requestTrial(personId2);
    const cancelled = await bus.execute<{ status: string; cancelledOperations: string[] }>(actor(), "trial.cancel", {
      trialId: trialId2,
      reason: "customer changed mind",
    });
    expect(cancelled).toMatchObject({ ok: true, data: { status: "CANCELLED" } });
  });

  it("records compatibility profiles and observations with a per-person summary", async () => {
    const personId = await makePerson();
    const trialId = await requestTrial(personId);

    const device = await inject({
      method: "POST",
      url: "/v1/compatibility/device-profiles",
      token,
      payload: { personId, deviceType: "STB", manufacturer: "Sample", model: "S-1", osName: "Linux" },
    });
    expect(device.statusCode).toBe(201);
    const deviceId = device.json<{ id: string }>().id;

    const appProfile = await inject({
      method: "POST",
      url: "/v1/compatibility/app-profiles",
      token,
      payload: { name: "IPTV Player", platform: "LINUX", version: "1.0.0" },
    });
    expect(appProfile.statusCode).toBe(201);
    const appId = appProfile.json<{ id: string }>().id;

    const observation = await inject({
      method: "POST",
      url: "/v1/compatibility/observations",
      token,
      payload: {
        personId,
        trialId,
        deviceProfileId: deviceId,
        appProfileId: appId,
        providerServerKey: "XTREAM",
        network: { ispName: "Example ISP", networkType: "FIBER", ipv6State: "OK", dnsProfile: "default" },
        procedureKey: "playback-check-v1",
        outcome: "SUCCESS",
        metricsJson: { startup_ms: 900 },
      },
    });
    expect(observation.statusCode).toBe(201);

    const summary = await inject({ method: "GET", url: `/v1/compatibility/summary?personId=${personId}`, token });
    expect(summary.statusCode).toBe(200);
    const body = summary.json<{ observationCount: number; byOutcome: Record<string, number>; networks: unknown[] }>();
    expect(body.observationCount).toBe(1);
    expect(body.byOutcome["SUCCESS"]).toBe(1);
    expect(body.networks).toHaveLength(1);

    // Seeded lead: every wave runs against a fresh tenant, but the pilot
    // seed's ACTIVE trial must never leak across tenants.
    const row = await db
      .selectFrom("trial.trials")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", "00000000-0000-4000-8000-000000000541")
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});
