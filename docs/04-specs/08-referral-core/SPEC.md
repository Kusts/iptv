# SPEC — Referral Core & Rewards Baseline

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Versão: 1.0  
> Slice: MVP-08  
> Dependências: Identity/CRM, Trial, Commerce/Billing, Subscription, Risk/Anti-Abuse, Communications, Ledger

## 1. Objetivo

Implementar Referral como canal de aquisição mensurável desde o tenant piloto, com atribuição, qualificação após conversão válida, antiabuso, rewards simples e economia auditável — sem depender de gamificação avançada.

## 2. Escopo MVP

Inclui:

- Referral Program ativo/versionado;
- código/link de indicação;
- advocate Customer;
- referred Person resolution;
- lifecycle de Referral;
- qualificação após conversão válida;
- anti-self-referral/duplicate baseline;
- rewards predefinidos;
- referral/reward ledger;
- ask-referral trigger em momentos positivos;
- reward aplicado a Order/Entitlement quando permitido;
- métricas de referral.

Fica para NEXT:

- níveis/achievements sofisticados;
- marketplace de rewards;
- reward personalization por ML;
- K-factor optimization autônoma;
- campanhas virais complexas.

## 3. Princípios

1. Referral não confirma por clique, cadastro ou Trial isolado.
2. `CONFIRMED` exige policy de qualificação + antiabuso.
3. Advocate precisa ser Customer válido conforme programa.
4. Reward não é saldo mutável; efeitos econômicos usam ledger.
5. Renovação grátis não cria Payment fictício.
6. Benefício recorrente considera custo recorrente esperado.
7. A origem de aquisição original não é sobrescrita por referral tardio; attribution model preserva touchpoints e referral assist quando aplicável.
8. Reward reversal preserva histórico e gera lançamento compensatório quando houver efeito econômico.

## 4. Gatilhos para pedir indicação

MVP pode solicitar indicação após:

```text
purchase/order completed successfully
subscription renewed
support resolved + positive signal
high customer health / satisfaction signal
reactivation/winback completed
```

Preconditions via `ask_for_referral`:

- customer eligible;
- nenhuma issue severa ativa;
- communication policy permite;
- frequency cap respeitado;
- programa/campanha ativo;
- não pedir repetidamente sem novo momento positivo.

## 5. Fluxo de referral

```text
advocate shares code/link
↓
referral.created.v1
↓
referred identity resolved
↓
ATTRIBUTED
↓
lead/trial journey
↓
ENGAGED
↓
valid economic conversion candidate
↓
QUALIFYING
↓
risk + program policy
├─ valid → CONFIRMED
└─ invalid → REJECTED
```

## 6. Qualificação

A policy versionada pode exigir, por exemplo:

- Order SETTLED;
- pagamento confirmado quando amount due > 0;
- Trial/technical journey válida quando aplicável;
- referred Person distinta do advocate;
- ausência de duplicate/self-referral signals;
- janela de qualificação cumprida;
- Order não totalmente revertida/refund/chargeback durante janela definida.

A regra exata pertence a `ReferralPolicy`, não ao prompt do Agent.

## 7. Anti-abuse baseline

Sinais determinísticos iniciais:

```text
same normalized identity
same person/customer
same payment instrument fingerprint when lawfully available
same device/account signals where appropriate
circular referral graph
repeated trial abuse
repeated gift self-redemption
high-frequency referral creation
```

Resultado do Risk Engine:

```text
ALLOW
REVIEW
DENY
```

Ambiguidade legítima deve preferir `REVIEW` a bloqueio irreversível.

## 8. Reward baseline

MVP suporta Reward Definitions predefinidas, por exemplo:

- referral credit;
- discount/order credit;
- renewal discount/credit;
- Gift Pass simples;
- app/add-on entitlement quando explicitamente configurado.

Não permitir reward arbitrário digitado pelo LLM.


## 8.1 Benefício bilateral

Referral Program may define **two independent benefit legs**:

```text
referred person benefit
+
advocate/referrer benefit
```

The referred benefit may be available at acquisition/qualified purchase according to policy; the advocate benefit is normally released only after valid economic conversion + anti-abuse. Each leg has its own Reward Definition, budget, reversal rules and ledger entries.

Examples: referred coupon/discount/app benefit; advocate referral credit/renewal discount/app/Gift Pass. Trust Renewal is not a generic referral reward for the initial provider.

## 9. Reward economics

Antes de `APPROVED`, calcular quando aplicável:

```text
nominal/perceived value
immediate cost
expected recurring cost
customer contribution margin
program budget/cap
reward ROI history
```

Conexão/tela adicional exige modelagem recorrente:

```text
+1 connection for N cycles
→ recurring entitlement/add-on effect
→ provider COGS em cada ciclo ativo
```

Um reward “permanente” só pode ser aprovado por policy que aceite custo futuro aberto/estimado.

## 10. Renovação grátis

Fluxo correto:

