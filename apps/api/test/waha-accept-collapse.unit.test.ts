import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { WahaWebhookController } from "../src/communications/waha-webhook.controller.js";
import type { WahaWebhookService } from "../src/communications/waha-webhook.service.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CHANNEL = { tenantId: TENANT, channel: "WHATSAPP", secretHash: "hash" };

function reqWith(secret: string | undefined): FastifyRequest {
  return { headers: secret === undefined ? {} : { "x-waha-secret": secret } } as unknown as FastifyRequest;
}

function stubService(overrides: {
  resolve?: (tenantKey: string) => Promise<typeof CHANNEL | null>;
  verify?: () => { ok: true; channel: typeof CHANNEL } | { ok: false; code: "unauthorized" };
  accept?: (input: {
    tenantId: string;
    tenantKey: string;
    channel: string;
    externalEventId: string;
    payload: unknown;
  }) => Promise<{ inserted: boolean; inboxId: string } | null>;
  /** Inline claim outcome: false simulates the scheduler drain owning the row. */
  claimed?: boolean;
}): { controller: WahaWebhookController; service: WahaWebhookService; processRow: ReturnType<typeof vi.fn>; processInline: ReturnType<typeof vi.fn> } {
  const processRow = vi.fn(async (tenantId: string, inboxId: string, payload: unknown): Promise<void> => {
    void tenantId;
    void inboxId;
    void payload;
  });
  const claimed = overrides.claimed ?? true;
  const processInline = vi.fn(async (tenantId: string, inboxId: string, payload: unknown, consumer: string) => {
    void consumer;
    if (!claimed) {
      return { claimed: false };
    }
    await processRow(tenantId, inboxId, payload);
    return { claimed: true };
  });
  const service = {
    resolveChannel: vi.fn(async (tenantKey: string) => (overrides.resolve === undefined ? CHANNEL : overrides.resolve(tenantKey))),
    verifySecret: vi.fn(
      () =>
        (overrides.verify === undefined
          ? { ok: true as const, channel: CHANNEL }
          : overrides.verify()) as { ok: true; channel: typeof CHANNEL },
    ),
    acceptAtomic: vi.fn(async (input: {
      tenantId: string;
      tenantKey: string;
      channel: string;
      externalEventId: string;
      payload: unknown;
    }) => (overrides.accept === undefined ? { inserted: true, inboxId: "inbox-1" } : overrides.accept(input))),
    processRow,
    processInline,
  } as unknown as WahaWebhookService;
  return { controller: new WahaWebhookController(service), service, processRow, processInline };
}

const BODY = {
  event: "message",
  session: "default",
  payload: { id: "wamsg-collapse-1", from: "5511999990001@c.us", fromMe: false, body: "oi", timestamp: 1758912000 },
};

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    if (err instanceof HttpException) {
      return err.getStatus();
    }
    throw err;
  }
}

describe("WAHA ingress collapse (054 mirror of the Asaas accept)", () => {
  it("404s unknown routing keys like an unknown endpoint", async () => {
    const { controller } = stubService({ resolve: async () => null });
    expect(await statusOf(controller.receive("nope", BODY, reqWith("s")))).toBe(404);
  });

  it("rejects a bad secret before any accept", async () => {
    const { controller, service } = stubService({ verify: () => ({ ok: false, code: "unauthorized" }) });
    expect(await statusOf(controller.receive("key", BODY, reqWith("wrong")))).toBe(401);
    expect(service.acceptAtomic as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("maps a mid-flight refusal (null accept) to 404 with zero processing", async () => {
    const { controller, processRow } = stubService({ accept: async () => null });
    expect(await statusOf(controller.receive("key", BODY, reqWith("s")))).toBe(404);
    expect(processRow).not.toHaveBeenCalled();
  });

  it("acks duplicates without reprocessing", async () => {
    const { controller, processRow } = stubService({ accept: async () => ({ inserted: false, inboxId: "inbox-dup" }) });
    await expect(controller.receive("key", BODY, reqWith("s"))).resolves.toEqual({ accepted: true, deduped: true });
    expect(processRow).not.toHaveBeenCalled();
  });

  it("defers inline processing with ?defer=1 and processes inline otherwise", async () => {
    const first = stubService({});
    await expect(first.controller.receive("key", BODY, reqWith("s"), "1")).resolves.toEqual({
      accepted: true,
      deduped: false,
    });
    expect(first.processRow).not.toHaveBeenCalled();
    expect(first.processInline).not.toHaveBeenCalled();

    const second = stubService({});
    await expect(second.controller.receive("key", BODY, reqWith("s"))).resolves.toEqual({
      accepted: true,
      deduped: false,
    });
    expect(second.processInline).toHaveBeenCalledOnce();
    expect(second.processInline).toHaveBeenCalledWith(TENANT, "inbox-1", BODY, "inline:waha");
    expect(second.processRow).toHaveBeenCalledOnce();
    expect(second.processRow).toHaveBeenCalledWith(TENANT, "inbox-1", BODY);
  });

  it("skips inline processing when the scheduler drain already claimed the row (no double-processing)", async () => {
    const { controller, processRow, processInline } = stubService({ claimed: false });
    await expect(controller.receive("key", BODY, reqWith("s"))).resolves.toEqual({
      accepted: true,
      deduped: true,
    });
    expect(processInline).toHaveBeenCalledOnce();
    expect(processRow).not.toHaveBeenCalled();
  });

  it("passes the resolved tenant as the expected tenant (remap guard input)", async () => {
    const seen: Array<{ tenantId: string; tenantKey: string }> = [];
    const { controller } = stubService({
      accept: async (input) => {
        seen.push({ tenantId: input.tenantId, tenantKey: input.tenantKey });
        return { inserted: true, inboxId: "inbox-1" };
      },
    });
    await controller.receive("routing-key", BODY, reqWith("s"));
    expect(seen).toEqual([{ tenantId: TENANT, tenantKey: "routing-key" }]);
  });
});
