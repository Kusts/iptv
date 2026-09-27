/**
 * W1-08 workflow port — public entry point. The port types live in
 * `./types.js`; the substrates are the local in-process adapter (default,
 * explicitly non-durable) and the Wave-0-gated Hatchet adapter.
 */
export type {
  EnqueueResult,
  TickResult,
  WorkflowHandler,
  WorkflowPort,
  WorkflowTask,
} from "./types.js";
export { newTaskId } from "./types.js";
export { LocalWorkflowAdapter } from "./local-adapter.js";
export { HatchetWorkflowAdapter, createWorkflowAdapter } from "./hatchet-adapter.js";
export type { HatchetEnv, WorkflowAdapterKind, WorkflowAdapterSelection } from "./hatchet-adapter.js";
