# P8.6 — Fechamento operacional, segurança e primeiro rehearsal

- Data: 2026-10-31
- Base de código: `main@be8f5504f52ee28952150baee17a0e91d30274bf`
- PR documental #117: `b8f202a45d874893675a8657fc1ff97c80879cf7` (aberta, não mergeada)
- Branch de implementação: `fix/p8-6-integrations`

## Veredito executivo

**NO-GO para canary autorizado e para declarar P8 concluído.** O resultado
financeiro do primeiro rehearsal permanece histórico conforme o relatório P8.5;
nenhuma cobrança, pagamento, webhook ou reconciliação financeira foi repetida.

As correções locais avançaram, mas a rotação das credenciais temporárias e a
recuperação externa do Infisical continuam bloqueadas por ação do operador. O
fulfillment CINEVISION não foi reconsultado nem executado e não foi marcado
como entregue. Nenhum gate é promovido sem evidência própria.

## A. Credenciais temporárias — `TEMPORARY_CREDENTIALS_SECURED`

**BLOCKED — P0.** As credenciais humanas temporárias foram tratadas como
comprometidas. Nenhuma senha foi lida, usada para login, impressa ou registrada;
nenhuma senha, sessão ou privilégio foi rotacionado ou revogado nesta sessão.

Evidência:

- StreamMax implementa logout apenas da sessão corrente. A API não expõe
  endpoint de troca de senha nem de revogação global. A sessão e o estado
  `is_platform_admin` vêm do banco; não foram alterados.
- Na versão Infisical `v0.165.16` pesquisada, a troca de senha self-service
  exige a senha antiga e revoga as sessões; recovery por e-mail depende de SMTP.
  O endpoint público de status respondeu 200 e reportou `emailConfigured=false`.
  Não foi identificada rota suportada de reset de senha ou revogação das sessões
  de outro usuário por admin.
- O operador escolheu recovery externo aprovado, mas o procedimento independente
  ainda não foi disponibilizado. Não se usou a senha exposta como mecanismo de
  acesso nem se improvisou escrita direta no banco.

Para encerrar o gate, o operador deve disponibilizar o procedimento externo
aprovado sem enviar valores secretos: trocar as senhas por canal seguro, revogar
as sessões antigas pelo mecanismo de cada produto, confirmar que a sessão antiga
falha e a nova funciona. Se a conta StreamMax tiver privilégio temporário de
plataforma, confirmar que ele foi removido e que o acesso administrativo é
negado. Tokens de machine identity são distintos das sessões humanas e também
precisam de inventário/rotação próprios.

## B. Recuperação Infisical — `INFISICAL_RECOVERY_READY`

**BLOCKED.** O endpoint de status do Infisical respondeu 200; isso não prova
leitura de segredo, backup recuperável ou restauração. A `ENCRYPTION_KEY` não
foi lida, copiada, transportada ou rotacionada; não há evidência de escrow
externo nem de restore do banco Infisical.

Evidência local:

- O Compose fixa Infisical `v0.165.16` com digest; a versão efetivamente
  executada no host não foi verificada.
- O template `.env.infisical.example` contém somente placeholders. O runbook
  registra os nomes dos campos necessários sem valores: `SITE_URL`,
  `ENCRYPTION_KEY`, `AUTH_SECRET`, `INFISICAL_POSTGRES_DB`,
  `INFISICAL_POSTGRES_USER` e `INFISICAL_POSTGRES_PASSWORD`. O nome da variável
  PostgreSQL foi alinhado ao Compose e `docker compose config --quiet` passou
  usando somente placeholders.
- O runbook agora distingue snapshot SQL local em claro de backup DR. O
  repositório tem `scripts/backup-dr.sh`/`backup-crypto.mjs` para dump
  criptografado AES-256-GCM, manifest/hash e cópia S3 compatível. A chave do
  arquivo de backup é distinta da `ENCRYPTION_KEY` e deve ficar fora da VPS e
  separada do arquivo criptografado.
- Foi criado, com autorização explícita, o bucket R2 dedicado
  `iptv-infisical-backups`. Verificações read-only confirmaram `r2.dev`
  desabilitado e nenhum domínio customizado. Nenhum objeto foi enviado e nenhum
  token S3 foi criado; o operador escolheu criar token limitado ao bucket.
- O `backup-dr.sh drill` valida o schema IPTV, não o schema Infisical. Não houve
  backup externo nem restore isolado. O gate exige cópia off-VPS criptografada,
  verificação de integridade e smoke em stack descartável isolada, com o mesmo
  digest/chaves originais e leitura de um segredo sintético sem imprimir valor.

