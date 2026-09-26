# Product Journeys

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Autoridade: jornadas e outcomes desejados. State machines detalhadas serão documentadas posteriormente nos domínios.

## 1. Objetivo

Documentar as principais jornadas ponta a ponta antes das state machines e SPECs. Uma journey mostra intenção e interação entre domínios; não substitui regras canônicas dos domínios.

---

## J01 — Lead → Trial → Customer

### Objetivo

Converter um Lead em Customer somente depois de validar que o serviço funciona em seu contexto técnico.

### Fluxo principal

```text
Lead inbound
↓
Identity Resolution
↓
Lead created/updated
↓
Agent understands need/device
↓
Trial Eligibility
↓
ALLOW
↓
Trial created
↓
Installation assistance
↓
Technical Validation
↓
Trial technical outcome = PASSED
↓
Offer resolution
↓
Order
↓
Settlement (Payment e/ou créditos/rewards autorizados)
↓
Entitlements activated
↓
Provider Fulfillment
↓
Fulfillment verified
↓
Customer ACTIVE
↓
Post-activation satisfaction check
```

### Regras críticas

- um Trial válido por Person por padrão;
- sale flow pausa se a falha técnica relevante não estiver resolvida;
- Agent não cria preço/benefício arbitrário;
- Payment e Fulfillment são estados distintos;
- failure após Payment gera fulfillment pendente, não perda do Order.

### Outcome de sucesso

- Customer pagou;
- entitlement correto está ativo;
- fulfillment verificado;
- Customer consegue utilizar o serviço;
- acquisition/trial/payment economics estão atribuíveis.

---

## J02 — Trial falhou → Retrial legítimo

### Objetivo

Dar nova oportunidade quando o Trial original foi tecnicamente inválido, sem transformar Trial em acesso gratuito recorrente.

### Fluxo

```text
Trial technical outcome = FAILED ou Trial INVALIDATED
↓
Support diagnosis
↓
Reason classified
↓
Evidence exists?
↓
Eligibility
├─ ALLOW_RETRIAL
├─ REVIEW
└─ DENY
```

Se aprovado:

```text
Retrial created
↓
original_trial_id linked
↓
new technical context if needed
↓
validation
```

### Exemplos legítimos

- provider incident;
- credentials/provisioning failure;
- instalação não concluída por incompatibilidade resolvível;
- teste ficou inutilizável durante a maior parte da janela;
- admin exception justificada.

### Exemplo não legítimo

“Quero outro porque acabou e ainda quero assistir.”

### Outcome de sucesso

A política protege margem sem penalizar Lead legítimo prejudicado por falha real.

---

## J03 — Customer Support resolvido pela IA

### Objetivo

Resolver problema usando contexto, troubleshooting estruturado e conhecimento validado.

### Fluxo

```text
Customer message
↓
Identity + Customer Context
↓
Incident check
↓
Known incident?
├─ yes → contextual communication
└─ no
    ↓
Problem classification
    ↓
Knowledge retrieval
    ↓
Ranked solution
    ↓
Guided troubleshooting
    ↓
Outcome collected
```

Se funcionou:

```text
Ticket resolved
↓
Solution evidence updated
↓
Knowledge ranking updated
```

### Outcome de sucesso

- problema resolvido;
- tentativas registradas;
- conhecimento melhora;
- Customer não precisou repetir contexto.

---

## J04 — Support → HITL → Learning

### Objetivo

Resolver situações fora da capacidade/autonomia do Agent e converter intervenção humana em aprendizado.

### Fluxo

```text
Agent cannot safely resolve
↓
NEEDS_HUMAN_GUIDANCE
↓
Customer moved to appropriate standby
↓
Escalation packet generated
↓
HITL Operator reviews
↓
Human guidance OR takeover
↓
Resolution attempted
↓
Outcome
↓
Candidate Knowledge
```

### Escalation packet mínimo

- Customer/Subscription state;
- problema;
- contexto técnico;
- o que já foi tentado;
- evidências;
- hipóteses;
- decisão/orientação solicitada.

