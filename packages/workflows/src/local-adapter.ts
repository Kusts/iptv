import { newTaskId, type TickResult, type WorkflowHandler, type WorkflowPort, type WorkflowTask } from "./types.js";

interface StoredTask {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  runAt: number;
  idempotencyKey: string | null;
}

/**
 * In-process workflow adapter (W1-08 default).
 *
 * Handlers run on `tick()` (driven by the API scheduler loop); due tasks
 * are scanned in `runAt` order. Tasks persist IN MEMORY ONLY — a process
 * restart drops every queued task. This is NOT a durable workflow engine;
 * durable execution awaits Hatchet adoption after Wave-0 certification.
 *
 * Failure isolation: one throwing handler is counted as failed and never
 * prevents the remaining due tasks in the same tick.
 */
export class LocalWorkflowAdapter implements WorkflowPort {
  private readonly handlers = new Map<string, WorkflowHandler>();
  private readonly queue: StoredTask[] = [];
  private readonly seenKeys = new Set<string>();

  registerHandler(name: string, handler: WorkflowHandler): void {
    if (this.handlers.has(name)) {
      throw new Error(`workflow handler already registered: ${name}`);
    }
    this.handlers.set(name, handler);
  }

  async enqueue(task: WorkflowTask): Promise<{ id: string; durable: boolean }> {
    if (task.idempotencyKey !== undefined && this.seenKeys.has(task.idempotencyKey)) {
      const existing = this.queue.find((t) => t.idempotencyKey === task.idempotencyKey);
      return { id: existing?.id ?? task.idempotencyKey, durable: false };
    }
    const id = newTaskId();
    if (task.idempotencyKey !== undefined) {
      this.seenKeys.add(task.idempotencyKey);
    }
    this.queue.push({
      id,
      name: task.name,
      payload: task.payload,
      runAt: task.runAt?.getTime() ?? Date.now(),
      idempotencyKey: task.idempotencyKey ?? null,
    });
    return { id, durable: false };
  }

  async tick(limit = 50): Promise<TickResult> {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    const at = Date.now();
    const due = this.queue
      .filter((t) => t.runAt <= at)
      .sort((a, b) => a.runAt - b.runAt)
      .slice(0, safeLimit);
    let processed = 0;
    let failed = 0;
    for (const task of due) {
      const handler = this.handlers.get(task.name);
      if (handler === undefined) {
        failed += 1;
        continue;
      }
      try {
        await handler(task.payload);
        processed += 1;
        this.remove(task.id);
      } catch {
        failed += 1;
        // Keep the failed task queued for a later tick (at-least-once
        // within process lifetime); the loop itself always continues.
      }
    }
    return { processed, failed };
  }

  /** Introspection for tests/ops (counts only, no payloads). */
  pending(): number {
    return this.queue.length;
  }

  private remove(id: string): void {
    const index = this.queue.findIndex((t) => t.id === id);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }
}
