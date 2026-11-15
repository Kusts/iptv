# StreamMax — estado operacional do MVP (15/11/2026)

> Snapshot datado de evidências. O staging está em `main@fc794f4`, marcador
> `.staging-revision` = `main@fc794f4`. Este documento não certifica integrações
> live, nem altera os critérios do [baseline](../15-implementation-baseline/01-product-and-mvp.md).

## Gates e marco geral

| Gate/marco | Estado em 15/11/2026 | Evidência / limite |
|---|---|---|
| `MVP_CODE_INTEGRATED` | **PASS (15/11)** | Deploy `main@fc794f4`; migrate sem pendências; smoke local/público; jornada comercial sintética e demais evidências abaixo. |
| `MVP_OPERATIONAL_SECURITY` | **PASS (15/11)** | Backup cifrado com chave em custódia separada, restore isolado 155/155, invalidação de sessão, ausência de admin temporário e leitura sintética de segredo. |
| `MVP_SERVICE_DELIVERY` | **BLOCKED_EXTERNAL** | Credenciais CINEVISION existentes, porém a leitura real retorna `CHALLENGE_DETECTED`; nenhuma ativação/readback. Resolução exige sessão supervisionada autorizada. |
| `MVP_RENEWAL_AND_OPERATIONS` | **PASS (15/11)** | Renovação, replay, suporte e processador outbox único comprovados. |
| `MVP_STREAMMAX_OPERATIONAL` | **BLOCKED** | 3/4 gates PASS; falta apenas evidência externa de entrega de serviço. |

## Evidências

### Código, deploy e operação

- Staging deployado em `main@fc794f4` (fast-forward verificado); imagens
  tagueadas `main-27c2527` e `rollback-b46cec7`; marcador `.staging-revision`
  = `main@fc794f4`.
- `migrate`: `applied=0 skipped=69 total=69`; nenhuma migration pendente,
  sem reset. PostgreSQL 17.11; 69/69 migrations.
- Smoke: `/v1/health`, `/v1/health/ready` e web 200 (local e público);
  `POST /v1/auth/register` público = 403 `REGISTER_CLOSED`.
- Outbox tem exatamente um processador (`iptv-staging-outbox-worker`,
  id `staging-outbox-1`); API com `LEGACY_OUTBOX_DRAIN_ENABLED=0` e log
  “skipping legacy outbox drain”.
- Rollback de aplicação por imagens tagueadas e recuperação do banco pelo
  dump disponível; não existe container PostgreSQL legado.

### Segurança e recuperação

- RLS em 139 de 155 tabelas; `FORCE RLS` 0; `iptv_app` com SELECT em
  150/155 (negado nos 5 objetos internos de outbox/migration).
- `platform.outbox_runtime_control` e `_transitions` pertencem a
  `outbox_executor` e negam SELECT a `iptv_owner`/`iptv_app`/`outbox_worker`
  (menor privilégio).
- Dump plano 10.511.507 bytes (`sha256 7eaa3860…`, 1.758 entradas de TOC);
  arquivo cifrado 10.514.582 bytes (`sha256 2fcce5f0…`), cópia off-host.
  Chave de backup movida para custódia separada do operador e removida do host.
- Drill: backup novo → restore em container descartável `postgres:17` →
  **155/155 tabelas com contagens idênticas (diverge=0)**. Paridade estrutural:
  155 tabelas / 139 RLS / 0 FORCE / 2 owners divergentes / extensões
  `pgcrypto,plpgsql`.
- Logout invalida sessão (401) e novo login funciona (200). Operador sintético
  é `tenant_owner` do próprio tenant, sem papel de plataforma/admin global.
  Segredo sintético cifrado (ciphertext 87 chars, valor em claro ausente);
  teste de integração retornou `INVALID_CREDENTIALS` (prova de leitura/uso,
  sem erro de decifra).

### Jornada comercial sintética

- Dados sintéticos, Asaas Sandbox: pedido → cobrança → `SETTLED`; pagamento
  `CONFIRMED`; ledger balanceado (`PAYMENT_CONFIRMATION`, `ORDER_SETTLEMENT`,
  2 entradas cada); replay de webhook `deduped:true`.
- Assinatura `PENDING_ACTIVATION → HUMAN_REQUIRED → ACTIVE` (com
  `externalRef` sintético; repetição `already:true`).
- Renovação plano DAY/2: extensão exata de +2 dias (17/11 → 19/11), 1 ciclo
  novo, replay `already:true`, sem duplicidade. Ticket
  `NEW → TRIAGING → IN_PROGRESS → RESOLVED`.
- A liquidação usou **evento sandbox simulado**, sem pagamento externo real.

### Entrega de serviço

- Tenant sintético: configure CINEVISION em `SANDBOX` retornou HTTP 201
  (binding v2); teste read-only (`read-identity` + `list-servers`) executou
  por 59,2 s e retornou `CHALLENGE_DETECTED`. Zero operações de escrita no
  fornecedor; tenant operacional intocado. Histórico operacional: 07/11
  `CONNECTED_READ_ONLY`, 08/11 `CHALLENGE_DETECTED`.

### Webhook Asaas

- Conta tem 7 registros; existe registro `enabled:true, interrupted:false`
  correspondente a canal `ASAAS` ATIVO no host
  `staging-api.synkroo.com.br/v1/webhooks/asaas/***`, eventos
  `PAYMENT_RECEIVED|PAYMENT_OVERDUE|PAYMENT_REFUNDED`.
- Tenant sintético da jornada não tem registro próprio (esperado); handler
  devolve 404 para `tenantKey` desconhecido.

## Gaps conhecidos

- `support.support_tickets.customer_id` é gravado como `NULL` fixo
  (`apps/api/src/support/support-store.ts`); vínculo só indireto via `person_id`.
- OpenAPI desatualizado em pedidos/cobranças: issue #136; não corrigido nesta entrega.
- Tenant sintético da jornada não tem registro próprio de webhook Asaas
  (esperado); o canal ativo existente é de outro tenant.
- Evento que liquidou o E2E foi simulado no Sandbox, sem pagamento externo real.
- Adapter CINEVISION simulado; não houve ativação/readback real.

## Escopo e próximo passo

`MVP_STREAMMAX_OPERATIONAL` é o marco operacional interno single-tenant,
condicionado aos quatro gates acima. Não declara concluídos `MVP-PILOT`
(escopo de piloto) nem `MVP-SAAS` (produto SaaS multi-tenant); são escopos
distintos e não promovidos por este snapshot.

Próxima ação mínima: resolver o challenge em sessão supervisionada autorizada
e então executar leitura e, se autorizado, **UMA** ativação controlada com
readback independente. Até lá,
`MVP_SERVICE_DELIVERY=BLOCKED_EXTERNAL` e o marco geral permanece BLOCKED.
