# E2E Sandbox Asaas — piloto staging (2026-11-04)

> Evidência sanitizada de teste autorizado em Sandbox. Sem segredos, sem IDs,
> sem e-mails, sem payloads de cobrança, sem tokens/hashes de webhook.

## Objetivo e escopo

- Objetivo: exercitar uma vez, em Sandbox, o caminho pedido → cobrança PIX →
  webhook → conciliação no staging Contabo, após corrigir a base pública de
  integrações que bloqueava o `webhook_ensure`.
- Escopo testado: um tenant de staging (Control Center StreamMax), um pedido
  sintético `NEW_SUBSCRIPTION` sobre o único plano de catálogo (`Monthly`,
  R$ 30/1 mês), uma cobrança PIX Sandbox com pagamento simulado no dashboard
  Asaas, e a entrega do webhook no endpoint do novo tenant.
- Fora de escopo (não executado): criação de assinatura a partir do pedido
  (`POST /v1/subscriptions/from-order`), fulfillment/ativação, reembolso,
  qualquer certificação ampla de webhooks, e qualquer ação em produção.

## Pré-condições e mudança mínima no host

- Staging canônico `/home/deploy/iptv-staging`, marcador `main@76515c3`
  verificado antes da mudança.
- Adicionada exatamente uma linha ao `deploy/staging/.env.staging` (arquivo
  só do host, modo 0600):
  `INTEGRATIONS_PUBLIC_BASE_URL=https://staging-api.synkroo.com.br`.
- Cópia de rollback preservada no host (`env-staging-bak-20261104-02`,
  modo 0600).
- Recriado somente o serviço `api` via compose canônico
  (`up -d --force-recreate api`, sem build/down); o migrate one-shot do
  compose reportou `applied=0 skipped=67 total=67`; API saudável, readiness
  HTTP 200 com banco ok. Nenhum outro serviço de longa duração foi alterado.
- Tenant StreamMax com Asaas `CONNECTED_READ_ONLY` (SANDBOX); teste de
  conexão read-only passou. `webhook_ensure` passou a configurar o webhook
  do novo tenant após o fix de env. Nenhuma chave de API foi alterada.

## Linha do tempo sanitizada (2026-11-04, sem IDs)

1. Pessoa sintética de CRM criada ("sandbox E2E", sem PII real).
2. Pedido `NEW_SUBSCRIPTION` criado via quote → submit sobre o plano `Monthly`.
3. Binding de cliente Asaas Sandbox provisionado para a pessoa sintética.
4. Uma cobrança PIX gerada para o pedido; pagamento simulado no dashboard
   Asaas Sandbox (nenhum dinheiro real).
5. Webhook `PAYMENT_RECEIVED` entregue ao novo endpoint do tenant: primeiro
   evento com HTTP 202; um reenvio autorizado pelo usuário depois, também
   HTTP 202 (2×202 somente no endpoint novo; uma cobrança/um pagamento/um
   pedido, sem exceções — distinto dos retries 404 legados abaixo).
6. Estado final conferido no Control Center: pedido `SETTLED`, uma cobrança
   `PAID`, um pagamento `CONFIRMED`, sem exceções de cobrança; página de
   assinaturas vazia (nenhuma assinatura criada, por desenho — o passo
   `from-order` não foi executado).
7. Adendo na mesma sessão (autorizado pelo usuário): somente o webhook legado
   Sandbox foi desativado (não excluído); o webhook novo permanece ativo.
   Nenhum item de fila foi removido, nenhum pagamento/evento adicional foi
   enviado após o único reenvio, sem mudança de identidade e sem produção.

## Resultados

- Pedido: `SETTLED`.
- Cobrança: uma, `PAID`.
- Pagamento: um, `CONFIRMED`.
- Exceções de cobrança: nenhuma.
- Assinaturas: nenhuma (passo não executado).
- Duplicidade: após o reenvio do evento, o Control Center manteve uma
  cobrança, um pagamento, pedido `SETTLED`, sem exceção — a entrega
  duplicada deste evento não duplicou o estado de domínio. Prova apenas
  este caminho Sandbox, não todos os casos de reorder/falha.
