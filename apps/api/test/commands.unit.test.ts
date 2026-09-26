import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildEnvelope, newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { InboxProcessor } from "../src/inbox/inbox-processor.js";
import {
  registerHumanReviewCommands,
} from "../src/human-review/human-review.commands.js";
import { MemoryDb, MemoryInboxStore } from "./fakes/memory-fakes.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

function actor(overrides: Partial<CommandActor> = {}): CommandActor {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    isPlatformAdmin: false,
    tenantId: TENANT,
    roleKeys: ["tenant_owner"],
    permissions: ["agent.review.request", "agent.review.decide"],
    actorType: "human",
    ...overrides,
  };
}

function reviewInput(overrides: Record<string, unknown> = {}) {
  return {
    resourceType: "refund_request",
    resourceId: "33333333-3333-4333-8333-333333333333",
    reviewMode: "APPROVAL",
    reason: "FINANCIAL_REVIEW",
    summary: "refund above auto-approve threshold",
    ...overrides,
  };
}

function setup(revalidate?: (ctx: never, req: never) => Promise<string | null>) {
  const db = new MemoryDb();
  const bus = new CommandBus(db);
  registerHumanReviewCommands(bus, revalidate === undefined ? {} : { revalidate: revalidate as never });
  return { db, bus };
}

