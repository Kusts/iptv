/**
 * Hatchet client provider boundary (F12 vertical slice).
 *
 * The real provider dynamically imports the published SDK
 * `@hatchet-dev/typescript-sdk` (pinned, see `HATCHET_SDK_VERSION`) behind
 * resolved env config, so a missing package can never break boot or build:
 * construction performs NO network I/O; connection happens in `connect()`
 * (called by `HatchetWorkflowAdapter.start()`), where failures are
 * fail-closed with a descriptive error.
 *
 * No `import type` from the SDK appears anywhere in `src/`: the structural
 * interfaces below are the only compile-time contract, so `tsc` stays green
 * with or without the optional dependency installed. The runtime shape is
 * asserted against the pinned SDK version (verified from the 1.37.0
 * tarball: default export with `.init(config)`, `client.task({ name, fn,
 * retries, executionTimeout, scheduleTimeout, backoff })`,
 * `client.worker(name)`, `worker.registerWorkflows/start/stop`,
 * `declaration.runNoWait(input) -> WorkflowRunRef { runId }`,
 * `client.runs.cancel({ ids })`).
 */

import { createRequire } from "node:module";
import type { HatchetResolvedConfig } from "./hatchet-env.js";

/** Published SDK package name — verified on the npm registry (1.37.0 latest). */
export const HATCHET_SDK_SPECIFIER = "@hatchet-dev/typescript-sdk";
/** Pinned SDK version this wiring is verified against. */
export const HATCHET_SDK_VERSION = "1.37.0";

/** Options accepted per task declaration (subset of the SDK's task opts). */
export interface HatchetDeclareTaskOpts {
  name: string;
  fn: (input: Record<string, unknown>) => Promise<unknown>;
  retries?: number;
  /** Go duration string, e.g. "60s", "5m", "1h" (SDK `executionTimeout`). */
  executionTimeout?: string;
  /** Go duration string (SDK `scheduleTimeout`). */
  scheduleTimeout?: string;
  backoffMaxSeconds?: number;
}

export interface HatchetRunHandle {
  runId: string;
}

export interface HatchetTaskDeclaration {
  readonly taskName: string;
  runNoWait(input: Record<string, unknown>): Promise<HatchetRunHandle>;
}