### Outcome de sucesso

Próximo caso semelhante possui maior chance de resolução sem intervenção humana.

---

## J05 — Payment → Renewal → Provider Fulfillment

### Objetivo

Renovar assinatura com consistência financeira e operacional.

### Fluxo principal

```text
Renewal due
↓
Communication / charge
↓
Payment confirmed
↓
Order/renewal state updated idempotently
↓
Entitlements extended
↓
Provider Operation created
↓
Provider renewal
↓
Postcondition validation
↓
Subscription ACTIVE
↓
Customer confirmation
```

### Falha do provider

```text
Payment confirmed
↓
Provider unavailable
↓
Subscription commercial state preserved
↓
Fulfillment PENDING
↓
Retry / Reconciliation / HITL
```

### Requisito econômico

Recurring add-ons, incluindo conexão/tela adicional, devem gerar COGS novamente em cada ciclo renovado.

---

## J06 — Renovação em Confiança / Trust Renewal

### Objetivo

Utilizar capability temporária do provider como ferramenta de continuidade/retenção, respeitando eligibility/cooldown.

### Possíveis gatilhos

- cliente fiel com pagamento atrasado;
- problema no gateway;
- retention action autorizada;
- reward;
- winback autorizado.

### Fluxo

```text
Need identified
↓
Benefit eligibility
↓
Provider capability availability
↓
Policy check
↓
Grant fixed Trust Renewal provider operation
↓
Fulfillment
↓
Track cooldown
↓
Continue payment/retention flow
```

### Outcome de sucesso

Continuidade temporária de +3 dias somente quando a conta está ACTIVE e <=3 dias do vencimento, sem ocultar inadimplência real.

---

## J07 — Subscription com conexão adicional recorrente

### Objetivo

Adicionar/remover conexão extra preservando billing, entitlement, fulfillment e recurring COGS.

### Adição

```text
Customer requests extra connection
↓
Eligible offer resolved
↓
Order / recurring add-on accepted
↓
Payment if required
↓
Subscription Add-on ACTIVE
↓
Entitlement CONNECTIONS +1
↓
Provider Fulfillment
↓
Recurring cost scheduled per cycle
```

### Renovação de ciclo

```text
Subscription renewal
+
Add-on remains active
↓
Customer charged according to contracted price
↓
Provider recurring connection cost booked again
↓
Entitlement continues
```

### Remoção

```text
Add-on cancellation request
↓
Policy/effective date
↓
Entitlement adjusted
↓
Provider connection count adjusted
↓
Future recurring charge/cost stopped
```

### Outcome de sucesso

Nunca tratar a tela extra como compra única.

---

## J08 — Purchase/Renewal → Referral Opportunity

### Objetivo

Solicitar indicação em momentos de alta satisfação/confiança.

### Gatilhos possíveis

- activation success;
- purchase success + product functioning;
- renewal confirmation;
- positive support resolution;
- loyalty milestone;
- explicit positive feedback.

### Fluxo

```text
Positive signal
↓
Referral propensity / policy
↓
Communication frequency check
↓
Referral offer
↓
Invite/link/code
↓
Referral Lead created
```

### Outcome de sucesso

Referral se torna canal rastreável com CAC e LTV próprios.

---

## J09 — Referral → Reward → Free Renewal

### Objetivo

Transformar referrals válidos em benefícios economicamente controlados.

### Fluxo

```text
Referral Lead
↓
Trial
↓
Paid conversion
↓
Qualification/fraud checks
↓
Referral CONFIRMED
↓
Reward Ledger entry
↓
Progress toward reward
```

Exemplo:

```text
Referral credits accumulated
↓
Next renewal partially/fully covered
↓
Order applies internal credit
↓
Ledger redeems amount
```

### Regra

“Renovação grátis” é um reward econômico contabilizado; não é uma renovação sem custo para a operação.

---

## J10 — Winback com Referral Campaign

### Objetivo

Recuperar ex-Customer e simultaneamente criar novo canal de aquisição.

### Fluxo possível