```text
Renewal Order subtotal = R$ X
↓
Referral Reward Credit = -R$ X
↓
net_total = 0
↓
Order SETTLED
↓
NO external Payment created
↓
Subscription renewal/fulfillment continua normalmente
```

Ledger registra reward cost/contra-partida e preserva unit economics.

## 11. Winback + Referral

Campanha pode usar referral como condição de benefício, por exemplo:

```text
reactivated customer
+ qualifying referrals
→ reward for next renewal
```

A campanha deve registrar:

- eligibility;
- target count;
- qualification window;
- reward definition;
- economic cap;
- whether benefit is immediate or future.

## 12. Gift Pass MVP

Gift Pass deve registrar:

```text
issued_to_customer_id
code
benefit_json
expires_at
redeemed_by_person_id
redemption_at
conversion attribution
status
```

Gift Pass não é automaticamente uma assinatura paga; redemption pode iniciar Trial/Offer/Entitlement conforme policy.

## 13. Eventos usados

Referral:

```text
referral.created.v1
referral.attributed.v1
referral.engaged.v1
referral.qualification_started.v1
referral.confirmed.v1
referral.rejected.v1
referral.expired.v1
referral.reversed.v1
```

Reward:

```text
reward.pending_created.v1
reward.approved.v1
reward.issued.v1
reward.available.v1
reward.redeemed.v1
reward.expired.v1
reward.revoked.v1
reward.fulfillment_failed.v1
```

Cross-domain relevantes:

```text
order.settled.v1
payment.paid.v1
payment.refunded.v1
payment.chargeback.v1
subscription.renewed.v1
support.resolved.v1
customer.reactivated.v1
```

## 14. APIs / Commands

Baseline contratual existente:

```text
POST /v1/customers/{customerId}/referrals
```

Extensões planejadas:

```text
GET  /v1/customers/{customerId}/referrals
GET  /v1/referrals/{referralId}
POST /v1/referrals/{referralId}/qualify
GET  /v1/customers/{customerId}/rewards
POST /v1/rewards/{rewardId}/redeem
POST /v1/gift-passes/{code}/redeem
```

Até entrarem no OpenAPI, são propostas de SPEC.

## 15. Persistência

```text
referral_programs
referrals
referral_qualifications
reward_definitions
rewards
reward_ledger_entries
gift_passes
```

Integra com:

```text
persons
customers
orders
payments
subscriptions
entitlements
financial ledger
risk assessments
attribution/touchpoints
```

## 16. Idempotência

Obrigatória para:

- create referral;
- qualification result;
- reward issue;
- reward redeem;
- gift pass redeem;
- reversal.

Replay de `referral.confirmed.v1` não pode emitir reward duas vezes.

## 17. Observabilidade

Mínimo:

- referral invite/create rate;
- attributed/engaged/confirmed rate;
- referral → Trial;
- referral → paid/settled conversion;
- qualification rejection reasons;
- reward issued/redeemed/expired;
- reward cost;
- Referral CAC;
- Referral LTV;
- contribution margin;
- referral-assisted winback;
- `% new customers from referrals`;
- suspected abuse/review rate.

## 18. Critérios de aceitação

- CA-01: Referral não confirma apenas por convite/Trial.
- CA-02: self-referral evidente é rejeitado ou enviado a review conforme policy.
- CA-03: replay não duplica Reward.
- CA-04: Order zero por Reward chega a SETTLED sem Payment fictício.
- CA-05: reward de conexão/tela adicional calcula COGS recorrente pelo período concedido.
- CA-06: reward reversal não apaga histórico.
- CA-07: referral tardio não sobrescreve arbitrariamente first-touch acquisition.
- CA-08: ask-referral respeita issue ativa/frequency cap/communication policy.
- CA-09: Referral e Reward nunca cruzam tenant.
- CA-10: cada reward econômico é reconciliável com ledger.

## 19. Testes mínimos

- referral happy path até CONFIRMED;
- self-referral;
- duplicate referred identity;
- chargeback durante qualification window;
- replay de confirmation x10;
- zero-value renewal order via referral reward;
- connection reward por 2 ciclos com COGS em ambos;
- reward expired before redemption;
- reward reversal;
- Gift Pass self-redemption risk review;
- cross-tenant code lookup denied;
- support severe open → ask_referral denied;
- referral after renewal allowed once per configured cadence.

## 20. Auto-revisão do arquivo

Revisado contra Referral/Reward state machines, Commerce/Billing, Subscription/Entitlements, Attribution e Agent Tool Contracts. Ajustes feitos:

- Referral Core foi mantido no MVP, mas gamificação avançada ficou NEXT;
- `CONFIRMED` depende de conversão econômica/policy, não de clique;
- renovação grátis usa Order `SETTLED` e não Payment fake;
- conexão adicional foi tratada explicitamente como reward de custo recorrente;
- referral assist foi separado de atribuição de origem para não corromper analytics.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — bilateral referral benefit and provider-compatible rewards checked.
