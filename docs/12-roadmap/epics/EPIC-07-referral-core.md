# EPIC-07 — Referral Core

## Outcome

Tratar indicação como canal mensurável de aquisição e retenção, sem criar incentivo fácil de abusar.

## Stories

### RF-01 — Referral identity/code

**Aceite:** convite liga referrer e referred Person sem substituir attribution original indevidamente.

### RF-02 — Qualification

**Aceite:** click/signup/trial não confirma referral; conversão válida + policy + risk qualificam.

### RF-03 — Anti-abuse

**Aceite:** self-referral/identidade duplicada/payment/device loops podem gerar REVIEW/DENY; falso positivo pode ir para HITL.

### RF-04 — Reward issuance

**Aceite:** reward é ledgered; benefício pode originar entitlement/credit sem alterar Payment histórico.

### RF-05 — Referral-triggered renewal

**Aceite:** campanha pode cobrir renovação via credits/reward; Order net=0 fica SETTLED sem Payment.

### RF-06 — Ask-referral triggers

**Aceite:** compra, ativação positiva, ticket resolvido, renovação e winback podem gerar oportunidade, respeitando Communication Policy.

## Epic Gate

Referral → Trial → Payment → Qualification → Reward é rastreável de ponta a ponta e tem custo/ROI calculável.