Pendências do operador: disponibilizar o token R2 bucket-scoped no ambiente
seguro; definir custódia separada da chave de backup e da `ENCRYPTION_KEY`; obter
um dump autorizado sem expor o conteúdo; executar cópia offsite e restore
Infisical isolado. O nome do bucket não autoriza upload por si só.

## C. PR documental #117 — `P85_DOCUMENTATION_MERGED`

**BLOCKED — não mergeada.** A branch pública foi reescrita, com autorização do
operador, para um único commit sanitizado sobre o `main` observado:
`b8f202a45d874893675a8657fc1ff97c80879cf7` (parent
`be8f5504f52ee28952150baee17a0e91d30274bf`). O diff líquido contém somente
`evidence/p8-5-public-routing-and-rehearsal/report.md`.

Reviewers independentes aprovaram a sanitização e a coerência dos addenda:
identificadores de cliente/transação/conta, e-mails e topologia acionável foram
removidos; o total não verificável de 297 requests foi retirado. Os checks
obrigatórios da CI ficaram verdes e a revisão de conteúdo/safety foi aprovada.
Ainda não há garantia de remoção de objetos órfãos, notificações ou cópias/forks
do conteúdo anterior. A PR permaneceu aberta por causa do gate P0.

## D. Fulfillment CINEVISION — `SUPERVISED_FULFILLMENT_VERIFIED`

**BLOCKED — `FULFILLMENT_PENDING_OPERATOR`.** O último estado no relatório P8.5
era `HUMAN_REQUIRED`; esse estado não foi reconsultado nesta sessão. Não houve
acesso autenticado à operação/assinatura, ativação no fornecedor ou chamada ao
endpoint de resolução. O código desta branch não foi implantado no staging.

Correção candidata no fluxo manual: `subscription.provision` com `SUCCEEDED`
exige `externalRef` seguro; o valor fica no `external_ref` da operação e cria
binding para a assinatura. A mudança terminal usa CAS no status observado; um
concorrente perdedor não cria attempt/evento/binding. A referência é separada
da nota e valores com formato de URL/segredo são recusados. **Isso continua
sendo uma declaração manual do operador:** a API valida apenas o formato,
persiste e vincula o ID informado, mas não consulta nem verifica a referência no
fornecedor. Portanto o resultado não é prova independente de entrega e não
encerra `SUPERVISED_FULFILLMENT_VERIFIED`. Operações `secret-required-v1`
continuam sem resolução manual; só readback conclusivo pode terminalizá-las.

Ao retomar: verificar estado atual de pedido/cobrança/pagamento/assinatura/
operação, ambiente autorizado, ausência de binding/resolução prévia e
proveniência do adapter. Confirmar a ativação no painel antes de escolher
`SUCCEEDED`; registrar somente o ID externo seguro, sem credenciais. Depois,
validar assinatura, binding, auditoria e ausência de duplicados. Se a operação
for `secret-required-v1`, parar e manter `HUMAN_REQUIRED` até readback
conclusivo. Nenhum teste ou serviço real foi ativado nesta sessão.

## E. Débitos técnicos

### `INFISICAL_FOLDER_AUTOMATION`

Implementação candidata em `packages/secrets`: `putSecret` deriva o caminho
permitido apenas do target validado, cria a pasta via API v2 e confirma
resultados de duplicata/race por listagem não recursiva do parent exato. Na
v0.165.16, filhos diretos retornam `id`, `envId` e `name`, sem `path` ou
`relativePath`; somente o nome exato sob o parent enviado confirma a pasta.
Respostas com forma recursiva, caminhos incompatíveis ou sem confirmação falham
fechado antes do envio dos bytes do segredo. Os reviews independentes de código,
segurança e testes aprovaram a mudança. A identidade machine precisa de
permissões de leitura/criação de folder no parent e permissões necessárias para
ler/escrever/remover secrets no namespace permitido; não foi concedido acesso
global. Nenhuma chamada real foi feita; resta executar a integração PostgreSQL
DB-gated e confirmar permissões efetivas no Infisical.

### `ASAAS_ERRORS_REFINED`

Implementação candidata: erros tipados retêm etapa `list/create/update` e
códigos internos sanitizados. O envelope público existente permanece: falhas
de precondição em 409, indisponibilidade/contrato malformado em 503. A
documentação oficial consultada declara lista vazia como 200 com `data: []`;
404 na coleção de webhooks não é documentado. O probe agora falha fechado como
`PROVIDER_CONTRACT_MISMATCH`, sem converter `customers → 200` em falso sucesso.
UI recebe instrução para revisar ambiente/contrato. Nenhuma chamada Asaas ou
ensaio financeiro foi feito. Os reviews independentes de código, segurança e
testes aprovaram esta mudança de tratamento de erro.

