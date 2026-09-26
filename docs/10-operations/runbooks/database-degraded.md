# Runbook — Database Degraded / Unavailable

> Status: Operational baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for authoritative-state safety and no unsafe write fallback.

## Trigger

High error/latency, connection exhaustion, read/write unavailability or corruption concern affecting PostgreSQL.

## Immediate actions

1. declare/assess incident severity;
2. disable non-essential/high-write automation via kill switches if useful;
3. stop unsafe retries that amplify DB load;
4. confirm whether problem is connectivity, saturation, migration, storage or provider outage;
5. preserve logs/metrics and deployment/migration timeline.

## Safety

Do not route authoritative writes to local memory/spreadsheets/LLM context as a substitute. Customer-facing flows should fail safely or queue only when durability is guaranteed outside the affected DB path.

## Recovery

Follow infrastructure-specific failover/restore procedure. After recovery validate migrations, outbox/inbox lag, workflow backlog and reconciliation before full automation resumes.

## Exit criteria

Stable DB health + successful smoke tests + backlog draining + no integrity alert.

## Auto-review result

Reviewed to preserve source-of-truth integrity during outage.
