# EPIC-08 — Reliability & Pilot Readiness

## Outcome

Tornar o tenant piloto seguro o suficiente para depender operacionalmente do sistema e produzir um case confiável.

## Stories

### RP-01 — Reconciliation jobs

**Aceite:** Asaas/provider/internal drift é detectado; auto-repair só ocorre em casos permitidos; resto vira HITL.

### RP-02 — SLOs/alerts

**Aceite:** payment ingestion, provider fulfillment, messaging e AI response possuem SLI/SLO inicial e alertas úteis.

### RP-03 — Backup/restore

**Aceite:** restore é executado e medido; RPO/RTO observados são registrados.

### RP-04 — Privacy operations

**Aceite:** export/correction/deletion/anonymization seguem Data Classification e preservam ledger/audit conforme obrigação.

### RP-05 — Pilot baseline

**Aceite:** métricas BEFORE são congeladas antes de automação e AFTER utiliza as mesmas definições do Metric Catalog.

### RP-06 — Manual fallback/runbooks

**Aceite:** provider down, WhatsApp down, AI down e payment webhook failure possuem runbook + kill switch.

### RP-07 — Release gate

**Aceite:** replay, retries, cross-tenant, recurring screen economics, Trial abuse e agent hard-fails passam em CI/staging.

## Epic Gate

O tenant piloto pode operar com fallback humano e observabilidade suficiente para medir ganho real do produto.
