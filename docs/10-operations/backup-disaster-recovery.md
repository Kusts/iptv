# Backup & Disaster Recovery Plan

> Status: Baseline; targets to be calibrated  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Scope

PostgreSQL, object/evidence storage, secrets/configuration references and critical deployment configuration.

## Rules

- backups are encrypted and access-separated;
- restore is tested regularly, not assumed;
- RPO/RTO are explicit per critical component;
- restore drills use isolated environment;
- ledger/audit consistency is verified after restore;
- provider/external systems are reconciled after recovery before replaying mutations.

## Recovery sequence

Contain writes if needed → restore authoritative data → validate integrity/migrations → restore application → reconcile external systems → resume queued work safely.

## Auto-review result

Reviewed to protect against blind replay after a data-plane recovery.
