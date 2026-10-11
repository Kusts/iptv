/**
 * F12 review-fix regressions (reviewer verdict CHANGES_REQUIRED, F12-REVIEW-02).
 *
 * Each test below fails on the pre-fix slice and passes after the fix
 * (F12-FIX-01 acceptance criterion 1):
 * - P1: two concurrent `enqueue()` calls with the same `idempotencyKey` must
 *   trigger exactly ONE engine run (reservation happens BEFORE the first
 *   await; rejected reservations are dropped, never cached).
 * - P2a: concurrent `start()` x2 must create a single worker (lifecycle
 *   serialization via a `starting` state).
 * - P2b: `stop()` during `connect()` must land on a terminal stopped state
 *   with no orphan worker (pending startup is tracked, partial resources
 *   are cleaned, never adopted).
 * - P2c: ANY future `runAt` instant is refused (scheduling is unimplemented),
 *   and invalid dates are refused; past/present `runAt` still enqueues.
 *
 * All doubles are in-process (fake provider / FakeHatchetEngine): zero
 * network, zero secrets, zero live Hatchet use.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HatchetWorkflowAdapter } from "../src/hatchet-adapter.js";
import { FakeHatchetEngine } from "../src/fake-hatchet.js";
import type {
  HatchetClientProvider,
  HatchetEngineClient,
  HatchetRunHandle,
  HatchetTaskDeclaration,
  HatchetWorkerHandle,
} from "../src/hatchet-provider.js";

const TEST_ENV = { HATCHET_CLIENT_TOKEN: "test-token-not-a-secret" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.useRealTimers();
});

/** Adapter wired to an injected provider (tests only, no network). */
function testAdapter(
  provider: HatchetClientProvider,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): HatchetWorkflowAdapter {
  return new HatchetWorkflowAdapter(TEST_ENV, {
    provider,
    workerName: "test-worker",
    retry: { attempts: opts.attempts ?? 5, baseDelayMs: opts.baseDelayMs ?? 1 },
    onWarning: () => undefined,
  });
}

interface BarrierHarness {
  provider: HatchetClientProvider;
  triggerCalls: () => number;
  releaseTrigger: () => void;
}

/**
 * Provider whose trigger blocks on a test-controlled gate, so two
 * concurrent `enqueue()` calls are guaranteed to overlap inside the first
 * `await` — the exact window the pre-fix code left unguarded. The worker
 * stub resolves its background `start()` when `stop()` is called, so
 * `adapter.stop()` never hangs.
 */
function barrierTriggerProvider(): BarrierHarness {
  let releaseTrigger!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseTrigger = resolve;
  });
  let calls = 0;
  const declaration: HatchetTaskDeclaration = {
    taskName: "order.expire_due",
    runNoWait: async (): Promise<HatchetRunHandle> => {
      calls += 1;
      await gate;
      return { runId: "fake-run-1" };
    },
  };
  let stopWorker!: () => void;
  const workerDone = new Promise<void>((resolve) => {
    stopWorker = resolve;
  });
  const worker: HatchetWorkerHandle = {
    registerWorkflows: async () => undefined,
    start: () => workerDone,
    stop: async () => {
      stopWorker();
    },
  };
  const client: HatchetEngineClient = {
    declareTask: () => declaration,
    createWorker: async () => worker,
    runs: {
      cancel: async () => undefined,
    },
  };
  return {
    provider: { kind: "barrier-test", connect: async () => client },
    triggerCalls: () => calls,
    releaseTrigger: () => releaseTrigger(),
  };
}

/**
 * Wraps the shared fake engine so `connect()` blocks on a test-controlled
 * gate while worker accounting (connect/worker-create counts) stays on the
 * engine journal. `onEnter` fires the moment `connect()` is entered — still
 * parked BEFORE the gate — so the test can prove the overlap window (the
 * engine's own `connectAttempts` counter only increments after the gate).
 */
function gatedConnectProvider(
  engine: FakeHatchetEngine,
  gate: Promise<void>,
  onEnter: () => void,
): HatchetClientProvider {
  const inner = engine.createProvider();
  return {
    kind: "gated-fake",
    connect: async (): Promise<HatchetEngineClient> => {
      onEnter();
      await gate;
      return inner.connect();
    },
  };
}

