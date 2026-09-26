import { describe, expect, it } from "vitest";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import type { StoredPolicyDocument } from "../src/commands/command-bus.js";
import { PolicyResolver } from "../src/policy/policy-resolver.js";
import type { PolicyRepository } from "../src/policy/policy-resolver.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { ActionGate } from "../src/capabilities/capability-registry.js";
import type { StoredCapability } from "../src/commands/command-bus.js";
import { registerCapabilityCommands } from "../src/capabilities/capability.commands.js";
import { MemoryDb } from "./fakes/memory-fakes.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PARTNER = "99999999-9999-4999-8999-999999999999";

function actor(overrides: Partial<CommandActor> = {}): CommandActor {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    isPlatformAdmin: false,
    tenantId: TENANT,
    roleKeys: ["tenant_admin"],
    permissions: ["settings.manage", "support.ticket.write"],
    actorType: "human",
    ...overrides,
  };
}

function platformAdmin(): CommandActor {
  return { ...actor(), isPlatformAdmin: true, permissions: [] };
}

function doc(
  overrides: Partial<StoredPolicyDocument> & { family: string; class: string },
): StoredPolicyDocument {
  return {
    id: `doc-${overrides.class}-v${overrides.version ?? 1}`,
    tenantId: null,
    scope: "PLATFORM",
    version: 1,
    status: "PUBLISHED",
    document: {},
    publishedAt: new Date(),
    ...overrides,
  } as StoredPolicyDocument;
}

function fakeRepo(rows: StoredPolicyDocument[]): PolicyRepository {
  return {
    listPublished: async (family: string) => rows.filter((r) => r.family === family),
  };
}

function capability(overrides: Partial<StoredCapability> = {}): StoredCapability {
  return {
    key: "trial.issue",
    ownerContext: "trial",
    availability: "AVAILABLE",
    certificationStatus: "UNCERTIFIED",
    riskLevel: "MEDIUM",
    mvpPhase: "MVP",
    manualEquivalent: "issue a trial from the admin UI",
    policyFamily: "trial-eligibility",
    degradation: "manual issuance",
    permissions: ["support.ticket.write"],
    ...overrides,
  };
}

describe("PolicyResolver with fake repo", () => {
  it("returns not_configured for a missing family", async () => {
    const resolver = new PolicyResolver(fakeRepo([]));
    const result = await resolver.resolve("unknown-family", { tenantId: TENANT });
    expect(result).toEqual({ configured: false, value: {}, provenance: [] });
  });

  it("resolves precedence: invariant overrides platform overrides tenant overrides partner", async () => {
    const rows = [
      doc({ family: "f", class: "PARTNER_POLICY", scope: "PARTNER", tenantId: PARTNER, version: 1, document: { autonomy: "AUTO", partner: true } }),
      doc({ family: "f", class: "TENANT_POLICY", scope: "TENANT", tenantId: TENANT, version: 1, document: { autonomy: "APPROVAL", tenant: true } }),
      doc({ family: "f", class: "PLATFORM_POLICY", scope: "PLATFORM", version: 1, document: { autonomy: "MANUAL", platform: true } }),
      doc({ family: "f", class: "PLATFORM_INVARIANT", scope: "PLATFORM", version: 1, document: { max_autonomy: "APPROVAL" } }),
    ];
    const resolver = new PolicyResolver(fakeRepo(rows));
    const result = await resolver.resolve("f", { tenantId: TENANT, partnerId: PARTNER });
    expect(result.configured).toBe(true);
    // Higher class wins per key; lower layers only fill unset keys.
    expect(result.value).toEqual({
      max_autonomy: "APPROVAL",
      autonomy: "MANUAL",
      tenant: true,
      partner: true,
      platform: true,
    });
    expect(result.provenance.map((s) => s.source)).toEqual([
      "PLATFORM_INVARIANT",
      "PLATFORM_POLICY",
      "TENANT_POLICY",
      "PARTNER_POLICY",
    ]);
  });

  it("picks the latest published version within a class", async () => {
    const rows = [
      doc({ family: "f", class: "TENANT_POLICY", scope: "TENANT", tenantId: TENANT, version: 1, document: { autonomy: "AUTO" } }),
      doc({ family: "f", class: "TENANT_POLICY", scope: "TENANT", tenantId: TENANT, version: 2, document: { autonomy: "MANUAL" } }),
    ];
    const resolver = new PolicyResolver(fakeRepo(rows));
    const result = await resolver.resolve("f", { tenantId: TENANT });
    expect(result.value).toEqual({ autonomy: "MANUAL" });
    expect(result.provenance).toHaveLength(1);
    expect(result.provenance[0]?.ref).toBe("TENANT:f:v2");
  });
});

