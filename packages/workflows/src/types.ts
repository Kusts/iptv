import { randomUUID } from "node:crypto";

/**
 * W1-08 workflow port. Worker-eligible work (trial/order/charge expiry,
 * renewal reminders/overdue, outbox + webhook drains) is expressed as named
 * tasks behind this port so the execution substrate is swappable:
 * - default: `LocalWorkflowAdapter` (in-process, explicitly NON-durable —
 *   tasks live only in memory and are lost on process exit);
 * - Wave-0-gated: `HatchetWorkflowAdapter` (construction-only placeholder —
 *   env/SDK-gated construction, but `enqueue` fails closed and never claims
 *   durability; durable adoption awaits W0-04 certification and is NEVER
 *   the default).
 *
 * Task names are free-form strings agreed with the caller (e.g.
 * `trial.expire_due`); payloads are plain JSON records — never class
 * instances, never secrets.
 */

export interface WorkflowTask {
  name: string;
  payload: Record<string, unknown>;
  /** Not-before instant; absent means "as soon as possible". */
  runAt?: Date;
  /** Caller-supplied dedupe key; the local adapter drops exact replays. */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  id: string;
  /** True only when the substrate persists the task durably. */
  durable: boolean;
}

export interface TickResult {
  processed: number;
  failed: number;
}

export type WorkflowHandler = (payload: Record<string, unknown>) => Promise<void>;

export interface WorkflowPort {
  enqueue(task: WorkflowTask): Promise<EnqueueResult>;
  registerHandler(name: string, handler: WorkflowHandler): void;
  /** Run every due task once. Never throws for a single task failure. */
  tick(limit?: number): Promise<TickResult>;
}

export function newTaskId(): string {
  return randomUUID();
}
