# Success Metrics & Validation Framework

> Status: Draft auto-revisado  
> Versão: 1.1  
> Data: 2026-09-20  
> Autoridade: categorias de sucesso e critérios de validação. Fórmulas canônicas agora vivem em `../08-data-analytics/metric-catalog.md`.

## 1. Objetivo

Definir como saberemos se o produto está melhorando a operação e quando uma capability está madura o suficiente para ganhar mais autonomia ou entrar no SaaS comercial.

Este documento evita metas numéricas arbitrárias antes de existir baseline confiável.

Quando houver diferença entre uma descrição resumida aqui e a fórmula detalhada do Metric Catalog, o **Metric Catalog prevalece**.

---

## 2. North Star conceitual

Não utilizar uma única métrica isolada.

O produto deve maximizar de forma equilibrada:

```text
Profitable Retained Customers
```

ou seja:

> Customers adquiridos, tecnicamente validados, satisfeitos, retidos e economicamente positivos.

Conversão sem margem, crescimento com churn ou automação com baixa qualidade não serão considerados sucesso.

---

# 3. Baseline obrigatório

Antes de automação ampla, registrar quando possível:

- Leads/mês;
- source mix;
- CPL/CAC atual;
- Lead → Trial;
- Trial technical pass;
- Trial → Paid;
- tempo de primeira resposta;
- tempo de resolução;
- horas humanas em atendimento/operação;
- renewal rate;
- churn;
- MRR/ARPU;
- gross/contribution margin;
- support volume;
- referral share;
- provider credit cost;
- cost per connection/add-on;
- payment fees;
- paid traffic spend.

Se uma métrica não possuir dado histórico confiável, o documento deve marcar `BASELINE_UNAVAILABLE`, em vez de inventar valor.

---

# 4. Acquisition Metrics

## ACQ-01 — Leads

Novas Persons qualificadas como Lead no período.

## ACQ-02 — Lead Source Mix

Distribuição por:

- paid;
- organic;
- referral;
- direct;
- unknown.

## ACQ-03 — CPL

Custo de mídia atribuído / Leads atribuíveis.

## ACQ-04 — CAC

Custo de aquisição relevante / novos Customers adquiridos.

Deve existir CAC por channel/source/campaign e CAC blended.

## ACQ-05 — Referral Share

Percentual de novos Customers cuja origem primária é Referral.

---

# 5. Trial Metrics

## TRIAL-01 — Trial Request Rate

Leads que solicitam/aceitam Trial.

## TRIAL-02 — Eligibility Approval Rate

Solicitações com resultado ALLOW/ALLOW_RETRIAL.

## TRIAL-03 — Trial Technical Pass Rate

Trials válidos que comprovam funcionamento técnico suficiente.

Trials invalidados por falha do provider devem ser segmentados separadamente.

## TRIAL-04 — Time to First Playback

Tempo entre criação do Trial e primeiro playback confirmado quando mensurável.

## TRIAL-05 — Trial → Paid Conversion

Conversão de Trials tecnicamente válidos em pagamento dentro da janela definida pelo Metric Catalog.

## TRIAL-06 — Retrial Rate

Percentual de Persons que receberam Retrial.

## TRIAL-07 — Legitimate Retrial → Paid

Conversão de Retrials legítimos.

## TRIAL-08 — Trial Abuse Rate

Solicitações/Persons classificadas como abuso confirmado dentro das regras definidas.

## TRIAL-09 — False Positive Review Rate

Casos inicialmente suspeitos que, após review, foram considerados legítimos.

Importante para evitar que Anti-Abuse destrua conversão legítima.

---

# 6. Sales Metrics

## SALES-01 — Lead → Paid

Conversão completa de Lead em Customer pagante.

## SALES-02 — Offer → Order

Taxa de aceitação de oferta.

## SALES-03 — Order → Settled

Taxa de Orders aceitas cuja obrigação econômica foi integralmente liquidada, por Payment externo e/ou créditos/rewards autorizados.

## SALES-04 — Sales Cycle Time

Tempo entre Lead e primeiro Payment confirmado.

## SALES-05 — Discount Dependency

Percentual de conversões que utilizaram Coupon/Promotion/Reward econômico.

A análise deve incluir margem/retention, não interpretar desconto apenas como positivo.

---

# 7. Billing & Fulfillment Metrics

## BILL-01 — Payment Confirmation Latency

Tempo entre confirmação externa e estado interno reconciliado.

## BILL-02 — Duplicate Event Safety

Quantidade de efeitos duplicados causados por eventos repetidos.

Target estrutural: zero efeitos financeiros duplicados.

## FUL-01 — Provider Operation Success Rate

Percentual de operações concluídas com postcondition válida.

## FUL-02 — Fulfillment Latency

Tempo entre entitlement ready e fulfillment verificado.

## FUL-03 — Fulfillment Drift Rate

Divergências detectadas entre estado interno esperado e provider.

