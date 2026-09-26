# Non-Functional Requirements, Pilot SLOs and Disaster Recovery

These are engineering targets for the pilot, not contractual external SLAs. Measure and recalibrate after real pilot telemetry.

## Reliability classes

### Tier 0 — integrity critical
Financial ledger, payment idempotency, tenant isolation, permissions, audit and provider-operation idempotency. Correctness takes precedence over latency. Duplicate economic effects are unacceptable.

### Tier 1 — operational critical path
API/database availability, workflow engine, messaging for active support/sales, payment processing and provider fulfillment. Must support graceful degradation and recovery.

### Tier 2 — degradable intelligence
Deep analytics, research, advanced recommendations, noncritical background learning. Failure must not stop commerce/support.

## Pilot performance targets

- API/database-only reads: server-side p95 target <= 500 ms under expected pilot load.
- Synchronous non-external commands: p95 acknowledgement <= 800 ms where safe to answer synchronously.
- External/agent workflows: immediately expose accepted/working state; never hold UI indefinitely waiting for provider/model completion.
- Inbox webhook ingestion: persist/acknowledge as quickly as possible and process asynchronously; target p95 internal acceptance <= 2 s under normal pilot load.
- UI: critical operational pages should remain usable on ordinary desktop/mobile connections and virtualize large lists rather than rendering unbounded rows.

Targets are `PILOT_CALIBRATE`; exceeding a latency target is not by itself permission to bypass integrity checks.

## Availability/degradation

No single warning should set the whole tenant to DOWN. Health is capability-specific, e.g. `WhatsApp inbound healthy / new outreach restricted`.

## Recovery objectives — pilot engineering targets

- Core database: target RPO <= 15 minutes and RTO <= 60 minutes, with managed PITR/backups where available.
- Configuration/secrets: recoverable from managed source + deployment configuration; no secrets only on a worker disk.
- Browser sessions: loss may require controlled reauthentication; business state remains in DB.
- Analytics/read models may be rebuilt from canonical facts/events where designed to do so.

These objectives must be validated by restore exercises before MVP-PILOT readiness and reviewed before external SaaS launch.

## Backup/restore

Backups are not considered complete until a restore test succeeds. Restore drills validate critical ledgers, tenant boundaries and application startup.

## Capacity/bulkheads

- per-tenant/provider/channel concurrency controls;
- browser sessions isolated from core API processes;
- expensive Agent/background work has budgets;
- one noisy tenant must not consume the whole workflow/LLM/browser pool.

## Data retention

Retention durations remain policy/legal-review items, but implementation must support independent classes for financial/audit, conversations/media, agent traces, browser evidence, knowledge and backups. Browser screenshots and raw traces should use minimum necessary retention.
