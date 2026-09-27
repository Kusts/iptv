import { describe, expect, it, vi } from "vitest";
import { LocalWorkflowAdapter } from "../src/local-adapter.js";
import { HatchetWorkflowAdapter, createWorkflowAdapter } from "../src/hatchet-adapter.js";

describe("LocalWorkflowAdapter", () => {
  it("runs due tasks and skips future runAt until due", async () => {
    const adapter = new LocalWorkflowAdapter();
    const seen: string[] = [];
    adapter.registerHandler("trial.expire_due", async (payload) => {
      seen.push(String(payload["tenant"]));
    });
    await adapter.enqueue({ name: "trial.expire_due", payload: { tenant: "t1" } });
    await adapter.enqueue({
      name: "trial.expire_due",
      payload: { tenant: "t-future" },
      runAt: new Date(Date.now() + 60_000),
    });
    const first = await adapter.tick();
    expect(first).toEqual({ processed: 1, failed: 0 });
    expect(seen).toEqual(["t1"]);
    expect(adapter.pending()).toBe(1);
  });

  it("counts a missing handler as failed and keeps looping (failure isolation)", async () => {
    const adapter = new LocalWorkflowAdapter();
    const seen: string[] = [];
    adapter.registerHandler("ok.task", async () => {
      seen.push("ok");
    });
    adapter.registerHandler("bad.task", async () => {
      throw new Error("boom");
    });
    await adapter.enqueue({ name: "bad.task", payload: {} });
    await adapter.enqueue({ name: "missing.task", payload: {} });
    await adapter.enqueue({ name: "ok.task", payload: {} });
    const result = await adapter.tick();
    expect(result).toEqual({ processed: 1, failed: 2 });
    expect(seen).toEqual(["ok"]);
  });

  it("drops idempotency-key replays", async () => {
    const adapter = new LocalWorkflowAdapter();
    let calls = 0;
    adapter.registerHandler("order.expire_due", async () => {
      calls += 1;
    });
    const first = await adapter.enqueue({ name: "order.expire_due", payload: {}, idempotencyKey: "k1" });
    const replay = await adapter.enqueue({ name: "order.expire_due", payload: {}, idempotencyKey: "k1" });
    expect(first.durable).toBe(false);
    expect(replay.id).toBe(first.id);
    expect(adapter.pending()).toBe(1);
    await adapter.tick();
    expect(calls).toBe(1);
  });

  it("rejects duplicate handler registration", () => {
    const adapter = new LocalWorkflowAdapter();
    adapter.registerHandler("x", async () => undefined);
    expect(() => adapter.registerHandler("x", async () => undefined)).toThrow(/already registered/);
  });
});

describe("Hatchet factory fallback", () => {
  it("selects local when no token is configured", () => {
    const selection = createWorkflowAdapter({});
    expect(selection.kind).toBe("local");
    expect(selection.adapter).toBeInstanceOf(LocalWorkflowAdapter);
  });

  it("throws from the constructor without config", () => {
    expect(() => new HatchetWorkflowAdapter({})).toThrow(/HATCHET_API_TOKEN/);
  });

  it("falls back to local when the SDK is absent, with a logged warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // Token set but the optional SDK is not installed: the constructor
      // throws and the factory falls back to local (non-durable) — no
      // network call happens anywhere on this path.
      expect(() => new HatchetWorkflowAdapter({ HATCHET_API_TOKEN: "test-token" })).toThrow(
        /not installed/,
      );
      const selection = createWorkflowAdapter({ HATCHET_API_TOKEN: "test-token" });
      expect(selection.kind).toBe("local");
      expect(selection.adapter).toBeInstanceOf(LocalWorkflowAdapter);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/falling back to local/);
    } finally {
      warn.mockRestore();
    }
  });
});