## FUL-04 — Auto-Reconciliation Recovery

Percentual de drifts recuperados sem intervenção humana.

## FUL-05 — Browser Human-Required Rate

Operações de browser que exigiram intervenção humana.

---

# 8. Subscription & Retention Metrics

## RET-01 — Renewal Rate

Subscriptions elegíveis que renovaram na janela definida.

## RET-02 — Logo Churn

Customers perdidos / Customers elegíveis no período, conforme definição canônica futura.

## RET-03 — Revenue Churn

Receita recorrente perdida proporcional à base elegível.

## RET-04 — Cohort Retention

Retention 30d / 60d / 90d / 180d / 365d quando aplicável.

## RET-05 — Winback Rate

Customers churned reativados / elegíveis abordados.

## RET-06 — Trust Renewal Recovery

Percentual de Trust Renewal Grants elegíveis (+3 dias fixos) associados a renovação/continuidade bem-sucedida, sem tratá-los como reward genérico.

---

# 9. Add-on / Connection Metrics

## ADDON-01 — Additional Connection Attach Rate

Customers com conexão adicional ativa / base elegível.

## ADDON-02 — Recurring Connection Revenue

Receita recorrente atribuída a conexões adicionais.

## ADDON-03 — Recurring Connection COGS

Custo recorrente do provider atribuído às conexões adicionais por ciclo.

## ADDON-04 — Additional Connection Contribution Margin

Revenue do add-on menos COGS e custos diretamente atribuíveis.

## ADDON-05 — Rewarded Connection Cost

Custo real acumulado de conexões oferecidas como reward temporário ou permanente.

Essa métrica existe para impedir que um reward aparentemente “grátis” crie passivo recorrente invisível.

---

# 10. App License Metrics

## APP-01 — App Attach Rate

Customers que compraram/receberam licença premium.

## APP-02 — App Revenue

Receita de licenças.

## APP-03 — App Gross Margin

Revenue menos supplier license cost.

## APP-04 — App Reward Cost

Supplier cost de apps concedidos como Reward.

## APP-05 — Support Impact

Comparação de support rate/outcomes para Customers com determinados apps quando houver dados suficientes.

---

# 11. Referral Metrics

## REF-01 — Referral Ask Rate

Customers elegíveis que receberam pedido de indicação.

## REF-02 — Referral Invite Rate

Customers que efetivamente geraram convite/referral.

## REF-03 — Referral Trial Rate

Referral Leads que iniciaram Trial válido.

## REF-04 — Referral Conversion Rate

Referral Leads que viraram Customer confirmado.

## REF-05 — Referrals per Advocate

Média de referrals por Advocate.

## REF-06 — Referral CAC

Reward/incentive + custos atribuíveis / Customers adquiridos via referral.

## REF-07 — Referral LTV

LTV de Customers originados por referral.

## REF-08 — Referral Contribution Margin

Contribution profit gerado por coortes referral.

## REF-09 — Referral K-factor

Convites/conversões conforme definição futura do Metric Catalog.

## REF-10 — Referral-assisted Winback

Winbacks associados a campanha/referral incentive.

## REF-11 — Revenue / Contribution per Reward Cost

Quanto de receita e contribuição foram gerados por unidade monetária de Reward.

---

# 12. Support Metrics

## SUP-01 — First Response Time

Tempo para primeira resposta útil ao Customer.

## SUP-02 — Resolution Time

Tempo até resolução confirmada.

## SUP-03 — AI Resolution Rate

Casos resolvidos sem takeover/orientação humana relevante.

## SUP-04 — Human Escalation Rate

Casos que exigiram HITL.

## SUP-05 — First Contact Resolution

Problemas resolvidos sem reabertura/retorno relacionado dentro da janela definida.

## SUP-06 — Reopen Rate

Casos reabertos.

## SUP-07 — Customer Satisfaction

CSAT ou proxy explicitamente definido; nunca inferir satisfação apenas de ausência de reclamação.

---

# 13. Knowledge Metrics

## KNOW-01 — Solution Success Rate

Tentativas bem-sucedidas / tentativas qualificadas por Solution/context.

## KNOW-02 — Attempts Before Resolution

Número médio de tentativas antes da solução.

## KNOW-03 — Knowledge Reuse Rate

Casos resolvidos com conhecimento previamente validado.

## KNOW-04 — Human Guidance Reuse

Orientações humanas que posteriormente ajudaram a resolver outros casos.

## KNOW-05 — Stale Knowledge Rate

Itens degradados/deprecated devido a baixa freshness/evidência recente.

## KNOW-06 — Candidate → Verified Rate

Qualidade do pipeline de conhecimento.

---

# 14. Agent Metrics

## AI-01 — Agent Task Success

Outcome correto por categoria de tarefa.

## AI-02 — Tool Success Rate

Tool calls concluídas com postcondition esperada.

## AI-03 — Wrong Action Rate

