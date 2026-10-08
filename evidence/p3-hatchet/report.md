# P2C-HATCHET — Hatchet gate W0-04/W0-05 (report-only, sem migração)

- TASK_ID: P2C-HATCHET · data: 2026-10-07 · escopo: somente leitura + este relatório (nenhum código alterado)
- Contrato: `docs/15-implementation-baseline/10-integrations-certification.md:200-206` (Hatchet gate); ADR-0019 (Hatchet preferred com certification gate, fallback Inngest)

## Pré-condição (bloqueia todo o resto)

Nenhuma instância Hatchet está configurada neste checkout:

- `.env` contém as chaves `HATCHET_API_TOKEN` e `HATCHET_SERVER_URL`, mas **ambas com valor vazio** (comprimento 0, verificado em-processo, sem imprimir valores). Pelo loader (`packages/config/src/index.ts:661-662`, `emptyToUndefined`), vazio = ausente.
- Logo: **não há alvo para sondar nem credencial para validar**. Teste de conectividade TCP/HTTP é inaplicável (sem host/porta); registrar "inalcançável" seria fabricar evidência — o fato honesto é "não configurado".
- Camada adicional: SDK `@hatchet-dev/hatchet` **não instalado** (`packages/workflows/package.json: dependencies: {}`; `require.resolve` = absent). Mesmo com token, `new HatchetWorkflowAdapter` lançaria `hatchet SDK is not installed` e `createWorkflowAdapter` cairia para local com warning.
- Camada adicional: `enqueue` é stub construction-only (`hatchet-adapter.ts:50-63` — retorna `newTaskId()` sem nenhuma chamada Hatchet; `tick` noop `:65-70`). Nenhum run durável é sequer endereçável.

## Vereditos (gate 10-integrations-certification.md:202-206)

| # | Item | Veredito | Evidência (sem segredos) |
|---|------|----------|--------------------------|
| 1 | Conectividade + versão | BLOCKED — sem instância configurada | `TOKEN_PRESENT=False, TOKEN_LENGTH=0`; `URL_PRESENT=False, URL_LENGTH=0`; nada para discar |
| 2 | Crash resume (run sobrevive a restart do worker?) | BLOCKED — idem | Nenhum run pode ser criado (stub + sem SDK + sem servidor); local perde fila no restart por design (`local-adapter.ts:13-16`) |
| 3 | Wait/event (wait-for-event/lookback) | BLOCKED — idem | Sem servidor, sem workflow-name mapping (pinado só em W0-04, `hatchet-adapter.ts:60-61`) |
| 4 | HITL (HumanReviewRequest + resume) | BLOCKED — idem | Idem; sem superfície para solicitar/resumir review |
| 5 | Cancellation / supersede | BLOCKED — idem | Idem |
| 6 | Retry policies | BLOCKED — idem | Idem |
| 7 | Tenant fairness / shared concurrency | BLOCKED — idem | Idem; cenário noisy-tenant impossível sem cluster |
| 8 | Provider-down bulkhead | BLOCKED — idem | Idem |
| 9 | Observabilidade (runs/listagens) | BLOCKED — idem | Idem; só há contadores in-process (`commands_executed_total`), sem runs Hatchet |

Nenhum item PASS; nenhum item FAIL por defeito de código — todos BLOCKED por motivo: **pré-condição de ambiente não atendida + adapter construction-only**.

## Comandos + resultados (validation, sem segredos)

- `Get-Content .env | ... HATCHET_*` → chaves presentes: `HATCHET_API_TOKEN`, `HATCHET_SERVER_URL` (só nomes)
- Sonda em-processo (pwsh, sem ecoar valores): `TOKEN_PRESENT=False TOKEN_LENGTH=0`; `URL_PRESENT=False URL_LENGTH=0`
- `node -e require.resolve('@hatchet-dev/hatchet')` em `packages/workflows` → `SDK_RESOLVE: absent`
- `pnpm --filter @iptv/workflows test` → **7 passed** (incl. `HatchetWorkflowAdapter` throws sem token; factory fallback p/ local — `test/workflows.unit.test.ts:71-83`)
- `grep HATCHET_` → fiação env-gated documentada em `.env.example:99-100`, `packages/config`, `apps/api/README.md:56,301`, `integrations-capability-status.md:28`

## Mudanças

Nenhuma (proibido pelo escopo; e a regra manda SEM mudar código quando credencial ausente/inválida). Único arquivo escrito: este relatório.

## Riscos / notas

- `enqueue` retornar `{ durable: true }` sem criar run é claim desonesto se um dia o adapter for selecionado sem certificação — hoje inalcançável (sem token + sem SDK o factory cai para local), mas o gate W0-04 deve exigir run real antes de qualquer seleção.
- Issue upstream aberta de over-admission em path SQL (`hatchet-dev/hatchet#4778`, citada no gate:206): o experimento de versão pinada deve incluir cold-engine startup com limites parent/task combinados — ainda não executado.
- F12 permanece BLOCKED; fallback Inngest NÃO acionado (exige nova decisão, fora deste escopo).

## Recomendação: MANTER-LOCAL (honesto)

Não há base para KEEP_HATCHET: 0/9 itens PASS, todos BLOCKED por ausência de instância + SDK + implementação real. Manter `LocalWorkflowAdapter` honesto não-durável como default; F12 segue BLOCKED.

Próximos passos **somente se** o operador quiser certificar (nova decisão/tarefa, fora deste gate):

1. Operador configura instância real (URL + token com quoting correto) e instala `@hatchet-dev/hatchet` em versão pinada.
2. Implementar mapeamento real workflow-name + `enqueue` via SDK (hoje stub).
3. Executar os 9 itens contra a instância pinada, incluindo cold-engine startup + limites combinados (issue #4778) e cenários noisy-tenant e provider-down.
4. Só com tudo PASS: KEEP_HATCHET + plano de adoção; senão, reavaliar fallback Inngest por decisão explícita.
