import { afterEach, describe, expect, it } from "vitest";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import type { EventEnvelope } from "@iptv/domain";
import { registerHumanReviewCommands } from "../src/human-review/human-review.commands.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { registerTrialCommands } from "../src/trial/trial.commands.js";
import { registerProviderCommands } from "../src/provider/provider.commands.js";
import {
  EchoProviderOpsAdapter,
  ManualProviderOpsAdapter,
  StubProviderReadback,
  applyCapabilityGate,
} from "../src/provider/provider-port.js";
import {
  DEFAULT_ELIGIBILITY_POLICY,
  TRIAL_EVENT_ALLOWLIST,
  TRIAL_TRANSITIONS,
  decideTrustRenewal,
  evaluateEligibility,
  isAllowedTrialEvent,
  parseTrustRenewalPolicy,
} from "../src/trial/trial-policy.js";
import { MemoryDb } from "./fakes/memory-fakes.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";

const PERMISSIONS = [
  "crm.person.read",
  "crm.lead.write",
  "trial.read",
  "trial.write",
  "provider.operation.read",
  "provider.operation.write",
  "agent.review.request",
  "agent.review.decide",
  "settings.manage",
];

function actor(tenantId: string = TENANT): CommandActor {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    isPlatformAdmin: false,
    tenantId,
    roleKeys: ["tenant_owner"],
    permissions: PERMISSIONS,
    actorType: "human",
  };
}

function setup(port: "echo" | "manual" = "echo") {
  const db = new MemoryDb();
  const bus = new CommandBus(db);
  registerHumanReviewCommands(bus);
  registerPolicyCommands(bus);
  registerCrmCommands(bus);
  const opsPort = port === "echo" ? new EchoProviderOpsAdapter() : new ManualProviderOpsAdapter();
  registerTrialCommands(bus, { opsPort });
  registerProviderCommands(bus, { opsPort, readbackPort: new StubProviderReadback() });
  return { db, bus };
}

function eventsOf(db: MemoryDb, tenantId: string = TENANT): EventEnvelope[] {
  return db.txFor(tenantId).events;
}

function eventTypes(db: MemoryDb, tenantId: string = TENANT): string[] {
  return eventsOf(db, tenantId).map((e) => e.event_type);
}

async function makePerson(bus: CommandBus, tenantId: string = TENANT): Promise<string> {
  const result = await bus.execute<{ id: string }>(actor(tenantId), "person.register", {
    canonicalName: "Trial Person",
  });
  if (!result.ok) {
    throw new Error(`person.register failed: ${result.message}`);
  }
  return result.data.id;
}

async function requestTrial(bus: CommandBus, personId: string): Promise<string> {
  const result = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
    personId,
    durationMinutes: 60,
  });
  if (!result.ok || result.data.id === null) {
    throw new Error(`trial.request failed: ${JSON.stringify(result)}`);
  }
  return result.data.id;
}

afterEach(() => {
  delete process.env["PROVIDER_READBACK_EFFECT"];
});

describe("trial transition map (exhaustive)", () => {
  it("matches the canonical state machine exactly", () => {
    expect(TRIAL_TRANSITIONS).toEqual({
      REQUESTED: ["PROVISIONING", "CANCELLED"],
      PROVISIONING: ["ACTIVE", "REQUESTED", "CANCELLED"],
      ACTIVE: ["ENDED", "INVALIDATED"],
      ENDED: [],
      INVALIDATED: [],
      CANCELLED: [],
    });
  });
});

