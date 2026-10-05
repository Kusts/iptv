# Operations Runbooks

> Review: Auto-reviewed v0.12 — checked for runbook index completeness and safe escalation paths.

> Status: Baseline index  
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

Runbooks are executable operational procedures, not architecture explanations.

Available baseline runbooks:

- [Provider unavailable / CINEVISION degraded](provider-down.md)
- [WhatsApp gateway unavailable](whatsapp-down.md)
- [AI/model runtime unavailable](ai-down.md)
- [Asaas webhook failure / queue drift](payment-webhook-failure.md)

Each runbook follows: detect → contain → preserve state → communicate → recover → reconcile → learn.

## Additional v0.12 runbooks

- [database-degraded.md](database-degraded.md)
- [outbox-workflow-backlog.md](outbox-workflow-backlog.md)
- [reconciliation-drift.md](reconciliation-drift.md)
- [provider-credit-low.md](provider-credit-low.md)
- [browser-drift-challenge.md](browser-drift-challenge.md)
- [migration-failure.md](migration-failure.md)
- [hitl-backlog.md](hitl-backlog.md)
- [rls-role-split-cutover.md](rls-role-split-cutover.md)
- [staging-deploy.md](staging-deploy.md)
- [backup-restore.md](backup-restore.md)
