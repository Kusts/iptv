# Operations Documentation

> **Operação atual do StreamMax:** [Plano de conclusão do MVP (13/11/2026)](../16-pilot-closure/MVP-FINALIZATION-PLAN-2026-11-13.md),
> [evidências de 12/11](../16-pilot-closure/STREAMMAX-MVP-STATUS-2026-11-12.md)
> e [runbook de staging](runbooks/staging-deploy.md). Os índices e registros
> anteriores podem conter snapshots históricos e não representam automaticamente
> a configuração implantada.

> Status: Canonical MVP baseline  
> Version: 0.12  
> Review: Auto-reviewed v0.12 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

- [Observability](observability.md)
- [Testing Strategy](testing-strategy.md)
- [Runbooks](runbooks/README.md)
- [SLO & Error Budget](slo-error-budget.md)
- [Backup & Disaster Recovery](backup-disaster-recovery.md)
- [Incident & Problem Management](incident-problem-management.md)
- [Privacy Operations](privacy-operations.md)
- [Release Management](release-management.md)
- [CI/CD & Quality Gates](ci-cd-quality-gates.md)
- [Service Dependency & Failure Matrix](service-dependency-failure-matrix.md)
- [Operational Dashboard Catalog](operational-dashboard-catalog.md)
- [Cost Governance](cost-governance.md)
- [Production Readiness Checklist](production-readiness-checklist.md)
- [Integrations Capability Status](integrations-capability-status.md) — matriz de evidência por integração; seu corpo é histórico e o resumo atual fica no topo do arquivo. PostgreSQL cifrado substituiu Infisical como caminho padrão; Hatchet está fora do runtime operacional.


Future operational documents extend this area with detailed SLO values, backup/restore drills, incident response and on-call procedures as the pilot environment is provisioned.
