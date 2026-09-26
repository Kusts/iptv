# MVP Specifications — Index

> Status: Draft auto-revisado  
> Versão: 0.7  
> Autoridade: especificações implementáveis do MVP.  
> Regra: PRD define **o quê**; Domain define **regras e estados**; Architecture define **estrutura**; SPEC define **como um slice deve se comportar** sem substituir essas fontes.

## 1. Objetivo

Transformar os requisitos já consolidados em unidades implementáveis, testáveis e revisáveis por humanos e agentes.

Cada SPEC deve conter:

- contexto e objetivo;
- escopo e não-escopo;
- regras de domínio referenciadas, sem duplicá-las silenciosamente;
- fluxo principal;
- pré-condições e pós-condições;
- APIs, eventos e persistência envolvidos;
- falhas e compensações;
- segurança, auditoria e observabilidade;
- critérios de aceitação;
- testes mínimos.

## 2. Vertical slices do MVP

1. [Identity & CRM](01-identity-crm/SPEC.md)
2. [Trial & Retrial](02-trial/SPEC.md)
3. [Commerce & Billing](03-commerce-billing/SPEC.md)
4. [Subscription & Entitlements](04-subscription-entitlements/SPEC.md)
5. [Provider Fulfillment](05-provider-fulfillment/SPEC.md)
6. [Reconciliation & Reliability](06-reconciliation-reliability/SPEC.md)
7. [Support, HITL & Knowledge](07-support-hitl-knowledge/SPEC.md)
8. [Referral Core & Rewards](08-referral-core/SPEC.md)

## 3. Regra de implementação

Um slice só pode ser considerado concluído quando:

```text
Domain invariant preserved
+
API/command validated
+
state persisted atomically
+
event persisted/published reliably
+
auditability present
+
observability present
+
negative paths tested
+
tenant isolation tested
```

## 4. Dependências

```text
Identity/CRM
   ↓
Trial
   ↓
Commerce/Billing
   ↓
Subscription/Entitlements
   ↓
Provider Fulfillment
   ↓
Reconciliation
   ↓
Support/HITL/Knowledge
   ↓
Referral Core
```

Essa ordem representa dependência de implementação, não acoplamento de domínio.

## 5. Regras transversais

Todas as SPECs obedecem a:

- `tenant_id` derivado de contexto autenticado, nunca confiado do body;
- idempotência em commands com efeitos relevantes;
- eventos de domínio versionados;
- Transactional Outbox para fatos que precisam sair do processo;
- PII minimizada em eventos e logs;
- operações financeiras e rewards em ledger append-only;
- ações de provider verificadas por pós-condição;
- retry não pode duplicar efeito;
- agent não pode ignorar Policy/Risk Engines;
- integração externa nunca vira fonte da verdade por conveniência.

## 6. Auto-revisão desta camada

Ao revisar uma SPEC, conferir:

1. estados usados existem nas state machines;
2. eventos usados existem no Event Model;
3. endpoint citado existe no OpenAPI ou está marcado como extensão planejada;
4. entidade citada existe no Logical Data Model ou está marcada como nova proposta;
5. nenhuma regra contradiz Principles/PRD;
6. telas adicionais continuam recorrentes em receita e COGS;
7. `Order SETTLED` não é confundida com `Payment PAID`;
8. `Trial PASSED` continua sendo assessment técnico, não lifecycle do acesso.