### `MANUAL_FULFILLMENT_EXTERNAL_REFERENCE`

Implementação candidata em API, OpenAPI e UI: resultado manual de sucesso exige
referência segura, persistida e vinculada à assinatura; o campo aparece apenas
no cenário aplicável, é obrigatório e a confirmação começa sem desfecho
selecionado. A UI e o contrato explicitam que é uma declaração do operador, não
readback; o ID externo não é validado no fornecedor. Reviews independentes
aprovaram o escopo como workflow de atestação manual, com risco residual de
erro/falsidade do resolvedor autorizado. A mudança não constitui prova
independente nem fecha o gate de fulfillment verificado. **Integração PostgreSQL
DB-gated pendente.**

## F. Regressão de staging — `STAGING_REGRESSION_PASS`

**BLOCKED / parcial.** Foram feitas somente leituras HTTP públicas:

- `/v1/health` → 200 e `/v1/health/ready` → 200 com banco `ok`.
- O health atual reportou `scheduler: enabled`, divergente do registro P8.5
  anterior. Não foi alterado; o operador precisa confirmar se é intencional.
- `/api/status` do Infisical → 200, mas não prova acesso a segredo e reportou
  SMTP não configurado.
- Cadastro público, conectores, webhook Asaas, logs e reconciliação financeira
  não foram reconsultados. Nenhum POST foi usado como sonda. Os resultados P8.5
  permanecem históricos, não evidência de estado corrente.

## G. Validação local

- `pnpm --filter @iptv/secrets test`: 47/47; `pnpm --filter @iptv/api test -- test/integrations-webhook-ensure.integration.test.ts test/asaas-webhook-urls.unit.test.ts test/asaas-hosts-parity.unit.test.ts test/provider-secret-gate.unit.test.ts test/subscription-fulfillment.integration.test.ts`: 59 passaram, 23 ignorados por dependência de banco; `pnpm --filter @iptv/web test -- test/flows.test.tsx test/integrations-hub.test.tsx`: 112/112.
- Typecheck e lint passaram para `@iptv/api`, `@iptv/web` e `@iptv/secrets`. `pnpm build`: 12/12 tasks. O build em Windows emitiu aviso não fatal de nome longo de link; o build terminou com exit 0.
- `python scripts/validate_docs.py`: passou; `python tests/contracts/test_contracts.py`: 21/21; `python tests/contracts/test_seed_contract.py`: 5/5.
- `docker compose config --quiet` passou usando somente placeholders num arquivo temporário ignorado, removido após a checagem. `TEST_DATABASE_URL` estava ausente; nenhum banco foi criado ou modificado.
- Nenhum teste chamou Asaas, Infisical ou CINEVISION reais; nenhum rehearsal financeiro foi repetido.

## Riscos residuais e gates

- A identidade Infisical ampla por limitação de licença, registrada em P8.5,
  continua sendo risco residual; guardas de namespace e identidade separada do
  Browser Worker são compensações, não equivalência a least privilege.
- Não há prova de backup Infisical offsite ou restore; não houve transporte de
  chave para fora da VPS.
- Não há confirmação externa de ativação CINEVISION; `HUMAN_REQUIRED` não
  equivale a entregue.
- O encerramento de P8 ainda depende de renovação, métricas, incidentes e demais
  gates operacionais. Nenhum `CERTIFIED` foi declarado.

| Gate | Estado em 2026-10-31 |
|---|---|
| `TEMPORARY_CREDENTIALS_SECURED` | **BLOCKED — P0, recovery externo pendente** |
| `INFISICAL_RECOVERY_READY` | **BLOCKED — upload e restore não provados** |
| `P85_DOCUMENTATION_MERGED` | **BLOCKED — PR #117 aberta, não mergeada** |
| `SUPERVISED_FULFILLMENT_VERIFIED` | **BLOCKED — operador/fornecedor** |
| `INFISICAL_FOLDER_AUTOMATION` | **Candidato — unit/reviews verdes; integração PostgreSQL e grants efetivos pendentes** |
| `ASAAS_ERRORS_REFINED` | **Candidato — testes/reviews verdes; integração PostgreSQL DB-gated pendente** |
| `MANUAL_FULFILLMENT_EXTERNAL_REFERENCE` | **Candidato — atestação manual explícita aprovada; PostgreSQL DB-gated pendente; não prova entrega** |
| `STAGING_REGRESSION_PASS` | **BLOCKED — probes de health parciais** |

**Recomendação: NO-GO para `PILOT_READY_FOR_AUTHORIZED_CANARY`.** Não declarar
`FIRST_LIVE_SALE_VERIFIED`, `PILOT_OPERATION_COMPLETE` ou `CERTIFIED`, e não
repetir o rehearsal financeiro aprovado.