describe("policy.publish command with fake db", () => {
  function setup() {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerPolicyCommands(bus);
    return { db, bus };
  }

  it("rejects scope/class mismatch without writing", async () => {
    const { db, bus } = setup();
    const result = await bus.execute(actor(), "policy.publish", {
      family: "f",
      scope: "TENANT",
      class: "PLATFORM_POLICY",
      document: {},
    });
    expect(result.ok ? null : result.code).toBe("validation_failed");
    expect(db.txFor(TENANT).policies.size).toBe(0);
  });

  it("forbids PLATFORM publish for tenant admins", async () => {
    const { bus } = setup();
    const result = await bus.execute(actor(), "policy.publish", {
      family: "f",
      scope: "PLATFORM",
      class: "PLATFORM_POLICY",
      document: { autonomy: "AUTO" },
    });
    expect(result.ok ? null : result.code).toBe("forbidden");
  });

  it("publishes tenant versions with version+1 and resolves through the bus tx", async () => {
    const { db, bus } = setup();
    const first = await bus.execute<{ id: string; version: number }>(actor(), "policy.publish", {
      family: "f",
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: { autonomy: "APPROVAL" },
    });
    expect(first).toEqual({ ok: true, data: { id: expect.any(String), version: 1 } });
    const second = await bus.execute<{ id: string; version: number }>(actor(), "policy.publish", {
      family: "f",
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: { autonomy: "MANUAL" },
    });
    expect((second as { ok: true; data: { version: number } }).data.version).toBe(2);
    const tx = db.txFor(TENANT);
    const gate = new ActionGate(
      new PolicyResolver({ listPublished: (f, t) => tx.listPublishedPolicies(f, t) }),
    );
    const resolved = await gate.resolve(capability({ policyFamily: "f" }), actor(), { tenantId: TENANT });
    expect(resolved.action).toBe("MANUAL");
  });
});