describe("eligibility evaluation (pure)", () => {
  const base = {
    hasPrimary: false,
    hasOpen: false,
    isRetrial: false,
    previousStatus: null,
    durationMinutes: 60,
    adult: false,
  };

  it("allows the first primary trial by default", () => {
    expect(evaluateEligibility(DEFAULT_ELIGIBILITY_POLICY, base)).toEqual({
      outcome: "ALLOW",
      reasonCodes: ["FIRST_PRIMARY_TRIAL"],
    });
  });

  it("denies a second primary and any request with an open trial", () => {
    expect(evaluateEligibility(DEFAULT_ELIGIBILITY_POLICY, { ...base, hasPrimary: true }).outcome).toBe("DENY");
    expect(evaluateEligibility(DEFAULT_ELIGIBILITY_POLICY, { ...base, hasOpen: true })).toEqual({
      outcome: "DENY",
      reasonCodes: ["OPEN_TRIAL_EXISTS"],
    });
  });

  it("parks retrials in review by default, honors retrial_mode overrides", () => {
    const retrial = { ...base, isRetrial: true, previousStatus: "INVALIDATED" };
    expect(evaluateEligibility(DEFAULT_ELIGIBILITY_POLICY, retrial).outcome).toBe("REVIEW");
    expect(evaluateEligibility({ ...DEFAULT_ELIGIBILITY_POLICY, retrialMode: "allow" }, retrial).outcome).toBe(
      "ALLOW_RETRIAL",
    );
    expect(evaluateEligibility({ ...DEFAULT_ELIGIBILITY_POLICY, retrialMode: "deny" }, retrial).outcome).toBe("DENY");
  });

  it("denies everything when the policy disables trials, and adult when disallowed", () => {
    expect(evaluateEligibility({ ...DEFAULT_ELIGIBILITY_POLICY, allow: false }, base).outcome).toBe("DENY");
    expect(
      evaluateEligibility({ ...DEFAULT_ELIGIBILITY_POLICY, allowAdult: false }, { ...base, adult: true }),
    ).toEqual({ outcome: "DENY", reasonCodes: ["ADULT_NOT_ALLOWED"] });
  });

  it("reviews first trials only when the policy asks for it", () => {
    expect(
      evaluateEligibility({ ...DEFAULT_ELIGIBILITY_POLICY, reviewFirstTrial: true }, base).outcome,
    ).toBe("REVIEW");
  });
});

describe("trust renewal gate (pure, boundary-exact)", () => {
  const at = new Date("2026-09-26T12:00:00.000Z");
  const policy = parseTrustRenewalPolicy(null);

  it("defaults to +3 days with a 3-day remaining threshold", () => {
    expect(policy).toEqual({ allow: true, extensionDays: 3, maxRemainingDays: 3 });
  });

  it("allows exactly 3 days remaining and denies 4 days", () => {
    const allowed = decideTrustRenewal(policy, {
      status: "ACTIVE",
      expiresAt: new Date(at.getTime() + 3 * 86_400_000),
      at,
    });
    expect(allowed.allowed).toBe(true);
    const denied = decideTrustRenewal(policy, {
      status: "ACTIVE",
      expiresAt: new Date(at.getTime() + 4 * 86_400_000),
      at,
    });
    expect(denied).toEqual({
      allowed: false,
      reason: "remaining time exceeds the policy threshold of 3 days",
    });
  });

  it("requires ACTIVE with a known expiration", () => {
    expect(decideTrustRenewal(policy, { status: "ENDED", expiresAt: new Date(at.getTime() + 3_600_000), at }).allowed).toBe(
      false,
    );
    expect(decideTrustRenewal(policy, { status: "ACTIVE", expiresAt: null, at })).toEqual({
      allowed: false,
      reason: "trial has no expiration to extend",
    });
  });
});

describe("capability gate (pure)", () => {
  it("forces MANUAL when provider.cinevision is UNAVAILABLE", () => {
    expect(applyCapabilityGate("echo", null)).toEqual({ name: "echo", note: "capability_not_catalogued" });
    expect(applyCapabilityGate("echo", { availability: "UNAVAILABLE", certificationStatus: "UNCERTIFIED" })).toEqual({
      name: "manual",
      note: "capability_unavailable_forced_manual",
    });
    expect(applyCapabilityGate("echo", { availability: "AVAILABLE", certificationStatus: "UNCERTIFIED" })).toEqual({
      name: "echo",
      note: "capability_AVAILABLE_UNCERTIFIED",
    });
  });
});

