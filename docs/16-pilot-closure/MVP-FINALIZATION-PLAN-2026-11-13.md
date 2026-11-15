# StreamMax — Plano de finalização do MVP operacional (13/11/2026)

> **Plano de execução, não atestado de release.** Baseline de repositório consultado:
> `main@c75875d` (CI do push [43484633148](https://github.com/Kusts/iptv/actions/runs/43484633148) com conclusão SUCCESS).
> Última inspeção documentada do staging: checkout detached/sujo em `b46cec7`, em 12/11.
> Nenhuma nova verificação da VPS foi realizada neste plano. A autoridade para critérios
> é [Product Contract and MVP Freeze](../15-implementation-baseline/01-product-and-mvp.md);
> fatos e limitações estão em [estado do MVP (12/11)](STREAMMAX-MVP-STATUS-2026-11-12.md).

## Resultado desejado e fronteiras

Concluir **`MVP_STREAMMAX_OPERATIONAL`**, isto é, operação interna single-tenant:
cliente → pedido/plano → cobrança/compensação → assinatura → ativação supervisionada
→ renovação → suporte/recuperação. **Não** confundir esse marco com
`MVP-PILOT` (escopo completo de piloto) nem com `MVP-SAAS` (tenants externos).

A implementação do núcleo está avançada, mas o release não está aprovado.
Nenhum percentual subjetivo de desenvolvimento substitui os quatro gates.
Manter adapters `echo`/manual e sandbox quando não houver autorização de
operação externa; não converter resultados simulados em certificação live.

## Evidência de partida (sem promoção de gate)

| Gate obrigatório | Estado preservado | Evidência que falta |
| --- | --- | --- |
| `MVP_CODE_INTEGRATED` | `BLOCKED_EXTERNAL` | Atualizar o staging correto para candidato identificado, preservar alterações locais, comprovar smoke e rollback após deploy |
| `MVP_OPERATIONAL_SECURITY` | `BLOCKED_EXTERNAL` | Revalidar recuperação/rotação de operador, backup externo, restore e leitura sintética de segredo com a configuração atual |
| `MVP_SERVICE_DELIVERY` | `BLOCKED_EXTERNAL` | Ativação supervisionada em recurso autorizado do fornecedor, `externalRef` válido e readback independente, sem efeitos duplicados |
| `MVP_RENEWAL_AND_OPERATIONS` | `PASS` | Gate já aprovado no fechamento controlado; E2E sintético pelo navegador em stack descartável r4 PASS em 12/11. Repetir no staging como evidência da release, sem alterar o PASS histórico |

A execução r4 usou PostgreSQL isolado, echo/Asaas simulado e não exercitou as
alterações posteriores de Compose. O staging tem 69/69 migrations na última
leitura, mas health 200 não comprova jornada comercial.

## Sequência de execução — menor caminho funcional

### F0 — Congelar evidência e inventariar divergências (rápida)

- [x] Consultar `main`, runs recentes, PRs e issues; registrar SHA candidato e CI.
- [x] Inspecionar **somente leitura** `/home/deploy/iptv-staging`: Git, arquivos sujos,
  Compose/env sem exibir valores, imagens, migrations, serviços e backups.
- [x] Classificar o delta local: preservar, incorporar à branch ou retirar de
  circulação somente com evidência e autorização. Não sobrescrever o checkout sujo.
- [x] Confirmar o procedimento de [staging deploy](../10-operations/runbooks/staging-deploy.md)
  com os três `env_file` e os campos `CINEVISION_ALLOWED_ORIGIN`/
  `CINEVISION_LOGIN_PATH`; não confundir a stack r4 com o Compose de staging.

**Saída:** candidato + diff/reversão documentados, decisão `GO`/`BLOCKED` para staging.

**Registro de inspeção (2026-11-13; somente leitura; sem promoção de gate):**

- Candidato `main@c75875d58e45db93d13298490e6b00794815e58c`, CI main `43484633148` verde. Branch atual de docs `03600c875c51a07226a0c64a70d412f045c320db`; PR #132 aberto, runs `43490112150` e `43490267229` verdes. Issues #86–#89 permanecem abertas.
- Host validado pela host key previamente pinada: hostname `vmi3630510.contaboserver.net` resolve para `213.199.37.252`. No staging, `.staging-revision=main@b46cec7`; HEAD `b46cec78435d3f1e542d48daa20b3f732fded84d`, detached e sujo. `b46cec7` é ancestral do candidato; diff local: 38 arquivos, +2004/-118, sem migrations novas.
- Preservar sem alteração o `deploy/staging/docker-compose.staging.yml` remoto (M, somente duas linhas locais), `.staging-revision`, backups `docker-compose.staging.yml.bak.20261108-cinevision-env` e `.bak.20261108-cinevision-read01`, e `packages/secrets/test/secrets-write.unit.test.ts` (untracked). O Compose remoto sujo fixa dois valores CINEVISION, enquanto o candidato exige interpolação de `CINEVISION_ALLOWED_ORIGIN`/`CINEVISION_LOGIN_PATH`; não sincronizar nem retirar essas alterações.
- Três `env_file` presentes com modo 600; `docker compose ... config --quiet` válido. O Compose remoto sujo hardcodeia os dois campos CINEVISION: config válido e valores não vazios no container comprovam somente a configuração/runtime atual. Verificação somente de presença em `/home/deploy/iptv-staging/deploy/staging/.env.staging` confirmou `CINEVISION_ALLOWED_ORIGIN` e `CINEVISION_LOGIN_PATH` ausentes. Portanto, o Compose candidato com `${...:?required}` não passaria até que o operador provisione esses campos. Não registrar valores.
- Banco: 69 registros em `platform.migration_history`, última `202611080000_069_provider_dispatch_verifying_sigma.sql`; outbox mode `WORKER`, generation 3. API, web, postgres e outbox-worker saudáveis; tunnel rodando; migrate `Exited (0)`. `API_SCHEDULER_ENABLED=1`, `LEGACY_OUTBOX_DRAIN_ENABLED=0`.
- Divergência de ownership/Compose ainda não reconciliada: API tem label de projeto Compose `staging`, demais containers `iptv-staging`; todos compartilham `working_dir`/`config_file`. API está nas redes `iptv-staging_internal` e `staging_internal`; `docker compose -p iptv-staging ... ps --all` não a lista. Não inferir causa conclusiva.
- Decisão: inventário F0 concluído; deploy/staging **BLOCKED** pelo checkout dirty preservado, divergência do label da API, variáveis requeridas ausentes no `.env.staging` e ausência de autorização específica para deploy. Nenhum gate promovido; F1/F2/F3 seguem suspensos. Evidência reversível: inspeções somente leitura e configuração/runtime atual validados sem exibir valores; o env não foi alterado, não houve provisionamento nem deploy.

### F1 — Reconciliar staging e comprovar o golden loop (prioridade máxima)

- [ ] Com autorização específica de deploy, preservar estado e executar o
  procedimento PINNED-COPY/migrate/smoke/rollback já existente; nunca usar
  wipe ou `up -d` indiscriminado.
- [ ] Comprovar na revisão implantada: web/API, registro público fechado,
  autenticação, `APP_DATABASE_URL`, migrations, um único processador
  outbox/scheduler e conectividade Sandbox.
- [ ] Executar E2E **autenticado no staging** com dados sintéticos: cadastrar
  cliente, criar pedido, liquidar por caminho autorizado/simulado, observar
  `SETTLED`, `PENDING_ACTIVATION`, operação manual `HUMAN_REQUIRED`,
  assinatura, renovação, extensão de período e ticket de suporte.
- [ ] Cobrir replay do webhook/pedido/renovação, ledger e ausência de cobrança
  ou extensão em duplicidade. Anexar logs sanitizados e revisão/ambiente exatos.

**Saída:** evidências do `MVP_CODE_INTEGRATED` e E2E real de UI de staging
(sem alegar fornecedor live). Falhas reproduzíveis viram correções mínimas.

### F2 — Comprovar entrega de serviço real (dependência externa)

- [ ] Identificar recurso de teste legítimo, conta/token e autorização do
  operador para **uma** ativação controlada Sigma/CINEVISION; não contratar
  serviço nem efetuar compra automaticamente.
- [ ] Confirmar os campos esperados, executar ativação supervisionada e ler
  o serviço de volta **diretamente do fornecedor**; cruzar `externalRef`,
  pedido, assinatura, binding, evidência e resultado da operação.
- [ ] Simular falhas/replay sem repetir uma escrita de efeito desconhecido.
  Se o fornecedor/token não estiver disponível, manter
  `MVP_SERVICE_DELIVERY=BLOCKED_EXTERNAL` e seguir tarefas independentes.

**Saída:** evidência de ativação + readback, ou bloqueio externo exato (sem
inventar certificação).

### F3 — Segurança e recuperação operacional (escopo necessário)

- [ ] Reexecutar a matriz mínima de recuperação e privilégios definida no
  baseline: login antigo inválido/novo válido após rotação, remoção de
  admin temporário, logs sem segredos.
- [ ] Comprovar backup PostgreSQL externo cifrado, chave separada do banco,
  restore isolado e leitura sintética de segredo. Validar custódia separada
  de `SECRETS_ENCRYPTION_KEY` e `BETTER_AUTH_SECRET`.
- [ ] Revalidar isolamento entre tenants, autenticação dos webhooks e ausência
  de efeitos duplicados após timeout/crash, aproveitando cobertura existente.
- [ ] Tratar #7, #44, #43, #51 e #74 por **lacuna reproduzida**; não reiniciar
  refatoração ampla nem reabrir decisões de infraestrutura sem falha concreta.

**Saída:** evidência necessária para `MVP_OPERATIONAL_SECURITY` e lista
curta de riscos residuais, se houver.

### F4 — Documentação, backlog e decisão final

- [ ] Atualizar `README.md`, `AGENTS.md`, status do MVP, catálogo de
  capabilities e runbook para refletir **código/ambiente observado**,
  preservando relatórios antigos como snapshots datados.
- [ ] Triar #86–#89: fechar só o que tiver evidência, redefinir como
  homologação restante ou adiar o que pertence ao `MVP-PILOT`.
- [ ] Diferir MK Ativador (#58), benchmarking de runtimes/modelos (#4/#27),
  ARTEMIS e novos recursos até depois do MVP operacional.
- [ ] Publicar relatório único por gate: estado, SHA, ambiente, comando/teste,
  evidência, bloqueio e responsável. Gate só muda para `PASS` quando **todos**
  os critérios do baseline estiverem comprovados.

**Saída:** `MVP_STREAMMAX_OPERATIONAL=PASS` somente com 4/4 gates `PASS`;
caso contrário, relatório `BLOCKED` com próximos passos concretos.

## Teste mínimo reproduzível

1. **Docs/contratos:** `python scripts/validate_docs.py`,
   `python tests/contracts/test_contracts.py`,
   `python tests/contracts/test_seed_contract.py`.
2. **Código candidato:** `pnpm lint`, `pnpm typecheck`, `pnpm test`
   com `TEST_DATABASE_URL` apontando para **banco descartável vazio**, e
   `pnpm build` (ou quatro checks obrigatórios do CI no SHA exato).
3. **Operação:** smoke API/web e pelo menos uma jornada completa de UI com
   renewal/replay e suporte no **staging da revisão aprovada**.
4. **Fornecedor:** uma confirmação externa de serviço quando houver recurso
   e autorização; nenhum simulador serve de readback live.

## Regras de eficiência

- Planner e subagentes podem executar tarefas independentes autonomamente.
  Usar componentes existentes; uma correção = reprodução + alteração mínima +
  regressão. Nenhum novo serviço, framework ou dashboard para fechar este MVP.
- Diferenciar **software implementado**, **teste sintético**, **staging** e
  **certificação live** em toda entrega.
- **Alerta:** deploy, rotação de credenciais, pagamentos e ativação externa
  podem expor dados ou causar efeitos irreversíveis; exigem escopo e autorização
  concretos antes da execução.
