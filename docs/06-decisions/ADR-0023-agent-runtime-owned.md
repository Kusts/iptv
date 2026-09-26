# ADR-0023 — Platform-owned Agent Runtime

- Status: **ACCEPTED**
- Decision: no external agent framework owns business state, memory, policies, tools or workflow semantics. The chosen harness is an adapter within an owned runtime. This prevents framework/model lock-in and ensures frontend/manual/workflow/agent paths converge on the same application commands.