describe("CommandBus with fake db", () => {
  it("rejects unknown commands without touching the database", async () => {
    const { db, bus } = setup();
    const result = await bus.execute(actor(), "nope.missing", {});
    expect(result).toEqual({ ok: false, code: "not_found", message: "unknown command: nope.missing" });
    expect(db.txByTenant.size).toBe(0);
  });

  it("rejects invalid input before any state change", async () => {
    const { db, bus } = setup();
    const result = await bus.execute(actor(), "human_review.request", { resourceType: "x" });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("validation_failed");
    expect(db.txFor(TENANT).audits).toHaveLength(0);
    expect(db.txFor(TENANT).events).toHaveLength(0);
  });

  it("rejects missing permission (forbidden) without executing", async () => {
    const { db, bus } = setup();
    const op = actor({ permissions: ["agent.review.request"] });
    const result = await bus.execute(op, "human_review.approve", { requestId: newId() });
    expect(result).toEqual({ ok: false, code: "forbidden", message: "missing permission: agent.review.decide" });
    expect(db.txByTenant.size).toBe(0);
  });

  it("rejects tenant-less actors", async () => {
    const { bus } = setup();
    const result = await bus.execute(actor({ tenantId: null }), "human_review.request", reviewInput());
    expect(result.ok ? null : result.code).toBe("forbidden");
  });

  it("executes request atomically: state + event + outbox + audit in one tx", async () => {
    const { db, bus } = setup();
    const result = await bus.execute<{ id: string }>(actor(), "human_review.request", reviewInput());
    expect(result.ok).toBe(true);
    const tx = db.txFor(TENANT);
    expect(tx.reviews.size).toBe(1);
    expect(tx.events).toHaveLength(1);
    expect(tx.events[0]?.event_type).toBe("hitl.review_requested.v1");
    expect(tx.events[0]?.schema_version).toBe(1);
    expect(tx.outbox).toHaveLength(1);
    expect(tx.audits).toHaveLength(1);
    expect(tx.audits[0]?.action).toBe("human_review.request");
  });

  it("replays idempotent requests without re-executing", async () => {
    const { db, bus } = setup();
    const first = await bus.execute<{ id: string }>(actor(), "human_review.request", reviewInput(), {
      idempotencyKey: "key-1",
    });
    expect(first.ok).toBe(true);
    const second = await bus.execute<{ id: string }>(actor(), "human_review.request", reviewInput(), {
      idempotencyKey: "key-1",
    });
    expect(second).toEqual(first);
    expect(db.txFor(TENANT).reviews.size).toBe(1);
    const conflict = await bus.execute(actor(), "human_review.request", reviewInput({ summary: "different" }), {
      idempotencyKey: "key-1",
    });
    expect(conflict.ok ? null : conflict.code).toBe("validation_failed");
  });

  it("rejects stale approvals via expectedStatus and keeps the request open", async () => {
    const { db, bus } = setup();
    const created = await bus.execute<{ id: string }>(actor(), "human_review.request", reviewInput());
    expect(created.ok).toBe(true);
    const id = (created as { ok: true; data: { id: string } }).data.id;
    const stale = await bus.execute(actor(), "human_review.approve", { requestId: id, expectedStatus: "QUEUED" });
    expect(stale).toEqual({
      ok: false,
      code: "precondition_failed",
      message: "stale approval rejected: expected QUEUED, current REQUESTED",
    });
    expect(db.txFor(TENANT).reviews.get(id)?.status).toBe("REQUESTED");
  });

  it("rejects second decisions as stale and runs the target revalidator hook", async () => {
    const { bus } = setup(async () => "target no longer eligible");
    const created = await bus.execute<{ id: string }>(actor(), "human_review.request", reviewInput());
    const id = (created as { ok: true; data: { id: string } }).data.id;
    const blocked = await bus.execute(actor(), "human_review.approve", { requestId: id });
    expect(blocked.ok ? null : blocked.code).toBe("precondition_failed");
    expect(blocked.ok ? "" : blocked.message).toContain("target no longer eligible");
  });

  it("resolves on approve and rejects later decisions as already-resolved", async () => {
    const { db, bus } = setup();
    const created = await bus.execute<{ id: string }>(actor(), "human_review.request", reviewInput());
    const id = (created as { ok: true; data: { id: string } }).data.id;
    const approved = await bus.execute<{ id: string; resolution: string }>(actor(), "human_review.approve", {
      requestId: id,
      expectedStatus: "REQUESTED",
    });
    expect(approved).toEqual({ ok: true, data: { id, resolution: "APPROVED" } });
    const again = await bus.execute(actor(), "human_review.reject", { requestId: id });
    expect(again.ok ? null : again.code).toBe("precondition_failed");
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toEqual([
      "hitl.review_requested.v1",
      "hitl.review_resolved.v1",
    ]);
  });

  it("rolls back partial writes when a handler throws", async () => {
    const db = new MemoryDb();
    const bus = new CommandBus(db);
    bus.register({
      name: "test.explode",
      permission: "agent.review.request",
      auditAction: "test.explode",
      auditResource: "test",
      input: z.object({}),
      handler: async (ctx) => {
        const envelope = buildEnvelope({
          event_type: "hitl.review_requested.v1",
          tenant_id: ctx.tenantId,
          aggregate_type: "human_review",
          aggregate_id: newId(),
          aggregate_version: 1,
          data: { review_id: "x" },
          actor: { type: "human", id: ctx.actor.userId },
          correlation_id: ctx.correlationId,
        });
        await ctx.tx.emitDomainEvent({ envelope });
        throw new Error("boom");
      },
    });
    await expect(bus.execute(actor(), "test.explode", {})).rejects.toThrow("boom");
    expect(db.txFor(TENANT).events).toHaveLength(0);
    expect(db.txFor(TENANT).audits).toHaveLength(0);
  });
});

describe("InboxProcessor with fake store", () => {
  function envelope() {
    return buildEnvelope({
      event_type: "hitl.review_requested.v1",
      tenant_id: TENANT,
      aggregate_type: "human_review",
      aggregate_id: newId(),
      aggregate_version: 1,
      data: { review_id: newId() },
      actor: { type: "human", id: "u" },
    });
  }

  it("processes once: second accept with the same key is a dedupe no-op", async () => {
    const processor = new InboxProcessor(new MemoryInboxStore());
    let calls = 0;
    processor.on("hitl.review_requested.v1", async () => {
      calls += 1;
    });
    const payload = JSON.parse(JSON.stringify(envelope())) as unknown;
    const eventId = (payload as { event_id: string }).event_id;
    const first = await processor.accept({ tenantId: TENANT, provider: "local-outbox", externalEventId: eventId, payload });
    expect(first.status).toBe("processed");
    const second = await processor.accept({ tenantId: TENANT, provider: "local-outbox", externalEventId: eventId, payload });
    expect(second.status).toBe("duplicate");
    expect(second.inboxId).toBe(first.inboxId);
    expect(calls).toBe(1);
  });
});
