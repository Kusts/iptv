# Metric Catalog — Definições Canônicas

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Autoridade: fórmula, população, janela e semântica das métricas principais do produto.

## 1. Objetivo

Garantir que o mesmo nome de métrica signifique a mesma coisa em dashboards, experimentos, relatórios e Business Learning.

Metas numéricas não são definidas aqui antes do baseline.

## 2. Convenções

### Population
A população elegível deve ser explicitada.

### Window
Toda conversão/retention precisa de janela temporal clara.

### Revenue
Valores financeiros realizados vêm prioritariamente do Financial Ledger e de Orders/Payments reconciliados.

### Attribution
Métricas por channel/campaign utilizam o modelo indicado em `attribution.md`.

### Version
Mudança incompatível na fórmula gera nova versão lógica da métrica.

---

# 3. Acquisition

## ACQ-01 — Leads

**Definição**  
Count de `lead.created.v1` únicos no período.

**Segmentações**  
source, channel, campaign, referral/paid/organic, tenant.

## ACQ-02 — Lead Source Mix

**Fórmula**

```text
Leads do source / Leads totais com source classificável
```

`unknown` deve ser exibido separadamente, não redistribuído.

## ACQ-03 — CPL

```text
Paid Media Spend atribuído à população / Leads atribuídos
```

Apresentar por plataforma/campanha e blended paid CPL.

## ACQ-04 — CAC

```text
Acquisition Cost / New Paying Customers
```

Duas versões oficiais:

- `Paid CAC`: paid media + custos diretamente atribuíveis à aquisição paga;
- `Blended CAC`: todos os custos de aquisição definidos / todos os novos Customers pagantes.

Referral reward não deve ser misturado em Paid CAC; pertence a Referral CAC.

## ACQ-05 — Referral Share

```text
New Paying Customers com Primary Acquisition = REFERRAL
/
New Paying Customers totais
```

---

# 4. Trial

## TRIAL-01 — Trial Request Rate

```text
Persons/Leads que geraram trial.requested
/
Leads elegíveis ao fluxo de Trial
```

## TRIAL-02 — Eligibility Approval Rate

```text
ALLOW + ALLOW_RETRIAL
/
Trial eligibility decisions totais
```

Sempre exibir ALLOW e ALLOW_RETRIAL também separadamente.

## TRIAL-03 — Trial Technical Pass Rate

```text
Trials válidos com technical outcome PASSED
/
Trials válidos com outcome conclusivo PASSED ou FAILED
```

`INCONCLUSIVE`, `INVALIDATED` e provider-caused failures devem aparecer separadamente e não ser silenciosamente tratados como FAIL.

## TRIAL-04 — Time to First Playback

Mediana e percentis do intervalo:

```text
trial.first_playback_observed.occurred_at
-
trial.activated.occurred_at
```

Somente Trials com ambos os eventos.

## TRIAL-05 — Trial → Paid Conversion

**População**  
Trials válidos, tecnicamente utilizáveis ou com regra de inclusão explícita.

**Numerador**  
Persons com primeiro `payment.paid.v1`/`order.settled.v1` de assinatura dentro da janela após Trial.

**Denominador**  
Persons da população de Trial considerada.

**Janela inicial**  
Configurável e versionada; dashboards devem mostrar a janela utilizada.

## TRIAL-06 — Retrial Rate

```text
Persons com trial.retrial_allowed
/
Persons que solicitaram Trial
```

## TRIAL-07 — Legitimate Retrial → Paid

```text
Persons com Retrial legítimo que viraram pagantes na janela
/
Persons com Retrial legítimo ativado
```

## TRIAL-08 — Trial Abuse Rate

```text
Persons/requests com risk.abuse_confirmed relacionado a Trial
/
Trial requests avaliados
```

## TRIAL-09 — False Positive Review Rate

```text
Risk reviews de Trial inicialmente suspeitos e posteriormente cleared
/
Risk reviews de Trial concluídos
```

---

# 5. Sales & Commerce

## SALES-01 — Lead → Paid

```text
Leads que alcançaram primeiro Order settled de assinatura
/
Leads criados na coorte
```

Preferir análise por coorte para evitar viés de Leads recentes ainda sem tempo de converter.

## SALES-02 — Offer → Order

```text
Offers accepted que resultaram em Order accepted/submitted válido
/
Offers presented elegíveis
```

## SALES-03 — Order → Settled

```text
Orders settled
/
Orders accepted elegíveis
```

Settlement pode ser coberto por Payment e/ou credits/rewards autorizados.

## SALES-04 — Sales Cycle Time

Tempo mediano entre:

```text
lead.created
→
primeiro order.settled de assinatura
```

## SALES-05 — Discount Dependency

```text
Orders settled com discount_amount > 0 ou reward_credit_amount > 0
/
Orders settled
```

