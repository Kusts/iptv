# MVP Operational Closure — StreamMax/Contabo

Data: 2026-11-03. Sem segredos, sem hash de conteúdo, sem IP/usuário/chave
privados, sem e-mails ou IDs de usuário.

## A. Escopo congelado

Escopo operacional interno single-tenant original do StreamMax (congelado,
sem ampliação para staging-only): gerenciar cliente; criar pedidos/vender
planos IPTV; cobrar via Asaas; confirmar/conciliar pagamento;
criar/gerenciar assinatura; ativação manual supervisionada; status; renovar;
suporte; recuperar operações interrompidas sem efeitos financeiros duplicados.

Exclusões: escrita automatizada CINEVISION; MK; Tenant Copilot completo;
campanhas sofisticadas/rede de revenda/recompensas de indicação; billing
SaaS/multi-tenancy comercial externa; Hatchet definitivo salvo alternativa
aprovada; Infisical Enterprise; white-label; novos canais; analytics
avançado; otimização de performance não provada.

MVP-PILOT e G01–G18 mantêm o significado existente e não são marcados como
concluídos. Nenhuma release tag, canary ou nova fase P8.

## B. Implementação

PR #122 merged em `main` no SHA `76515c319324cda98460de05b980e9aa3f3ae800`.
CI do candidato 8/8 PASS; workflow `41439104265` da main 4/4 PASS. Validação
local do candidato: 302 checks PASS; 55 testes renewal/billing/support
PASS (separados); gates de docs `validate_docs.py` OK, contratos 21, seed 5.
Reviewer e security review aprovaram código e docs. Sem cobranças Sandbox
repetidas nem chamadas reais a Asaas/CINEVISION; o túnel de staging existente
foi iniciado sem alteração de DNS.

Usuário autorizou explicitamente deletar/recriar o volume só-de-teste
`iptv-staging_pgdata`, aceitando a perda de todos os registros antigos de
teste P8.5/staging e sem restore de DB. Reset executado; fresh com
`applied=67 skipped=0 total=67`. Só o projeto de staging do candidato foi
alterado; nenhum vizinho/produção/DNS tocado. Pedido/pagamento/assinatura de
teste P8.5 antigos não existem mais no DB atual; o relatório segue como
evidência histórica somente; sem pagamento duplicado.

Owner fresh criado via registro isolado one-off (sem portas publicadas nem
túnel; registro público seguiu fechado); `tenant_owner`, não platform admin.
Novas credenciais sintéticas de teste em `.env.operator` local ignorado
(valores nunca incluídos). Seed mínimo só-de-catálogo autorizado e aplicado:
um produto, um plano mensal e um preço para o novo tenant; sem
clientes/pedidos/pagamentos/placeholder CINEVISION. Nenhuma cobrança real.
`.staging-revision` marca `main@76515c3` após smoke. Pós-reset:
API/web/outbox/túnel saudáveis; health/ready públicos 200, web 200,
registro público 403, login do novo owner 200. Túnel a partir do token
existente; sem mudança de DNS. Senha do worker vinda do valor de env
existente (não impressa); TCP SCRAM verificado; API/worker recriados e
saudáveis.

## C. Segurança

Incidente de segurança: um erro de comando anterior registrou prefixos
parciais dos papéis `iptv_app` e `outbox_worker` (sem valores completos);
usuário autorizou a rotação. Ambos foram rotacionados para valores novos e
independentes, com os campos de URL do env remoto atualizados, auth TCP
SCRAM verificada e API/worker recriados e saudáveis. Incidente adicional de
edição: a primeira substituição alterou temporariamente a linha owner
`DATABASE_URL` ao mirar `APP_DATABASE_URL`; detectado por diff e restaurado
da memória em processo antes de qualquer restart de serviço/migration;
verificação final do env mostrou só os campos pretendidos (URL APP e URL do
worker) alterados; API/worker seguiram saudáveis após a rotação. Distinto da
exposição anterior de prefixos parciais (já registrada, papéis rotacionados);
não se alega que nenhum segredo jamais tenha alcançado logs. Sem valores ou
prefixos aqui; nenhuma credencial de produção tocada. Sessões de auth e
linhas do usuário antigo removidas pelo reset autorizado do volume de teste;
login do novo owner funciona; nenhuma credencial antiga usada.

