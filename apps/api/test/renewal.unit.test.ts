import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { registerRenewalCommands } from "../src/renewal/renewal.commands.js";
import { MemoryDb } from "./fakes/memory-fakes.js";
import { computeProjectedState } from "../src/subscription/subscription-policy.js";
import {
  DEFAULT_RENEWAL_POLICY,
  DEFAULT_SUBSCRIPTION_TRUST_POLICY,
  RENEWAL_POLICY_FAMILY,
  SUBSCRIPTION_TRUST_RENEWAL_FAMILY,
  capExtensionDays,
  decideRenewalQuote,
  decideSubscriptionTrustRenewal,
  parseRenewalPolicy,
  parseSubscriptionTrustPolicy,
  renewalReminderKey,
} from "../src/renewal/renewal-policy.js";

describe("Wave 9 renewal policy (pure)", () => {
  it("family names match the canonical policy families", () => {
    expect(RENEWAL_POLICY_FAMILY).toBe("subscription.renewal");
    expect(SUBSCRIPTION_TRUST_RENEWAL_FAMILY).toBe("subscription.trust_renewal");
  });

  it("renewal policy defaults are safe (7d window, no early, 3d grace)", () => {
    expect(DEFAULT_RENEWAL_POLICY).toEqual({ windowDays: 7, earlyAllowed: false, graceDays: 3 });
    expect(parseRenewalPolicy(null)).toEqual(DEFAULT_RENEWAL_POLICY);
    expect(parseRenewalPolicy({})).toEqual(DEFAULT_RENEWAL_POLICY);
    expect(parseRenewalPolicy({ window_days: -2, early_allowed: "yes", grace_days: 0 })).toEqual(
      DEFAULT_RENEWAL_POLICY,
    );
    expect(parseRenewalPolicy({ window_days: 14, early_allowed: true, grace_days: 5 })).toEqual({
      windowDays: 14,
      earlyAllowed: true,
      graceDays: 5,
    });
  });

  it("quote window is boundary-exact: [end - window, end]", () => {
    const policy = { ...DEFAULT_RENEWAL_POLICY };
    const end = new Date("2026-10-01T00:00:00Z");
    // Far before → early denied by default.
    expect(
      decideRenewalQuote(policy, { cycleEnd: end, at: new Date("2026-09-01T00:00:00Z") }),
    ).toEqual({
      allowed: false,
      reason: expect.stringContaining("early renewal is not allowed"),
    });
    // One ms outside the window → denied; exactly on the edge → allowed.
    expect(
      decideRenewalQuote(policy, { cycleEnd: end, at: new Date("2026-09-23T23:59:59.999Z") }).allowed,
    ).toBe(false);
    const edge = decideRenewalQuote(policy, { cycleEnd: end, at: new Date("2026-09-24T00:00:00Z") });
    expect(edge).toEqual({ allowed: true, early: false });
    // Mid-window → allowed, not early.
    expect(decideRenewalQuote(policy, { cycleEnd: end, at: new Date("2026-09-27T00:00:00Z") })).toEqual({
      allowed: true,
      early: false,
    });
    // Exactly at end → still allowed (zero remaining is inside the window).
    expect(decideRenewalQuote(policy, { cycleEnd: end, at: end })).toEqual({ allowed: true, early: false });
    // One ms past end → closed, never a renewal (trust/expiry own that path).
    expect(decideRenewalQuote(policy, { cycleEnd: end, at: new Date("2026-10-01T00:00:00.001Z") })).toEqual({
      allowed: false,
      reason: expect.stringContaining("window closed"),
    });
  });

  it("early quoting opens only when the policy allows it", () => {
    const early = { ...DEFAULT_RENEWAL_POLICY, earlyAllowed: true };
    const end = new Date("2026-10-01T00:00:00Z");
    expect(
      decideRenewalQuote(early, { cycleEnd: end, at: new Date("2026-09-01T00:00:00Z") }),
    ).toEqual({ allowed: true, early: true });
  });

  it("quoting agrees with the computed RENEWAL_DUE projection under default policy", () => {
    const policy = { ...DEFAULT_RENEWAL_POLICY };
    const end = new Date("2026-10-01T00:00:00Z");
    const cases: Array<{ at: string; projected: string; quotable: boolean }> = [
      { at: "2026-09-01T00:00:00Z", projected: "ACTIVE", quotable: false },
      { at: "2026-09-24T00:00:00Z", projected: "RENEWAL_DUE", quotable: true },
      { at: "2026-09-30T12:00:00Z", projected: "RENEWAL_DUE", quotable: true },
      { at: "2026-10-02T00:00:00Z", projected: "GRACE", quotable: false },
      { at: "2026-10-20T00:00:00Z", projected: "OVERDUE", quotable: false },
    ];
    for (const c of cases) {
      const at = new Date(c.at);
      expect(computeProjectedState({ status: "ACTIVE", currentPeriodEnd: end, at })).toBe(c.projected);
      expect(decideRenewalQuote(policy, { cycleEnd: end, at }).allowed).toBe(c.quotable);
    }
    // Non-ACTIVE rows are never quotable and never projected as due.
    expect(computeProjectedState({ status: "SUSPENDED", currentPeriodEnd: end })).toBe("SUSPENDED");
    expect(
      decideSubscriptionTrustRenewal(DEFAULT_SUBSCRIPTION_TRUST_POLICY, {
        status: "SUSPENDED",
        cycleEnd: end,
        at: new Date("2026-09-30T00:00:00Z"),
      }),
    ).toEqual({ allowed: false, reason: expect.stringContaining("SUSPENDED") });
  });

  it("trust renewal defaults mirror the documented trial rule (+3d, remaining<=3, reviewed)", () => {
    expect(DEFAULT_SUBSCRIPTION_TRUST_POLICY).toEqual({
      allow: true,
      maxExtensionDays: 3,
      maxRemainingDays: 3,
      requireReview: true,
    });
    expect(parseSubscriptionTrustPolicy(null)).toEqual(DEFAULT_SUBSCRIPTION_TRUST_POLICY);
    expect(parseSubscriptionTrustPolicy({ allow: false })).toEqual({
      ...DEFAULT_SUBSCRIPTION_TRUST_POLICY,
      allow: false,
    });
    expect(
      parseSubscriptionTrustPolicy({ max_extension_days: 10, max_remaining_days: 5, require_review: false }),
    ).toEqual({ allow: true, maxExtensionDays: 10, maxRemainingDays: 5, requireReview: false });
  });

  it("trust gate is boundary-exact and ACTIVE-only", () => {
    const policy = { ...DEFAULT_SUBSCRIPTION_TRUST_POLICY };
    const end = new Date("2026-10-01T00:00:00Z");
    // 4 days remaining → denied; exactly 3 days → allowed.
    expect(
      decideSubscriptionTrustRenewal(policy, { status: "ACTIVE", cycleEnd: end, at: new Date("2026-09-27T00:00:00Z") }),
    ).toEqual({ allowed: false, reason: expect.stringContaining("threshold") });
    expect(
      decideSubscriptionTrustRenewal(policy, { status: "ACTIVE", cycleEnd: end, at: new Date("2026-09-28T00:00:00Z") }),
    ).toEqual({ allowed: true, extensionDays: 3, remainingMs: 3 * 86_400_000 });
    // GRACE (past end) stays eligible — no lower bound.
    const grace = decideSubscriptionTrustRenewal(policy, {
      status: "ACTIVE",
      cycleEnd: end,
      at: new Date("2026-10-02T00:00:00Z"),
    });
    expect(grace).toEqual({ allowed: true, extensionDays: 3, remainingMs: -86_400_000 });
    // Disabled policy and non-ACTIVE are forbidden.
    expect(
      decideSubscriptionTrustRenewal({ ...policy, allow: false }, { status: "ACTIVE", cycleEnd: end, at: end }),
    ).toEqual({ allowed: false, reason: expect.stringContaining("disabled") });
    expect(
      decideSubscriptionTrustRenewal(policy, { status: "ENDED", cycleEnd: end, at: end }).allowed,
    ).toBe(false);
    expect(
      decideSubscriptionTrustRenewal(policy, { status: "ACTIVE", cycleEnd: null, at: end }).allowed,
    ).toBe(false);
  });

  it("extension days default to the policy max and are capped", () => {
    expect(capExtensionDays(undefined, 3)).toBe(3);
    expect(capExtensionDays(1, 3)).toBe(1);
    expect(capExtensionDays(10, 3)).toBe(3);
    expect(() => capExtensionDays(0, 3)).toThrow();
    expect(() => capExtensionDays(-1, 3)).toThrow();
    expect(() => capExtensionDays(1.5, 3)).toThrow();
  });

  it("reminder key is unique per subscription cycle", () => {
    const key = renewalReminderKey("sub-1", "cycle-1");
    expect(key).toBe("renewal-reminder:sub-1:cycle-1");
    expect(renewalReminderKey("sub-1", "cycle-2")).not.toBe(key);
    expect(renewalReminderKey("sub-2", "cycle-1")).not.toBe(key);
  });
});