Segmentar coupon, promotion e reward credit.

---

# 6. Billing & Fulfillment

## BILL-01 — Payment Confirmation Latency

Tempo entre confirmação externa observada e `payment.paid.v1` reconciliado internamente.

Usar mediana/P95.

## BILL-02 — Critical Duplicate Effects

Count de efeitos financeiros duplicados confirmados por idempotency/reconciliation incident.

**Target estrutural:** zero.

## FUL-01 — Provider Operation Success Rate

```text
provider.operation_succeeded
/
provider operations terminalizadas (succeeded + failed + cancelled)
```

`human_required` não é terminal enquanto operação puder ser retomada.

## FUL-02 — Fulfillment Latency

Tempo entre entitlement pronto para fulfillment e `provider.operation_succeeded` com postcondition válida.

## FUL-03 — Fulfillment Drift Rate

```text
Unique fulfilled entities com drift detectado
/
Unique fulfilled entities reconciliadas/verificadas
```

## FUL-04 — Auto-Reconciliation Recovery

```text
Drifts repaired sem HITL
/
Drifts repaired totais
```

## FUL-05 — Browser Human-Required Rate

```text
Browser provider operations que geraram human_required
/
Browser provider operations iniciadas
```

---

# 7. Subscription & Retention

## RET-01 — Renewal Rate

```text
Subscriptions com renewal_due que foram renovadas dentro da grace/window
/
Subscriptions elegíveis para renovação
```

## RET-02 — Logo Churn

```text
Customers que churned na janela
/
Customers ativos elegíveis no início/definição da janela
```

A população exata deve permanecer constante dentro da versão da métrica.

## RET-03 — Revenue Churn

```text
Recurring revenue perdido por churn/downgrade
/
Recurring revenue elegível no início da janela
```

Expansion não deve mascarar gross revenue churn; apresentar net revenue retention separadamente no futuro.

## RET-04 — Cohort Retention

```text
Customers da coorte ainda ativos no marco N
/
Customers originais da coorte
```

Marcos: 30/60/90/180/365 dias quando houver maturidade.

## RET-05 — Winback Rate

```text
Customers churned elegíveis que reativaram na janela
/
Customers churned abordados/elegíveis conforme análise
```

Exibir versão `contacted` e `eligible` quando necessário.

## RET-06 — Courtesy Extension Recovery

```text
Courtesy extensions seguidas por renovação paga/continuidade qualificada na janela
/
Courtesy extensions concedidas
```

Não interpretar automaticamente como efeito causal; campanhas devem usar Experiment Engine quando quisermos inferir causalidade.

---

# 8. Additional Connection / Recurring Add-on

## ADDON-01 — Additional Connection Attach Rate

```text
Active Customers com ADDITIONAL_CONNECTION entitlement/add-on recorrente
/
Active Customers elegíveis
```

## ADDON-02 — Recurring Connection Revenue

Soma da receita recorrente reconhecida/gerencial atribuída ao add-on de conexão no período.

## ADDON-03 — Recurring Connection COGS

Soma de `inventory.provider_credit_consumed` e outros custos diretamente vinculados às conexões adicionais durante cada ciclo.

**Regra:** custo reaparece em cada ciclo enquanto o add-on estiver ativo.

## ADDON-04 — Additional Connection Contribution Margin

```text
Recurring Connection Revenue
-
Recurring Connection COGS
-
outros custos variáveis diretamente atribuíveis
```

## ADDON-05 — Rewarded Connection Cost

Custo acumulado das conexões adicionais concedidas como Reward, incluindo ciclos futuros efetivamente consumidos enquanto o benefício permanecer ativo.

---

# 9. App Licenses

## APP-01 — App Attach Rate

```text
Customers com App License comprada ou concedida
/
Customers elegíveis
```

Também apresentar paid attach separadamente de rewarded attach.

## APP-02 — App Revenue

Receita de Order Items classificados como App License.

## APP-03 — App Gross Margin

```text
App Revenue - Supplier App License Cost
```

## APP-04 — App Reward Cost

Supplier cost de licenças concedidas gratuitamente/descontadas como Reward.

## APP-05 — App Support Impact

Comparação de support incidence/resolution outcomes entre grupos de App, com controle de contexto quando possível.

Não interpretar diferença observacional como causalidade sem experimento apropriado.

---

# 10. Referral

## REF-01 — Referral Ask Rate

```text
Eligible Customers que receberam pedido de indicação
/
Eligible Customers
```

## REF-02 — Referral Invite Rate

```text
Customers que criaram/compartilharam Referral
/
Customers que receberam pedido de indicação
```

## REF-03 — Referral Trial Rate

```text
Referred Persons com Trial válido iniciado
/
Referred Persons atribuídas
```