Recuperação Infisical por admin/e-mail humano segue bloqueada
(`emailConfigured=false`); `.env.staging` do host sem os quatro valores de
identidade de máquina `INFISICAL_*`, de modo que o adapter de segredos da
API segue noop e a leitura sintética de segredo não foi provada; sem upload
R2, sem chave de backup/restore. Distingue-se: o container live
`iptv-infisical` usa a tag de imagem `v0.165.16` e está healthy (status
Docker somente-leitura) — isso prova tag/saúde da imagem, não conectividade
de segredo da API. O `/api/status` público só informa `emailConfigured=false`
e não expõe versão da aplicação. Conta/recurso CINEVISION não confirmado;
sem ativação/readback. Não se alega leitura de segredo, recuperação de
admin, nem PASS em Asaas, Infisical ou CINEVISION.

## D. Entrega

Sem entrega atual de serviço verificada externamente: nenhum pedido,
pagamento, assinatura ou ativação novos nesta missão. O histórico do Addendum
4 do P8.5 (`PAID/CONFIRMED/SETTLED`, ledger balanceado, um
`PENDING_ACTIVATION` com fulfillment `HUMAN_REQUIRED`) é evidência passada,
não entrega atual — distingue-se do que o gate exige agora: reutilizar o
P8.5, verificar o estado atual de
pedido/cobrança/pagamento/assinatura/fulfillment, sem duplicata, ativar
somente via recurso de teste CINEVISION autorizado com externalRef seguro e
readback independente no provedor, com
auditoria/vínculo/pedido/pagamento/ledger consistentes. Atestação manual
sozinha não é PASS.

No tenant fresh, `provider.provider_accounts` está vazio; Asaas segue
`NOT_CONFIGURED`, webhook não assegurado. O vínculo de segredo Asaas
existente perdeu-se no reset autorizado do volume de teste; nenhum pagamento
foi repetido. Falta readback independente CINEVISION.

## E. Renovação

55/55 testes controlados de renovação/billing/support PASS em banco
descartável (renovação controlada, retry, idempotência, suporte,
conciliação) — distinguem-se explicitamente da renovação mensal comercial
real, observação futura do piloto, não deste gate de software. Fila de
outbox em runtime: modo `WORKER`, worker único ativo/saudável, fila vazia;
scheduler da API habilitado, drain legado desabilitado; nenhum processador
duplo. Antes do reset autorizado: geração 3, 20 `PUBLISHED`, zero
pendente/in-flight/stranded, sem worker em execução.

## F. Operação

Hostinger VPS desativada (usuário): Contabo é o único provedor; nunca tentar
a Hostinger de novo. Alvo real: `/home/deploy/iptv-staging` (marcador
atualizado para `main@76515c3` após smoke); `/home/deploy/iptv` ausente.
Ponteiro local `VPS_*` ainda é Hostinger; config Contabo pertence a outro
projeto; acesso pontual Contabo autorizado nesta tarefa. DB atual fresh:
67/67 aplicadas; stack API/web/outbox/túnel saudável com smoke atribuível
(health/ready e web 200, registro 403, login 200); só o projeto do candidato
alterado; vizinhos/DNS intocados; nenhuma escrita fora do staging. Sem
backup válido: só dump antigo sem criptografia, sem manifesto/hash/
procedência; chave de backup ausente; só tags `:local`. Outbox: worker único
ativo, fila vazia, sem processador duplo. Estado: deploy executado; HOLD
restante é integrações/segurança/entrega (Asaas, Infisical, CINEVISION) —
não mais drift de hash.

## G. Backlog

Backlog opcional não-bloqueante do review do PR (não executar sem decisão do
operador; priorizar P2/P3): drift OpenAPI-vs-Zod de `externalRef` em status
inválido; edge de adapter customizado `SUCCEEDED`-sem-ref fora da rota
manual normal. Também pendentes de decisão: backup válido com custódia de
chave; gates de segurança/CINEVISION; readback independente; renovação
mensal real no piloto. Exclusões de roadmap (seção A) mantidas separadas,
fora salvo reescopo explícito.

