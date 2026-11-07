# @iptv/workflows

In-process workflow port for short, non-durable tasks (expiry ticks,
reminders). The MVP has exactly one substrate: `LocalWorkflowAdapter`.

- `LocalWorkflowAdapter` — in-memory queue; tasks are lost on restart. This is
  deliberately NOT a durable engine.
- Financial/supplier operations and outbox publishing are NOT routed here.
  The MVP's durable operational path is the dedicated outbox worker backed by
  PostgreSQL (`platform.outbox_messages` + lease/claim protocol).

There is no external workflow engine (Hatchet or otherwise) in the standard
MVP runtime. A future durable substrate can implement `WorkflowPort` without
changing callers.

## Usage

```ts
import { LocalWorkflowAdapter } from "@iptv/workflows";

const workflows = new LocalWorkflowAdapter();
workflows.registerHandler("trial.expire_due", async (payload) => {
  /* idempotent handler */
});
await workflows.enqueue({ name: "trial.expire_due", payload: { tenantId } });
await workflows.tick();
```
