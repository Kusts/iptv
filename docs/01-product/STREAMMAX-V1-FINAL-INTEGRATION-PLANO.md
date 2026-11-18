# StreamMax V1 — Plano de integração final

- **Data:** 2026-11-17
- **Status:** plano revisado e aprovado para execução; **NÃO certifica produção**
- **Escopo:** operação própria StreamMax
- **Repositórios:** Kusts/iptv e Kusts/OpenMausBot
- **Referências:** [Catálogo comercial](CATALOGO-COMERCIAL.md); [Plano unificado](STREAMMAX-V1-PLANO-UNIFICADO.md); [Contrato do bot](../05-contracts/streammax-bot-contract.md)

## Supersedência e mapeamento de marcos

Há três esquemas M0–M5 coexistindo nos documentos históricos. Este documento é a fonte canônica da missão **STREAMMAX-V1-FINAL-INTEGRATION**. Ele prevalece sobre o PLANO-UNIFICADO somente para esta missão; não apaga nem reescreve o histórico. O “M1” deste plano não é o M1 do contrato do bot.

| Marco desta missão | Conteúdo e origem |
|---|---|
| P | Planejamento/documentação; novo. |
| M1 | Sincronizar bots/catálogo = antigo M1 do PLANO-UNIFICADO (atendimento→cliente) + pendências S5; não é o M1 do contrato do bot. |
| M2 | Ferramentas comerciais = antigo M2 (venda/cobrança), ampliado para 9 capacidades. |
| M3 | Jornadas = antigo M3 (entrega/suporte/renovação). |
| M4 | Homologação staging = antigo S5 + M4-A/B; executado em homologação sintética, sem certificação de produção. |
| M5 | Limpeza/fechamento técnico = antigo M4 (limpeza). Piloto comercial (antigo M5) permanece **FORA DE ESCOPO**. |

## Estado atual verificado (2026-11-17)

| Marco | Estado e evidências |
|---|---|
| M1 | Catálogo aprovado V1.0: quatro planos (30/75/150/300), adicionais por tela (20/60/100/150 para 1/3/6/12 meses), trial de 6h uma vez por usuário com exceção técnica auditável; desconto antecipado de R$5 implementado em `approved-catalog.ts`, `renewal.commands.ts`, `renewal-store.ts`. A API/bot ainda não expõe adicionais (`streammax-bot-contract.md:10,14,38`). OpenMausBot ainda descreve R$30 como seed sem catálogo vigente (`teams/iptv/knowledge/streammax-comercial.md:16,19,23,30,32`), inclusive nas skills `streammax-atendimento`/`streammax-vendas` e em `souls/atendimento.md:11`; não documenta desconto R$5. `streammax-api/SKILL.md:8` ainda recomenda wrapper sintético. Fonte canônica: `docs/01-product/CATALOGO-COMERCIAL.md`. |
| M2 | API do bot expõe `list-plans`, `resolve-lead`, `reply`, `quote`, `create-order` e as cinco rotas seguras de `get-charge`, `get-subscription`, `get-trial`, `open-ticket`, `get-ticket`; apenas `renewal-quote` e `renew` seguem 501. As consultas são tenant-scoped e verificam titularidade onde há recurso individual; `get-trial` é somente leitura e não calcula elegibilidade. Guard deriva tenant da credencial e rejeita campos `tenant*`; escritas conservam idempotência. `offer.quote` e comandos existentes permanecem responsáveis por preços e efeitos comerciais, nunca a API do bot. Preços executáveis vêm exclusivamente de `catalog.prices`; `approved-catalog.ts` é referência, não fonte executável. A carga via `scripts/seed-approved-catalog.mjs --tenant-id <uuid> --apply` depende de autorização em M4. Addons antes da carga são referência com `executable:false`; flags default off. Integração requer PostgreSQL descartável vazio. |
| M3 | Suítes de jornada existentes: `apps/api/test/streammax-v1-journey.integration.test.ts` (J1–J5), `streammax-bot-wiring.integration.test.ts`, `bot-service-api.integration.test.ts`, `streammax-v1-crossrepo.integration.test.ts`; usam `skipIf` sem `TEST_DATABASE_URL`. |
| M4 | EXECUTADO (homologação sintética): staging Contabo `feat/streammax-v1-final-integration@8ad9e18e6e1c64ebc2a94a6c87bbb21152db54a0`; rollback tags de api/migrate/web preservadas e arquivos untracked do host mantidos. Deploy/build OK, migration no-op (`applied=0 skipped=70 total=70`), health/ready e web 200. Dry-run e aplicação do catálogo no tenant StreamMax: `created=11, updated=3`; oito preços operacionais (4 PLAN + 4 ADDON) segmentados P1M/P3M/P6M/P12M, metadata V1.0 conferida; sem exclusões. S2 configurado com API habilitada e bot interno desabilitado; rota sem credencial retornou 401. Credencial de serviço provisionada (sem registrar token); drop-in systemd root:root 600 aplicado e processo recebeu duas variáveis STREAMMAX_. CLI real instalada e validada somente com dados sintéticos: `list-plans` (4 planos + 4 addons, catálogo operacional carregado), `resolve-lead` com replay (`isNew=false`), `get-trial` (6h/1x, sem cálculo de elegibilidade) e `quote` mensal + 1 tela (`amountMinor=5000`, R$50,00). Nenhuma cobrança, ativação ou mensagem real. |
| M5 | Não iniciado; issues #86–#89 a revalidar. |

