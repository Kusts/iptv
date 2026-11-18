import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenantTransaction } from "@iptv/database";
import { BotServiceController } from "../src/bot/bot-service.controller.js";
import * as queries from "../src/bot/streammax-bot-queries.js";
import * as adapter from "../src/bot/streammax-bot-adapter.js";
import * as catalogQueries from "../src/commerce/catalog-queries.js";

vi.mock("@iptv/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iptv/database")>();
  return { ...actual, withTenantTransaction: vi.fn() };
});

const bus = { execute: vi.fn() };
const database = {} as never;
const controller = new BotServiceController(database, bus as never);
const base = { messageId: "m", requestedAt: new Date().toISOString(), idempotencyKey: "k" };
const personId = "73000000-0000-4000-8000-000000000001";
const orderId = "73000000-0000-4000-8000-000000000002";
const credential = { tenantId: "73000000-0000-4000-8000-000000000099", credentialId: "credential" };
const req = (body: unknown) => ({ body, botService: credential }) as FastifyRequest;
async function rejects400(method: (request: FastifyRequest) => Promise<unknown>, body: unknown) {
  await expect(method.call(controller, req(body))).rejects.toMatchObject({ status: 400 });
}
function setQueryResults(results: Record<string, unknown>, fallback?: unknown) {
  const queries: Record<string, ReturnType<typeof makeQuery>> = {};
  function makeQuery(result: unknown) {
  const query = {
      innerJoin: vi.fn(() => query), select: vi.fn(() => query), where: vi.fn(() => query),
      orderBy: vi.fn(() => query), leftJoin: vi.fn((...args: unknown[]) => {
        const cb = args[1];
        if (typeof cb === "function") {
          const join = { onRef: vi.fn(() => join), on: vi.fn(() => join) };
          cb(join);
        }
        return query;
      }),
      execute: vi.fn(async () => result), executeTakeFirst: vi.fn(async () => result),
    };
    return query;
  };
  vi.mocked(withTenantTransaction).mockImplementation(async (_db, _tenantId, callback) => callback({
    selectFrom: vi.fn((table: string) => queries[table] ??= makeQuery(results[table] ?? fallback)),
  } as never) as never);
  return queries;
}
const setQueryResult = (result: unknown) => setQueryResults({}, result);
beforeEach(() => { vi.clearAllMocks(); });

describe("bot capability request validation", () => {
  it.each(["tenantId", "tenant_id", "tenant"])("rejects %s in strict requests", async (field) => {
    await rejects400(controller.quote, { ...base, personId, planId: orderId, [field]: "attacker" });
  });

  it.each(["amountMinor", "price", "total", "currency"])("rejects client monetary field %s in quote", async (field) => {
    await rejects400(controller.quote, { ...base, personId, planId: orderId, [field]: 1 });
  });

  it("rejects monetary client values for renewal quote", async () => {
    await rejects400(controller.renewalQuote, { ...base, personId, amountMinor: 10 });
  });

  it("accepts quote shape without client-supplied price and then requires credential context", async () => {
    await expect(new BotServiceController(null, bus as never).quote(req({ ...base, personId, planId: orderId })))
      .rejects.toMatchObject({ status: 503 });
  });

  it("validates strict shape and returns the read-only trial response", async () => {
    setQueryResult([]);
    await expect(controller.getTrial(req({ ...base, personId }))).resolves.toMatchObject({
      personId, durationHours: 6, usesPerUser: 1, trials: [],
      eligibilityComputed: true, eligible: true,
    });
    await rejects400(controller.getTrial, { ...base, personId, durationHours: 100 });
  });

  it("fails trial eligibility closed when the policy/history read is unavailable", async () => {
    vi.mocked(withTenantTransaction).mockRejectedValueOnce(new Error("policy read unavailable"));
    await expect(controller.getTrial(req({ ...base, personId }))).resolves.toMatchObject({
      durationHours: 6, usesPerUser: 1, eligibilityComputed: false, eligible: null,
      reason: "ELIGIBILITY_DATA_UNAVAILABLE",
    });
  });
});