// F16 same-tenant ownership guard for `subscription.renew` (mocked stores, no
// DB): a settled RENEWAL order whose person derives another customer of the
// same tenant must be rejected with `precondition_failed` BEFORE the
// idempotent replay shortcuts and every cycle/grant/ledger mutation. Normal
// orders leave denormalized `orders.customer_id` NULL and identify the buyer
// with `person_id`; a contradictory non-null denormalized id is rejected too.
const renewStoreMocks = vi.hoisted(() => ({
  getOrder: vi.fn(),
  getCustomerIdForPerson: vi.fn(),
  getCycleByRenewalOrder: vi.fn(),
  advisoryLockSubscription: vi.fn(),
  getSubscription: vi.fn(),
  getCycle: vi.fn(),
  listCycles: vi.fn(),
  updateCycle: vi.fn(),
  insertCycle: vi.fn(),
  updateSubscription: vi.fn(),
  updateEntitlementsStatusBySource: vi.fn(),
  reopenEntitlementsForRenewal: vi.fn(),
}));

vi.mock("../src/renewal/renewal-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renewal/renewal-store.js")>();
  return { ...actual, ...renewStoreMocks } as unknown as typeof actual;
});

const subscriptionStoreMocks = vi.hoisted(() => ({
  getCatalogPlan: vi.fn(),
  listEntitlementsBySource: vi.fn(),
  insertGrant: vi.fn(),
  updateCycle: vi.fn(),
}));