## Correções ao plano original (decisões do Planner)

1. Colisão de marcos resolvida pela tabela de supersedência.
2. M1 é correção de conhecimento e exposição de adicionais, não “sincronizar” genericamente.
3. “Simular orçamento” significa **consultar cotação calculada pelo backend**; o bot nunca calcula valores financeiros. Invariante testável.
4. M4 possui gate de autorização explícita.
5. Critérios acrescentados: contagem de mensagens para provar dono único; invariante sem efeito real; evidência nomeada por marco; exceção técnica do trial como gap a verificar.

## Cronograma por dependência

| Ordem | Dependência | Justificativa |
|---|---|---|
| P → M1 (+M2a adicionais) | P define fontes e critérios | M1 e exposição de adicionais seguem juntos, pois addons são pré-requisito do orçamento. |
| M2 | M1/M2a | Ferramentas comerciais usam catálogo alinhado. |
| M3 | M2 | Jornadas dependem das ferramentas disponíveis. |
| M4 | M3 + autorização | Homologação somente após jornadas aprovadas e autorização explícita. |
| M5 | M4 | Limpeza e fechamento após substituição/homologação comprovadas. |

## Tasks

### P — Plano e critérios
- **Objetivo:** fixar escopo, sequência, fontes e aceite desta missão.
- **WORK_SCOPE:** este documento e uma entrada no CHANGELOG.
- **ACCEPTANCE_CRITERIA:** marcos sem colisão; estado, dependências, restrições e gates explícitos.
- **VALIDATION:** três gates Python e revisão de diff.
- **EVIDENCE:** este plano e CHANGELOG.
- **AUTHORIZATION:** documentação autorizada; sem efeito operacional.

### M1 — Conhecimento e catálogo
- **Objetivo:** sincronizar o OpenMausBot com `CATALOGO-COMERCIAL.md` V1.0, corrigindo knowledge, souls e skills; identificar cópias como derivadas e declarar a fonte canônica prevalente em divergência.
- **WORK_SCOPE:** conteúdo comercial e integração de addons na API/bot; remover wrapper sintético da skill `streammax-api`; preservar guardrails e alterações locais do usuário no repositório OpenMausBot.
- **ACCEPTANCE_CRITERIA:** planos, addons, trial, desconto e ressalvas coerentes em todas as cópias; nenhuma cópia derivada prevalece sobre o catálogo.
- **VALIDATION:** busca de valores/termos obsoletos e testes de contrato/API para addons.
- **EVIDENCE:** catálogo canônico, diffs das cópias derivadas e testes.
- **AUTHORIZATION:** alterações locais nos dois repositórios; sem operações externas.

### M2 — Ferramentas comerciais
- **Objetivo:** expor nove capacidades comerciais por interface do bot.
- **WORK_SCOPE:** estender API com rotas finas que deleguem a comandos/queries/adapter existentes; sem SQL direto nem regras financeiras no bot. Tenant vem da credencial; preservar `idempotencyKey`. Estender `bots/streammax/cli/streammax.mjs` somente com comandos indispensáveis e atualizar contrato.
- **ACCEPTANCE_CRITERIA:** cotação sempre calculada pelo backend; guardrails mantidos; nove capacidades cobertas; testes unitários e de contrato. A API nunca calcula preço; addons só são cobráveis após carga operacional; antes disso são referência com `executable:false`.
- **VALIDATION:** testes unitários/contrato e suíte de integração quando houver PostgreSQL descartável vazio.
- **EVIDENCE:** contrato, rotas e resultados de testes.
- **AUTHORIZATION:** somente implementação e validação local sintética; sem cobranças reais.