describe("F12-FIX-01 P1: concurrent same-key enqueues create exactly one run", () => {
  it("dedupes concurrent enqueues onto a single trigger", async () => {
    const harness = barrierTriggerProvider();
    const adapter = testAdapter(harness.provider, { attempts: 1 });
    adapter.registerHandler("order.expire_due", async () => undefined);
    await adapter.start();
    try {
      const task = { name: "order.expire_due", payload: {}, idempotencyKey: "race-key" };
      const first = adapter.enqueue(task);
      const second = adapter.enqueue(task);
      // Both calls are now parked inside the first await (trigger gate
      // still closed): the second must NOT have issued its own trigger.
      await sleep(25);
      expect(harness.triggerCalls()).toBe(1);
      harness.releaseTrigger();
      const [r1, r2] = await Promise.all([first, second]);
      expect(r1).toEqual({ id: "fake-run-1", durable: true });
      expect(r2.id).toBe(r1.id);
      expect(r2.durable).toBe(true);
    } finally {
      harness.releaseTrigger();
      await adapter.stop();
    }
  });

  it("drops rejected reservations so a later enqueue retries instead of observing a stale failure", async () => {
    let failuresLeft = 2;
    const declaration: HatchetTaskDeclaration = {
      taskName: "trial.expire_due",
      runNoWait: async (): Promise<HatchetRunHandle> => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("barrier-test: transient trigger failure");
        }
        return { runId: "fake-run-healed" };
      },
    };
    let stopWorker!: () => void;
    const workerDone = new Promise<void>((resolve) => {
      stopWorker = resolve;
    });
    const worker: HatchetWorkerHandle = {
      registerWorkflows: async () => undefined,
      start: () => workerDone,
      stop: async () => {
        stopWorker();
      },
    };
    const client: HatchetEngineClient = {
      declareTask: () => declaration,
      createWorker: async () => worker,
      runs: {
        cancel: async () => undefined,
      },
    };
    const adapter = testAdapter(
      { kind: "flaky-test", connect: async () => client },
      { attempts: 2 },
    );
    adapter.registerHandler("trial.expire_due", async () => undefined);
    await adapter.start();
    try {
      const task = { name: "trial.expire_due", payload: {}, idempotencyKey: "flaky-key" };
      await expect(adapter.enqueue(task)).rejects.toThrow(/failed after 2 attempt/);
      // The rejected reservation must be gone: the healed engine accepts a
      // fresh trigger for the same key (failures are never cached).
      const healed = await adapter.enqueue(task);
      expect(healed).toEqual({ id: "fake-run-healed", durable: true });
    } finally {
      await adapter.stop();
    }
  });
});

describe("F12-FIX-01 P2a: concurrent start() creates a single worker", () => {
  it("serializes concurrent start() calls: one worker, loser observes already-started", async () => {
    const engine = new FakeHatchetEngine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enteredConnect = false;
    const adapter = testAdapter(gatedConnectProvider(engine, gate, () => {
      enteredConnect = true;
    }));
    adapter.registerHandler("trial.expire_due", async () => undefined);
    const first = adapter.start();
    const second = adapter.start();
    // Both calls are parked inside connect(): the second must NOT have
    // issued its own connect.
    await sleep(25);
    expect(enteredConnect).toBe(true);
    release();
    await first;
    await expect(second).rejects.toThrow(/already started/);
    expect(engine.connectAttempts).toBe(1);
    expect(engine.workerCreateAttempts).toBe(1);
    expect(engine.workerNames).toEqual(["test-worker"]);
    expect(adapter.started).toBe(true);
    await adapter.stop();
  });
});

describe("F12-FIX-01 P2b: stop() during connect() leaves no orphan worker", () => {
  it("lands terminal stopped with zero workers created", async () => {
    const engine = new FakeHatchetEngine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enteredConnect = false;
    const adapter = testAdapter(gatedConnectProvider(engine, gate, () => {
      enteredConnect = true;
    }));
    adapter.registerHandler("trial.expire_due", async () => undefined);
    const starting = adapter.start();
    await sleep(25);
    // Prove the startup is really parked inside connect() before stopping.
    expect(enteredConnect).toBe(true);
    const stopping = adapter.stop();
    release();
    const startOutcome = await starting.then(
      () => ({ settled: "resolved" }) as const,
      (err: unknown) => ({ settled: "rejected", message: String(err) }) as const,
    );
    await stopping;
    // The startup must NOT have sneaked a worker past the stop().
    expect(engine.workerCreateAttempts).toBe(0);
    expect(engine.workerNames).toEqual([]);
    expect(adapter.started).toBe(false);
    expect(startOutcome.settled).toBe("rejected");
    if (startOutcome.settled === "rejected") {
      expect(startOutcome.message).toMatch(/stopped/);
    }
    // Terminal: resume requires a new adapter, and stop stays idempotent.
    await expect(adapter.start()).rejects.toThrow(/stopped/);
    await adapter.stop();
  });
});

