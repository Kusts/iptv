import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenantTransaction } from "@iptv/database";
import { BotServiceController } from "../src/bot/bot-service.controller.js";
import * as queries from "../src/bot/streammax-bot-queries.js";
import * as adapter from "../src/bot/streammax-bot-adapter.js";

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
function setQueryResult(result: unknown) {
  const query = {
    innerJoin: vi.fn(() => query), select: vi.fn(() => query), where: vi.fn(() => query),
    orderBy: vi.fn(() => query), execute: vi.fn(async () => result),
    executeTakeFirst: vi.fn(async () => result),
  };
  vi.mocked(withTenantTransaction).mockImplementation(async (_db, _tenantId, callback) => callback({
    selectFrom: vi.fn(() => query),
  } as never) as never);
  return query;
}
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
      eligibilityComputed: false, eligible: null,
    });
    await rejects400(controller.getTrial, { ...base, personId, durationHours: 100 });
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
    const query = setQueryResult([{ id: orderId, trialKind: "TRIAL", lifecycleStatus: "ACTIVE",
      requestedDurationMinutes: 360, activatedAt: null, expiresAt: null }]);
    const execute = bus.execute;
    await expect(controller.getTrial(req({ ...base, personId }))).resolves.toMatchObject({
      trials: [{ id: orderId, trialKind: "TRIAL", lifecycleStatus: "ACTIVE", requestedDurationMinutes: 360 }],
      eligibilityComputed: false, eligible: null,
    });
    expect(query.execute).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});