### M3 — Jornadas
- **Objetivo:** executar cinco jornadas multimensagem e verificar estado equivalente em API, banco e bot.
- **WORK_SCOPE:** J1–J5 e suítes cross-repo existentes; fixtures sintéticas.
- **ACCEPTANCE_CRITERIA:** estado consistente e contagem de mensagens comprova dono único; invariante explícita de ausência de efeitos reais.
- **VALIDATION:** testes de integração com banco descartável vazio.
- **EVIDENCE:** resultados J1–J5, estado e contagem de mensagens.
- **AUTHORIZATION:** proibido cobrar, ativar ou enviar mensagem real.

### M4 — Homologação staging (**EXECUTADO — homologação sintética**)
- **Objetivo:** homologar fluxo sintético no staging, somente após autorização explícita.
- **WORK_SCOPE:** confirmar host e marcador `.staging-revision = main@d776656`; confirmar alvo e recursos; nunca ler/imprimir valores de segredo; usar somente a variável de ambiente mínima em processo local. Executar `scripts/seed-approved-catalog.mjs --tenant-id <uuid> --dry-run`, verificar metadata e, somente com autorização, aplicar idempotentemente com `--apply` no tenant autorizado, sem cobrança/ativação. Credencial de serviço. S2 on com fluxo interno concorrente off; WAHA sem mensagens a clientes reais; Asaas Sandbox e fallback CINEVISION sem ativação externa; conversa sintética ponta a ponta sem duplicação, com contagem de mensagens.
- **ACCEPTANCE_CRITERIA:** pré-condições e autorização satisfeitas; evidência reproduzível, sem efeitos reais ou mensagens duplicadas.
- **VALIDATION:** readback sanitizado, contagem e smoke sintético, com rollback preservado.
- **EVIDENCE:** marcador, recursos confirmados, resultado do seed e trilha sintética sem segredos.
- **AUTHORIZATION:** execução autorizada para o host/recursos exatos nesta missão; não autoriza produção nem ações comerciais reais.

### M5 — Limpeza e fechamento técnico
- **Objetivo:** fechar somente após substituição comprovada, sem apagar histórico.
- **WORK_SCOPE:** manter migrations históricas; revalidar issues #86–#89; executar CI completa e registrar evidências e limitações.
- **ACCEPTANCE_CRITERIA:** nenhum código morto removido sem prova; issues revalidadas; gates pertinentes verdes; limitações declaradas.
- **VALIDATION:** CI completa e revisão de diff.
- **EVIDENCE:** resultados de CI, referências das issues e inventário do que foi preservado.
- **AUTHORIZATION:** sem piloto comercial; remoções irreversíveis dependem de confirmação específica.

## Restrições e limitações observadas

As suítes de integração completas não terminaram por timeout (600s); falhas parciais em `agent-model-failure` e `agent-shadow-approval` não foram confirmadas. Um teste de `outbox-worker` falhou por pré-condição de role global no cluster compartilhado; a tentativa com container isolado também não terminou. Esses resultados não invalidam os smokes sintéticos de M4, mas deixam a validação integral de integração pendente. **Não declarar M2/M3 validados por jornada integrada** sem execução completa em banco PostgreSQL descartável e vazio.

## Definition of Done da missão

- [ ] Fonte canônica, supersedência e marcos sem ambiguidade documentados.
- [ ] Catálogo e cópias do OpenMausBot alinhados; wrapper sintético removido preservando alterações locais.
- [ ] Nove capacidades expostas com tenant da credencial, idempotência preservada e cálculo financeiro no backend.
- [ ] Cinco jornadas multimensagem verificadas com estado equivalente e dono único comprovado.
- [ ] Nenhuma cobrança, ativação ou mensagem real executada nas validações.
- [x] M4 executado em staging com homologação sintética, sem efeitos reais; sem certificação de produção.
- [ ] M5 preserva migrations históricas, revalida #86–#89, executa CI e registra limites.
- [ ] Gates Python e evidências de cada marco registrados; nenhuma certificação de produção implícita.