describe("F12-FIX-02 (a): stop() during registerWorkflows() cleans the partial worker", () => {
  it("stops the created worker and stays terminal stopped when registration rejects", async () => {
    let releaseRegister!: () => void;
    const registerGate = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    let enteredRegister = false;
    let stopCalls = 0;
    let stopWorker!: () => void;
    const workerDone = new Promise<void>((resolve) => {
      stopWorker = resolve;
    });
    const worker: HatchetWorkerHandle = {
      registerWorkflows: async () => {
        enteredRegister = true;
        await registerGate;
        throw new Error("fake hatchet: transient register failure");
      },
      start: () => workerDone,
      stop: async () => {
        stopCalls += 1;
        stopWorker();
      },
    };
    const client: HatchetEngineClient = {
      declareTask: (opts) => ({
        taskName: opts.name,
        runNoWait: async (): Promise<HatchetRunHandle> => ({ runId: "fake-run-x" }),
      }),
      createWorker: async () => worker,
      runs: {
        cancel: async () => undefined,
      },
    };
    const adapter = testAdapter(
      { kind: "register-gate-test", connect: async () => client },
      { attempts: 1 },
    );
    adapter.registerHandler("trial.expire_due", async () => undefined);
    const starting = adapter.start();
    await sleep(25);
    // Prove the startup is really parked inside registerWorkflows() before stopping.
    expect(enteredRegister).toBe(true);
    const stopping = adapter.stop();
    releaseRegister();
    const startOutcome = await starting.then(
      () => ({ settled: "resolved" }) as const,
      (err: unknown) => ({ settled: "rejected", message: String(err) }) as const,
    );
    await stopping;
    // The partial worker must have been cleaned up, not orphaned.
    expect(stopCalls).toBe(1);
    expect(adapter.started).toBe(false);
    expect(startOutcome.settled).toBe("rejected");
    // Terminal: resume requires a new adapter, and stop stays idempotent.
    await expect(adapter.start()).rejects.toThrow(/stopped/);
    await adapter.stop();
    expect(stopCalls).toBe(1);
  });
});

describe("F12-FIX-02 (b): failed registration releases for a clean retry", () => {
  it("cleans the first worker and a retry start adopts exactly one live worker", async () => {
    const stopCalls: number[] = [];
    let registers = 0;
    let created = 0;
    const makeWorker = (idx: number): HatchetWorkerHandle => {
      stopCalls[idx] = 0;
      let stopWorker!: () => void;
      const done = new Promise<void>((resolve) => {
        stopWorker = resolve;
      });
      return {
        registerWorkflows: async () => {
          registers += 1;
          if (registers === 1) {
            throw new Error("fake hatchet: transient register failure");
          }
        },
        start: () => done,
        stop: async () => {
          stopCalls[idx] = (stopCalls[idx] ?? 0) + 1;
          stopWorker();
        },
      };
    };
    const client: HatchetEngineClient = {
      declareTask: (opts) => ({
        taskName: opts.name,
        runNoWait: async (): Promise<HatchetRunHandle> => ({ runId: "fake-run-x" }),
      }),
      createWorker: async () => makeWorker(created++),
      runs: {
        cancel: async () => undefined,
      },
    };
    const adapter = testAdapter(
      { kind: "register-retry-test", connect: async () => client },
      { attempts: 1 },
    );
    adapter.registerHandler("trial.expire_due", async () => undefined);
    await expect(adapter.start()).rejects.toThrow(/register/);
    // The failed attempt must not orphan its worker.
    expect(stopCalls[0]).toBe(1);
    expect(adapter.started).toBe(false);
    // A fresh start() retries cleanly and adopts exactly one live worker.
    await adapter.start();
    expect(adapter.started).toBe(true);
    expect(created).toBe(2);
    expect(stopCalls).toEqual([1, 0]);
    await adapter.stop();
    expect(stopCalls).toEqual([1, 1]);
  });
});

describe("F12-FIX-01 P2c: runAt guard rejects any future instant and invalid dates", () => {
  it("refuses sub-second-future and invalid runAt under a controlled clock, accepts past/present", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    const engine = new FakeHatchetEngine();
    engine.pauseDrain = true;
    const adapter = testAdapter(engine.createProvider());
    adapter.registerHandler("order.expire_due", async () => undefined);
    await adapter.start();
    try {
      const now = Date.now();
      // 500ms out: the pre-fix 1000ms tolerance window executed this early.
      await expect(
        adapter.enqueue({ name: "order.expire_due", payload: {}, runAt: new Date(now + 500) }),
      ).rejects.toThrow(/delayed runAt/);
      // Boundary + far future stay refused.
      await expect(
        adapter.enqueue({ name: "order.expire_due", payload: {}, runAt: new Date(now + 1000) }),
      ).rejects.toThrow(/delayed runAt/);
      await expect(
        adapter.enqueue({ name: "order.expire_due", payload: {}, runAt: new Date(now + 60_000) }),
      ).rejects.toThrow(/delayed runAt/);
      // Invalid dates never schedule.
      await expect(
        adapter.enqueue({ name: "order.expire_due", payload: {}, runAt: new Date(Number.NaN) }),
      ).rejects.toThrow(/runAt/);
      expect(engine.runs).toHaveLength(0);
      // Past and present instants satisfy not-before and still enqueue.
      const past = await adapter.enqueue({
        name: "order.expire_due",
        payload: {},
        runAt: new Date(now - 1000),
      });
      expect(past.durable).toBe(true);
      const present = await adapter.enqueue({
        name: "order.expire_due",
        payload: {},
        runAt: new Date(now),
      });
      expect(present.durable).toBe(true);
      expect(engine.runs).toHaveLength(2);
    } finally {
      engine.pauseDrain = false;
      vi.useRealTimers();
      await adapter.stop();
    }
  });
});
