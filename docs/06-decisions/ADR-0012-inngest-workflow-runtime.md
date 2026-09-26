# ADR-0012 — Inngest workflow runtime

- Status: **SUPERSEDED** by ADR-0019
- Original decision: Inngest as proposed durable workflow runtime.
- Reason for supersession: final architecture prefers Hatchet subject to Wave 0 certification because it aligns with self-hosted TypeScript durable workflows and tenant-scoped concurrency. Inngest remains the first fallback candidate if Hatchet certification fails.