describe("StreamMax bot routes", () => {
  it("maps charge state without exposing PIX and returns an empty charge safely", async () => {
    vi.spyOn(queries, "getOrderState").mockResolvedValue({
      order: { orderId, status: "PENDING", netAmountMinor: 1250n, currency: "BRL" },
      charge: null, settled: false,
    } as never);
    await expect(controller.getCharge(req({ ...base, personId, orderId }))).resolves.toEqual({
      personId, orderId, order: { orderId, status: "PENDING", netAmountMinor: "1250", currency: "BRL" },
      charge: null, settled: false, pix: null,
    });
  });

  it("maps a missing order to 404 but infrastructure errors to 503", async () => {
    vi.spyOn(queries, "getOrderState").mockRejectedValueOnce(new Error("order not found"));
    await expect(controller.getCharge(req({ ...base, personId, orderId }))).rejects.toMatchObject({ status: 404 });
    vi.spyOn(queries, "getOrderState").mockRejectedValueOnce(new Error("connection lost"));
    await expect(controller.getCharge(req({ ...base, personId, orderId }))).rejects.toMatchObject({ status: 503 });
  });

  it("maps subscription projection fields", async () => {
    setQueryResult({ subscriptionId: orderId, status: "ACTIVE",
      currentPeriodStart: new Date("2026-01-01T00:00:00Z"), currentPeriodEnd: new Date("2026-02-01T00:00:00Z") });
    await expect(controller.getSubscription(req({ ...base, personId }))).resolves.toMatchObject({
      personId, subscriptionId: orderId, status: "ACTIVE", projectedState: null,
    });
  });

  it("maps ticket opening result and stable idempotency key from command", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, data: { id: orderId, status: "OPEN" } });
    const spy = vi.spyOn(adapter, "botExecute").mockImplementation(execute as never);
    await expect(controller.openTicket(req({ ...base, personId, kind: "GENERAL", summary: "help" }))).resolves.toEqual({
      ticketId: orderId, status: "OPEN", personId, kind: "GENERAL",
    });
    expect(spy).toHaveBeenCalledWith(bus, credential.tenantId, "support.ticket.open",
      expect.objectContaining({ category: "bot:GENERAL" }),
      { idempotencyKey: `bot:ticket:${credential.tenantId}:${personId}:GENERAL:k` }, expect.objectContaining({ tenantId: credential.tenantId }));
  });

  it("maps ticket details and hides tickets owned by another person as 404", async () => {
    setQueryResult({ id: orderId, status: "OPEN", priority: "NORMAL", category: "bot:GENERAL", summary: "help",
      personId, createdAt: new Date("2026-01-01T00:00:00Z"), resolvedAt: null, closedAt: null });
    await expect(controller.getTicket(req({ ...base, personId, ticketId: orderId }))).resolves.toMatchObject({
      personId, ticket: { id: orderId, personId, status: "OPEN" },
    });
    setQueryResult(undefined);
    await expect(controller.getTicket(req({ ...base, personId: "73000000-0000-4000-8000-000000000003", ticketId: orderId })))
      .rejects.toMatchObject({ status: 404 });
  });

  it("reads trial rows without running commands or mutating state", async () => {
    const queries = setQueryResult([{ id: orderId, trialKind: "TRIAL", lifecycleStatus: "ACTIVE",
      requestedDurationMinutes: 360, activatedAt: null, expiresAt: null }]);
    const execute = bus.execute;
    await expect(controller.getTrial(req({ ...base, personId }))).resolves.toMatchObject({
      trials: [{ id: orderId, trialKind: "TRIAL", lifecycleStatus: "ACTIVE", requestedDurationMinutes: 360 }],
      eligibilityComputed: true, eligible: false,
    });
    expect(queries["trial.trials"]?.execute).toHaveBeenCalledTimes(1);
    expect(queries["platform.policy_documents"]?.execute).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the policy-proven technical exception for one retrial without mutation", async () => {
    setQueryResults({
      "trial.trials": [{ id: orderId, trialKind: "TRIAL", lifecycleStatus: "INVALIDATED",
        technicalOutcome: "FAILED", requestedDurationMinutes: 360, activatedAt: null, expiresAt: null }],
      "platform.policy_documents": [{ id: orderId, tenantId: credential.tenantId, family: "trial.eligibility",
        scope: "TENANT", class: "TENANT_POLICY", version: 1, status: "PUBLISHED", publishedAt: new Date(),
        document: { retrial_mode: "allow", durations_minutes: [360] } }],
    });
    await expect(controller.getTrial(req({ ...base, personId }))).resolves.toMatchObject({
      durationHours: 6, usesPerUser: 1, eligible: true, eligibilityComputed: true, reason: "RETRIAL_POLICY_ALLOW",
    });
    expect(bus.execute).not.toHaveBeenCalled();
  });

  it("returns renewal quote values verbatim from the backend for discount and no-discount replay", async () => {
    setQueryResult({ id: orderId });
    const command = vi.spyOn(adapter, "botExecute").mockImplementation(vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { orderId, status: "AWAITING_PAYMENT", netAmountMinor: "4500", currency: "BRL", early: true, already: false } })
      .mockResolvedValueOnce({ ok: true, data: { orderId, status: "AWAITING_PAYMENT", netAmountMinor: "5000", currency: "BRL", early: false, already: false } })
      .mockResolvedValueOnce({ ok: true, data: { orderId, status: "AWAITING_PAYMENT", netAmountMinor: "5000", currency: "BRL", early: false, already: true } }) as never);
    await expect(controller.renewalQuote(req({ ...base, personId }))).resolves.toMatchObject({
      amountMinor: "4500", currency: "BRL", early: true, already: false,
    });
    const noDiscountRequest = req({ ...base, personId, idempotencyKey: "no-discount" });
    await expect(controller.renewalQuote(noDiscountRequest)).resolves.toMatchObject({
      amountMinor: "5000", currency: "BRL", early: false, already: false,
    });
    await expect(controller.renewalQuote(noDiscountRequest)).resolves.toMatchObject({
      amountMinor: "5000", currency: "BRL", early: false, already: true,
    });
    expect(command).toHaveBeenNthCalledWith(1, bus, credential.tenantId, "renewal.quote", { subscriptionId: orderId },
      { idempotencyKey: `bot-api:renewal-quote:${credential.tenantId}:${personId}:k` }, expect.objectContaining({ tenantId: credential.tenantId }));
  });

  it("validates renewal order ownership and state before invoking the renew command", async () => {
    const command = vi.spyOn(adapter, "botExecute").mockResolvedValue({ ok: true, data: {
      subscriptionId: orderId, priorCycleId: personId, cycleId: orderId, cycleNo: 2,
      startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-02-01T00:00:00.000Z", already: false,
    } } as never);
    const body = { ...base, personId, quoteId: orderId };
    setQueryResult(undefined);
    await expect(controller.renew(req(body))).rejects.toMatchObject({ status: 404 });
    expect(command).not.toHaveBeenCalled();

    setQueryResult({ id: orderId, personId: "73000000-0000-4000-8000-000000000003", orderType: "RENEWAL", status: "SETTLED" });
    await expect(controller.renew(req(body))).rejects.toMatchObject({ status: 404 });
    expect(command).not.toHaveBeenCalled();

    setQueryResult({ id: orderId, personId, orderType: "NEW_SUBSCRIPTION", status: "SETTLED" });
    await expect(controller.renew(req(body))).rejects.toMatchObject({ status: 400 });
    expect(command).not.toHaveBeenCalled();

    setQueryResult({ id: orderId, personId, orderType: "RENEWAL", status: "AWAITING_PAYMENT" });
    await expect(controller.renew(req(body))).rejects.toMatchObject({ status: 409 });
    expect(command).not.toHaveBeenCalled();

    setQueryResult({ id: orderId, personId, orderType: "RENEWAL", status: "SETTLED" });
    await expect(controller.renew(req(body))).resolves.toMatchObject({ already: false, orderId });
    expect(command).toHaveBeenCalledWith(bus, credential.tenantId, "subscription.renew", { orderId },
      { idempotencyKey: `bot-api:renew:${credential.tenantId}:${orderId}` }, expect.objectContaining({ tenantId: credential.tenantId }));
  });

  it("marks addons executable only for exact approved operational price, currency and segment matches", async () => {
    vi.spyOn(catalogQueries, "listActiveSellablePlans").mockResolvedValue([]);
    setQueryResults({ "catalog.addons as a": [
      { sellableId: orderId, segmentKey: "P1M", amountMinor: "2000", currency: "BRL" },
      { sellableId: orderId, segmentKey: "P3M", amountMinor: "6000", currency: "BRL" },
      { sellableId: orderId, segmentKey: "P6M", amountMinor: "10000", currency: "USD" },
    ] });
    const response = await controller.listPlans(req(base));
    expect(response.addons.find((addon) => addon.segmentKey === "P1M")?.executable).toBe(true);
    expect(response.addons.find((addon) => addon.segmentKey === "P3M")?.executable).toBe(true);
    expect(response.addons.find((addon) => addon.segmentKey === "P6M")?.executable).toBe(false);
    expect(response.addons.find((addon) => addon.segmentKey === "P12M")?.executable).toBe(false);
  });
});
