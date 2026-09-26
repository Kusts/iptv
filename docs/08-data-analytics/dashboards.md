# Dashboard Information Architecture

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Autoridade: quais decisões cada dashboard deve suportar. Não redefine métricas.

## 1. Princípio

Dashboard não é coleção de gráficos.

Cada superfície precisa responder uma pergunta operacional ou estratégica e usar métricas do `Metric Catalog`.

## 2. Executive / Business Overview

Perguntas:

- estamos crescendo com lucro?;
- retenção está saudável?;
- referral está substituindo aquisição mais cara?;
- há riscos operacionais relevantes?;

Blocos:

- MRR;
- Revenue;
- Contribution Profit/Margin;
- Active Paying Customers;
- CAC / LTV / Payback;
- Renewal / Churn;
- Referral Share;
- Trial → Paid;
- Provider Health alerts;
- Inventory runway;
- AI/HITL operational summary.

Sempre incluir período e comparação equivalente.

## 3. Acquisition & Funnel

```text
Traffic/Touch
→ Lead
→ Trial Request
→ Trial Activated
→ Technical Pass
→ Offer
→ Order Settled
→ Subscription Activated
```

Segmentar por:

- source;
- campaign;
- creative;
- referral;
- device;
- app.

Mostrar maturity de coorte onde necessário.

## 4. Trial & Compatibility

Blocos:

- eligibility decisions;
- Trial Abuse/Review;
- Trial activation;
- technical pass/fail/inconclusive;
- time to first playback;
- Retrial reasons;
- compatibility matrix;
- top failure reasons;
- server/app/device combinations.

## 5. Revenue & Profitability

- Revenue por product/plan;
- MRR;
- COGS;
- Contribution;
- Payment fees;
- Coupon/Reward cost;
- provider credit cost;
- app margin;
- additional connection recurring revenue/COGS;
- profit per Customer/cohort/channel.

Tela adicional deve mostrar custo mensal acumulado, nunca apenas custo de ativação.

## 6. Subscription & Retention

- renewals due;
- renewal rate;
- overdue;
- grace/courtesy extensions;
- churn;
- winback;
- cohort retention;
- Customer Health distribution.

## 7. Referral & Loyalty

- eligible advocates;
- ask rate;
- invite rate;
- attributed/confirmed referrals;
- Referral Conversion;
- Referral CAC;
- reward cost;
- Contribution per Reward Cost;
- Gift Pass conversion;
- referral-assisted winback.

Separar valor percebido de reward e custo econômico real.

## 8. Support & Knowledge

- open tickets;
- resolution time;
- AI Resolution;
- HITL;
- incidents;
- recurring Problems;
- solution success;
- knowledge reuse;
- stale/degraded knowledge;
- top unresolved categories.

## 9. Provider Operations

- operation queue;
- success/failure;
- browser human-required;
- drift;
- reconciliation;
- server/provider health;
- adapter degraded status;
- pending fulfillment age.

## 10. Inventory & Procurement

- credit balance;
- weighted unit cost;
- burn rate;
- consumption by base/additional connection;
- days of inventory;
- upcoming renewal demand;
- reorder point;
- procurement recommendations.

## 11. Agent & Automation

- task success;
- tool success;
- wrong actions;
- policy blocks;
- shadow agreement;
- human overrides;
- LLM/tool cost;
- latency;
- action risk classes;
- kill-switch/feature states relevantes.

## 12. Growth

- spend;
- CPL/CAC;
- Trial quality;
- technical pass;
- paid conversion;
- 30/60/90d retention quando maduro;
- LTV;
- Contribution by campaign/creative;
- attribution model selector.

Evitar ranking de campanha apenas por CPL/ROAS curto.

## 13. SaaS Control Plane futuro

Por tenant:

- usage;
- variable cost;
- activation;
- feature adoption;
- health;
- support;
- SaaS gross margin.

## 14. Data quality surface

Admin interno deve enxergar:

- invalid events;
- unknown acquisition rate;
- late events;
- missing spend sync;
- reconciliation gaps;
- metric freshness;
- schema version drift.

Sem isso, dashboards podem parecer corretos enquanto a telemetria está quebrada.

## 15. Auto-revisão aplicada

Revisado para:

- não duplicar fórmula de métricas;
- atrelar cada dashboard a decisões;
- destacar data quality;
- incluir recurring additional-connection economics;
- separar attribution models;
- evitar vanity metrics como critério isolado.
