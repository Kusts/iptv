# EPIC-05 — Provider Fulfillment & Inventory

## Outcome

Executar fulfillment externo de forma idempotente, verificável e economicamente rastreável.

## Stories

### PI-01 — Provider account / bindings

**Aceite:** external IDs ficam em bindings; secrets permanecem fora do banco; tenant A não usa account do tenant B.

### PI-02 — ProviderOperation runtime

**Aceite:** estados canônicos; SUCCEEDED somente após postcondition; timeout observa estado externo antes de retry.

### PI-03 — API adapter + Browser adapter

**Aceite:** Core usa a mesma Port; browser tem allowlist, trace redaction e HITL para CAPTCHA/2FA/challenge.

### PI-04 — Evidence & adapter version

**Aceite:** tentativa guarda adapter version, trace/evidence refs e observed before/after sem secrets.

### PI-05 — Credit procurement

**Aceite:** lote de créditos guarda quantidade/custo unitário/remaining; ofertas de fornecedor são versionadas.

### PI-06 — Credit consumption ledger

**Aceite:** consumo é append-only e idempotente; pode ser atribuído a cycle/add-on/provider operation.

### PI-07 — 45-day provider account rule

**Aceite:** sistema calcula dias desde recarga e gera alertas operacionais configuráveis antes do limite do fornecedor.

## Epic Gate

Renew + change connections + credit consumption demonstrados e reconciliáveis.
