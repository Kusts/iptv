import { describe, expect, it } from "vitest";
import { HttpException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { BotServiceController } from "../src/bot/bot-service.controller.js";

const controller = new BotServiceController(null, {} as never);
const base = { messageId: "m", requestedAt: new Date().toISOString(), idempotencyKey: "k" };
const personId = "73000000-0000-4000-8000-000000000001";
const orderId = "73000000-0000-4000-8000-000000000002";
const req = (body: unknown) => ({ body }) as FastifyRequest;
async function rejects400(method: (request: FastifyRequest) => Promise<unknown>, body: unknown) {
  await expect(method.call(controller, req(body))).rejects.toMatchObject({ status: 400 });
}

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
    await expect(controller.quote(req({ ...base, personId, planId: orderId }))).rejects.toMatchObject({ status: 503 });
  });

  it("validates strict shapes for the capabilities deliberately blocked with 501", async () => {
    await expect(controller.getTrial(req({ ...base, personId }))).rejects.toMatchObject({ status: 501 });
    await rejects400(controller.getTrial, { ...base, personId, durationHours: 100 });
  });
});
