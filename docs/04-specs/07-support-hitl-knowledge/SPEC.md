# SPEC — Support, HITL & Knowledge Loop

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Versão: 1.0  
> Slice: MVP-07  
> Dependências: Identity/CRM, Communications, Agent Runtime, Provider Fulfillment, Event/Outbox

## 1. Objetivo

Implementar o loop operacional de atendimento em que um problema individual pode ser triado, investigado, escalado para humano quando necessário, resolvido com evidência e convertido em aprendizado reutilizável sem promover automaticamente conteúdo não confiável a conhecimento canônico.

## 2. Escopo MVP

Inclui:

- criação e lifecycle de Support Ticket;
- structured troubleshooting e Solution Attempts;
- consulta a Incident/Problem antes de troubleshooting repetitivo;
- criação e resolução de HumanReviewRequest;
- takeover/return-to-AI de conversa;
- Knowledge Source/Item/Version baseline;
- registro de Solution Outcome;
- candidate knowledge a partir de guidance/outcome;
- retrieval somente de Knowledge adequado ao contexto e trust level;
- auditoria, telemetria e feedback de qualidade.

Não inclui no MVP:

- crawler autônomo amplo;
- promoção automática de conhecimento externo a VERIFIED;
- root-cause analysis totalmente autônomo;
- aprendizado causal;
- publicação automática de políticas de negócio.

## 3. Autoridades

Esta SPEC não redefine estados. Usa:

- `docs/02-domain/support/states.md`;
- `docs/02-domain/hitl/states.md`;
- `docs/02-domain/knowledge/states.md`;
- `docs/02-domain/event-model.md`;
- `docs/07-agent/tool-contracts.md`.

## 4. Invariantes

1. Ticket, HumanReview e Knowledge Item possuem lifecycles independentes.
2. `WAITING_INTERNAL` no Ticket não significa automaticamente `HUMAN_CONTROL` na conversa.
3. Human guidance nunca contorna Policy/Risk/Authorization.
4. Uma solução bem-sucedida uma vez não vira `VERIFIED` automaticamente.
5. Conteúdo externo nasce `UNTRUSTED` e pode apenas gerar Candidate Knowledge.
6. Policies internas autoritativas têm precedência sobre retrieval externo.
7. Todo troubleshooting relevante registra tentativa + contexto + outcome.
8. Ticket `RESOLVED` pode ser reaberto; histórico nunca é sobrescrito.
9. Human takeover impede resposta autônoma concorrente.
10. Tenant isolation se aplica a Tickets, Reviews, Knowledge, Conversations e evidence.

## 5. Fluxo principal de suporte

```text
message/problem detected
↓
create/reuse Support Ticket
↓
NEW → TRIAGING
↓
consult current Incidents/Problems
↓
retrieve context-matched Knowledge
↓
IN_PROGRESS
↓
attempt solution
↓
record SolutionAttempt + Outcome
├─ solved → RESOLVED → confirmation window → CLOSED
├─ needs customer → WAITING_CUSTOMER
├─ provider dependency → WAITING_PROVIDER
└─ uncertainty/risk → WAITING_INTERNAL + HumanReviewRequest
```

## 6. Triage

Triage mínimo deve estruturar:

```text
symptom/category
severity/priority
person/customer
conversation
subscription/server when known
device/app/network context
active incident/problem matches
previous attempts
```

O Agent não deve repetir troubleshooting local quando existe Incident confirmado que explica o sintoma, salvo quando há ação local útil e segura.

## 7. Solution Attempt

Cada tentativa deve persistir:

```text
support_ticket_id
solution_id | procedure_key
attempt_no
context_json
started_at
completed_at
outcome
observed evidence
actor
```

Outcomes baseline:

```text
SUCCEEDED
FAILED
PARTIAL
INCONCLUSIVE
NOT_APPLICABLE
```

`knowledge.solution_outcome_recorded.v1` é emitido quando há resultado observável suficiente.

## 8. HITL — quando solicitar

Criar `HumanReviewRequest` quando pelo menos uma condição ocorrer:

- baixa confiança depois de troubleshooting razoável;
- policy exige aprovação;
- security challenge/CAPTCHA/2FA;
- conflito entre estados canônicos e provider;
- ação R3/R4 sem autonomia;
- suspeita de fraude/abuso que exige revisão;
- orientação humana específica é necessária;
- incidente/provider não permite decisão segura.

O contexto mínimo segue `docs/02-domain/hitl/states.md`.

## 9. HITL — SLA e escalonamento