export interface HatchetWorkerHandle {
  registerWorkflows(declarations: HatchetTaskDeclaration[]): Promise<void>;
  /** Resolves when the worker is stopped or killed (run in background). */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HatchetRunsHandle {
  cancel(runId: string): Promise<void>;
}

export interface HatchetEngineClient {
  declareTask(opts: HatchetDeclareTaskOpts): HatchetTaskDeclaration;
  createWorker(name: string): Promise<HatchetWorkerHandle>;
  runs: HatchetRunsHandle;
}

export interface HatchetClientProvider {
  readonly kind: string;
  connect(): Promise<HatchetEngineClient>;
}

/**
 * Synchronous presence check for the OPTIONAL Hatchet SDK. Uses
 * `require.resolve` (no module load, no network).
 */
export function assertHatchetSdkPresent(): void {
  try {
    createRequire(import.meta.url).resolve(HATCHET_SDK_SPECIFIER);
  } catch {
    throw new Error(`hatchet SDK is not installed (optional dependency ${HATCHET_SDK_SPECIFIER}@${HATCHET_SDK_VERSION})`);
  }
}

/** Minimal structural view of the real SDK client (no static import). */
interface RealSdkClientShape {
  task(opts: {
    name: string;
    fn: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
    retries?: number;
    executionTimeout?: string;
    scheduleTimeout?: string;
    backoff?: { maxSeconds?: number };
  }): {
    runNoWait(input: Record<string, unknown>): Promise<{ runId: Promise<string> }>;
  };
  worker(name: string): Promise<{
    registerWorkflows(declarations: unknown[]): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  }>;
  runs: {
    cancel(opts: { ids: string[] }): Promise<unknown>;
  };
}

interface RealSdkModuleShape {
  default: {
    init(config: { token: string; host_port?: string; api_url?: string; namespace?: string }): RealSdkClientShape;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertRealSdkShape(mod: unknown): asserts mod is RealSdkModuleShape {
  if (!isRecord(mod) || !isRecord(mod["default"]) || typeof mod["default"]["init"] !== "function") {
    throw new Error(
      `hatchet SDK shape mismatch: ${HATCHET_SDK_SPECIFIER}@${HATCHET_SDK_VERSION} default export does not expose init() — refusing to wire an unverified SDK`,
    );
  }
}

/** Production provider: builds the real SDK client from resolved config. */
export class RealHatchetProvider implements HatchetClientProvider {
  readonly kind = "real" as const;
  constructor(private readonly config: HatchetResolvedConfig) {}

  async connect(): Promise<HatchetEngineClient> {
    assertHatchetSdkPresent();
    let mod: unknown;
    try {
      mod = await import(HATCHET_SDK_SPECIFIER);
    } catch (err) {
      throw new Error(
        `hatchet SDK failed to load (${HATCHET_SDK_SPECIFIER}@${HATCHET_SDK_VERSION}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    assertRealSdkShape(mod);
    const initConfig: { token: string; host_port?: string; api_url?: string; namespace?: string } = {
      token: this.config.token,
    };
    if (this.config.hostPort !== undefined) {
      initConfig.host_port = this.config.hostPort;
    }
    if (this.config.apiUrl !== undefined) {
      initConfig.api_url = this.config.apiUrl;
    }
    if (this.config.namespace !== undefined) {
      initConfig.namespace = this.config.namespace;
    }
    let client: RealSdkClientShape;
    try {
      client = mod.default.init(initConfig);
    } catch (err) {
      throw new Error(`hatchet client init failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Raw SDK declarations, keyed by task name: the worker registration
    // below must receive the real objects returned by `client.task()`.
    const rawDeclarations = new Map<string, unknown>();
    return {
      declareTask: (opts: HatchetDeclareTaskOpts): HatchetTaskDeclaration => {
        const taskOpts: {
          name: string;
          fn: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
          retries?: number;
          executionTimeout?: string;
          scheduleTimeout?: string;
          backoff?: { maxSeconds?: number };
        } = {
          name: opts.name,
          fn: async (input: Record<string, unknown>) => opts.fn(input),
        };
        if (opts.retries !== undefined) {
          taskOpts.retries = opts.retries;
        }
        if (opts.executionTimeout !== undefined) {
          taskOpts.executionTimeout = opts.executionTimeout;
        }
        if (opts.scheduleTimeout !== undefined) {
          taskOpts.scheduleTimeout = opts.scheduleTimeout;
        }
        if (opts.backoffMaxSeconds !== undefined) {
          taskOpts.backoff = { maxSeconds: opts.backoffMaxSeconds };
        }
        const declaration = client.task(taskOpts);
        rawDeclarations.set(opts.name, declaration);
        return {
          taskName: opts.name,
          runNoWait: async (input: Record<string, unknown>): Promise<HatchetRunHandle> => {
            const ref = await declaration.runNoWait(input);
            return { runId: await ref.runId };
          },
        };
      },
      createWorker: async (name: string): Promise<HatchetWorkerHandle> => {
        const worker = await client.worker(name);
        return {
          registerWorkflows: async (declarations: HatchetTaskDeclaration[]): Promise<void> => {
            const raw = declarations.map((d) => {
              const found = rawDeclarations.get(d.taskName);
              if (found === undefined) {
                throw new Error(`hatchet worker registration refused: unknown task declaration "${d.taskName}"`);
              }
              return found;
            });
            await worker.registerWorkflows(raw);
          },
          start: () => worker.start(),
          stop: () => worker.stop(),
        };
      },
      runs: {
        cancel: async (runId: string): Promise<void> => {
          await client.runs.cancel({ ids: [runId] });
        },
      },
    };
  }
}