- Dados sintéticos não foram limpos.

## Achados laterais (não alterados)

- Logs Asaas read-only filtrados ao pagamento mostram retries HTTP 404 contra
  o endpoint legado de webhook com chave de tenant antiga, observados às
  10:33, 10:58 e 11:58 (horário do dashboard) após a desativação — retries
  já enfileirados persistiram após desativar, e não foram removidos (remoção
  não autorizada).
- Dashboard Asaas: webhook legado agora `Desativado` (não excluído) e webhook
  atual permanece `Ativado` com zero eventos penalizados; filas seguem 3
  pausadas e 2 configs penalizadas. Nenhum item de fila foi excluído.
- Infisical UI exibe a machine identity `iptv-api-staging` com papel amplo
  (`Admin Project`), mantido por escolha do usuário; o `webhook_ensure` + entrega bem-sucedidos provam que o
  caminho atual de leitura/escrita da API funcionou para este escopo, mas
  nenhum least-privilege foi aplicado.
- R2 exibia um conjunto novo de objetos de backup datado de ~02:00 UTC de
  2026-11-04; a evidência de restore isolado de 3 Nov está em
  `docs/10-operations/runbooks/backup-restore.md`. Cópia offline separada da
  chave privada segue não verificada/não documentada; backup de app DB segue
  sem backup válido conforme o closure.
- Além do único pagamento Sandbox autorizado e seu único reenvio de evento,
  a única mudança posterior autorizada foi desativar (não excluir) o webhook
  legado Sandbox; nenhuma entrada de fila foi excluída, nenhuma identidade
  foi alterada, e nada foi tocado em chaves de backup, CINEVISION, WAHA,
  produção ou outras integrações.

## Asserções testadas (este slice Sandbox)

1. `webhook_ensure` configura o webhook do novo tenant quando a base pública
   está correta — PASS.
2. Pedido sintético → PIX Sandbox → pagamento simulado → webhook 202 →
   pedido `SETTLED` / cobrança `PAID` / pagamento `CONFIRMED`, sem exceção —
   PASS (um caminho).
3. Reenvio do mesmo evento (202) não duplica estado de domínio — PASS (este
   evento; não generalizar).
4. Retries 404 contra endpoint legado coexistem sem quebrar o caminho atual —
   observado, não corrigido: a desativação do webhook legado não eliminou
   retries já enfileirados (10:33/10:58/11:58), e a fila antiga segue sem
   correção.

## Não testado / bloqueadores mantidos

- Criação de assinatura a partir do pedido, fulfillment/ativação, reembolsos.
- Certificação ampla de webhooks (reorder/falhas gerais) — não reivindicada.
- Least-privilege da identity Infisical, chave offline, backup válido de app
  DB e readback autorizado CINEVISION — seguem bloqueadores do closure.
- WAHA não está configurado no Control Center no momento, se a jornada
  completa de mensageria estiver em escopo.
- G07 diferido; F12 bloqueado, por política existente.

## Veredito (sem promoção de gate)

- Slice Sandbox de cobrança/webhook: **PASS** com legado 404 anotado.
- Nenhum status `MVP_OPERATIONAL_*`, `MVP-PILOT` ou linha da matriz de 35
  itens é promovido por este relatório. O closure mais amplo segue
  bloqueado nos itens acima.

## Referências de evidência

- Runbook executado: `docs/10-operations/runbooks/pilot-first-sale.md`
  (passos 1–4; passo 5 `from-order` não executado por desenho).
- Limites e vereditos vigentes:
  `docs/16-pilot-closure/MVP-OPERATIONAL-CLOSURE.md`
  (closure operacional 2026-11-03, sem promoção por este relatório).
- Evidência de restore isolado (3 Nov):
  `docs/10-operations/runbooks/backup-restore.md`.
- Estado de execução no host (compose/migrate/health) verificado em sessão;
  sem artefato novo além da linha de env e da cópia de rollback citadas.