## REF-04 — Referral Conversion Rate

```text
Referrals confirmed
/
Referred Persons atribuídas elegíveis
```

`referral.confirmed` deve seguir regra antifraude/qualificação vigente.

## REF-05 — Referrals per Advocate

```text
Referrals created / Unique advocates
```

Apresentar também confirmed referrals por advocate.

## REF-06 — Referral CAC

```text
Reward cost realizado + custos incrementais do programa
/
Customers adquiridos por Referral
```

Usar custo econômico real da recompensa, não apenas valor percebido.

## REF-07 — Referral LTV

LTV calculado exclusivamente sobre Customers com Primary Acquisition = REFERRAL, além de análises assistidas separadas.

## REF-08 — Referral Contribution Margin

Contribution Profit das coortes Referral.

## REF-09 — Referral K-factor

Versão operacional inicial:

```text
Confirmed referrals médios por active advocate elegível
```

Não usar como modelo epidemiológico literal. O valor deve ser acompanhado com definição versionada e período explícito.

## REF-10 — Referral-assisted Winback

```text
Winbacks associados a campanha/referral incentive
/
Winbacks elegíveis do programa
```

## REF-11 — Contribution per Reward Cost

```text
Contribution Profit incremental/atribuído ao programa
/
Reward Cost realizado
```

Quando incrementalidade não puder ser provada, rotular como `attributed`, não `incremental`.

---

# 11. Support

## SUP-01 — First Response Time

Tempo entre primeira mensagem/ticket qualificado e primeira resposta útil.

Bots de mera confirmação não contam como resposta útil.

## SUP-02 — Resolution Time

Tempo entre abertura/início do problema e `support.resolved`, descontando ou segmentando períodos `waiting_customer` quando necessário.

## SUP-03 — AI Resolution Rate

```text
Tickets resolvidos com resolved_by = AI e sem guidance/takeover humano relevante
/
Tickets resolvidos elegíveis
```

## SUP-04 — Human Escalation Rate

```text
Tickets/conversations que geraram HITL relevante
/
Tickets/conversations elegíveis
```

## SUP-05 — First Contact Resolution

```text
Tickets resolvidos sem reabertura/novo ticket relacionado na janela definida
/
Tickets resolvidos elegíveis
```

## SUP-06 — Reopen Rate

```text
support.reopened
/
support.resolved
```

## SUP-07 — Customer Satisfaction

Preferir CSAT explícito. Proxies comportamentais devem ser identificados como proxy e nunca renomeados como satisfação real.

---

# 12. Knowledge

## KNOW-01 — Solution Success Rate

```text
SUCCESS outcomes
/
SUCCESS + FAILURE outcomes conclusivos
```

Segmentar por context signature.

## KNOW-02 — Attempts Before Resolution

Número de `solution_outcome`/procedimentos tentados até resolução confirmada.

## KNOW-03 — Knowledge Reuse Rate

```text
Resolved tickets que utilizaram Knowledge previamente VERIFIED
/
Resolved tickets elegíveis
```

## KNOW-04 — Human Guidance Reuse

Quantidade/taxa de guidance humano convertido em Knowledge VERIFIED e reutilizado com sucesso posteriormente.

## KNOW-05 — Stale Knowledge Rate

```text
Knowledge DEGRADED/DEPRECATED por freshness/evidência
/
Knowledge VERIFIED ativo
```

## KNOW-06 — Candidate → Verified Rate

```text
Candidates que atingiram VERIFIED
/
Candidates avaliados
```

---

# 13. Agent

## AI-01 — Agent Task Success

Outcome correto por task class conforme eval online/offline definida.

## AI-02 — Tool Success Rate

```text
Tool calls com postcondition confirmada
/
Tool calls terminalizadas
```

## AI-03 — Wrong Action Rate

```text
Ações executadas posteriormente classificadas como incorretas
/
Ações executadas elegíveis
```

Sempre segmentar por Action Risk Class.

## AI-04 — Policy Blocks

Count/taxa de ações negadas corretamente pela Policy Engine. Deve ser analisada junto de false positives.

## AI-05 — Cost per Conversation / Task

Custo variável de LLM/tools atribuído à unidade operacional.

## AI-06 — Human Override Rate

```text
Agent recommendations/decisions alteradas por humano
/
recommendations/decisions revisadas
```

## AI-07 — Shadow Agreement

```text
Shadow decisions equivalentes à decisão humana aprovada
/
Shadow decisions comparáveis
```

Não usar acordo bruto como único critério de segurança.

---

# 14. Financial

## FIN-01 — MRR

Monthly Recurring Revenue gerencial derivado de componentes recorrentes ativos normalizados para equivalente mensal.

Exemplo:

```text
Plano anual R$225 → R$18,75 MRR equivalente
```

MRR não é caixa recebido.