describe("ActionGate with fake policies", () => {
  function gateFor(rows: StoredPolicyDocument[]): ActionGate {
    return new ActionGate(new PolicyResolver(fakeRepo(rows)));
  }

  it("denies UNAVAILABLE before the permission check", async () => {
    const gate = gateFor([]);
    const noPerms = actor({ permissions: [] });
    const result = await gate.resolve(
      capability({ availability: "UNAVAILABLE" }),
      { ...noPerms, tenantId: TENANT },
      { tenantId: TENANT },
    );
    expect(result.action).toBe("DENY");
    expect(result.reason).toBe("unavailable");
  });

  it("denies forbidden actors and flags DEGRADED results", async () => {
    const gate = gateFor([]);
    const noPerms = actor({ permissions: [] });
    const forbidden = await gate.resolve(
      capability({ availability: "AVAILABLE" }),
      { ...noPerms, tenantId: TENANT },
      { tenantId: TENANT },
    );
    expect(forbidden).toMatchObject({ action: "DENY", reason: "forbidden", degraded: false });
    const degraded = await gate.resolve(
      capability({ availability: "DEGRADED" }),
      { ...actor(), tenantId: TENANT },
      { tenantId: TENANT },
    );
    expect(degraded).toMatchObject({ action: "AUTO", degraded: true });
  });

  it("downgrades autonomy by the platform max and never upgrades silently", async () => {
    const rows = [
      doc({ family: "f", class: "PLATFORM_INVARIANT", scope: "PLATFORM", version: 1, document: { max_autonomy: "APPROVAL" } }),
      doc({ family: "f", class: "TENANT_POLICY", scope: "TENANT", tenantId: TENANT, version: 1, document: { autonomy: "AUTO" } }),
    ];
    const gate = gateFor(rows);
    const clamped = await gate.resolve(
      capability({ policyFamily: "f" }),
      { ...actor(), tenantId: TENANT },
      { tenantId: TENANT },
    );
    expect(clamped.action).toBe("APPROVAL");
    // A tenant asking for less than the max keeps the lower level.
    const rows2 = [
      doc({ family: "f", class: "PLATFORM_INVARIANT", scope: "PLATFORM", version: 1, document: { max_autonomy: "APPROVAL" } }),
      doc({ family: "f", class: "TENANT_POLICY", scope: "TENANT", tenantId: TENANT, version: 1, document: { autonomy: "MANUAL" } }),
    ];
    const kept = await gateFor(rows2).resolve(
      capability({ policyFamily: "f" }),
      { ...actor(), tenantId: TENANT },
      { tenantId: TENANT },
    );
    expect(kept.action).toBe("MANUAL");
  });

  it("denies on policy refusal and failed preconditions", async () => {
    const denied = await gateFor([
      doc({ family: "f", class: "TENANT_POLICY", scope: "TENANT", tenantId: TENANT, version: 1, document: { allow: false } }),
    ]).resolve(capability({ policyFamily: "f" }), { ...actor(), tenantId: TENANT }, { tenantId: TENANT });
    expect(denied).toMatchObject({ action: "DENY", reason: "policy_denied" });
    const precond = await gateFor([]).resolve(
      capability(),
      { ...actor(), tenantId: TENANT },
      { tenantId: TENANT, preconditions: () => false },
    );
    expect(precond).toMatchObject({ action: "DENY", reason: "precondition_failed" });
  });

  it("denies unknown capabilities", async () => {
    const result = await gateFor([]).resolve(null, { ...actor(), tenantId: TENANT }, { tenantId: TENANT });
    expect(result).toMatchObject({ action: "DENY", reason: "capability_not_found" });
  });
});

describe("capability commands with fake db", () => {
  function setup() {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    registerCapabilityCommands(bus);
    return { db, bus };
  }

  it("forbids catalog writes for non platform admins", async () => {
    const { bus } = setup();
    const result = await bus.execute(actor(), "capability.register", {
      key: "trial.issue",
      ownerContext: "trial",
      policyFamily: "trial-eligibility",
    });
    expect(result.ok ? null : result.code).toBe("forbidden");
  });

  it("registers and flips availability with an event row", async () => {
    const { db, bus } = setup();
    const registered = await bus.execute(actor(platformAdmin()), "capability.register", {
      key: "trial.issue",
      ownerContext: "trial",
      policyFamily: "trial-eligibility",
      permissions: ["support.ticket.write"],
    });
    expect(registered.ok).toBe(true);
    const flipped = await bus.execute(actor(platformAdmin()), "capability.set_availability", {
      key: "trial.issue",
      availability: "DEGRADED",
      reason: "provider latency",
    });
    expect(flipped).toEqual({ ok: true, data: { key: "trial.issue", availability: "DEGRADED" } });
    expect(db.txFor(TENANT).capabilityEvents).toEqual([
      {
        capabilityKey: "trial.issue",
        from: "AVAILABLE",
        to: "DEGRADED",
        reason: "provider latency",
        actorId: expect.any(String),
      },
    ]);
    const missing = await bus.execute(actor(platformAdmin()), "capability.set_availability", {
      key: "nope.missing",
      availability: "UNAVAILABLE",
    });
    expect(missing.ok ? null : missing.code).toBe("not_found");
  });
});
