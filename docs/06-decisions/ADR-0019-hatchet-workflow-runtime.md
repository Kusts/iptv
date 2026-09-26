# ADR-0019 — Hatchet durable workflow runtime

- Status: **ACCEPTED WITH WAVE-0 CERTIFICATION GATE**
- Decision: use Hatchet for durable business workflows, waits, retries, scheduled work, HITL coordination and tenant-scoped concurrency.
- Boundary: domain state remains PostgreSQL; Hatchet is process orchestration, not source of truth.
- Fallback: if the certification suite fails critical requirements, evaluate Inngest before dependent implementation expands. Temporal is future-only unless measured requirements justify migration.