Exclusões iniciais:

- one-time App License;
- refunds;
- créditos promocionais sem receita;
- Gift Pass não monetizado.

Add-on recorrente de conexão entra no MRR pelo preço recorrente líquido aplicável.

## FIN-02 — ARPU

```text
Revenue reconhecida/gerencial da população no período
/
Average Active Paying Customers
```

A variante exata deve ser rotulada (`ARPU monthly`, etc.).

## FIN-03 — Gross Profit / Margin

```text
Gross Profit = Revenue - COGS
Gross Margin = Gross Profit / Revenue
```

COGS inclui provider credits e supplier app license cost diretamente vinculáveis.

## FIN-04 — Contribution Profit / Margin

```text
Contribution Profit = Revenue - COGS - Variable/Incremental Operating Costs
Contribution Margin = Contribution Profit / Revenue
```

A lista de custos incluídos deve ser versionada e transparente.

## FIN-05 — LTV

Enquanto não houver histórico maduro suficiente, utilizar LTV observado por coorte como principal referência.

Modelos preditivos futuros devem ser rotulados como `Predicted LTV` e não substituir silenciosamente `Observed LTV`.

## FIN-06 — LTV:CAC

```text
LTV da população / CAC correspondente
```

Não comparar LTV de uma população com CAC de outra.

## FIN-07 — Payback Period

Primeiro ponto temporal em que contribution acumulada da coorte recupera CAC/custos iniciais definidos.

## FIN-08 — Profit per Customer

Contribution Profit acumulado / por período por Customer.

## FIN-09 — Profit per Campaign

Contribution Profit atribuído a Customers do modelo de attribution selecionado menos acquisition spend correspondente.

---

# 15. Inventory & Procurement

## INV-01 — Credit Balance

Saldo de provider credits reconstruído pelo Provider Credit Ledger e reconciliado quando possível.

## INV-02 — Weighted Unit Cost

```text
Valor econômico remanescente dos credits / quantidade remanescente
```

Método contábil/gerencial definitivo deve ser fixado em SPEC financeira.

## INV-03 — Burn Rate

Provider credits consumidos / unidade de tempo.

Segmentar:

- base subscription;
- additional connections;
- outros.

## INV-04 — Days of Inventory

```text
Current Credit Balance / Forecast Daily Burn
```

Exibir incerteza quando forecast ainda for fraco.

## INV-05 — Stockout Events

Count de casos em que saldo insuficiente bloqueou/atrasou fulfillment.

## INV-06 — Procurement Savings

Economia observada contra benchmark interno versionado, por exemplo preço que seria pago no lote alternativo comparável.

---

# 16. Reliability

## REL-01 — Workflow Failure Rate

```text
Workflows terminalizados em failure
/
Workflows terminalizados
```

## REL-02 — Retry Recovery Rate

```text
Falhas transitórias recuperadas automaticamente
/
Falhas transitórias elegíveis
```

## REL-03 — Dead-letter Age

Idade dos itens pendentes de intervenção; reportar P50/P95/max e quantidade acima do SLO.

## REL-04 — Reconciliation Drift Age

Tempo entre detecção e reparo/fechamento do drift.

## REL-05 — Critical Duplicate Effects

Count de duplicate side effects críticos confirmados.

**Target estrutural:** zero.

---

# 17. SaaS

## SAAS-01 — Cost per Tenant

Soma de custos variáveis atribuíveis ao tenant no período.

## SAAS-02 — Usage per Tenant

Métricas de uso: LLM, messages, browser minutes, storage, transcription, contacts, workflows etc.

## SAAS-03 — Tenant Activation

Tenant que completa onboarding mínimo e executa o primeiro workflow real definido.

## SAAS-04 — Tenant Retention

Retenção do SaaS por coorte de tenants.

## SAAS-05 — SaaS Gross Margin

Receita SaaS menos COGS/infra diretamente associados ao serviço SaaS, separada da margem operacional IPTV de cada tenant.

---

# 18. Métricas de guardrail

Devem acompanhar otimizações importantes:

- Contribution Margin;
- Complaint/Opt-out Rate;
- Trial Abuse False Positive Rate;
- Refund/Chargeback Rate;
- Support Volume;
- Provider Failure Rate;
- Human Escalation Rate;
- Policy Violation/Wrong Action Rate;
- Message Delivery Health;
- Churn/Retention.

## 19. Auto-revisão aplicada

Revisado para:

- usar `Order Settled`, não “paid order” como regra geral;
- separar caixa de MRR;
- manter additional connection como revenue e COGS recorrentes;
- separar resultado atribuído de resultado incremental;
- evitar causalidade indevida em Courtesy Extension/App/Referral;
- evitar denominator bias em Trial e Sales;
- exigir população/janela/modelo de attribution explícitos.