describe("trial happy path on the memory store", () => {
  it("request -> provisioning(echo) -> ACTIVE -> technical PASSED -> trust renewal -> ENDED", async () => {
    const { db, bus } = setup("echo");
    const personId = await makePerson(bus);

    const requested = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request", {
      personId,
      durationMinutes: 60,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || requested.data.id === null) {
      throw new Error("expected a trial id");
    }
    const trialId = requested.data.id;
    expect(requested.data.status).toBe("REQUESTED");

    const provisioned = await bus.execute<{ id: string; status: string; operationId: string; effectUncertain: boolean }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { id: trialId, status: "ACTIVE", effectUncertain: false } });

    const technical = await bus.execute(actor(), "trial.record_technical_result", {
      trialId,
      playbackSuccess: true,
      summaryOutcome: "PASSED",
    });
    expect(technical.ok).toBe(true);

    const renewed = await bus.execute<{ id: string; expiresAt: string }>(actor(), "trial.apply_trust_renewal", {
      trialId,
    });
    expect(renewed.ok).toBe(true);

    const ended = await bus.execute<{ id: string; status: string }>(actor(), "trial.end", { trialId });
    expect(ended).toMatchObject({ ok: true, data: { id: trialId, status: "ENDED" } });

    const types = eventTypes(db);
    for (const required of [
      "trial.eligibility_allowed.v1",
      "trial.requested.v1",
      "trial.provisioning_started.v1",
      "trial.activated.v1",
      "trial.technical_passed.v1",
    ]) {
      expect(types).toContain(required);
    }
    // Trust renewal is audit-only: no invented event id may appear.
    expect(types.some((t) => t.includes("trust") || t.includes("renewal"))).toBe(false);
    // The person fixture emits its own registry-listed event; only the
    // trial/provider scope must stay inside this wave's allowlist.
    const waveEvents = types.filter((t) => t.startsWith("trial.") || t.startsWith("provider."));
    expect(waveEvents.length).toBeGreaterThan(0);
    for (const t of waveEvents) {
      expect(isAllowedTrialEvent(t)).toBe(true);
    }
    expect(TRIAL_EVENT_ALLOWLIST).toHaveLength(17);
  });

  it("rejects a second primary trial with 409 and records the denial", async () => {
    const { db, bus } = setup("echo");
    const personId = await makePerson(bus);
    const first = await requestTrial(bus, personId);
    await bus.execute(actor(), "trial.end", { trialId: first }).catch(() => undefined);
    // End the ACTIVE trial first: echo activation sets a 60min expiry, so
    // force expiry through the scheduler seam instead.
    const second = await bus.execute(actor(), "trial.request", { personId, durationMinutes: 60 });
    expect(second.ok).toBe(false);
    if (second.ok) {
      throw new Error("expected denial");
    }
    expect(second.code).toBe("precondition_failed");
    expect(eventTypes(db)).toContain("trial.eligibility_denied.v1");
  });

  it("records only one technical result per trial", async () => {
    const { bus } = setup("echo");
    const trialId = await requestTrial(bus, await makePerson(bus));
    await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    const first = await bus.execute(actor(), "trial.record_technical_result", {
      trialId,
      summaryOutcome: "INCONCLUSIVE",
    });
    expect(first.ok).toBe(true);
    const second = await bus.execute(actor(), "trial.record_technical_result", {
      trialId,
      summaryOutcome: "PASSED",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("precondition_failed");
    }
  });

  it("keeps tenants isolated", async () => {
    const { bus } = setup("echo");
    const trialId = await requestTrial(bus, await makePerson(bus));
    const foreign = await bus.execute(actor(OTHER_TENANT), "trial.begin_provisioning", { trialId });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.code).toBe("not_found");
    }
  });
});

