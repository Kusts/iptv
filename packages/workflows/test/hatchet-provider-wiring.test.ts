/**
 * F12 review-fix regressions (independent review of PR #52):
 * - P1 SDK shape: `RealHatchetProvider.connect()` normalizes every observed
 *   shape of `@hatchet-dev/typescript-sdk@1.37.0` (legacy `default.init`
 *   object, class-with-static-`init` as `default`, CJS-ESM double-default
 *   interop `default.default.init`, named `Hatchet.init`) and drives the
 *   full provider path (declare → trigger → worker → cancel), not just
 *   `typeof init`. F12 stays BLOCKED on a live engine: these are
 *   tarball-faithful module doubles, zero network, zero secrets.
 * - P1 factory: required mode (`required: true` or `HATCHET_REQUIRED=1`)
 *   fails closed at bootstrap (missing token, missing SDK, construction
 *   failure) instead of silently falling back to local; the default keeps
 *   the optional-SDK local fallback.
 * - P2 stop terminal: `stop()` on a constructed (never-started) adapter is
 *   terminal — `start()`/`registerHandler` past it are rejected and a
 *   second `stop()` stays idempotent.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { HatchetWorkflowAdapter, createWorkflowAdapter } from "../src/hatchet-adapter.js";
import { FakeHatchetEngine } from "../src/fake-hatchet.js";
import {
  HATCHET_SDK_SPECIFIER,
  RealHatchetProvider,
  resolveHatchetSdkInit,
} from "../src/hatchet-provider.js";

const TEST_ENV = { HATCHET_CLIENT_TOKEN: "test-token-not-a-secret" };

function sdkPresent(): boolean {
  try {
    createRequire(import.meta.url).resolve(HATCHET_SDK_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}

/** Tarball-faithful raw SDK doubles: class with `static init`, like `HatchetClient`. */
function makeRawSdkHarness() {
  const seenConfigs: unknown[] = [];
  const cancelled: string[][] = [];
  const registered: unknown[][] = [];
  let stopCalls = 0;
  const rawClient = {
    task: (opts: {
      name: string;
      fn: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
      retries?: number;
      executionTimeout?: string;
      scheduleTimeout?: string;
      backoff?: { maxSeconds?: number };
    }) => ({
      taskOpts: opts,
      runNoWait: async (input: Record<string, unknown>) => ({ runId: Promise.resolve(`sdk-run-for-${opts.name}`), input }),
    }),
    worker: async (name: string) => ({
      workerName: name,
      registerWorkflows: async (declarations: unknown[]) => {
        registered.push(declarations);
      },
      start: async () => undefined,
      stop: async () => {
        stopCalls += 1;
      },
    }),
    runs: {
      cancel: async (opts: { ids: string[] }) => {
        cancelled.push(opts.ids);
      },
    },
  };
  class FakeHatchetClient {
    static init(config: Record<string, unknown>): typeof rawClient {
      seenConfigs.push(config);
      return rawClient;
    }
  }
  return { FakeHatchetClient, seenConfigs, cancelled, registered, stopCalls: () => stopCalls };
}

describe("P1: SDK init normalization covers every observed module shape", () => {
  it.each([
    ["default.init object", (cls: { init: unknown }) => ({ default: { init: cls.init } })],
    ["class as default", (cls: unknown) => ({ default: cls })],
    // ESM `await import()` of the CJS entry: `mod.default` is
    // `module.exports` (`{ Hatchet, default: HatchetClient, ... }`).
    ["double-default interop", (cls: unknown) => ({ default: { default: cls, Hatchet: cls }, Hatchet: cls })],
    ["named Hatchet only", (cls: unknown) => ({ Hatchet: cls })],
  ])("resolves init via %s", (_label, wrap) => {
    const { FakeHatchetClient } = makeRawSdkHarness();
    const resolved = resolveHatchetSdkInit(wrap(FakeHatchetClient));
    expect(typeof resolved.init).toBe("function");
  });

  it("reports every tried location on a shape mismatch", () => {
    expect(() => resolveHatchetSdkInit({ default: {} })).toThrow(
      /default\.init, default\.default\.init, Hatchet\.init, init/,
    );
    expect(() => resolveHatchetSdkInit(null)).toThrow(/shape mismatch/);
  });
});

