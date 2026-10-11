/**
 * Hatchet durable-workflow adapter (F12 vertical slice — Wave-0-gated, NEVER the default).
 *
 * Wiring (verified against the published SDK `@hatchet-dev/typescript-sdk`
 * pinned at `HATCHET_SDK_VERSION`):
 * - env: canonical `HATCHET_CLIENT_*` (`resolveHatchetEnv`), legacy
 *   `HATCHET_API_TOKEN`/`HATCHET_SERVER_URL` compat-mapped with a logged
 *   warning; fail-closed when no token resolves;
 * - client: `RealHatchetProvider` (dynamic import, no network at
 *   construction); a `HatchetClientProvider` can be injected for tests;
 * - lifecycle: `registerHandler` (before `start`) → `start()` (connect with
 *   bounded retry, declare tasks with retry/timeout config, create + start
 *   worker in background) → `enqueue()` (trigger accepted ⇒
 *   `{ durable: true }` with the engine run id) → `cancel(runId)` →
 *   `stop()` (graceful shutdown, terminal).
 *
 * Honesty contract:
 * - `durable: true` is returned ONLY after the engine accepts the trigger
 *   (a run id exists server-side). Every other outcome throws — including
 *   enqueue-before-start, unknown handler, delayed `runAt` (not yet mapped
 *   to the SDK `schedule()` API), and exhausted provider retries.
 * - At-least-once: redelivered runs re-invoke the handler. The adapter
 *   propagates the caller `idempotencyKey` as run input `__dedupeKey` (fresh
 *   UUID when absent) and dedupes in-flight triggers per key within process
 *   lifetime, but cross-restart effect dedupe stays with the domain handler
 *   (existing idempotency/fencing patterns). NO exactly-once claim.
 * - `tick()` is a compatibility no-op returning zeros: the engine drives
 *   execution server-side; the local scheduler loop keeps calling `tick()`
 *   so swapping substrates never changes the caller shape.
 */

import { LocalWorkflowAdapter } from "./local-adapter.js";
import { type HatchetEnv, resolveHatchetEnv } from "./hatchet-env.js";
import {
  RealHatchetProvider,
  assertHatchetSdkPresent,
  type HatchetClientProvider,
  type HatchetDeclareTaskOpts,
  type HatchetEngineClient,
  type HatchetTaskDeclaration,
  type HatchetWorkerHandle,
} from "./hatchet-provider.js";
import { newTaskId, type TickResult, type WorkflowHandler, type WorkflowPort, type WorkflowTask } from "./types.js";

export type { HatchetEnv } from "./hatchet-env.js";

/** Reserved run-input keys owned by the adapter (payload collision fails closed). */
export const HATCHET_RUN_TASK_KEY = "__task";
export const HATCHET_RUN_DEDUPE_KEY = "__dedupeKey";

/** Per-handler execution policy mapped onto the SDK task declaration. */
export interface HatchetTaskOptions {
  /** Task retries after the first attempt (SDK `retries`, default 0). */
  retries?: number;
  /** Go duration string, e.g. "60s" (SDK `executionTimeout`). */
  executionTimeout?: string;
  /** Go duration string (SDK `scheduleTimeout`). */
  scheduleTimeout?: string;
  /** Exponential backoff cap in seconds (SDK `backoff.maxSeconds`). */
  backoffMaxSeconds?: number;
}

export interface HatchetRetryPolicy {
  /** Total attempts including the first (default 5). */
  attempts?: number;
  /** Base delay in ms, doubled per retry, capped at 2000ms (default 100). */
  baseDelayMs?: number;
}

export interface HatchetAdapterOptions {
  /** Injected provider (tests); default is the real SDK provider. */
  provider?: HatchetClientProvider;
  /** Worker name registered on the engine (default "iptv-worker"). */
  workerName?: string;
  /** Default task policy for handlers registered without explicit options. */
  taskDefaults?: HatchetTaskOptions;
  /** Bounded-retry policy for connect/trigger (default { attempts: 5 }). */
  retry?: HatchetRetryPolicy;
  /** Warning sink (default `console.warn`); warnings never carry secrets. */
  onWarning?: (message: string) => void;
}

/** Durable extension of the workflow port: explicit lifecycle + cancel. */
export interface DurableWorkflowPort extends WorkflowPort {
  /** Connect, declare tasks, and start the worker (background). */
  start(): Promise<void>;
  /** Graceful shutdown: stop the worker; terminal (construct a new adapter to resume). */
  stop(): Promise<void>;
  /** Cancel a run by engine run id. */
  cancel(runId: string): Promise<void>;
  readonly started: boolean;
}

