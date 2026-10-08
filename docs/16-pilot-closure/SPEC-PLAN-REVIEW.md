# SPEC + PLAN v1 — Revisão normativa (2026-10-07)

Veredito: **APROVADA COM CORREÇÕES** abaixo. Nenhuma correção muda o objetivo
(`READY FOR CONTROLLED PILOT` → `READY FOR PRODUCTION — INTERNAL TENANT`) nem
os 15 critérios do §15. Itens fora do acceptance viram follow-up (§17 da SPEC).

Evidência base: `main@396f55e` + branch atual `Kusts/p1-outbox-worker-process`
em `ae2da47` (PR #11); 50 migrations (última `050_platform_outbox_worker`);
`docs/15-implementation-baseline/` v1.0.1; `CHANGELOG.md ## Unreleased`.

## 1. Reconciliação com a realidade do repo (todas confirmadas)

| # | Afirmação da SPEC | Realidade observada | Efeito |
|---|---|---|---|
| R1 | Drift de contagens (§13) | `README.md:51,76-78` diz 46; baseline diz 046; staging provou 49; runtime tem 050 | Correção `p0-docs` torna contagens count-agnostic; baseline status vai em fatia C9 dedicada |
| R2 | PR #11 deixa live-interlock manual | `activation.ts:1-13` + `config.ts:160-162`: quiescence é env copiado de `GET drain-state`; CHANGELOG registra "P1 live-interlock declinado por escopo" | Confirma C0: 051 é o trabalho restante real, não re-revisão |
| R3 | Coexistência legacy/worker proibida | `outbox-drainer.ts:60-73`: legacy marca `PUBLISHING` sem lease/token; worker só reclama lease não-NULL | 051 deve bloquear ativação com `PUBLISHING` sem lease (linhas órfãs legacy) — critério já previsto, detalhado no §2 |
| R4 | Cutover RLS pendente em platform/billing/finance | CHANGELOG: "global cutover stays BLOCKED on platform/billing/finance"; só control/identity/crm enrolados | P1 Tier 0 (billing+finance primeiro) mantido |
| R5 | Web tem 10 rotas, sem 1:1 com as 12 superfícies C5 | `apps/web/app`: `/, /login, /hitl, /copilot, /orders, /conversations, /provider-operations, /support, /conhecimento, /subscriptions` | P4 exige tabela de mapeamento existente→obrigatório (correção C5, §3) |
| R6 | Sem `tests/release/pilot-evidence.yaml` | Nenhum arquivo `pilot-evidence*`/`tests/release/**` | P5 cria do zero; sem migração |
| R7 | Baseline diz OpenAI Agents SDK; runtime usa harness próprio + `LocalWorkflowAdapter` não-durável | `packages/workflows` + `08-agent-harness.md` | ADR KEEP/ADOPT com evidência é obrigatório antes do pilot (C4); doc e código não podem divergir sem ADR |
| R8 | RPO ≤ 15m sem PITR provado | Staging mediu backup/restore de DB vazio, sem SLO, sem offsite/PITR | P6 decide PITR ou retarget formal do RPO — sem manter SLO sem mecanismo |

## 2. Correções normativas (vinculam a execução)

- **C-050/051 (escopo de "não editar 050"):** proibido editar os ARQUIVOS
  `001–050`. Permitido — e necessário — que a **nova** migration 051 faça
  `CREATE OR REPLACE` de `platform.outbox_claim` (acrescenta o gate de modo;
  todo o resto byte-idêntico) e crie `platform.outbox_runtime_control` +
  `platform.outbox_runtime_transitions` + `platform.outbox_runtime_mode()` +
  `platform.outbox_runtime_set()`. Sem isso o critério "claim falha fora de
  WORKER" seria inexequível.
- **C-QUIESCING (P0.3, "API restart não muda runtime mode"):** o modo vive no
  DB após 051; restart não o altera **por construção**. O teste prova
  autoridade-DB (modo lido a cada drain/claim), não snapshot de env.
- **C-LEGACY-GATE:** após 051 o legacy consulta `platform.outbox_runtime_mode()`
  (função `SECURITY DEFINER`, `EXECUTE` ao papel da API) **antes de cada
  drain** — drena só em `LEGACY`. O kill-switch de env
  (`LEGACY_OUTBOX_DRAIN_ENABLED=0`) permanece como defesa em profundidade.
  Revogação total do acesso direto legacy vem no cutover P1 (RLS), não em P0.
- **C-SWITCH (concorrência + crash):** transições via
  `platform.outbox_runtime_set(p_from, p_to, p_actor, p_expected_generation)`
  com CAS de geração no predicado do `UPDATE` (modo E geração; segundo
  escritor/ABA recebe 0 linhas → erro de mensagem fixa); transição é um
  `UPDATE` atômico — crash deixa o modo antigo, nunca trava. Rollback é transição
  `WORKER→QUIESCING→LEGACY` (forward-fix), nunca `DOWN` de migration.
- **C-STRANDED:** `→WORKER` é recusada com `PUBLISHING` sem lease
  (`lease_expires_at IS NULL`) — prova "zero unfenced PUBLISHING". Linhas
  `PUBLISHING` **com** lease válido/expirado não bloqueiam (reclaim cobre).
- **C-BATCH (P2 "claim ≤ lanes"):** registrado como **tradeoff documentado**,
  não como igualdade estrita — o servidor limita `p_limit ≤ 100`, lanes
  `≤ 16`, e o batch corrente é integralmente contabilizado no shutdown
  (§4). Igualar claim==lanes reduziria throughput sem prova de benefício;
  reabrir exige evidência de pressão de duplicatas, como follow-up.
- **C-ROW-MIGRATION (§5.2):** "row migration via `tenant_id`" significa
  **prevenir** `UPDATE` de `tenant_id` (`WITH CHECK` + política), não suportá-lo.
- **C-AGENT-DOC (§8.1):** se o ADR disser `KEEP_CURRENT_HARNESS`, o mesmo PR
  atualiza `08-agent-harness.md` (hoje declara o SDK como harness primário).
- **C-G16 (escopo):** G16 no piloto = conversão de reseller em tenant
  **interno**; self-service externo segue excluído (Waves 18–20).
- **C-BRANCH (§12.2):** antes de invocar a compensação, verificar o plano real
  do GitHub; se indisponível, aplicar branch-only + PR-only + CI verde +
  human merge + sem force-push + sem push direto, com evidência.
- **C-FRONTEND-MAP (§9/C5):** P4 abre com a tabela existente→obrigatório
  (R5); cada mutação reutiliza comando existente; telas com
  loading/empty/error/retry/permission-aware/mobile-crítico.

## 3. Design 051 (contrato do coder — P0)

```text
LEGACY → QUIESCING → WORKER   (+ rollback WORKER → QUIESCING → LEGACY)
```

- `platform.outbox_runtime_control` (singleton `id=1`; `mode` ∈
  LEGACY/QUIESCING/WORKER; `generation int`; `updated_at/at_by/nota`;
  seed `LEGACY gen 1`). Dono: `outbox_executor`; `REVOKE FROM PUBLIC`;
  sem grants a `worker`/`iptv_app`/owner-novo (executor lê por ser dono;
  app/worker só via funções).
- `platform.outbox_runtime_transitions` append-only (from/to/generation/
  actor/recorded_at) + trigger append-only existente; `set()` insere a linha.
- `platform.outbox_runtime_mode()` → `text`, `SECURITY DEFINER`, estável,
  `EXECUTE` a `outbox_worker` + `iptv_app` (leitura estreita da autoridade).
- `platform.outbox_runtime_set(p_from, p_to, p_actor, p_expected_generation)` —
  valida não-nulidade e a ordem, CAS de geração no predicado
  (`mode=p_from AND generation=p_expected_generation`), recusa `→WORKER`
  com unfenced `PUBLISHING`, sem `EXECUTE` a app roles (operador via owner).
  Erros com mensagens fixas, sem ecoar valores.
- `platform.outbox_claim` (051 `CREATE OR REPLACE`, corpo 050 intacto +
  gate nas primeiras linhas): lê o modo e `RAISE` se ≠ `WORKER`.
- Legacy (`OutboxDrainer`): consulta `mode()` antes de cada `drain`;
  drena só em `LEGACY` (`QUIESCING`/`WORKER` → mesmo erro 409 de desabilitado).
  Scheduler inalterado (já respeita o gate).
- Worker: nenhuma chamada nova no caminho quente — o próprio `claim`
  consulta a autoridade (critério "não depende de variável copiada").
  `OUTBOX_LEGACY_QUIESCED` permanece como asserção do operador em profundidade.
- `roleGuard.ts`: estender com (f) zero ACLs de parâmetro cluster-global para
  o worker (espelho 050), (g) worker não é dono de objetos, (h) sem `CREATE`
  no schema `platform`. `TEMPORARY`/outros defaults de instância **não**
  são afirmados (variam por provedor) — documentar, não falhar.
- Testes 051 (DB descartável): LEGACY drena / claim nega; QUIESCING bloqueia
  novos legacy, in-flight termina; WORKER inverte; unfenced bloqueia ativação;
  rollback; switch concorrente (CAS); crash-durante-switch (modo antigo);
  restart não muda modo. Worker: heartbeat renova durante drain gracioso;
  `stop()` aguarda o batch corrente (não só `processItem`).

## 4. P2s do worker (resolução nesta fatia)

1. **Shutdown/batch:** `stop()` passa a aguardar o batch corrente
   (flag `activeBatches` além de `inFlight`); lanes do batch reclamado são
   concluídas, nunca abandonadas para "limpar estado".
2. **Heartbeat em drain:** remover o `stopRequested` da condição de parada do
   heartbeat — renova até a tentativa assentar ou `maxRenews`, inclusive em
   shutdown gracioso.
3. **Claim batch:** mantido o tradeoff at-least-once (servidor ≤100, lanes
   ≤16, batch contabilizado); sem igualdade claim==lanes.
4. **roleGuard:** provas (f)(g)(h) do §3; o que depender de default de
   provedor vira documentação explícita, não gate.

## 5. O que esta revisão NÃO muda

Objetivo, princípios (§3 da SPEC), DoD, matriz G/F, ordem P0→P8, política de
PRs `closure/<phase>-<slice>`, política de review (2 rodadas; depois só
blocker real; melhoria vira follow-up), lista de artefatos finais, regra de
conclusão ("qual acceptance criterion falhou?").
