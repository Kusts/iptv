/**
 * In-process Hatchet test double (F12 vertical slice).
 *
 * TEST-ONLY: never durable, never a certification claim. It implements the
 * `HatchetClientProvider` boundary with a shared, append-only run journal
 * (`FakeHatchetEngine`) so tests can prove adapter-level behavior without a
 * Hatchet cluster or network:
 * - happy path (register → start → enqueue → worker execution),
 * - worker crash/restart resume (a second adapter over the SAME engine
 *   picks up the still-queued run; the effect sink — keyed by the
 *   `__dedupeKey` the adapter injects — must not record twice),
 * - provider-unavailable retry (injected transient failures, then recovery
 *   or fail-closed exhaustion),
 * - cancel before execution (cancelled runs never execute),
 * - graceful shutdown (`stop()` drains nothing new and refuses new work).
 *
 * At-least-once, like the real engine: a redelivered run re-invokes the
 * function. The adapter makes NO exactly-once claim.
 */

import type {
  HatchetClientProvider,
  HatchetDeclareTaskOpts,
  HatchetEngineClient,
  HatchetRunHandle,
  HatchetTaskDeclaration,
  HatchetWorkerHandle,
} from "./hatchet-provider.js";

export type FakeRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface FakeRunRecord {
  runId: string;
  taskName: string;
  input: Record<string, unknown>;
  status: FakeRunStatus;
  attempts: number;
}

export interface FakeDeclaredTask {
  name: string;
  retries: number;
  executionTimeout: string | null;
  scheduleTimeout: string | null;
  backoffMaxSeconds: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeHatchetEngine {
  readonly runs: FakeRunRecord[] = [];
  readonly declared: FakeDeclaredTask[] = [];
  readonly cancelledIds: string[] = [];
  readonly workerNames: string[] = [];

  connectAttempts = 0;
  triggerAttempts = 0;
  workerCreateAttempts = 0;

  /** Next N `connect()` calls throw a transient error. */
  failConnectTimes = 0;
  /** Next N `runNoWait()` calls throw a transient error. */
  failTriggerTimes = 0;
  /** Next N `createWorker()` calls throw a transient error. */
  failWorkerCreateTimes = 0;
  /**
   * When true, the next executed run is "crashed": the function IS invoked,
   * but the run goes back to `queued` (attempts consumed) as if the worker
   * died before acknowledging. One-shot (reset after firing).
   */
  crashNextRun = false;
  /** When true, started workers hold queued runs until set back to false. */
  pauseDrain = false;

  private nextRun = 1;

  createProvider(): HatchetClientProvider {
    return createFakeProvider(this);
  }

  runById(runId: string): FakeRunRecord | undefined {
    return this.runs.find((r) => r.runId === runId);
  }

  /** Allocate the next fake run id (used by providers created for this engine). */
  allocateRunId(): string {
    const runId = `fake-run-${this.nextRun}`;
    this.nextRun += 1;
    return runId;
  }
}

function createFakeProvider(engine: FakeHatchetEngine): HatchetClientProvider {
  return {
      kind: "fake",
      connect: async (): Promise<HatchetEngineClient> => {
        engine.connectAttempts += 1;
        if (engine.failConnectTimes > 0) {
          engine.failConnectTimes -= 1;
          throw new Error("fake hatchet: transient connect failure");
        }
        const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
        const declaredOpts = new Map<string, HatchetDeclareTaskOpts>();
        return {
          declareTask: (opts: HatchetDeclareTaskOpts): HatchetTaskDeclaration => {
            engine.declared.push({
              name: opts.name,
              retries: opts.retries ?? 0,
              executionTimeout: opts.executionTimeout ?? null,
              scheduleTimeout: opts.scheduleTimeout ?? null,
              backoffMaxSeconds: opts.backoffMaxSeconds ?? null,
            });
            handlers.set(opts.name, opts.fn);
            declaredOpts.set(opts.name, opts);
            return {
              taskName: opts.name,
              runNoWait: async (input: Record<string, unknown>): Promise<HatchetRunHandle> => {
                engine.triggerAttempts += 1;
                if (engine.failTriggerTimes > 0) {
                  engine.failTriggerTimes -= 1;
                  throw new Error("fake hatchet: transient trigger failure");
                }
                const runId = engine.allocateRunId();
                engine.runs.push({ runId, taskName: opts.name, input, status: "queued", attempts: 0 });
                return { runId };
              },
            };
          },
          createWorker: async (name: string): Promise<HatchetWorkerHandle> => {
            engine.workerCreateAttempts += 1;
            if (engine.failWorkerCreateTimes > 0) {
              engine.failWorkerCreateTimes -= 1;
              throw new Error("fake hatchet: transient worker-create failure");
            }
            engine.workerNames.push(name);
            let alive = false;
            let stopResolve: (() => void) | null = null;
            const stopped = new Promise<void>((resolve) => {
              stopResolve = resolve;
            });
            const registered = new Set<string>();
            async function drain(): Promise<void> {
              while (alive) {
                if (engine.pauseDrain) {
                  await sleep(5);
                  continue;
                }
                const run = engine.runs.find((r) => r.status === "queued");
                if (run === undefined) {
                  await sleep(5);
                  continue;
                }
                const fn = handlers.get(run.taskName);
                if (fn === undefined) {
                  run.status = "failed";
                  continue;
                }
                run.status = "running";
                run.attempts += 1;
                const retries = declaredOpts.get(run.taskName)?.retries ?? 0;
                try {
                  await fn(run.input);
                } catch {
                  if (run.attempts <= retries) {
                    run.status = "queued";
                  } else {
                    run.status = "failed";
                  }
                  continue;
                }
                if (engine.crashNextRun) {
                  engine.crashNextRun = false;
                  // Worker died after the effect but before the ack: the
                  // run stays queued for redelivery (at-least-once).
                  run.status = "queued";
                  continue;
                }
                run.status = "succeeded";
              }
            }
            return {
              registerWorkflows: async (declarations: HatchetTaskDeclaration[]): Promise<void> => {
                for (const d of declarations) {
                  if (!handlers.has(d.taskName)) {
                    throw new Error(`fake hatchet: unknown task declaration "${d.taskName}"`);
                  }
                  registered.add(d.taskName);
                }
              },
              start: async (): Promise<void> => {
                alive = true;
                void drain().catch(() => {
                  alive = false;
                });
                await stopped;
              },
              stop: async (): Promise<void> => {
                alive = false;
                stopResolve?.();
              },
            };
          },
          runs: {
            cancel: async (runId: string): Promise<void> => {
              const run = engine.runs.find((r) => r.runId === runId);
              if (run === undefined) {
                throw new Error(`fake hatchet: unknown run id "${runId}"`);
              }
              if (run.status === "queued" || run.status === "running") {
                run.status = "cancelled";
              }
              engine.cancelledIds.push(runId);
            },
          },
        };
      },
  };
}