## H. Aceite

Matriz top-level (status em 2026-11-03; sub-evidência de teste não promove
gate; sem percentuais):

| Gate | Status | Critério completo + evidência |
| --- | --- | --- |
| `MVP_CODE_INTEGRATED` | `BLOCKED_EXTERNAL` | Critério: PR merged + regressão/DB-gated + CI verde no HEAD + deploy PINNED-COPY no staging correto com baseline/rollback/migrations verificados + smoke obrigatório (API/frontend healthy, signup fechado, auth, Infisical, Asaas CONNECTED/webhook ativo, assinatura/fulfillment sem regressão, scheduler/outbox com exatamente um processador). Evidência: PR #122 merged no SHA base; CI 8/8, main 4/4; 302 checks + 55 testes PASS; reviewer + security APPROVED; fresh 67/67 + smoke atribuível executados — porém Asaas + Infisical faltantes (adapter noop, leitura sintética não provada); sub-evidência não promove. |
| `MVP_OPERATIONAL_SECURITY` | `BLOCKED_EXTERNAL` | Critério: trocar credenciais temporárias comprometidas via recuperação aprovada; invalidar sessões antigas; antigas falham/novas funcionam; remover admin temporário; backup do PostgreSQL cifrado com AES-256-GCM (`platform.secret_values`, migration 068, `SECRETS_ENCRYPTION_KEY`), custódia separada do dump e restore isolado com chave correta/incorreta (PR #123), leitura sintética; sem edição de hash. Evidência: rotação autorizada executada (papéis rotacionados, SCRAM verificado, saudáveis); sem reset/revoke global além do reset de teste; `.env.staging` sem os quatro `INFISICAL_*` (adapter noop, leitura sintética não provada), R2 indisponível, `emailConfigured=false`; sem backup externo. `iptv-infisical` live em `v0.165.16` healthy prova tag/saúde da imagem, não conectividade de segredo da API; `/api/status` não expõe versão da aplicação. |
| `MVP_SERVICE_DELIVERY` | `BLOCKED_EXTERNAL` | Critério: reutilizar P8.5 + verificar estado atual pedido/cobrança/pagamento/assinatura/fulfillment; sem duplicata; ativação só via recurso de teste CINEVISION autorizado com externalRef seguro + readback independente; auditoria/vínculo/pedido/pagamento/ledger consistentes; atestação manual só não é PASS. Evidência: só histórico P8.5 (registros antigos removidos pelo reset); `provider_accounts` vazio, Asaas `NOT_CONFIGURED`; sem ativação autorizada nem readback. |
| `MVP_RENEWAL_AND_OPERATIONS` | `PASS` | Critério: renovação controlada (ciclo ativo, reter dias pagos, nova expiração/ciclo, sem duplicata), retries/webhook/idempotência, suporte (busca/ticket/atendimento), ledger/fila/isolamento finais; mensal real diferida ao piloto. Evidência: 55/55 controlados PASS; worker único ativo, fila vazia, scheduler habilitado, drain legado off, sem processador duplo. Mensal comercial real segue como observação futura do piloto, não deste gate. |

Status válidos: `PASS`/`FAIL`/`BLOCKED_EXTERNAL`/`NOT_RUN`.

## I. Veredito

Veredito: `MVP_OPERATIONAL_BLOCKED`. A documentação está na branch
`docs/mvp-streammax-contabo-closure-v2`, local e não publicada; a candidata
está implantada no staging Contabo. Próximas ações do operador para os gates
bloqueados: configurar a identidade de máquina Infisical e comprovar backup/
restore offsite; reconfigurar Asaas Sandbox/webhook para o novo tenant sem
cobrança; fornecer recurso CINEVISION de teste autorizado e obter readback;
depois reexecutar os smokes correspondentes. O reset de volume de teste já
autorizado foi executado; os registros P8.5 antigos permanecem só como
evidência histórica, sem cobrança repetida. A renovação mensal comercial real
é observação futura do piloto, separada — não pré-requisito destes gates.
Promover um gate exige critério completo + evidência atribuível.