Ações executadas que violaram outcome esperado sem serem bloqueadas antes.

Target qualitativo: extremamente baixo; classes críticas podem exigir zero tolerância observada antes de autonomia.

## AI-04 — Policy Blocks

Tentativas bloqueadas corretamente por policy/risk.

## AI-05 — Cost per Conversation / Task

Custo variável de IA por unidade operacional.

## AI-06 — Human Override Rate

Decisões/recomendações do Agent modificadas por humano.

## AI-07 — Shadow Agreement

Concordância entre decisão humana e decisão simulada do Agent, segmentada por action type.

---

# 15. Financial Metrics

## FIN-01 — MRR

Definição futura no Metric Catalog deve separar receita recorrente contratada de caixa recebido antecipadamente.

## FIN-02 — ARPU

Receita média por Customer segundo população/janela definidas.

## FIN-03 — Gross Profit / Margin

Revenue menos COGS diretamente associado.

## FIN-04 — Contribution Profit / Margin

Gross profit menos custos variáveis/incrementais definidos.

## FIN-05 — LTV

Lifetime value com definição explícita; não usar fórmulas diferentes em dashboards diferentes.

## FIN-06 — LTV:CAC

Comparação de valor e aquisição por source/cohort.

## FIN-07 — Payback Period

Tempo necessário para recuperar CAC e outros custos iniciais conforme definição oficial.

## FIN-08 — Profit per Customer

Lucro/contribuição por Customer.

## FIN-09 — Profit per Campaign

Contribution profit atribuível a campanha, quando attribution suportar.

---

# 16. Inventory / Procurement Metrics

## INV-01 — Credit Balance

Saldo econômico/operacional de provider credits.

## INV-02 — Weighted Unit Cost

Custo médio unitário do estoque segundo método definido.

## INV-03 — Burn Rate

Consumo de credits por período.

## INV-04 — Days of Inventory

Dias estimados até esgotamento.

## INV-05 — Stockout Events

Ocorrências em que estoque insuficiente impediu/demorou fulfillment.

Target estrutural: evitar completamente na operação planejada.

## INV-06 — Procurement Savings

Economia obtida por volume/contratos comparada a benchmark interno apropriado.

---

# 17. Reliability Metrics

## REL-01 — Workflow Failure Rate

Workflows que entram em failure state.

## REL-02 — Retry Recovery Rate

Falhas transitórias recuperadas automaticamente.

## REL-03 — Dead-letter Age

Tempo de itens aguardando intervenção.

## REL-04 — Reconciliation Drift Age

Tempo entre surgimento e correção de inconsistência.

## REL-05 — Critical Duplicate Effects

Renovação, reward, payment booking ou fulfillment duplicado.

Target estrutural: zero.

---

# 18. SaaS Metrics futuras

## SAAS-01 — Cost per Tenant

Custos variáveis atribuíveis por tenant.

## SAAS-02 — Usage per Tenant

LLM, messages, browser minutes, storage, transcriptions etc.

## SAAS-03 — Tenant Activation

Tenants que completam onboarding e chegam ao primeiro workflow real.

## SAAS-04 — Tenant Retention

Retenção do produto SaaS.

## SAAS-05 — Gross Margin do SaaS

Separado da margem da operação IPTV do tenant piloto.

---

# 19. Guardrail Metrics

Toda otimização relevante deve observar guardrails como:

- contribution margin;
- complaint/opt-out rate;
- support volume;
- fraud/abuse;
- provider failure;
- refund;
- churn;
- policy violation;
- human escalation;
- message delivery health.

Exemplo:

> Um novo reward aumenta Referral Conversion em 20%, mas reduz Contribution Margin de forma material.

Não deve ser promovido automaticamente apenas pela primeira métrica.

---

# 20. Gates de autonomia

Aumento de autonomia do Agent deve exigir evidência mínima por action class:

```text
Offline eval pass
+
Shadow performance
+
Low wrong-action rate
+
Stable tool success
+
Policy compliance
+
Rollback/kill switch ready
```

Ações financeiras/destrutivas exigem padrão mais alto que FAQ ou Trial creation elegível.

---

# 21. Case Study Metrics

Para marketing futuro do SaaS, preservar comparabilidade de before/after:

- response time;
- conversion;
- Trial pass;
- renewal;
- churn;
- referral share;
- support automation;
- human hours;
- CAC;
- LTV;
- contribution margin;
- provider failure handling;
- revenue/profit growth.

Toda claim futura deve ser derivável de dados documentados e período/população explícitos.

---

# 22. Auto-revisão aplicada

Revisado para:

- não inventar metas numéricas antes do baseline;
- separar MRR de cash received;
- incluir recurring COGS da tela adicional;
- medir impacto econômico de rewards/referrals;
- equilibrar AI automation com quality/override metrics;
- incluir anti-abuse false positives;
- incluir reliability/reconciliation como sucesso de produto;
- impedir otimização por vanity metric isolada.