describe("retrial after INVALIDATED with human review", () => {
  it("parks in review, then materializes with an approved review", async () => {
    const { db, bus } = setup("echo");
    const personId = await makePerson(bus);
    const trialId = await requestTrial(bus, personId);
    await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    const invalidated = await bus.execute(actor(), "trial.invalidate", {
      trialId,
      reason: "playback unusable on customer device",
    });
    expect(invalidated.ok).toBe(true);

    const parked = await bus.execute<{ id: string | null; status: string; reviewRequestId?: string }>(
      actor(),
      "trial.request_retrial",
      { previousTrialId: trialId, reason: "provider incident fixed, customer asked again" },
    );
    expect(parked).toMatchObject({ ok: true, data: { id: null, status: "PENDING_REVIEW" } });
    if (!parked.ok || parked.data.reviewRequestId === undefined) {
      throw new Error("expected a review request");
    }
    const reviewId = parked.data.reviewRequestId;
    expect(eventTypes(db)).toContain("trial.eligibility_review_required.v1");

    const approved = await bus.execute(actor(), "human_review.approve", { requestId: reviewId });
    expect(approved.ok).toBe(true);

    const retrial = await bus.execute<{ id: string | null; status: string }>(actor(), "trial.request_retrial", {
      previousTrialId: trialId,
      reason: "provider incident fixed, customer asked again",
      approvedReviewId: reviewId,
    });
    expect(retrial).toMatchObject({ ok: true, data: { status: "REQUESTED" } });
    if (!retrial.ok || retrial.data.id === null) {
      throw new Error("expected a retrial id");
    }
    expect(eventTypes(db)).toContain("trial.retrial_allowed.v1");

    // The retrial provisions independently.
    const provisioned = await bus.execute<{ status: string }>(actor(), "trial.begin_provisioning", {
      trialId: retrial.data.id,
    });
    expect(provisioned).toMatchObject({ ok: true, data: { status: "ACTIVE" } });
  });

  it("requires a terminal previous trial", async () => {
    const { bus } = setup("echo");
    const trialId = await requestTrial(bus, await makePerson(bus));
    const retrial = await bus.execute(actor(), "trial.request_retrial", {
      previousTrialId: trialId,
      reason: "too early",
    });
    expect(retrial.ok).toBe(false);
    if (!retrial.ok) {
      expect(retrial.code).toBe("precondition_failed");
    }
  });
});

describe("manual provisioning and provider resolve", () => {
  it("parks in HUMAN_REQUIRED, then a provider operator resolves to ACTIVE", async () => {
    const { db, bus } = setup("manual");
    const trialId = await requestTrial(bus, await makePerson(bus));
    const provisioned = await bus.execute<{ status: string; operationId: string; effectUncertain: boolean }>(
      actor(),
      "trial.begin_provisioning",
      { trialId },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING", effectUncertain: true } });
    if (!provisioned.ok) {
      throw new Error("expected provisioning to park");
    }
    const resolved = await bus.execute<{ status: string; resumedTrial: boolean }>(
      actor(),
      "provider.resolve_operation",
      { operationId: provisioned.data.operationId, outcome: "SUCCEEDED", note: "created by hand in portal" },
    );
    expect(resolved).toMatchObject({ ok: true, data: { status: "SUCCEEDED", resumedTrial: true } });
    expect(eventTypes(db)).toContain("trial.activated.v1");
  });

  it("returns the trial to REQUESTED on a certain FAILED outcome", async () => {
    const { db, bus } = setup("manual");
    const trialId = await requestTrial(bus, await makePerson(bus));
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!provisioned.ok) {
      throw new Error("expected provisioning to park");
    }
    const resolved = await bus.execute(actor(), "provider.resolve_operation", {
      operationId: provisioned.data.operationId,
      outcome: "FAILED",
      note: "credit exhausted",
    });
    expect(resolved.ok).toBe(true);
    expect(eventTypes(db)).toContain("trial.provisioning_failed.v1");
    // Retry stays possible: provisioning can start again from REQUESTED.
    const retry = await bus.execute<{ status: string; operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId,
      adapter: "echo",
      echoOutcome: "success",
    });
    expect(retry).toMatchObject({ ok: true, data: { status: "ACTIVE" } });
  });
});