Cada review pode registrar:

```text
priority
assigned_to
sla_due_at
escalation_policy
resource_type/resource_id
```

`hitl.review_sla_breached.v1` sinaliza atraso, mas não concede permissão implícita nem executa a ação automaticamente.

## 10. Conversation Control

O runtime deve respeitar:

```text
AI_CONTROL
HUMAN_CONTROL
PAUSED
```

- `HUMAN_CONTROL`: AI pode observar/resumir, mas não responder autonomamente.
- `PAUSED`: nenhuma resposta até condição explícita liberar.
- retorno para AI exige evento `conversation.returned_to_ai.v1` ou `conversation.resumed_by_ai.v1` conforme estado.

## 11. Knowledge ingestion baseline

Fontes MVP podem incluir:

- admin/manual;
- conversas/tickets resolvidos;
- provider notices;
- documentos previamente aprovados;
- human guidance reutilizável.

Pipeline:

```text
KnowledgeSource
↓
DISCOVERED
↓
extract/structure
↓
CANDIDATE
↓
validation
├─ VERIFIED
└─ REJECTED
```

Web/YouTube/grupos entram posteriormente pelo mesmo quarantine path.

## 12. Promotion de Candidate Knowledge

Critérios mínimos para `VERIFIED` devem ser policy/configuráveis, podendo considerar:

- fonte confiável;
- contexto claro;
- outcome observável;
- ausência de conflito com policy;
- múltiplos sucessos ou aprovação humana, conforme tipo;
- versão de app/provider quando aplicável.

Nunca usar apenas confiança do LLM como evidência suficiente.

## 13. Retrieval

Ranking pode considerar:

```text
context_match
× confidence
× success_rate
× freshness
× source_reliability
```

Filtros obrigatórios antes do ranking:

- tenant scope;
- status permitido (`VERIFIED`, e opcionalmente `DEGRADED` com aviso/policy);
- knowledge type permitido;
- compatibility constraints;
- policy precedence;
- content safety/trust.

## 14. Incident & Problem linkage

Ticket pode vincular-se a Incident e/ou Problem sem alterar a semântica destes objetos.

Quando Incident é resolvido:

- Tickets relacionados podem ser reavaliados;
- não devem ser fechados automaticamente sem verificar o efeito no cliente quando confirmação for necessária.

Problem pode registrar workaround e root cause, mas Knowledge canônico permanece entidade própria/versionada.

## 15. APIs / Commands

MVP já possui baseline em OpenAPI para:

- `POST /v1/support/tickets`;
- `POST /v1/hitl/reviews/{reviewId}/guidance`;
- `POST /v1/conversations/{conversationId}/messages`.

Extensões planejadas para implementação do slice:

```text
GET  /v1/support/tickets/{ticketId}
POST /v1/support/tickets/{ticketId}/attempts
POST /v1/support/tickets/{ticketId}/resolve
POST /v1/hitl/reviews
POST /v1/conversations/{conversationId}/takeover
POST /v1/conversations/{conversationId}/return-to-ai
GET  /v1/knowledge/search
POST /v1/knowledge/candidates
```

Até esses endpoints entrarem no OpenAPI, são propostas de SPEC e não contratos executáveis.

## 16. Eventos usados

Support:

```text
support.ticket_created.v1
support.triage_started.v1
support.work_started.v1
support.waiting_customer.v1
support.waiting_internal.v1
support.waiting_provider.v1
support.work_resumed.v1
support.resolved.v1
support.closed.v1
support.reopened.v1
support.cancelled.v1
support.ticket_linked_to_incident.v1
```

HITL/Conversation:

```text
hitl.review_requested.v1
hitl.review_queued.v1
hitl.review_acknowledged.v1
hitl.review_started.v1
hitl.guidance_provided.v1
hitl.action_taken.v1
hitl.review_resolved.v1
hitl.review_expired.v1
hitl.review_cancelled.v1
hitl.review_sla_breached.v1
conversation.human_takeover_started.v1
conversation.returned_to_ai.v1
conversation.paused.v1
conversation.resumed_by_ai.v1
conversation.resumed_by_human.v1
```

Knowledge:

```text
knowledge.source_discovered.v1
knowledge.candidate_created.v1
knowledge.validation_started.v1
knowledge.verified.v1
knowledge.rejected.v1
knowledge.degraded.v1
knowledge.reverified.v1
knowledge.superseded.v1
knowledge.deprecated.v1
knowledge.solution_outcome_recorded.v1
```

## 17. Persistência