```text
Customer CHURNED
↓
Winback eligibility
↓
Offer authorized
↓
Referral challenge / benefit
↓
Customer reactivates or engages
↓
New referrals convert
↓
Reward unlocked
```

### Métricas

- winback conversion;
- referred Customers generated;
- reward cost;
- contribution profit;
- retention pós-winback.

---

## J11 — App premium como upsell

### Objetivo

Vender app premium quando houver valor real para Customer.

### Fluxo

```text
Customer context
↓
App compatibility / need
↓
Eligible app offer
↓
Order
↓
Payment
↓
APP_LICENSE entitlement
↓
Supplier/provider activation
↓
Margin recorded
```

### Princípio

Upsell deve ser baseado em adequação/benefício e não em pressão comercial indiscriminada.

---

## J12 — App premium como Reward

### Objetivo

Utilizar app premium como benefício de alto valor percebido e custo conhecido.

```text
Reward unlocked
↓
APP_LICENSE entitlement
↓
Supplier cost booked
↓
Activation
↓
Reward Ledger updated
```

O sistema deve comparar custo do reward com resultado incremental de retention/referral.

---

## J13 — Provider Incident → Customer Communication

### Objetivo

Evitar troubleshooting local inútil quando existe problema coletivo conhecido.

```text
Signal from provider/group/support/data
↓
Incident candidate
↓
validation
↓
Incident OPEN
↓
Affected context identified
↓
Agent checks incident before local troubleshooting
↓
Customer receives contextual status
```

Após recuperação:

```text
Incident RESOLVED
↓
Customers/workflows updated
↓
post-incident knowledge/problem analysis
```

---

## J14 — Knowledge from external source

### Objetivo

Ingerir conteúdo útil sem permitir que fonte externa controle o Agent.

```text
YouTube/Web/Group/Document
↓
UNTRUSTED source
↓
Extraction
↓
Classification
↓
Candidate Knowledge
↓
Validation/evidence
↓
Canonical Knowledge
```

Para vídeo:

```text
URL
↓
yt-dlp
↓
metadata/captions/audio as applicable
↓
segments + timestamps
↓
retrieval
```

---

## J15 — Learning → Experiment → Policy Improvement

### Objetivo

Melhorar operação sem confundir correlação com causalidade.

```text
Metrics / outcomes
↓
Insight
↓
Hypothesis
↓
Experiment or review
↓
Evidence
↓
Decision
↓
Policy/config change
```

Mudanças críticas de pricing, reward, eligibility e ad budget não devem ser aplicadas somente porque o sistema detectou correlação.

---

## J16 — Agent release lifecycle

```text
Prompt/model/tool/knowledge change
↓
Offline evals
↓
Shadow Mode
↓
Limited rollout
↓
Production
↓
Online monitoring
↓
Failure → regression case
```

Outcome: evolução de IA mensurável e reversível.

---

## J17 — Provider drift / Browser recovery

```text
Provider operation starts
↓
Expected interface mismatch
↓
DRIFT_DETECTED
↓
operation stops safely
↓
trace/screenshot captured
↓
Adapter DEGRADED
↓
validation/recovery
↓
new adapter revision
```

Nenhum repair inseguro deve ser testado diretamente em ação destrutiva de Customer real.

---

## J18 — Tenant onboarding futuro

### Objetivo

Preparar o produto para repetição comercial.

```text
Tenant created
↓
Users/RBAC
↓
Brand/products/pricing
↓
Billing provider
↓
Messaging provider
↓
Fulfillment provider
↓
Agent policies/autonomy
↓
Knowledge bootstrap
↓
Trial/Referral rules
↓
Health checks
↓
Go-live
```

Essa jornada não precisa estar completa no tenant piloto, mas o domínio não deve impedir sua implementação posterior.

---


## J19 — Payment overdue → Recovery

### Objetivo

Recuperar pagamento/renovação sem confundir inadimplência com falha técnica ou de gateway.

