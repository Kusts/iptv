# EPIC-06 — Support, Agent, HITL & Knowledge

## Outcome

Permitir que IA resolva atendimento com ferramentas seguras, escale exceções e transforme resultados em conhecimento validável.

## Stories

### SA-01 — Conversation runtime

**Aceite:** AI_ACTIVE/HUMAN_TAKEOVER/PAUSED são controle de conversa separado do Ticket.

### SA-02 — Support Ticket

**Aceite:** ticket segue state machine canônica; Incident/Problem são objetos separados.

### SA-03 — Agent Tool Gateway

**Aceite:** tool call passa authorization + policy + risk + domain command; RAG não autoriza ação crítica.

### SA-04 — HITL package

**Aceite:** escalada inclui problema, contexto, tentativas, evidências, hipótese e pergunta; humano pode orientar sem assumir conversa.

### SA-05 — Human takeover / return to AI

**Aceite:** takeover bloqueia respostas automáticas; retorno injeta resumo auditável.

### SA-06 — Knowledge candidate loop

**Aceite:** solução que funcionou vira CANDIDATE, nunca VERIFIED automaticamente; success/failure/freshness atualizam ranking.

### SA-07 — Evals + shadow mode

**Aceite:** releases do agente passam dataset offline e shadow antes de autonomia maior; hard-fails bloqueiam promoção.

## Epic Gate

Atendimento real pode ser resolvido por AI, escalado, retomado e convertido em Candidate Knowledge sem violar guardrails.
