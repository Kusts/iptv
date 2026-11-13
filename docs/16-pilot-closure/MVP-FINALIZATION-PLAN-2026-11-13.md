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

- [ ] Consultar `main`, runs recentes, PRs e issues; registrar SHA candidato e CI.
- [ ] Inspecionar **somente leitura** `/home/deploy/iptv-staging`: Git, arquivos sujos,
  Compose/env sem exibir valores, imagens, migrations, serviços e backups.
- [ ] Classificar o delta local: preservar, incorporar à branch ou retirar de
  circulação somente com evidência e autorização. Não sobrescrever o checkout sujo.
- [ ] Confirmar o procedimento de [staging deploy](../10-operations/runbooks/staging-deploy.md)
  com os três `env_file` e os campos `CINEVISION_ALLOWED_ORIGIN`/
  `CINEVISION_LOGIN_PATH`; não confundir a stack r4 com o Compose de staging.

**Saída:** candidato + diff/reversão documentados, decisão `GO`/`BLOCKED` para staging.

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
