import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { LocalWorkflowAdapter } from "../src/local-adapter.js";
import {
  HatchetWorkflowAdapter,
  createWorkflowAdapter,
} from "../src/hatchet-adapter.js";
import { HATCHET_SDK_SPECIFIER } from "../src/hatchet-provider.js";

function sdkPresent(): boolean {
  try {
    createRequire(import.meta.url).resolve(HATCHET_SDK_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}

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

describe("HatchetWorkflowAdapter.enqueue honesty contract", () => {
  // Construction is env-gated but performs no network I/O; without start()
  // the adapter holds no engine client, so every enqueue shape must reject
  // instead of resolving — with or without the optional SDK installed.
  const adapter = new HatchetWorkflowAdapter({ HATCHET_CLIENT_TOKEN: "test-token-not-a-secret" });

  it("never resolves before start (no durable claim, no silent drop)", async () => {
    await expect(
      adapter.enqueue({ name: "trial.expire_due", payload: { tenant: "t1" } }),
    ).rejects.toThrow(/not started/);
  });

  it("rejects delayed and keyed shapes before start rather than resolving", async () => {
    await expect(
      adapter.enqueue({
        name: "order.expire_due",
        payload: { id: 1 },
        runAt: new Date(Date.now() + 60_000),
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/not started/);
  });

  it("keeps the empty-name validation ahead of every other guard", async () => {
    await expect(adapter.enqueue({ name: "   ", payload: {} })).rejects.toThrow(/must not be empty/);
  });
});

describe("Hatchet factory fallback", () => {
  it("selects local when no token is configured", () => {
    const selection = createWorkflowAdapter({});
    expect(selection.kind).toBe("local");
    expect(selection.adapter).toBeInstanceOf(LocalWorkflowAdapter);
  });

  it("throws from the constructor without config", () => {
    expect(() => new HatchetWorkflowAdapter({})).toThrow(/HATCHET_CLIENT_TOKEN/);
  });

  it("selects the hatchet adapter when a token resolves and the SDK is installed", () => {
    if (!sdkPresent()) {
      return;
    }
    // Construction performs no network I/O: only env resolution + the sync
    // SDK presence check. Connection happens in start().
    const selection = createWorkflowAdapter({ HATCHET_CLIENT_TOKEN: "test-token-not-a-secret" });
    expect(selection.kind).toBe("hatchet");
    expect(selection.adapter).toBeInstanceOf(HatchetWorkflowAdapter);
  });

  it("falls back to local when provider construction fails, with a logged warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const selection = createWorkflowAdapter(
        { HATCHET_CLIENT_TOKEN: "test-token-not-a-secret" },
        {
          createProvider: () => {
            throw new Error("boom");
          },
        },
      );
      expect(selection.kind).toBe("local");
      expect(selection.adapter).toBeInstanceOf(LocalWorkflowAdapter);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/falling back to local/);
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to local when the SDK is absent, with a logged warning", () => {
    if (sdkPresent()) {
      return;
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // Token set but the optional SDK is not installed: the factory falls
      // back to local (non-durable) — no network call happens on this path.
      const selection = createWorkflowAdapter({ HATCHET_CLIENT_TOKEN: "test-token-not-a-secret" });
      expect(selection.kind).toBe("local");
      expect(selection.adapter).toBeInstanceOf(LocalWorkflowAdapter);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/falling back to local/);
    } finally {
      warn.mockRestore();
    }
  });
});