vi.mock("../src/subscription/subscription-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/subscription/subscription-store.js")>();
  return { ...actual, ...subscriptionStoreMocks } as unknown as typeof actual;
});

const wave2Mocks = vi.hoisted(() => ({
  kyselyTrxOf: vi.fn(),
  emitAndEnqueue: vi.fn(),
}));

vi.mock("../src/crm/wave2-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/crm/wave2-store.js")>();
  return { ...actual, ...wave2Mocks } as unknown as typeof actual;
});

describe("F16 subscription.renew same-tenant ownership guard (mocked stores)", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const CUSTOMER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const CUSTOMER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const SUB_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const ORDER_R = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const CYCLE_PRIOR = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const CYCLE_NEXT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const PLAN_P = "99999999-9999-4999-8999-999999999999";
  const PERSON_A = "22222222-2222-4222-8222-222222222222";
  const PERSON_B = "33333333-3333-4333-8333-333333333333";

  const PRIOR_START = new Date("2026-10-01T00:00:00.000Z");
  const PRIOR_END = new Date("2026-11-01T00:00:00.000Z");

  function actor(): CommandActor {
    return {
      userId: PERSON_A,
      isPlatformAdmin: false,
      tenantId: TENANT,
      roleKeys: ["tenant_owner"],
      permissions: ["subscription.write"],
      actorType: "human",
    };
  }

  function setupBus(): CommandBus {
    const bus = new CommandBus(new MemoryDb());
    registerRenewalCommands(bus);
    return bus;
  }

  function orderFixture(input: { personId: string; customerId: string | null }) {
    return {
      id: ORDER_R,
      personId: input.personId,
      customerId: input.customerId,
      orderType: "RENEWAL",
      status: "SETTLED",
      netMinor: "3000",
      currency: "BRL",
    };
  }

  function priorFixture() {
    return {
      id: CYCLE_PRIOR,
      tenantId: TENANT,
      subscriptionId: SUB_A,
      cycleNo: 1,
      startsAt: PRIOR_START,
      endsAt: PRIOR_END,
      renewalOrderId: ORDER_R,
      status: "ACTIVE",
      baseRevenueMinor: "3000",
      currency: "BRL",
    };
  }

  function subscriptionFixture() {
    return {
      id: SUB_A,
      tenantId: TENANT,
      customerId: CUSTOMER_A,
      planId: PLAN_P,
      originatingOrderId: null,
      status: "ACTIVE",
      startedAt: PRIOR_START,
      currentPeriodStart: PRIOR_START,
      currentPeriodEnd: PRIOR_END,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    wave2Mocks.kyselyTrxOf.mockReturnValue({});
    wave2Mocks.emitAndEnqueue.mockResolvedValue(undefined);
    renewStoreMocks.advisoryLockSubscription.mockResolvedValue(undefined);
    renewStoreMocks.updateEntitlementsStatusBySource.mockResolvedValue(undefined);
    renewStoreMocks.reopenEntitlementsForRenewal.mockResolvedValue([]);
    subscriptionStoreMocks.listEntitlementsBySource.mockResolvedValue([]);
  });

  it("rejects a settled RENEWAL order owned by another same-tenant customer before any mutation", async () => {
    const bus = setupBus();
    // Same tenant, two customers: the order's person derives B (denormalized
    // customer_id is NULL, as normal orders leave it), the linked
    // subscription names A.
    renewStoreMocks.getOrder.mockResolvedValue(orderFixture({ personId: PERSON_B, customerId: null }));
    renewStoreMocks.getCustomerIdForPerson.mockResolvedValue(CUSTOMER_B);
    renewStoreMocks.getCycleByRenewalOrder.mockResolvedValue(priorFixture());
    renewStoreMocks.getSubscription.mockResolvedValue(subscriptionFixture());

    const result = await bus.execute(actor(), "subscription.renew", { orderId: ORDER_R });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("F16 defect: cross-customer renewal order was accepted");
    }
    expect(result.code).toBe("precondition_failed");
    expect(result.message).toMatch(/customer|ownership|cross-customer|same customer/i);
    // The guard owns both reads it needs ...
    expect(renewStoreMocks.getCustomerIdForPerson).toHaveBeenCalledTimes(1);
    expect(renewStoreMocks.getCycleByRenewalOrder).toHaveBeenCalledTimes(1);
    expect(renewStoreMocks.getSubscription).toHaveBeenCalledTimes(1);
    // ... and runs before the idempotent replay shortcuts (reads) ...
    expect(renewStoreMocks.getCycle).not.toHaveBeenCalled();
    expect(renewStoreMocks.listCycles).not.toHaveBeenCalled();
    // ... and before every cycle/grant/ledger mutation.
    expect(subscriptionStoreMocks.updateCycle).not.toHaveBeenCalled();
    expect(renewStoreMocks.insertCycle).not.toHaveBeenCalled();
    expect(renewStoreMocks.updateSubscription).not.toHaveBeenCalled();
    expect(renewStoreMocks.updateEntitlementsStatusBySource).not.toHaveBeenCalled();
    expect(renewStoreMocks.reopenEntitlementsForRenewal).not.toHaveBeenCalled();
    expect(subscriptionStoreMocks.insertGrant).not.toHaveBeenCalled();
    expect(wave2Mocks.emitAndEnqueue).not.toHaveBeenCalled();
  });

  it("rejects a contradictory non-null denormalized orders.customer_id before any mutation", async () => {
    const bus = setupBus();
    // Person derives A (matching the subscription), but the denormalized
    // orders.customer_id names B — contradictory denormalization is rejected.
    renewStoreMocks.getOrder.mockResolvedValue(orderFixture({ personId: PERSON_A, customerId: CUSTOMER_B }));
    renewStoreMocks.getCustomerIdForPerson.mockResolvedValue(CUSTOMER_A);
    renewStoreMocks.getCycleByRenewalOrder.mockResolvedValue(priorFixture());
    renewStoreMocks.getSubscription.mockResolvedValue(subscriptionFixture());

    const result = await bus.execute(actor(), "subscription.renew", { orderId: ORDER_R });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("F16 defect: contradictory denormalized customer_id was accepted");
    }
    expect(result.code).toBe("precondition_failed");
    expect(result.message).toMatch(/customer|cross-customer|contradict/i);
    expect(renewStoreMocks.getCycle).not.toHaveBeenCalled();
    expect(renewStoreMocks.listCycles).not.toHaveBeenCalled();
    expect(renewStoreMocks.insertCycle).not.toHaveBeenCalled();
    expect(wave2Mocks.emitAndEnqueue).not.toHaveBeenCalled();
  });

  it("valid control: a same-customer settled RENEWAL order renews (already:false)", async () => {
    const bus = setupBus();
    const prior = priorFixture();
    // Normal post-migration shape: denormalized customer_id is NULL; the
    // order's person derives the subscription's customer.
    renewStoreMocks.getOrder.mockResolvedValue(orderFixture({ personId: PERSON_A, customerId: null }));
    renewStoreMocks.getCustomerIdForPerson.mockResolvedValue(CUSTOMER_A);
    renewStoreMocks.getCycleByRenewalOrder.mockResolvedValue(prior);
    renewStoreMocks.getSubscription.mockResolvedValue(subscriptionFixture());
    renewStoreMocks.getCycle.mockResolvedValue(prior);
    renewStoreMocks.listCycles.mockResolvedValue([prior]);
    subscriptionStoreMocks.getCatalogPlan.mockResolvedValue({
      id: PLAN_P,
      planKey: "f16-monthly",
      intervalUnit: "MONTH",
      intervalCount: 1,
      metadata: {},
    });
    subscriptionStoreMocks.updateCycle.mockResolvedValue({ ...prior, status: "COMPLETED" });    const next = {
      ...prior,
      id: CYCLE_NEXT,
      cycleNo: 2,
      startsAt: PRIOR_END,
      endsAt: new Date("2026-12-01T00:00:00.000Z"),
      status: "ACTIVE",
      renewalOrderId: null,
      baseRevenueMinor: "3000",
    };
    renewStoreMocks.insertCycle.mockResolvedValue(next);
    renewStoreMocks.updateSubscription.mockResolvedValue({ ...subscriptionFixture() });

    const result = await bus.execute<{ subscriptionId: string; already: boolean }>(actor(), "subscription.renew", {
      orderId: ORDER_R,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`valid control failed: ${JSON.stringify(result)}`);
    }
    expect(result.data.subscriptionId).toBe(SUB_A);
    expect(result.data.already).toBe(false);
    expect(renewStoreMocks.insertCycle).toHaveBeenCalledTimes(1);
    expect(wave2Mocks.emitAndEnqueue).toHaveBeenCalledTimes(1);
  });
});
