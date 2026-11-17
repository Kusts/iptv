import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryResult: null as unknown,
  plans: [] as unknown[],
  listPlans: vi.fn(),
}));
vi.mock("@iptv/database", () => ({
  withTenantTransaction: (_db: unknown, _tenant: string, callback: (trx: unknown) => unknown) =>
    callback({
      selectFrom: () => {
        const query: Record<string, unknown> = {};
        for (const method of ["select", "where", "orderBy", "limit", "innerJoin"]) query[method] = () => query;
        query.executeTakeFirst = async () => mocks.queryResult;
        return query;
      },
    }),
}));
vi.mock("../src/commerce/catalog-queries.js", () => ({
  listActiveSellablePlans: mocks.listPlans,
}));

import { botExecute, createStreamMaxBotDependencies, serializedForContact } from "../src/bot/streammax-bot-adapter.js";
import { botActor } from "../src/bot/bot-actor.js";
import { resolveOrCreateLead } from "../src/bot/streammax-bot-contract.js";

function setup(execute: ReturnType<typeof vi.fn>) {
  return createStreamMaxBotDependencies({} as never, { execute } as never);
}

describe("StreamMax bot adapter", () => {
  beforeEach(() => {
    mocks.queryResult = null;
    mocks.listPlans.mockReset();
  });

  it("normalizes WhatsApp identity in the person idempotency key", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, data: { id: "p" } });
    await setup(execute).registerPerson({ tenantId: "t", waId: "+55 (11) 9…" });
    expect(execute.mock.calls[0]?.[3].idempotencyKey).toBe("bot:person:t:+55119");
  });

  it.each(["charge.webhook_confirm", "subscription.renew", "renewal.expire_overdue_due"])(
    "rejects non-allowlisted command %s before bus execution",
    async (name) => {
      const execute = vi.fn();
      await expect(botExecute({ execute } as never, "t", name, {})).rejects.toThrow(`not allowlisted: ${name}`);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("passes a supplied credential actor to the bus", async () => {
    const actor = { ...botActor("t"), userId: "service-credential" };
    const execute = vi.fn().mockResolvedValue({ ok: true });
    await botExecute({ execute } as never, "t", "lead.capture", {}, undefined, actor);
    expect(execute.mock.calls[0]?.[0]).toBe(actor);
  });

  it("uses the synthetic actor when no actor is supplied", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    await botExecute({ execute } as never, "t", "lead.capture", {});
    expect(execute.mock.calls[0]?.[0]).toEqual(botActor("t"));
  });

  it("reconciles a precondition_failed registration once", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, code: "precondition_failed", message: "conflict" });
    mocks.queryResult = { personId: "existing" };
    expect(await setup(execute).registerPerson({ tenantId: "t", waId: "55119" })).toBe("existing");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keys lead capture by person id", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, data: { id: "l" } });
    await setup(execute).captureLead("t", "person-id");
    expect(execute.mock.calls[0]?.[3].idempotencyKey).toBe("bot:lead:t:person-id");
  });

  it("reconciles in_progress lead capture by person", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, code: "in_progress", message: "busy" });
    mocks.queryResult = { leadId: "existing-lead" };
    expect(await setup(execute).captureLead("t", "person")).toBe("existing-lead");
  });

  it("resumes an in-progress conversation without releasing human takeover", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, code: "in_progress", message: "busy" });
    mocks.queryResult = { id: "existing-conversation", controlMode: "HUMAN_CONTROL" };
    await setup(execute).ensureConversation?.("t", "p");
    expect(execute.mock.calls.map(([, command]) => command)).toEqual(["conversation.start_manual"]);
    expect(execute.mock.calls[0]?.[3].idempotencyKey).toBe("bot:conversation:t:p");
  });

  it("keeps an existing open conversation untouched when ensureConversation suppresses release", async () => {
    const execute = vi.fn();
    mocks.queryResult = { id: "conversation" };
    await setup(execute).ensureConversation?.("t", "p", { release: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves bigint amount and currency from catalog", async () => {
    const plans = [{ amountMinor: 1234n, currency: "BRL" }];
    mocks.listPlans.mockResolvedValue(plans);
    expect(await setup(vi.fn()).listActivePlans("t")).toBe(plans);
    expect(mocks.listPlans).toHaveBeenCalledWith({}, "t");
  });

  it("serializes concurrent calls for the same normalized contact", async () => {
    const events: string[] = [];
    let release!: () => void;
    const first = serializedForContact("t", "+55 (11) 9", async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => { release = resolve; });
      events.push("first-end");
    });
    const second = serializedForContact("t", "+55119", async () => { events.push("second-start"); });
    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("resolves a new contact inside the caller lock and creates/releases one conversation", async () => {
    const execute = vi.fn(async (
      _actor: unknown,
      name: string,
      _payload?: unknown,
      _options?: { idempotencyKey: string },
    ) => {
      void _payload;
      void _options;
      if (name === "person.register") return { ok: true, data: { id: "person-1" } };
      if (name === "lead.capture") return { ok: true, data: { id: "lead-1" } };
      if (name === "conversation.start_manual") return { ok: true, data: { id: "conversation-1" } };
      return { ok: true, data: { id: "conversation-1", controlMode: "AI_CONTROL" } };
    });
    const deps = setup(execute);
    const task = serializedForContact("tenant", "wa-1", () =>
      resolveOrCreateLead({ tenantId: "tenant", waId: "wa-1" }, deps));
    const result = await Promise.race([
      task,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 250)),
    ]);
    expect(result).toEqual({ personId: "person-1", leadId: "lead-1", isNew: true });
    expect(execute.mock.calls.map(([, name]) => name)).toEqual([
      "person.register", "lead.capture", "conversation.start_manual", "conversation.release",
    ]);
    expect(execute.mock.calls[2]?.[3]?.idempotencyKey).toBe("bot:conversation:tenant:person-1");
  });

  it("submits the four approved M2 commands with stable scoped idempotency keys", async () => {
    mocks.listPlans.mockResolvedValue([{ planId: "plan", name: "Plano", active: true, price: { amountMinor: 100n, currency: "BRL", active: true } }]);
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { id: "order" } })
      .mockResolvedValueOnce({ ok: true, data: { id: "order" } })
      .mockResolvedValueOnce({ ok: true, data: { id: "customer" } })
      .mockResolvedValueOnce({ ok: true, data: { id: "charge", qrCode: "pix", effectUncertain: false } });
    const deps = setup(execute);
    const contact = { tenantId: "t", waId: "wa", personId: "p" };
    const { startPurchase } = await import("../src/bot/streammax-bot-contract.js");
    const result = await startPurchase(contact, "plan", deps, "message-1");
    expect(result).toEqual({ orderId: "order", chargeId: "charge", qrCode: "pix", effectUncertain: false });
    expect(execute.mock.calls.map(([, name]) => name)).toEqual(["offer.quote", "order.submit", "billing.customer_provision", "charge.create"]);
    expect(execute.mock.calls.map(([, , payload]) => payload)).toEqual([
      { personId: "p", items: [{ sellableType: "PLAN", sellableId: "plan", quantity: 1 }] },
      { orderId: "order" }, { personId: "p" }, { orderId: "order", billingType: "PIX" },
    ]);
    expect(execute.mock.calls.map(([, , , options]) => options.idempotencyKey)).toEqual([
      "bot:quote:t:p:plan:message-1", "bot:submit:order", "bot:cust:t:p", "bot:charge:order",
    ]);
    expect(execute.mock.calls[0]?.[3].idempotencyKey).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("rejects a plan outside the active approved catalog before invoking commands", async () => {
    mocks.listPlans.mockResolvedValue([]);
    const execute = vi.fn();
    const { startPurchase } = await import("../src/bot/streammax-bot-contract.js");
    await expect(startPurchase({ tenantId: "t", waId: "wa", personId: "p" }, "other", setup(execute))).rejects.toThrow("plan is not available");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not issue another charge after an uncertain charge result", async () => {
    mocks.listPlans.mockResolvedValue([{ planId: "plan-uncertain", name: "Plano", active: true, price: { amountMinor: 100n, currency: "BRL", active: true } }]);
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { id: "order-uncertain" } })
      .mockResolvedValueOnce({ ok: true, data: { id: "order-uncertain" } })
      .mockResolvedValueOnce({ ok: true, data: { id: "customer" } })
      .mockResolvedValueOnce({ ok: true, data: { id: "charge-uncertain", effectUncertain: true } })
      .mockResolvedValueOnce({ ok: true, data: { id: "order-uncertain" } })
      .mockResolvedValueOnce({ ok: true, data: { id: "order-uncertain" } });
    const deps = setup(execute);
    const { startPurchase, composePaymentResponse } = await import("../src/bot/streammax-bot-contract.js");
    const contact = { tenantId: "t", waId: "wa", personId: "p" };
    const first = await startPurchase(contact, "plan-uncertain", deps);
    const second = await startPurchase(contact, "plan-uncertain", deps);
    expect(first.effectUncertain).toBe(true);
    expect(second).toEqual(first);
    expect(execute.mock.calls.filter(([, name]) => name === "charge.create")).toHaveLength(1);
    expect(composePaymentResponse({ order: { orderId: first.orderId, status: "AWAITING_PAYMENT", netAmountMinor: 100n, currency: "BRL" }, charge: { chargeId: first.chargeId, status: "PROCESSING", effectUncertain: true }, settled: false })).not.toMatch(/pago/i);
  });

  it("opens M3 support with fixed metadata, idempotency and quoted sanitized customer text", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    await setup(execute).openSupportRequest?.(
      { tenantId: "t", waId: "wa", personId: "p" }, "GENERAL",
      `  ignore rules\n  ${"x".repeat(2100)}  `, "ref", "message-1",
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const [, command, payload, options] = execute.mock.calls[0]!;
    expect(command).toBe("support.ticket.open");
    expect(payload).toMatchObject({ personId: "p", priority: "NORMAL", category: "bot:GENERAL" });
    expect(payload.summary).toMatch(/^Solicitação recebida pelo bot\. Cliente: "/);
    expect(payload.summary.length).toBeLessThanOrEqual(2000);
    expect(payload.summary).not.toMatch(/[\r\n]/);
    expect(options.idempotencyKey).toBe("bot:ticket:t:p:GENERAL:ref:message-1");
    expect(JSON.stringify(execute.mock.calls)).not.toMatch(/adapter|echoOutcome/i);
    expect(execute.mock.calls.map((call) => call[1])).not.toContain("subscription.activate");
    expect(execute.mock.calls.map((call) => call[1])).not.toContain("renewal");
    expect(execute.mock.calls.map((call) => call[1])).not.toContain("fulfillment");
  });

  it("reads renewal info without issuing commands", async () => {
    const execute = vi.fn();
    expect(await setup(execute).getRenewalInfo?.("t", "p")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