interface RegisteredHandler {
  handler: WorkflowHandler;
  options: HatchetTaskOptions;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Settle a cleanup promise without ever throwing (shutdown paths only). */
function settleQuietly(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

function retryDelayMs(baseDelayMs: number, attempt: number): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), 2000);
}

export class HatchetWorkflowAdapter implements DurableWorkflowPort {
  private readonly handlers = new Map<string, RegisteredHandler>();
  private readonly inflightByKey = new Map<string, string>();
  /**
   * Reservations for triggers currently awaiting engine acceptance, keyed by
   * caller `idempotencyKey`. The reservation is stored BEFORE the first
   * `await` so concurrent `enqueue()` calls with the same key share one
   * trigger instead of each creating a run. Rejected reservations are
   * dropped (never cached); only accepted run ids enter the bounded
   * `inflightByKey` cache.
   */
  private readonly pendingByKey = new Map<string, Promise<{ id: string; durable: boolean }>>();
  private readonly workerName: string;
  private readonly taskDefaults: HatchetTaskOptions;
  private readonly retryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly warn: (message: string) => void;

  private provider: HatchetClientProvider | null;
  private client: HatchetEngineClient | null = null;
  private declarations = new Map<string, HatchetTaskDeclaration>();
  private worker: HatchetWorkerHandle | null = null;
  private workerDone: Promise<void> | null = null;
  private workerError: Error | null = null;
  private lifecycle: "constructed" | "starting" | "started" | "stopped" = "constructed";
  /**
   * In-flight `start()` attempt. Lets a concurrent `start()` serialize on the
   * same startup (never double-create workers) and lets `stop()` track a
   * pending startup so it can request shutdown and await its settlement.
   */
  private startPromise: Promise<void> | null = null;

  constructor(env: NodeJS.ProcessEnv | HatchetEnv = process.env, opts: HatchetAdapterOptions = {}) {
    const resolution = resolveHatchetEnv(env);
    if (!resolution.ok) {
      throw new Error(resolution.reason);
    }
    for (const warning of resolution.warnings) {
      (opts.onWarning ?? defaultWarn)(warning);
    }
    this.provider = opts.provider ?? new RealHatchetProvider(resolution.config);
    this.workerName = opts.workerName ?? "iptv-worker";
    this.taskDefaults = opts.taskDefaults ?? {};
    this.retryAttempts = Math.min(Math.max(Math.floor(opts.retry?.attempts ?? 5), 1), 10);
    this.retryBaseDelayMs = Math.min(Math.max(opts.retry?.baseDelayMs ?? 100, 0), 10_000);
    this.warn = opts.onWarning ?? defaultWarn;
  }

  get started(): boolean {
    return this.lifecycle === "started";
  }

  /**
   * Fresh lifecycle read that TypeScript cannot narrow away: `stop()` may
   * flip the state to "stopped" across any `await` inside `runStartup()`.
   */
  private shutdownRequested(): boolean {
    const lifecycle: string = this.lifecycle;
    return lifecycle === "stopped";
  }

  registerHandler(name: string, handler: WorkflowHandler, taskOptions: HatchetTaskOptions = {}): void {
    if (this.lifecycle !== "constructed") {
      throw new Error("hatchet handlers must be registered before start()");
    }
    if (this.handlers.has(name)) {
      throw new Error(`workflow handler already registered: ${name}`);
    }
    this.handlers.set(name, { handler, options: taskOptions });
  }

