# Ensaio sintético do piloto — 2026-11-15

Ensaio autenticado em staging, sem cobrança, webhook, ativação externa ou acesso ao banco. Nenhum registro existente foi alterado. Base `https://staging-api.synkroo.com.br`.

## Registro

| Passo | Chamada | Status | Estado / ID |
|---|---|---|---|
| Catálogo | leitura do plano | — | `cc271d74-16b5-47c9-bcf4-619456e74efb`, monthly, BRL 3000 minor, mensal |
| Cliente | `POST /v1/crm/persons` | criado | `01a1e053-ff7e-758e-9217-04e6281f76f3`, marcador `PILOT-REHEARSAL-2026-11-15` |
| 1. Cotar pedido | `POST /v1/orders/quote` | 201 | `DRAFT` |
| 2. Submeter pedido | `POST /v1/orders/{id}/submit` | 201 | `AWAITING_PAYMENT`; pedido `01a1e054-bff5-776a-a9c3-fa0971aaf55f`; readback confirma `subscriptions` vazio |
| Ticket | `POST /v1/tickets` | 201 | `NEW`, ticket `01a1e054-00ad-73df-8bd7-d9b99115b783` |
| Ticket | transições `TRIAGING` → `IN_PROGRESS` | concluído | ticket em andamento |
| Ticket | `POST /v1/tickets/{id}/resolve` antes de tentativa | 409 | resolução recusada conforme regra |
| Ticket | `POST /v1/tickets/{id}/attempts` (tentativa `SUCCEEDED`), depois `resolve` | 201 | `RESOLVED`, confirmado por readback |

## O que falta para o ensaio completo

| Passo da missão | Estado | Dependência / evidência |
|---|---|---|
| 1. Quote do pedido | CONCLUÍDO | `DRAFT` confirmado |
| 2. Submit do pedido | CONCLUÍDO | `AWAITING_PAYMENT`, sem assinatura |
| 3. Criar cobrança | BLOQUEADO para este ensaio/tenant (pré-requisito) | autorização de cobrança Sandbox neste tenant |
| 4. Efetuar pagamento | BLOQUEADO para este ensaio/tenant (pré-requisito) | pagamento no painel Asaas ou replay autorizado de webhook com segredo do canal neste tenant |
| 5. Confirmar pagamento | BLOQUEADO para este ensaio/tenant (pré-requisito) | evento autorizado e readback de pagamento neste tenant |
| 6. Confirmar ledger | BLOQUEADO para este ensaio/tenant (pré-requisito) | pagamento Sandbox confirmado neste tenant |
| 7. Criar assinatura | BLOQUEADO para este ensaio/tenant (pré-requisito) | pedido `SETTLED` neste tenant |
| 8. Ativação supervisionada | BLOQUEADO para este ensaio/tenant (pré-requisito) | pedido pago neste tenant e operador CINEVISION autorizado |
| 9. Registrar externalRef | BLOQUEADO para este ensaio/tenant (pré-requisito) | ativação externa autorizada neste tenant e referência verificada |
| 10. Confirmar serviço ativo | BLOQUEADO para este ensaio/tenant (pré-requisito) | readback no painel CINEVISION após ativação autorizada deste tenant |
| 11. Renovação e nova expiração | BLOQUEADO para este ensaio/tenant (pré-requisito) | pagamento Sandbox autorizado neste tenant e assinatura/renovação liquidada |
| 12. Registrar tentativa de solução e resolver ticket | CONCLUÍDO | tentativa `SUCCEEDED`, resolve 201 e readback `RESOLVED` |

A jornada completa com evento Sandbox simulado em tenant sintético distinto já está registrada em [STREAMMAX-MVP-STATUS-2026-11-15.md](STREAMMAX-MVP-STATUS-2026-11-15.md) (§Jornada comercial sintética), incluindo cobrança, liquidação, ativação manual com `externalRef=214790811` e renovação. Não é pagamento real e não se aplica a este tenant.

## Checklist executável restante

Com operador autorizado, sessão autenticada e dados de ensaio aprovados, seguir endpoints já documentados em [runbook de primeira venda](../10-operations/runbooks/pilot-first-sale.md): provisionar cliente do provedor (`POST /v1/billing-customers/provision`), criar cobrança (`POST /v1/charges`), simular pagamento pelo painel Asaas, conferir `GET /v1/charges`, `GET /v1/payments` e `GET /v1/orders/{orderId}` (`SETTLED`); tratar exceções em `GET /v1/billing-exceptions` e reconciliar somente conforme runbook. Com pedido liquidado, `POST /v1/subscriptions/from-order`; seguir fulfillment supervisionado no painel autorizado e resolver via `POST /v1/provider/operations/{operationId}/resolve`, registrando referência verificada. Não execute sem autorização específica.

Para renovação, `POST /v1/renewals/quote` cria/retorna o pedido de renovação em `AWAITING_PAYMENT`. Após liquidar pelo fluxo autorizado, efetive somente quando o pedido `orderType=RENEWAL` estiver `SETTLED`: `POST /v1/renewals/renew` com body `{ "orderId": "<uuid>" }`. `orderType` é propriedade do pedido, não campo do body de renew. Confira readbacks da assinatura/expiração conforme UI/API existente; não contorne a liquidação.

## Preparação do piloto real

- [ ] Um único cliente autorizado e consentimento/escopo documentados.
- [ ] Autorização explícita para cobrança e ação externa, no ambiente/recurso exatos.
- [ ] Canal Asaas ativo do tenant, credencial e webhook autorizados; confirmação no Sandbox antes do piloto real.
- [ ] Operador CINEVISION autorizado disponível para ativação e readback.
- [ ] Plano de rollback e responsáveis confirmados antes de iniciar.
- [ ] Registrar IDs, estados e evidências sem expor segredos.

**Nenhum pagamento ou ativação real foi feito nesta sessão.** Passos bloqueados permanecem bloqueados até os pré-requisitos e autorizações acima.