Entidades/tabelas principais:

```text
support_tickets
solution_attempts
incidents
problems
ticket_incident_links
ticket_problem_links
human_review_requests
human_review_actions
knowledge_sources
knowledge_items
knowledge_versions
solutions
solution_outcomes
conversations
messages
```

## 18. Segurança e privacidade

- não expor transcript completo em HumanReview quando resumo suficiente;
- redigir secrets/credentials de provider;
- limitar knowledge retrieval por tenant;
- knowledge global futuro exige processo explícito de sanitização/proveniência;
- anexos/evidências seguem classificação de dados;
- takeover e guidance exigem RBAC adequado.

## 19. Observabilidade

Mínimo:

- ticket age/state;
- first response/resolution time;
- attempts per ticket;
- AI resolution rate;
- escalation/HITL rate;
- HITL queue age/SLA breach;
- solution success by context;
- knowledge reuse rate;
- candidate → verified rate;
- reopen rate;
- provider-related ticket share.

## 20. Critérios de aceitação

- CA-01: Ticket pode aguardar humano sem transferir conversa automaticamente.
- CA-02: takeover impede resposta AI concorrente.
- CA-03: cada solução tentada gera outcome estruturado quando observável.
- CA-04: guidance humana reutilizável gera Candidate, não VERIFIED automático.
- CA-05: knowledge externo/untrusted não altera policy/tool permission.
- CA-06: Incident é consultado antes de troubleshooting redundante quando match existe.
- CA-07: Ticket resolvido pode ser reaberto sem apagar resolução anterior.
- CA-08: retrieval nunca cruza tenant.
- CA-09: HumanReview expira/cancela sem inferir aprovação.
- CA-10: métricas de suporte/knowledge são deriváveis dos fatos persistidos.

## 21. Testes mínimos

- ticket happy path até CLOSED;
- WAITING_CUSTOMER → resume;
- provider incident matched;
- AI falha → HITL → guidance → resume → resolve;
- human takeover race contra send_message;
- review SLA breach sem auto-approval;
- malicious external knowledge attempting instruction injection;
- same solution succeeds/fails em contextos diferentes;
- Candidate rejected;
- VERIFIED knowledge de outro tenant não aparece no retrieval;
- resolved ticket reopened;
- guidance creates Candidate only once under replay/idempotency.

## 22. Auto-revisão do arquivo

Revisado contra Support/HITL/Knowledge state machines, Event Model, Logical Data Model e Agent Tool Contracts. Ajustes feitos na revisão:

- mantidos Ticket, Review e Knowledge como lifecycles ortogonais;
- removida qualquer promoção automática de guidance para VERIFIED;
- explicitada diferença entre takeover e `WAITING_INTERNAL`;
- adicionada consulta a Incident/Problem antes de troubleshooting repetitivo;
- endpoints ainda não contratuais foram marcados explicitamente como extensões planejadas.

## 23. Refinamentos de suporte e inteligência v0.14

### Confirmação de contexto volátil

Antes de diagnóstico, apresentar dados conhecidos que podem ter mudado (device/app/rede) e pedir confirmação apenas quando relevantes. Fatos autoritativos como pagamento/plano/vencimento são consultados, não perguntados por rotina. Atualizar `last_verified_at/source` quando cliente confirmar mudança.

### Operational Signals / incident correlation

Mensagens de canais/grupos autorizados, avisos do provider e recorrência de tickets podem gerar `OperationalSignal` normalizado. Raw content permanece separado. Incident Candidate exige correlação/evidência; uma mensagem isolada não é incidente confirmado. Comunicados oficiais recebem provenance/trust distinto de relatos comunitários.

### Research assistido

Quando knowledge interno não basta, Support Research pode consultar documentação, web, sites de apps, GitHub, fóruns, comunidades e YouTube. `yt-dlp` pode coletar metadata/subtitles/autosubs/transcrição quando permitido. Todo material externo entra como UNTRUSTED e nunca altera policy/tools.

### Conhecimento global

Tenant facts → sanitize/normalize → Global Candidate → validação multi-evidência/humana → Global Verified. Nunca promover nome, telefone, mensagens privadas, credenciais, MAC/Device ID, dados financeiros ou identificadores do tenant.

### Refund

Toda solicitação de reembolso abre/usa HumanReview `REFUND`. Agent pode manter AI_CONTROL, coletar Trial, payment, usage, attempts, provider cost e residual potential, mas não autoriza nem executa refund.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — volatile context, signals, research, global knowledge and refund HITL checked.

