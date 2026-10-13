# ADR-0028 — F12 local-honesto no piloto (Hatchet BLOCKED até certificação integral)

- **Status:** Accepted
- **Data:** 2026-10-13

## Context

O piloto precisa operar com fronteira honesta de durabilidade: o gate F12
(resume durável de workflows) tem apenas prova parcial — 1/1 verde contra
engine hatchet-lite descartável próprio em 2026-10-12
(`evidence/p3-hatchet/w004-live-proof-20261012.md`), single-tenant, sem
bulkheads provider-down/noisy-tenant e sem cancel sob engine real. O gate
integral de 9 itens (`evidence/p3-hatchet/report.md`) segue sem instância
definitiva do operador para certificar. O runbook do piloto (P8-PILOT) admite
explicitamente os dois modos — Hatchet ou local-honesto aceito — desde que por
decisão explícita, sem coexistência ambígua. O `LocalWorkflowAdapter` é
não-durável por desenho: fila somente em memória, restart derruba tudo
enfileirado (`packages/workflows/src/local-adapter.ts`). O gate de
certificação no código é fail-closed: sem `certified` /
`HATCHET_DURABLE_CERTIFIED`, `enqueue` do Hatchet recusa antes de qualquer
trigger (`packages/workflows/src/hatchet-adapter.ts`).

## Decision

- Modo do piloto = `LocalWorkflowAdapter` honesto (não-durável, fail-closed).
- F12 permanece `BLOCKED` em `tests/release/pilot-evidence.yaml` (dono:
  operator; desbloqueio só pela condição de reativação abaixo) — a prova lite
  de 2026-10-12 é registrada como evidência parcial, não como certificação.
- Sem token Hatchet (canônico `HATCHET_CLIENT_TOKEN` e legado
  `HATCHET_API_TOKEN`) e sem flag `HATCHET_DURABLE_CERTIFIED` em ambiente
  compartilhado: a certificação por flag é auto-assertiva (disciplina de
  `.env`); a flag da prova lite vive somente no `.env` local ignorado pelo
  git. A remoção é explícita no env do piloto (tokens + flag), verificada
  pela checagem de seleção no boot da condição 1.
- Sem fallback Inngest nesta decisão (exigiria decisão explícita própria).

## Condições explícitas de operação no modo local-honesto

1. Seleção verificável do modo local: o processo do piloto roda SEM
   `HATCHET_CLIENT_TOKEN` e SEM `HATCHET_API_TOKEN` (legado) — ausência
   conta como ausente também para string vazia — e o boot verifica que o
   adapter resolve local (`createWorkflowAdapter` ⇒ `kind: "local"`,
   `durable: false`, warning logado). Remover só a flag de certificação
   NÃO basta: com token presente e sem `HATCHET_DURABLE_CERTIFIED`,
   `enqueue` do Hatchet passa a falhar fail-closed em vez de selecionar
   local. A configuração (tokens + flag) é removida explicitamente do env
   do piloto; não entra no repo nem é citada como certificação.
2. Efeitos externos exigem `idempotencyKey` + fencing/reconciliação no handler
   (at-least-once, nunca exactly-once) + drill de restart-loss executado antes
   de tráfego real: provar que perda de fila em restart é detectada e
   reconciliada sem segundo efeito.
3. Teto de volume: tenant interno + canaries controlados (P8); pausa imediata
   se `duplicate effects > 0` ou queue age anômalo na janela de medição.
4. Promoção para Hatchet exige instância definitiva do operador + re-prova dos
   9 itens do gate integral contra ela, incluindo cold-start upstream
   (hatchet-dev/hatchet#4778), noisy-tenant e provider-down.

## Consequences

- O piloto opera sem claim durável: restart do processo perde a fila em
  memória — perda silenciosa salvo reconciliação pelo drill da condição 2.
- Duplicata é possível se o handler não implementar idempotência/fencing
  próprios: o dedupe do adapter local vale só dentro do tempo de vida do
  processo; dedupe cross-restart é responsabilidade do handler de domínio.
- Pior caso declarado: (a) perda silenciosa de fila em restart (memória);
  (b) duplicata de efeito se handler sem idempotência; (c) certificação por
  flag é auto-assertiva e só vale com disciplina de `.env` do operador.
- Nenhuma chamada externa é executada por esta decisão; nenhum crédito é
  gasto; nenhum cliente ou produção é tocado ou afirmado.

## Condição de reativação (promoção para Hatchet)

1. Operador provisiona instância Hatchet definitiva (URL + token com quoting
   correto) e instala o SDK em versão pinada.
2. Re-prova dos 9 itens do gate integral contra a instância definitiva,
   incluindo cold-engine startup com limites combinados (upstream #4778),
   cenários noisy-tenant e provider-down, e cancelamento sob engine real.
3. Só com tudo PASS: nova decisão KEEP_HATCHET + plano de adoção; senão,
   reavaliar fallback por decisão explícita.

## Reversibilidade

- Total neste ponto: factory é env-gated (sem token Hatchet ⇒ local com
  warning, sem I/O de rede na construção); o modo local não persiste dados,
  então sair dele não deixa estado durável para migrar.
- Reverter deixa de ser barato se o volume crescer sem idempotência nos
  handlers: cada efeito externo sem `idempotencyKey` + fencing vira dívida de
  reconciliação na promoção. Manter o teto da condição 3 preserva a
  reversibilidade barata.
