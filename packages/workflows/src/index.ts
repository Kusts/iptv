/**
 * W1-08 workflow port — public entry point.
 *
 * The MVP has exactly one substrate: `LocalWorkflowAdapter` (in-process,
 * explicitly NON-durable). Durable work that must not be lost (financial or
 * supplier operations) belongs to the dedicated outbox worker, not here.
 *
 * Task names are free-form strings agreed with the caller; payloads are plain
 * JSON records — never class instances, never secrets.
 */

export type {
  EnqueueResult,
  TickResult,
  WorkflowHandler,
  WorkflowTask,
  WorkflowPort,
} from "./types.js";
export { newTaskId } from "./types.js";
export { LocalWorkflowAdapter } from "./local-adapter.js";