  async start(): Promise<void> {
    if (this.lifecycle === "started") {
      throw new Error("hatchet adapter already started");
    }
    if (this.lifecycle === "stopped") {
      throw new Error("hatchet adapter is stopped; construct a new adapter to resume");
    }
    if (this.lifecycle === "starting") {
      // Serialize on the in-flight startup so concurrent start() calls can
      // never double-create workers: wait for it, then re-evaluate.
      const inflight = this.startPromise;
      if (inflight !== null) {
        try {
          await inflight;
        } catch {
          // Fall through and re-evaluate: a failed first attempt releases
          // back to "constructed" (or a stop() owns "stopped").
        }
      }
      // Widened re-read: `stop()` or the settling attempt may have moved
      // the state across the `await` above (narrowing from the "starting"
      // guard no longer applies).
      const current: string = this.lifecycle;
      if (current === "started") {
        throw new Error("hatchet adapter already started");
      }
      if (current === "stopped") {
        throw new Error("hatchet adapter is stopped; construct a new adapter to resume");
      }
      // The in-flight attempt failed without a stop: retry as a fresh start.
      return this.start();
    }
    if (this.handlers.size === 0) {
      throw new Error("hatchet adapter has no registered handlers; register at least one before start()");
    }
    const provider = this.provider;
    if (provider === null) {
      throw new Error("hatchet adapter has no provider");
    }
    this.lifecycle = "starting";
    const attempt = this.runStartup(provider);
    this.startPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.startPromise === attempt) {
        this.startPromise = null;
      }
    }
  }

  /**
   * The async startup body. Checks the lifecycle at every phase boundary so
   * a `stop()` that lands mid-startup aborts before adopting anything: any
   * partially created worker is stopped and discarded, the terminal
   * "stopped" state (owned by `stop()`) is preserved, and no orphan worker
   * is left behind. Failures with nobody stopping us release back to
   * "constructed" so a later `start()` can retry.
   */
  private async runStartup(provider: HatchetClientProvider): Promise<void> {
    // Partial worker owned by THIS attempt until adoption: every exceptional
    // exit below (register exhaustion, stop-during-startup, worker-start race)
    // stops it so no orphan survives. Adoption clears the slot.
    let partialWorker: HatchetWorkerHandle | null = null;
    let partialDone: Promise<void> | null = null;
    try {
      const client = await this.withRetry("connect", () => provider.connect());
      if (this.shutdownRequested()) {
        // Stopped during connect(): no worker exists yet, nothing to clean.
        throw new Error("hatchet adapter stopped during startup; construct a new adapter to resume");
      }
      const declarations = new Map<string, HatchetTaskDeclaration>();
      for (const [name, registered] of this.handlers) {
        const declareOpts: HatchetDeclareTaskOpts = {
          name,
          fn: async (input: Record<string, unknown>) => {
            await registered.handler(unwrapRunInput(input));
          },
        };
        const retries = registered.options.retries ?? this.taskDefaults.retries;
        const executionTimeout = registered.options.executionTimeout ?? this.taskDefaults.executionTimeout;
        const scheduleTimeout = registered.options.scheduleTimeout ?? this.taskDefaults.scheduleTimeout;
        const backoffMaxSeconds = registered.options.backoffMaxSeconds ?? this.taskDefaults.backoffMaxSeconds;
        if (retries !== undefined) {
          declareOpts.retries = retries;
        }
        if (executionTimeout !== undefined) {
          declareOpts.executionTimeout = executionTimeout;
        }
        if (scheduleTimeout !== undefined) {
          declareOpts.scheduleTimeout = scheduleTimeout;
        }
        if (backoffMaxSeconds !== undefined) {
          declareOpts.backoffMaxSeconds = backoffMaxSeconds;
        }
        declarations.set(name, client.declareTask(declareOpts));
      }
      const worker = await this.withRetry("create worker", () => client.createWorker(this.workerName));
      partialWorker = worker;
      if (this.shutdownRequested()) {
        throw new Error("hatchet adapter stopped during startup; construct a new adapter to resume");
      }
      await this.withRetry("register workflows", () => worker.registerWorkflows([...declarations.values()]));
      if (this.shutdownRequested()) {
        throw new Error("hatchet adapter stopped during startup; construct a new adapter to resume");
      }
      const workerDone = worker.start();
      partialDone = workerDone;
      if (this.shutdownRequested()) {
        // The background loop may already have drained a run (at-least-once
        // redelivery covers any effect); fall through to the catch below,
        // which stops the worker BEFORE settling its background promise.
        throw new Error("hatchet adapter stopped during startup; construct a new adapter to resume");
      }
      this.client = client;
      this.declarations = declarations;
      this.worker = worker;
      this.workerDone = workerDone;
      this.workerDone.catch((err: unknown) => {
        this.workerError = err instanceof Error ? err : new Error(String(err));
      });
      // Adopted: the catch below must not touch the live worker.
      partialWorker = null;
      partialDone = null;
      this.lifecycle = "started";
    } catch (err) {
      // Clean the unadopted partial worker on EVERY exceptional exit
      // (register-exhaustion and stop-during-register included): `stop()` only
      // settles the in-flight attempt and never stops a worker it never
      // adopted, so ownership stays here. Stop BEFORE settling the background
      // promise (it only resolves after `stop()`).
      const orphan = partialWorker;
      const orphanDone = partialDone;
      partialWorker = null;
      partialDone = null;
      if (orphan !== null) {
        await settleQuietly(orphan.stop());
      }
      if (orphanDone !== null) {
        await settleQuietly(orphanDone);
      }
      // A stop() that lands mid-startup owns the terminal "stopped" state;
      // only release back to "constructed" when nobody stopped us.
      if (this.lifecycle === "starting") {
        this.lifecycle = "constructed";
      }
      throw err;
    }
  }

  async enqueue(task: WorkflowTask): Promise<{ id: string; durable: boolean }> {
    if (task.name.trim().length === 0) {
      throw new Error("workflow task name must not be empty");
    }
    this.assertUsable();
    const declaration = this.declarations.get(task.name);
    if (declaration === undefined) {
      throw new Error(`hatchet enqueue refused: no handler registered for "${task.name}"`);
    }
    if (task.runAt !== undefined) {
      const runAtMs = task.runAt.getTime();
      if (Number.isNaN(runAtMs)) {
        throw new Error(
          "hatchet enqueue refused: runAt is not a valid date; refusing instead of mis-scheduling",
        );
      }
      // Scheduling is unimplemented in this slice (not mapped to the SDK
      // `schedule()` API): refuse ANY future instant fail-closed instead of
      // running early — the not-before contract in `types.ts` forbids
      // executing before `runAt`.
      if (runAtMs > Date.now()) {
        throw new Error(
          "hatchet enqueue refused: delayed runAt is not mapped to the engine schedule API in this slice; refusing instead of running early",
        );
      }
    }
    if (task.payload[HATCHET_RUN_TASK_KEY] !== undefined || task.payload[HATCHET_RUN_DEDUPE_KEY] !== undefined) {
      throw new Error(
        `hatchet enqueue refused: payload must not define reserved keys "${HATCHET_RUN_TASK_KEY}"/"${HATCHET_RUN_DEDUPE_KEY}"`,
      );
    }
    const dedupeKey = task.idempotencyKey ?? newTaskId();
    const input: Record<string, unknown> = {
      ...task.payload,
      [HATCHET_RUN_TASK_KEY]: task.name,
      [HATCHET_RUN_DEDUPE_KEY]: dedupeKey,
    };
    if (task.idempotencyKey === undefined) {
      // `{ durable: true }` ONLY after the engine accepts the trigger (a run
      // id exists). Transient provider failures are retried boundedly; then
      // fail-closed — never a silent drop, never a false durable claim.
      const handle = await this.withRetry("trigger run", () => declaration.runNoWait(input));
      return { id: handle.runId, durable: true };
    }
    const key = task.idempotencyKey;
    const pending = this.pendingByKey.get(key);
    if (pending !== undefined) {
      // A trigger for this key is already awaiting engine acceptance: share
      // it instead of creating a second run.
      return pending;
    }
    const accepted = this.inflightByKey.get(key);
    if (accepted !== undefined) {
      return { id: accepted, durable: true };
    }
    // Reserve BEFORE the first await so concurrent enqueues with the same
    // key collapse onto this single trigger.
    const reservation = this.triggerOnce(key, declaration, input);
    this.pendingByKey.set(key, reservation);
    const forget = (): void => {
      if (this.pendingByKey.get(key) === reservation) {
        this.pendingByKey.delete(key);
      }
    };
    void reservation.then(forget, forget);
    return reservation;
  }

  /**
   * Single engine trigger for a reserved idempotency key. Only an accepted
   * run id enters the bounded `inflightByKey` cache; rejections settle the
   * shared reservation (whose `pendingByKey` entry is dropped by the
   * registrant) so a later enqueue retries instead of observing stale state.
   */
  private async triggerOnce(
    key: string,
    declaration: HatchetTaskDeclaration,
    input: Record<string, unknown>,
  ): Promise<{ id: string; durable: boolean }> {
    const handle = await this.withRetry("trigger run", () => declaration.runNoWait(input));
    this.inflightByKey.set(key, handle.runId);
    if (this.inflightByKey.size > 1000) {
      const oldest = this.inflightByKey.keys().next();
      if (!oldest.done) {
        this.inflightByKey.delete(oldest.value);
      }
    }
    return { id: handle.runId, durable: true };
  }

  async cancel(runId: string): Promise<void> {
    if (runId.trim().length === 0) {
      throw new Error("hatchet cancel refused: run id must not be empty");
    }
    this.assertUsable();
    const client = this.client;
    if (client === null) {
      throw new Error("hatchet cancel refused: adapter is not started");
    }
    try {
      await client.runs.cancel(runId);
    } catch (err) {
      throw new Error(`hatchet cancel failed for run "${runId}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycle === "stopped") {
      return;
    }
    if (this.lifecycle === "starting") {
      // Shutdown requested mid-startup: take the terminal state now. The
      // in-flight startup observes it at the next phase boundary, cleans
      // any partial resources, and aborts without adopting a worker — so no
      // orphan can complete afterwards.
      this.lifecycle = "stopped";
      const inflight = this.startPromise;
      if (inflight !== null) {
        await settleQuietly(inflight);
      }
      this.worker = null;
      this.workerDone = null;
      this.client = null;
      this.provider = null;
      return;
    }
    if (this.lifecycle !== "started") {
      return;
    }
    this.lifecycle = "stopped";
    const worker = this.worker;
    const done = this.workerDone;
    this.worker = null;
    this.workerDone = null;
    this.client = null;
    this.provider = null;
    if (worker !== null) {
      await worker.stop();
    }
    if (done !== null) {
      await done;
    }
    if (this.workerError !== null) {
      throw new Error(`hatchet worker stopped with error: ${this.workerError.message}`);
    }
  }

  async tick(limit = 50): Promise<TickResult> {
    // Server-side execution: nothing to poll in-process. The limit is
    // accepted (and bounded) to keep the caller shape substrate-agnostic.
    void Math.min(Math.max(Math.floor(limit), 1), 500);
    return { processed: 0, failed: 0 };
  }

  private assertUsable(): void {
    if (this.workerError !== null) {
      throw new Error(`hatchet worker is unhealthy: ${this.workerError.message}`);
    }
    if (this.lifecycle !== "started" || this.client === null) {
      throw new Error("hatchet adapter is not started; call start() before enqueue/cancel");
    }
  }

  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < this.retryAttempts) {
          this.warn(
            `[workflows] hatchet ${operation} failed (attempt ${attempt}/${this.retryAttempts}), retrying: ${err instanceof Error ? err.message : String(err)}`,
          );
          await sleep(retryDelayMs(this.retryBaseDelayMs, attempt));
        }
      }
    }
    throw new Error(
      `hatchet ${operation} failed after ${this.retryAttempts} attempt(s), refusing to lose the task: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

/** Strip the adapter-internal envelope key before invoking the domain handler. */
function unwrapRunInput(input: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    // `__task` is adapter routing metadata; `__dedupeKey` is intentionally
    // passed through so handlers can key recorded side effects on it
    // (idempotent-consumer pattern — the adapter never claims exactly-once).
    if (key === HATCHET_RUN_TASK_KEY) {
      continue;
    }
    rest[key] = value;
  }
  return rest;
}

export type WorkflowAdapterKind = "local" | "hatchet";

export interface WorkflowAdapterSelection {
  adapter: WorkflowPort;
  kind: WorkflowAdapterKind;
}

export interface WorkflowAdapterFactoryOptions extends HatchetAdapterOptions {
  /**
   * Override provider construction (tests). When it throws, the factory
   * falls back to local with a logged warning — same as a missing SDK.
   */
  createProvider?: () => HatchetClientProvider;
}

/**
 * Factory: Hatchet only when a client token resolves AND the adapter
 * constructs; every failure falls back to the local adapter with a logged
 * warning. Local mode is explicitly NON-durable. Construction performs no
 * network I/O — use `start()` on the `DurableWorkflowPort` to connect.
 */
export function createWorkflowAdapter(
  env: NodeJS.ProcessEnv | HatchetEnv = process.env,
  opts: WorkflowAdapterFactoryOptions = {},
): WorkflowAdapterSelection {
  const warn = opts.onWarning ?? defaultWarn;
  const resolution = resolveHatchetEnv(env);
  if (resolution.ok) {
    try {
      const { createProvider, ...adapterOpts } = opts;
      if (createProvider === undefined) {
        // Fail fast when the optional SDK is absent (sync resolve, no
        // network): the factory falls back to local instead of handing out
        // an adapter that could only fail later at start().
        assertHatchetSdkPresent();
      }
      const provider = createProvider !== undefined ? createProvider() : undefined;
      const adapter =
        provider === undefined
          ? new HatchetWorkflowAdapter(env, adapterOpts)
          : new HatchetWorkflowAdapter(env, { ...adapterOpts, provider });
      return { adapter, kind: "hatchet" };
    } catch (err) {
      warn(
        `[workflows] hatchet adapter unavailable, falling back to local (non-durable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { adapter: new LocalWorkflowAdapter(), kind: "local" };
}

function defaultWarn(message: string): void {
  console.warn(message);
}