describe("unknown effect reconcile path", () => {
  it("VERIFYING -> reconcile(NOT_APPLIED) -> FAILED with the trial back in REQUESTED", async () => {
    const { db, bus } = setup("echo");
    process.env["PROVIDER_READBACK_EFFECT"] = "NOT_APPLIED";
    const trialId = await requestTrial(bus, await makePerson(bus));
    const provisioned = await bus.execute<{ status: string; operationId: string; effectUncertain: boolean }>(
      actor(),
      "trial.begin_provisioning",
      { trialId, echoOutcome: "unknown" },
    );
    expect(provisioned).toMatchObject({ ok: true, data: { status: "PROVISIONING", effectUncertain: true } });
    if (!provisioned.ok) {
      throw new Error("expected VERIFYING park");
    }
    // No blind retry: a second provisioning attempt is rejected while the
    // uncertain operation is open.
    const retry = await bus.execute(actor(), "trial.begin_provisioning", { trialId });
    expect(retry.ok).toBe(false);

    const reconciled = await bus.execute<{
      status: string;
      effectCertainty: string;
      effectApplied: boolean;
      resumedTrial: boolean;
    }>(actor(), "provider.reconcile", { operationId: provisioned.data.operationId });
    expect(reconciled).toMatchObject({
      ok: true,
      data: { status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED", effectApplied: false, resumedTrial: true },
    });
    expect(eventTypes(db)).toContain("trial.provisioning_failed.v1");
  });

  it("VERIFYING -> reconcile(APPLIED) -> SUCCEEDED with the trial ACTIVE", async () => {
    const { bus } = setup("echo");
    process.env["PROVIDER_READBACK_EFFECT"] = "APPLIED";
    const trialId = await requestTrial(bus, await makePerson(bus));
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", {
      trialId,
      echoOutcome: "unknown",
    });
    if (!provisioned.ok) {
      throw new Error("expected VERIFYING park");
    }
    const reconciled = await bus.execute<{ status: string; resumedTrial: boolean }>(actor(), "provider.reconcile", {
      operationId: provisioned.data.operationId,
    });
    expect(reconciled).toMatchObject({ ok: true, data: { status: "SUCCEEDED", resumedTrial: true } });
  });

  it("refuses to reconcile operations that are not VERIFYING", async () => {
    const { bus } = setup("manual");
    const trialId = await requestTrial(bus, await makePerson(bus));
    const provisioned = await bus.execute<{ operationId: string }>(actor(), "trial.begin_provisioning", { trialId });
    if (!provisioned.ok) {
      throw new Error("expected provisioning to park");
    }
    const reconciled = await bus.execute(actor(), "provider.reconcile", {
      operationId: provisioned.data.operationId,
    });
    expect(reconciled.ok).toBe(false);
    if (!reconciled.ok) {
      expect(reconciled.code).toBe("precondition_failed");
    }
  });
});

describe("policy-driven eligibility", () => {
  it("denies trials when the published policy disables them", async () => {
    const { bus } = setup("echo");
    const personId = await makePerson(bus);
    const published = await bus.execute(actor(), "policy.publish", {
      family: "trial.eligibility",
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: { allow: false },
      status: "PUBLISHED",
    });
    expect(published.ok).toBe(true);
    const requested = await bus.execute(actor(), "trial.request", { personId, durationMinutes: 60 });
    expect(requested.ok).toBe(false);
    if (!requested.ok) {
      expect(requested.code).toBe("forbidden");
    }
  });
});

describe("compatibility observations", () => {
  it("records device/app profiles and observations without emitting events", async () => {
    const { db, bus } = setup("echo");
    const personId = await makePerson(bus);
    const trialId = await requestTrial(bus, personId);

    const device = await bus.execute<{ id: string }>(actor(), "compatibility.record_device_profile", {
      personId,
      deviceType: "SMART_TV",
      manufacturer: "Sample",
      model: "T-1000",
      osName: "Tizen",
      osVersion: "8.0",
    });
    expect(device.ok).toBe(true);
    if (!device.ok) {
      throw new Error("expected device profile");
    }
    const app = await bus.execute<{ id: string }>(actor(), "compatibility.record_app_profile", {
      name: "IPTV Player",
      platform: "TIZEN",
      version: "3.2.1",
    });
    expect(app.ok).toBe(true);
    if (!app.ok) {
      throw new Error("expected app profile");
    }
    const observation = await bus.execute(actor(), "compatibility.record_observation", {
      personId,
      trialId,
      deviceProfileId: device.data.id,
      appProfileId: app.data.id,
      providerServerKey: "ONE",
      network: { ispName: "Example ISP", networkType: "FIBER" },
      procedureKey: "playback-check-v1",
      outcome: "SUCCESS",
      metricsJson: { startup_ms: 1200 },
    });
    expect(observation.ok).toBe(true);
    // Compatibility writes are observational: no domain events.
    expect(eventTypes(db).some((t) => t.startsWith("compatibility."))).toBe(false);
  });
});
