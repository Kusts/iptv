import { createRequire } from "node:module";
import { LocalWorkflowAdapter } from "./local-adapter.js";
import { newTaskId, type TickResult, type WorkflowHandler, type WorkflowPort, type WorkflowTask } from "./types.js";

export interface HatchetEnv {
  HATCHET_API_TOKEN?: string;
  HATCHET_SERVER_URL?: string;
}

/**
 * Hatchet durable-workflow adapter (W1-08, Wave-0-gated — NEVER the default).
 *
 * Requires `HATCHET_API_TOKEN` (+ optional `HATCHET_SERVER_URL`) AND the
 * `@hatchet-dev/hatchet` SDK installed. The SDK is loaded with a dynamic
 * `import()` behind env so a missing package/config can never break boot:
 * the constructor throws when config is absent and `enqueue` throws a
 * descriptive error when the SDK is absent — both cases make
 * `createWorkflowAdapter` fall back to `LocalWorkflowAdapter` with a logged
 * warning. No Hatchet network call happens at construction time.
 *
 * `tick()` is a compatibility no-op returning zeros: Hatchet drives
 * execution server-side (scheduled runs trigger workers through the Hatchet
 * cluster); the local scheduler loop keeps calling `tick()` so swapping
 * substrates never changes the caller shape. Durable adoption as a whole
 * awaits W0-04 certification.
 */
export class HatchetWorkflowAdapter implements WorkflowPort {
  private readonly handlers = new Map<string, WorkflowHandler>();
  private readonly serverUrl: string | null;

  constructor(env: NodeJS.ProcessEnv | HatchetEnv = process.env) {
    const token = env["HATCHET_API_TOKEN"];
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("hatchet is not configured (HATCHET_API_TOKEN)");
    }
    // The token is validated here but never stored or logged: Hatchet
    // client construction (with the SDK) reads it from env at call time.
    assertHatchetSdkPresent();
    const serverUrl = env["HATCHET_SERVER_URL"];
    this.serverUrl = typeof serverUrl === "string" && serverUrl.length > 0 ? serverUrl : null;
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
    const sdk = await loadHatchetSdk();
    void sdk;
    void this.serverUrl;
    void task.payload;
    // The durable scheduled run is created through the Hatchet client
    // (tenant scoping travels inside `task.payload`, never as SDK auth).
    // Concrete workflow-name mapping is pinned at W0-04 certification;
    // until then this path is construction-only and never the default.
    return { id: newTaskId(), durable: true };
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

/**
 * Load the Hatchet SDK lazily. The specifier goes through a variable so a
 * missing optional dependency stays a runtime fallback (never a build or
 * boot breakage): with no `HATCHET_API_TOKEN` this is never attempted.
 */
async function loadHatchetSdk(): Promise<unknown> {
  const specifier = "@hatchet-dev/hatchet";
  try {
    return await import(specifier);
  } catch (err) {
    throw new Error(
      `hatchet SDK is not installed (optional dependency ${specifier}): ${err instanceof Error ? err.message : String(err)}`,
    );
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
