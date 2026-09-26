# Support — Support Ticket State Machine

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Domínios: D14 — Support; D15 — Incident & Problem Management

## 1. Responsabilidade

Support Ticket representa um caso individual de suporte.

Incident e Problem são entidades próprias:

- Ticket: caso de uma Person/Customer;
- Incident: condição coletiva atual;
- Problem: causa recorrente/estrutural.

## 2. Estados do Ticket

```text
NEW
TRIAGING
IN_PROGRESS
WAITING_CUSTOMER
WAITING_INTERNAL
WAITING_PROVIDER
RESOLVED
CLOSED
CANCELLED
```

## 3. Transições

| De | Evento | Para | Regra |
|---|---|---|---|
| — | `support.ticket_created.v1` | NEW | caso registrado |
| NEW | `support.triage_started.v1` | TRIAGING | classificação iniciada |
| TRIAGING | `support.work_started.v1` | IN_PROGRESS | execução de troubleshooting |
| IN_PROGRESS | `support.waiting_customer.v1` | WAITING_CUSTOMER | precisa de resposta/ação do cliente |
| IN_PROGRESS | `support.waiting_internal.v1` | WAITING_INTERNAL | HITL/conhecimento/review interno |
| IN_PROGRESS | `support.waiting_provider.v1` | WAITING_PROVIDER | depende de provider/incidente externo |
| WAITING_CUSTOMER/WAITING_INTERNAL/WAITING_PROVIDER | `support.work_resumed.v1` | IN_PROGRESS | dependência liberada |
| IN_PROGRESS | `support.resolved.v1` | RESOLVED | solução aplicada e evidência suficiente |
| RESOLVED | `support.closed.v1` | CLOSED | janela de confirmação concluída |
| RESOLVED/CLOSED | `support.reopened.v1` | IN_PROGRESS | problema voltou/solução não sustentou |
| NEW/TRIAGING/IN_PROGRESS/WAITING_CUSTOMER/WAITING_INTERNAL/WAITING_PROVIDER | `support.cancelled.v1` | CANCELLED | duplicado/inválido/sem necessidade |

## 4. Structured Troubleshooting

Cada tentativa deve poder registrar:

```text
problem/symptom
context
solution/procedure attempted
result
evidence
timestamp
actor
```

Não gravar somente uma nota final "resolvido".

## 5. Incidents

Quando Ticket é correlacionado a Incident:

```text
ticket
→ incident link
→ WAITING_PROVIDER ou IN_PROGRESS conforme ação possível
```

Agent deve consultar incidentes antes de executar checklist local repetitivo.

Eventos relevantes:

- `incident.detected.v1`;
- `incident.confirmed.v1`;
- `incident.resolved.v1`;
- `support.ticket_linked_to_incident.v1`.

## 6. Problems

Múltiplos Tickets/Incidents podem apontar para `Problem`.

Problem pode possuir:

- root cause;
- known workaround;
- canonical Knowledge Items;
- affected configurations;
- status de investigação.

Não transformar toda reclamação individual em Problem.

## 7. HITL

Quando IA não consegue prosseguir:

```text
IN_PROGRESS
→ support.waiting_internal.v1
→ WAITING_INTERNAL
```

e cria `HumanReviewRequest`.

Depois de guidance:

```text
human guidance
→ support.work_resumed.v1
→ IN_PROGRESS
```

## 8. Resolution

`support.resolved.v1` deve indicar:

- resolução conhecida/aplicada;
- outcome;
- se Customer confirmou quando necessário;
- knowledge used;
- human guidance used;
- incident/problem link.

## 9. Knowledge feedback

Uma solução bem-sucedida deve poder emitir:

```text
knowledge.solution_outcome_recorded.v1
```

Orientação humana reutilizável pode emitir:

```text
knowledge.candidate_created.v1
```

## 10. Métricas ligadas

- First Response Time;
- Resolution Time;
- AI Resolution Rate;
- Human Escalation Rate;
- First Contact Resolution;
- Reopen Rate;
- Solution Success Rate;
- CSAT quando coletado explicitamente.

## 11. Refinamentos v0.14

Triage deve distinguir **fato autoritativo** de **contexto volátil**. App/device/rede já conhecidos são apresentados ao cliente para confirmação quando relevantes; pagamento/plano/vencimento autoritativos não são perguntados sem motivo.

Incident detection pode correlacionar tickets com `OperationalSignal` sanitizado de fontes autorizadas, incluindo canais operacionais do WhatsApp. Uma mensagem isolada não confirma incidente.

Pedido de reembolso sempre cria/usa `HumanReviewRequest`; Ticket e Conversation podem permanecer sob AI_CONTROL enquanto aguardam a decisão, salvo necessidade de takeover.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — support context/signals/refund review checked.

