/**
 * F12 vertical-slice tests: Hatchet adapter against the in-process
 * `FakeHatchetEngine` (no cluster, no network, no secrets).
 *
 * - happy path: register → start → enqueue → worker execution, persisted
 *   run id, retry/timeout declaration config;
 * - crash/restart: a queued run survives a worker death and a second
 *   adapter over the same engine resumes it; a crash-after-effect
 *   redelivers WITHOUT recording the side effect twice (at-least-once +
 *   idempotent consumer keyed by `__dedupeKey` — never exactly-once);
 * - provider-unavailable: bounded retry then recovery, or fail-closed
 *   exhaustion that records nothing as durable;
 * - cancel path + graceful shutdown;
 * - env wiring: canonical `HATCHET_CLIENT_*`, legacy compat with warnings,
 *   fail-closed without a token;
 * - real-SDK wiring proof (conditional on the optional dependency being
 *   installed): exact specifier/version + `init()` shape, construction-only.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  HATCHET_RUN_DEDUPE_KEY,
  HatchetWorkflowAdapter,
  createWorkflowAdapter,
} from "../src/hatchet-adapter.js";
import { resolveHatchetEnv } from "../src/hatchet-env.js";
import { FakeHatchetEngine } from "../src/fake-hatchet.js";
import {
  HATCHET_SDK_SPECIFIER,
  HATCHET_SDK_VERSION,
  resolveHatchetSdkInit,
} from "../src/hatchet-provider.js";

const TEST_ENV = { HATCHET_CLIENT_TOKEN: "test-token-not-a-secret" };

function testAdapter(
  engine: FakeHatchetEngine,
  opts: { warnings?: string[]; attempts?: number; baseDelayMs?: number } = {},
): HatchetWorkflowAdapter {
  const warnings = opts.warnings;
  // `certified: true` here is TEST-ONLY mechanics exercise: it lets the
  // adapter walk the certified path against the in-memory double. It asserts
  // NO real durability (the fake persists nothing) and NO W0-04
  // certification — production adapters are uncertified by default.
  return new HatchetWorkflowAdapter(TEST_ENV, {
    provider: engine.createProvider(),
    workerName: "test-worker",
    certified: true,
    retry: { attempts: opts.attempts ?? 5, baseDelayMs: opts.baseDelayMs ?? 1 },
    onWarning: (message: string) => {
      warnings?.push(message);
    },
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sdkPresent(): boolean {
  try {
    createRequire(import.meta.url).resolve(HATCHET_SDK_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}

describe("resolveHatchetEnv", () => {
  it("resolves canonical HATCHET_CLIENT_* without warnings", () => {
    const resolution = resolveHatchetEnv({
      HATCHET_CLIENT_TOKEN: "tok",
      HATCHET_CLIENT_API_URL: "https://hatchet.example",
      HATCHET_CLIENT_NAMESPACE: "tenant-a",
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      return;
    }
    expect(resolution.config.token).toBe("tok");
    expect(resolution.config.apiUrl).toBe("https://hatchet.example");
    expect(resolution.config.namespace).toBe("tenant-a");
    expect(resolution.config.usedLegacyToken).toBe(false);
    expect(resolution.warnings).toEqual([]);
  });

  it("compat-maps legacy HATCHET_API_TOKEN/HATCHET_SERVER_URL with warnings", () => {
    const warnings: string[] = [];
    const adapter = new HatchetWorkflowAdapter(
      { HATCHET_API_TOKEN: "legacy-not-a-secret", HATCHET_SERVER_URL: "https://legacy.example" },
      { provider: new FakeHatchetEngine().createProvider(), onWarning: (m) => warnings.push(m) },
    );
    expect(adapter.started).toBe(false);
    expect(warnings.some((w) => w.includes("HATCHET_API_TOKEN is deprecated"))).toBe(true);
    expect(warnings.some((w) => w.includes("HATCHET_SERVER_URL is deprecated"))).toBe(true);
    const resolution = resolveHatchetEnv({
      HATCHET_API_TOKEN: "legacy",
      HATCHET_SERVER_URL: "https://legacy.example",
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      return;
    }
    expect(resolution.config.usedLegacyToken).toBe(true);
    expect(resolution.config.usedLegacyServerUrl).toBe(true);
  });

  it("prefers canonical vars when both are set, with a warning", () => {
    const resolution = resolveHatchetEnv({
      HATCHET_CLIENT_TOKEN: "canonical",
      HATCHET_API_TOKEN: "legacy",
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      return;
    }
    expect(resolution.config.token).toBe("canonical");
    expect(resolution.config.usedLegacyToken).toBe(false);
    expect(resolution.warnings.some((w) => w.includes("HATCHET_CLIENT_TOKEN"))).toBe(true);
  });

  it("fails closed without a token; empty string counts as absent", () => {
    expect(resolveHatchetEnv({}).ok).toBe(false);
    expect(resolveHatchetEnv({ HATCHET_CLIENT_TOKEN: "" }).ok).toBe(false);
    const resolution = resolveHatchetEnv({});
    if (resolution.ok) {
      throw new Error("expected failure");
    }
    expect(resolution.reason).toMatch(/HATCHET_CLIENT_TOKEN/);
    expect(() => new HatchetWorkflowAdapter({})).toThrow(/HATCHET_CLIENT_TOKEN/);
    expect(createWorkflowAdapter({}).kind).toBe("local");
  });
});

describe("hatchet durable slice: fail-closed guards", () => {
  it("refuses enqueue before start, unknown handlers, and double start", async () => {
    const engine = new FakeHatchetEngine();
    const adapter = testAdapter(engine);
    adapter.registerHandler("trial.expire_due", async () => undefined);
    await expect(adapter.enqueue({ name: "trial.expire_due", payload: {} })).rejects.toThrow(/not started/);
    await adapter.start();
    await expect(adapter.enqueue({ name: "nope.missing", payload: {} })).rejects.toThrow(/no handler registered/);
    await expect(adapter.start()).rejects.toThrow(/already started/);
    expect(() => adapter.registerHandler("late.handler", async () => undefined)).toThrow(/before start/);
    await adapter.stop();
  });

  it("refuses delayed runAt and reserved payload keys instead of mis-scheduling", async () => {
    const engine = new FakeHatchetEngine();
    const adapter = testAdapter(engine);
    adapter.registerHandler("order.expire_due", async () => undefined);
    await adapter.start();
    try {
      await expect(
        adapter.enqueue({ name: "order.expire_due", payload: {}, runAt: new Date(Date.now() + 60_000) }),
      ).rejects.toThrow(/delayed runAt/);
      await expect(
        adapter.enqueue({ name: "order.expire_due", payload: { [HATCHET_RUN_DEDUPE_KEY]: "x" } }),
      ).rejects.toThrow(/reserved keys/);
      expect(engine.runs).toHaveLength(0);
    } finally {
      await adapter.stop();
    }
  });

  it("rejects duplicate handler registration", () => {
    const adapter = testAdapter(new FakeHatchetEngine());
    adapter.registerHandler("x", async () => undefined);
    expect(() => adapter.registerHandler("x", async () => undefined)).toThrow(/already registered/);
  });

  it("refuses durable claims without certification: uncertified enqueue throws before any trigger", async () => {
    const engine = new FakeHatchetEngine();
    const adapter = new HatchetWorkflowAdapter(TEST_ENV, {
      provider: engine.createProvider(),
      workerName: "test-worker",
      retry: { attempts: 5, baseDelayMs: 1 },
      onWarning: () => undefined,
    });
    adapter.registerHandler("trial.expire_due", async () => undefined);
    await adapter.start();
    try {
      await expect(adapter.enqueue({ name: "trial.expire_due", payload: {} })).rejects.toThrow(/not certified/);
      expect(engine.triggerAttempts).toBe(0);
      expect(engine.runs).toHaveLength(0);
    } finally {
      await adapter.stop();
    }
  });

  it("opts into the certified path only via explicit flag or HATCHET_DURABLE_CERTIFIED", async () => {
    const engine = new FakeHatchetEngine();
    const viaEnv = new HatchetWorkflowAdapter(
      { ...TEST_ENV, HATCHET_DURABLE_CERTIFIED: "1" },
      { provider: engine.createProvider(), workerName: "test-worker", onWarning: () => undefined },
    );
    viaEnv.registerHandler("trial.expire_due", async () => undefined);
    await viaEnv.start();
    try {
      const result = await viaEnv.enqueue({ name: "trial.expire_due", payload: {} });
      expect(result.durable).toBe(true);
    } finally {
      await viaEnv.stop();
    }
  });
});

describe("hatchet durable slice: happy path", () => {
  it("declares tasks with retry/timeout config, triggers a durable run, executes via the worker", async () => {
    const engine = new FakeHatchetEngine();
    const adapter = testAdapter(engine);
    const seen: Record<string, unknown>[] = [];
    adapter.registerHandler(
      "trial.expire_due",
      async (payload) => {
        seen.push(payload);
      },
      { retries: 2, executionTimeout: "60s", scheduleTimeout: "5m", backoffMaxSeconds: 30 },
    );
    await adapter.start();
    const result = await adapter.enqueue({
      name: "trial.expire_due",
      payload: { tenant: "t1" },
      idempotencyKey: "dedupe-1",
    });
    expect(result.durable).toBe(true);
    expect(result.id).toMatch(/^fake-run-/);
    await waitFor(() => engine.runById(result.id)?.status === "succeeded");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.["tenant"]).toBe("t1");
    // Handler sees the dedupe key (idempotent-consumer contract) but never
    // the adapter-internal routing key.
    expect(typeof seen[0]?.[HATCHET_RUN_DEDUPE_KEY]).toBe("string");
    expect(seen[0]?.["__task"]).toBeUndefined();
    const declared = engine.declared.find((d) => d.name === "trial.expire_due");
    expect(declared).toMatchObject({
      retries: 2,
      executionTimeout: "60s",
      scheduleTimeout: "5m",
      backoffMaxSeconds: 30,
    });
    expect(await adapter.tick()).toEqual({ processed: 0, failed: 0 });
    await adapter.stop();
  });

  it("dedupes in-flight triggers on the caller idempotency key", async () => {
    const engine = new FakeHatchetEngine();
    engine.pauseDrain = true;
    const adapter = testAdapter(engine);
    let calls = 0;
    adapter.registerHandler("order.expire_due", async () => {
      calls += 1;
    });
    await adapter.start();
    try {
      const first = await adapter.enqueue({ name: "order.expire_due", payload: {}, idempotencyKey: "k1" });
      const replay = await adapter.enqueue({ name: "order.expire_due", payload: {}, idempotencyKey: "k1" });
      expect(replay.id).toBe(first.id);
      expect(replay.durable).toBe(true);
      expect(engine.runs).toHaveLength(1);
      engine.pauseDrain = false;
      await waitFor(() => engine.runById(first.id)?.status === "succeeded");
      expect(calls).toBe(1);
    } finally {
      engine.pauseDrain = false;
      await adapter.stop();
    }
  });
});

describe("hatchet durable slice: crash/restart resume", () => {
  it("resumes a queued run on a new adapter without repeating the recorded side effect", async () => {
    const engine = new FakeHatchetEngine();
    engine.pauseDrain = true;

    // First worker: crashes before it can drain (simulates a deploy kill).
    const adapter1 = testAdapter(engine);
    adapter1.registerHandler("charge.expire_due", async () => undefined);
    await adapter1.start();
    const enqueued = await adapter1.enqueue({ name: "charge.expire_due", payload: { tenant: "t9" } });
    await adapter1.stop();
    expect(engine.runById(enqueued.id)?.status).toBe("queued");

    // Restart: a NEW adapter over the SAME engine journal resumes the run.
    // The effect sink dedupes on __dedupeKey (at-least-once, no exactly-once
    // claim): the crash-after-effect redelivery must not record twice.
    let fnCalls = 0;
    const recordedEffects: string[] = [];
    const seenKeys = new Set<string>();
    const adapter2 = testAdapter(engine);
    adapter2.registerHandler("charge.expire_due", async (payload) => {
      fnCalls += 1;
      const key = String(payload[HATCHET_RUN_DEDUPE_KEY]);
      if (seenKeys.has(key)) {
        return;
      }
      seenKeys.add(key);
      recordedEffects.push(key);
    });
    await adapter2.start();
    try {
      engine.crashNextRun = true;
      engine.pauseDrain = false;
      await waitFor(() => engine.runById(enqueued.id)?.status === "succeeded");
      // The function ran twice (initial + redelivery after the crash) but
      // the recorded side effect exists exactly once.
      expect(fnCalls).toBe(2);
      expect(recordedEffects).toHaveLength(1);
    } finally {
      engine.pauseDrain = false;
      await adapter2.stop();
    }
  });
});

describe("hatchet durable slice: provider-unavailable retry", () => {
  it("retries transient connect/trigger failures and recovers", async () => {
    const engine = new FakeHatchetEngine();
    engine.failConnectTimes = 2;
    engine.failTriggerTimes = 2;
    const warnings: string[] = [];
    const adapter = testAdapter(engine, { warnings });
    adapter.registerHandler("trial.expire_due", async () => undefined);
    await adapter.start();
    expect(engine.connectAttempts).toBe(3);
    const result = await adapter.enqueue({ name: "trial.expire_due", payload: {} });
    expect(result.durable).toBe(true);
    expect(engine.triggerAttempts).toBe(3);
    expect(warnings.some((w) => w.includes("connect") && w.includes("retrying"))).toBe(true);
    await waitFor(() => engine.runById(result.id)?.status === "succeeded");
    await adapter.stop();
  });

  it("fails closed when retries are exhausted, recording nothing as durable", async () => {
    const engine = new FakeHatchetEngine();
    engine.failTriggerTimes = 99;
    const adapter = testAdapter(engine, { attempts: 3, baseDelayMs: 1 });
    adapter.registerHandler("trial.expire_due", async () => undefined);
    await adapter.start();
    try {
      await expect(adapter.enqueue({ name: "trial.expire_due", payload: {} })).rejects.toThrow(
        /trigger run.*failed after 3 attempt/,
      );
      expect(engine.runs).toHaveLength(0);
    } finally {
      await adapter.stop();
    }
  });
});

describe("hatchet durable slice: cancel + graceful shutdown", () => {
  it("cancels a queued run so it never executes", async () => {
    const engine = new FakeHatchetEngine();
    engine.pauseDrain = true;
    const adapter = testAdapter(engine);
    let calls = 0;
    adapter.registerHandler("trial.expire_due", async () => {
      calls += 1;
    });
    await adapter.start();
    try {
      const result = await adapter.enqueue({ name: "trial.expire_due", payload: {} });
      await adapter.cancel(result.id);
      engine.pauseDrain = false;
      await waitFor(() => engine.runById(result.id)?.status === "cancelled");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(0);
      await expect(adapter.cancel("fake-run-does-not-exist")).rejects.toThrow(/cancel failed/);
      await expect(adapter.cancel("")).rejects.toThrow(/must not be empty/);
    } finally {
      engine.pauseDrain = false;
      await adapter.stop();
    }
  });

  it("stops gracefully: stop is idempotent and ends new work", async () => {
    const engine = new FakeHatchetEngine();
    const adapter = testAdapter(engine);
    adapter.registerHandler("trial.expire_due", async () => undefined);
    await adapter.start();
    const result = await adapter.enqueue({ name: "trial.expire_due", payload: {} });
    await waitFor(() => engine.runById(result.id)?.status === "succeeded");
    await adapter.stop();
    await adapter.stop();
    await expect(adapter.enqueue({ name: "trial.expire_due", payload: {} })).rejects.toThrow(/not started/);
    await expect(adapter.start()).rejects.toThrow(/stopped/);
  });

  it("aborts trigger retries after stop: no second engine call post-shutdown", async () => {
    const engine = new FakeHatchetEngine();
    engine.failTriggerTimes = 1;
    const adapter = new HatchetWorkflowAdapter(TEST_ENV, {
      provider: engine.createProvider(),
      workerName: "test-worker",
      certified: true,
      retry: { attempts: 5, baseDelayMs: 200 },
      onWarning: () => undefined,
    });
    adapter.registerHandler("trial.expire_due", async () => undefined);
    await adapter.start();
    const pending = adapter.enqueue({ name: "trial.expire_due", payload: {} });
    await waitFor(() => engine.triggerAttempts === 1);
    await adapter.stop();
    await expect(pending).rejects.toThrow(/aborted/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(engine.triggerAttempts).toBe(1);
  });

  it("stop waits for the active handler: graceful shutdown finishes in-flight work", async () => {
    const engine = new FakeHatchetEngine();
    const adapter = testAdapter(engine);
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let effects = 0;
    adapter.registerHandler("trial.expire_due", async () => {
      entered = true;
      await gate;
      effects += 1;
    });
    await adapter.start();
    const result = await adapter.enqueue({ name: "trial.expire_due", payload: {} });
    await waitFor(() => entered);
    let stopped = false;
    const stopping = adapter.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(effects).toBe(1);
    expect(engine.runById(result.id)?.status).toBe("succeeded");
  });
});

describe("hatchet real-SDK wiring proof", () => {
  // NOTE (F12-FIX-03): the `await import()` below pulls the full published
  // SDK graph (grpc/protobuf/rest clients) into the test worker — ~350ms
  // warm, but 11026ms on the loaded canonical rerun (F12-CANONICAL-01),
  // exceeding vitest's 5s default per-test timeout. The raised timeout is a
  // mechanism fix only: the specifier+version+init() assertions below are
  // unchanged. Shape-only — no client construction, no network.
  it("pins the exact published specifier + version and exposes init()", async () => {
    if (!sdkPresent()) {
      return;
    }
    expect(HATCHET_SDK_SPECIFIER).toBe("@hatchet-dev/typescript-sdk");
    expect(HATCHET_SDK_VERSION).toBe("1.37.0");
    const require = createRequire(import.meta.url);
    const pkg = require(`${HATCHET_SDK_SPECIFIER}/package.json`) as { version: string };
    expect(pkg.version).toBe(HATCHET_SDK_VERSION);
    // Shape only — no client construction, no network. Resolved through
    // the same normalizer `RealHatchetProvider.connect()` uses, so the
    // CJS-entry double-default interop (`exports.default = HatchetClient`)
    // passes here exactly as it does in production wiring.
    const mod = (await import(HATCHET_SDK_SPECIFIER)) as unknown;
    expect(mod).toBeDefined();
    const resolved = resolveHatchetSdkInit(mod);
    expect(typeof resolved.init).toBe("function");
  }, 30_000);

  it("documents the fail-closed fallback when the SDK is absent", () => {
    if (sdkPresent()) {
      return;
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const selection = createWorkflowAdapter(TEST_ENV);
      expect(selection.kind).toBe("local");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
