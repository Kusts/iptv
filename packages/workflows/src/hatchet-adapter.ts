import { createRequire } from "node:module";
import { LocalWorkflowAdapter } from "./local-adapter.js";
import { type TickResult, type WorkflowHandler, type WorkflowPort, type WorkflowTask } from "./types.js";

export interface HatchetEnv {
  HATCHET_API_TOKEN?: string;
  HATCHET_SERVER_URL?: string;
}

/**
 * Hatchet durable-workflow adapter (W1-08, Wave-0-gated — NEVER the default).
 *
 * Requires `HATCHET_API_TOKEN` (+ optional `HATCHET_SERVER_URL`) AND the
 * `@hatchet-dev/hatchet` SDK installed. SDK presence is checked synchronously
 * with `require.resolve` (no module load, no network), so a missing package
 * can never break boot: the constructor throws when config or SDK is absent
 * and `createWorkflowAdapter` falls back to `LocalWorkflowAdapter` with a
 * logged warning. No Hatchet network call happens at construction time.
 *
 * `enqueue()` FAILS CLOSED: it throws a descriptive error instead of ever
 * returning `{ durable: true }`. This substrate creates no scheduled run and
 * persists nothing, so asserting durability would be a false guarantee —
 * and silently reporting `durable: false` would be one too, because unlike
 * `LocalWorkflowAdapter` there is no in-memory queue behind this adapter:
 * the task would simply be gone. The only honest outcome is a loud refusal
 * at the call site. A real durable path (SDK workflow-name mapping, certified
 * at W0-04) replaces this guard before the substrate is ever selected.
 *
 * `tick()` is a compatibility no-op returning zeros: Hatchet drives
 * execution server-side (scheduled runs trigger workers through the Hatchet
 * cluster); the local scheduler loop keeps calling `tick()` so swapping
 * substrates never changes the caller shape. Durable adoption as a whole
 * awaits W0-04 certification.
 */
export class HatchetWorkflowAdapter implements WorkflowPort {
  private readonly handlers = new Map<string, WorkflowHandler>();

  constructor(env: NodeJS.ProcessEnv | HatchetEnv = process.env) {
    const token = env["HATCHET_API_TOKEN"];
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("hatchet is not configured (HATCHET_API_TOKEN)");
    }
    // The token is validated here but never stored or logged: a future
    // Hatchet client construction (with the SDK) reads it from env at call
    // time. `HATCHET_SERVER_URL` is likewise not retained — the construction
    // -only substrate never dials anything.
    assertHatchetSdkPresent();
  }

  registerHandler(name: string, handler: WorkflowHandler): void {
    if (this.handlers.has(name)) {
      throw new Error(`workflow handler already registered: ${name}`);
    }
    this.handlers.set(name, handler);
  }

  async enqueue(task: WorkflowTask): Promise<{ id: string; durable: boolean }> {
    if (task.name.trim().length === 0) {
      throw new Error("workflow task name must not be empty");
    }
    // Fail closed: no Hatchet scheduled run is created and nothing is
    // persisted, so `EnqueueResult.durable` ("true only when the substrate
    // persists the task durably") must never be asserted here. Throwing
    // keeps the caller from losing the task silently — reporting
    // `durable: false` would still drop it with no queue behind this
    // adapter, and returning `durable: true` was the dishonest stub this
    // guard replaces. Durable enqueue lands only with the real SDK
    // workflow-name mapping, certified at W0-04.
    throw new Error(
      "hatchet enqueue is not certified (W0-04 gate pending): this adapter is construction-only and creates no durable run; refusing to enqueue instead of claiming durability",
    );
  }

  async tick(limit = 50): Promise<TickResult> {
    // Server-side execution: nothing to poll in-process. The limit is
    // accepted (and bounded) to keep the caller shape substrate-agnostic.
    void Math.min(Math.max(Math.floor(limit), 1), 500);
    return { processed: 0, failed: 0 };
  }
}

/**
 * Synchronous presence check for the OPTIONAL Hatchet SDK. Uses
 * `require.resolve` (no module load, no network) so the constructor can
 * throw when the SDK is absent and the factory can fall back to local
 * without ever breaking boot or build.
 */
function assertHatchetSdkPresent(): void {
  const specifier = "@hatchet-dev/hatchet";
  try {
    createRequire(import.meta.url).resolve(specifier);
  } catch {
    throw new Error(`hatchet SDK is not installed (optional dependency ${specifier})`);
  }
}

export type WorkflowAdapterKind = "local" | "hatchet";

export interface WorkflowAdapterSelection {
  adapter: WorkflowPort;
  kind: WorkflowAdapterKind;
}

/**
 * Factory: Hatchet only when `HATCHET_API_TOKEN` is set AND the adapter
 * constructs; every failure falls back to the local adapter with a logged
 * warning. Local mode is explicitly NON-durable.
 */
export function createWorkflowAdapter(env: NodeJS.ProcessEnv | HatchetEnv = process.env): WorkflowAdapterSelection {
  const token = env["HATCHET_API_TOKEN"];
  if (typeof token === "string" && token.length > 0) {
    try {
      return { adapter: new HatchetWorkflowAdapter(env), kind: "hatchet" };
    } catch (err) {
      warn(`[workflows] hatchet adapter unavailable, falling back to local (non-durable): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { adapter: new LocalWorkflowAdapter(), kind: "local" };
}

function warn(message: string): void {
  console.warn(message);
}