```text
Renewal due
↓
Charge / reminder
↓
Payment not confirmed
↓
OVERDUE
↓
Recovery policy
├─ reminder
├─ authorized offer
├─ Trust Renewal +3d if provider-eligible
└─ HITL when necessary
↓
Payment confirmed OR recovery exhausted
```

### Regras

- communication policy controla frequência;
- Trust Renewal não marca Payment como pago;
- descontos/rewards somente por Offer/Policy autorizada;
- provider state não substitui Billing state.

---

## J20 — Cancellation / Churn → Winback

### Objetivo

Registrar perda de Customer corretamente e manter possibilidade de recuperação mensurável.

```text
Cancellation request / non-renewal
↓
Reason capture
↓
Entitlement end policy
↓
Provider fulfillment adjusted
↓
Subscription CANCELED / CHURNED
↓
Winback eligibility
↓
Future campaign / referral-assisted offer
```

### Outcome

- churn reason estruturado;
- revenue impact registrado;
- benefits/add-ons recorrentes interrompidos conforme regra;
- winback attribution preservada.

---

## J21 — Credit Inventory → Procurement

### Objetivo

Evitar perda de venda/renovação por falta de estoque e reduzir custo unitário conforme escala.

```text
Credit consumption events
↓
Inventory balance / burn rate
↓
Forecast renewals + sales
↓
Reorder threshold
↓
Purchase recommendation
↓
Human approval / authorized purchase
↓
Credit batch received
↓
Provider Credit Ledger updated
```

### Outcome

- nenhum stockout evitável;
- unit cost rastreável;
- negociação de supplier plan baseada em consumo real.

---

## 22. Jornadas que devem originar State Machines primeiro

Prioridade 1:

1. Lead/Customer lifecycle;
2. Trial/Retrial;
3. Order/Payment;
4. Subscription;
5. Entitlement;
6. Provider Operation;
7. Support Ticket;
8. HITL Escalation;
9. Referral/Reward;
10. Knowledge lifecycle.

---

## 23. Auto-revisão aplicada

Revisão verificou:

- conexão adicional tratada somente como recorrente;
- Trial e Retrial separados;
- Customer commercial state separado de Provider Fulfillment;
- referral após compra/renovação incluído;
- free renewal contabilizada como reward com custo;
- incident check antes de troubleshooting individual;
- external knowledge quarantined;
- failure paths incluídos nas jornadas críticas;
- HITL como workflow formal;
- journeys não antecipam implementação específica de queue/workflow engine.

## Jxx — Refinamentos de jornada v0.14

### Renovação confirmada pelo agente

O Agent apresenta a configuração atual e confirma se ainda é desejada: plano/período, quantidade de conexões e eventual app perto do vencimento. Não replica cegamente o ciclo anterior. Conexão adicionada no meio do ciclo recebe aviso explícito de que expira junto com a assinatura atual.

### Renovação em Confiança

Somente conta ainda ativa e com <=3 dias para vencer pode receber +3 dias fixos. A operação não existe para conta vencida e não aceita N dias arbitrários. O fato financeiro permanece pendente.

### App pago

Recomendar app conforme Device/compatibilidade/evidência → configurar teste gratuito → confirmar experiência → criar Order → receber pagamento → reservar saldo MK → comprar/ativar licença → verificar postcondition. Opção gratuita/parceira continua disponível quando adequada.

### Reembolso

Pedido de reembolso → Ticket/Review → IA reúne Trial, pagamento, uso, problemas, attempts, custos e eventual residual access → humano decide. Recuperação/revenda de capacidade residual é workflow econômico separado e nunca condiciona a decisão ao cliente.

### Importação de tenant existente

Conectar provider → descobrir base → normalizar → preview/conflitos → importar idempotentemente → completar identities faltantes → iniciar sync/reconciliation → operar inicialmente em modo Observação.

### Suporte orientado por sinais

Confirmar contexto volátil conhecido → consultar Incidents/Operational Signals/tickets semelhantes → troubleshooting local apenas quando apropriado → web/community/YouTube research quando necessário → registrar attempts/outcomes → candidate/global knowledge conforme sanitização e evidência.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — renewal/app/refund/import/support journeys checked.