describe("P1: connect() drives the provider path on every module shape", () => {
  it.each([
    ["default.init object", (cls: { init: unknown }) => ({ default: { init: cls.init } })],
    ["class as default", (cls: unknown) => ({ default: cls })],
    ["double-default interop", (cls: unknown) => ({ default: { default: cls, Hatchet: cls }, Hatchet: cls })],
    ["named Hatchet only", (cls: unknown) => ({ Hatchet: cls })],
  ])("declares, triggers, works and cancels via %s", async (_label, wrap) => {
    const harness = makeRawSdkHarness();
    const provider = new RealHatchetProvider(
      {
        token: "tok",
        hostPort: "localhost:8888",
        apiUrl: "https://hatchet.example",
        namespace: "tenant-a",
        usedLegacyToken: false,
        usedLegacyServerUrl: false,
      },
      {
        loadSdk: async () => wrap(harness.FakeHatchetClient),
        // Shape doubles run with or without the optional dependency
        // installed; the presence guard itself is covered by the
        // SDK-absent/present tests elsewhere in this file.
        assertSdkPresent: () => undefined,
      },
    );
    const client = await provider.connect();
    // Init receives the normalized snake_case SDK config (TLS stays
    // SDK-managed via HATCHET_CLIENT_TLS_* env — never passed here).
    expect(harness.seenConfigs).toEqual([
      { token: "tok", host_port: "localhost:8888", api_url: "https://hatchet.example", namespace: "tenant-a" },
    ]);
    const declaration = client.declareTask({
      name: "trial.expire_due",
      fn: async () => "ok",
      retries: 2,
      executionTimeout: "60s",
      scheduleTimeout: "5m",
      backoffMaxSeconds: 30,
    });
    expect(declaration.taskName).toBe("trial.expire_due");
    await expect(declaration.runNoWait({ tenant: "t1" })).resolves.toEqual({ runId: "sdk-run-for-trial.expire_due" });
    const worker = await client.createWorker("test-worker");
    await worker.registerWorkflows([declaration]);
    expect(harness.registered).toHaveLength(1);
    await worker.start();
    await worker.stop();
    expect(harness.stopCalls()).toBe(1);
    await client.runs.cancel("sdk-run-for-trial.expire_due");
    expect(harness.cancelled).toEqual([["sdk-run-for-trial.expire_due"]]);
  });

  it("fails closed on an unverified shape and on init/load failures", async () => {
    const noopGuard = () => undefined;
    const base = {
      token: "tok",
      usedLegacyToken: false,
      usedLegacyServerUrl: false,
    } as const;
    await expect(
      new RealHatchetProvider(base, { loadSdk: async () => ({ default: {} }), assertSdkPresent: noopGuard }).connect(),
    ).rejects.toThrow(/shape mismatch/);
    await expect(
      new RealHatchetProvider(base, {
        loadSdk: async () => ({
          default: {
            init: () => {
              throw new Error("bad token");
            },
          },
        }),
        assertSdkPresent: noopGuard,
      }).connect(),
    ).rejects.toThrow(/client init failed: bad token/);
    await expect(
      new RealHatchetProvider(base, {
        loadSdk: async () => {
          throw new Error("cannot find module");
        },
        assertSdkPresent: noopGuard,
      }).connect(),
    ).rejects.toThrow(/SDK failed to load/);
  });

  it("rejects init() results without the wrapper surface in connect() (fail-closed)", async () => {
    const noopGuard = () => undefined;
    const base = {
      token: "tok",
      usedLegacyToken: false,
      usedLegacyServerUrl: false,
    } as const;
    const badClients: Array<[string, unknown]> = [
      ["null", null],
      ["empty object", {}],
      [
        "null task",
        { task: null, worker: async () => ({}), runs: { cancel: async () => undefined } },
      ],
      [
        "non-callable worker",
        { task: () => ({}), worker: "nope", runs: { cancel: async () => undefined } },
      ],
      ["missing runs.cancel", { task: () => ({}), worker: async () => ({}), runs: {} }],
    ];
    for (const [label, badClient] of badClients) {
      await expect(
        new RealHatchetProvider(base, {
          loadSdk: async () => ({ default: { init: () => badClient } }),
          assertSdkPresent: noopGuard,
        }).connect(),
        label,
      ).rejects.toThrow(/client shape mismatch.*task\(\).*worker\(\).*runs\.cancel/s);
    }
  });
});

describe("P1: factory required mode fails closed at bootstrap", () => {
  it("throws on provider-construction failure instead of falling back (explicit flag and env flag)", () => {
    const failing = (): never => {
      throw new Error("boom");
    };
    const quiet = { onWarning: () => undefined };
    // Explicit flag.
    expect(() =>
      createWorkflowAdapter(TEST_ENV, { ...quiet, createProvider: failing, required: true }),
    ).toThrow(/required.*boom/);
    // Env flag.
    expect(() =>
      createWorkflowAdapter({ ...TEST_ENV, HATCHET_REQUIRED: "1" }, { ...quiet, createProvider: failing }),
    ).toThrow(/required.*boom/);
    // Explicit false wins over env.
    expect(
      createWorkflowAdapter(
        { ...TEST_ENV, HATCHET_REQUIRED: "1" },
        { ...quiet, createProvider: failing, required: false },
      ).kind,
    ).toBe("local");
    // Default (no flag) preserves the local fallback.
    expect(createWorkflowAdapter(TEST_ENV, { ...quiet, createProvider: failing }).kind).toBe("local");
  });

  it("throws on a missing token instead of handing out local", () => {
    expect(() => createWorkflowAdapter({}, { required: true })).toThrow(/required.*HATCHET_CLIENT_TOKEN/);
    expect(() => createWorkflowAdapter({ HATCHET_REQUIRED: "true" }, {})).toThrow(
      /required.*HATCHET_CLIENT_TOKEN/,
    );
    expect(createWorkflowAdapter({}).kind).toBe("local");
  });

  it("throws when the SDK is absent and Hatchet is required", () => {
    if (sdkPresent()) {
      return;
    }
    expect(() => createWorkflowAdapter(TEST_ENV, { required: true })).toThrow(/required.*not installed/);
    expect(() => createWorkflowAdapter({ ...TEST_ENV, HATCHET_REQUIRED: "1" })).toThrow(
      /required.*not installed/,
    );
  });
});

describe("P2: stop() on a constructed adapter is terminal", () => {
  it("rejects start()/registerHandler after a pre-start stop; stop stays idempotent", async () => {
    const adapter = new HatchetWorkflowAdapter(TEST_ENV, {
      provider: new FakeHatchetEngine().createProvider(),
      onWarning: () => undefined,
    });
    expect(adapter.started).toBe(false);
    await adapter.stop();
    expect(adapter.started).toBe(false);
    await expect(adapter.start()).rejects.toThrow(/stopped/);
    expect(() => adapter.registerHandler("late.handler", async () => undefined)).toThrow(/before start/);
    await adapter.stop();
    expect(adapter.started).toBe(false);
  });
});
