# StreamMax — estado operacional do MVP (15/11/2026)

> Snapshot datado de evidências. O staging está em `main@89b3f3a`, marcador
> `.staging-revision` = `main@89b3f3a`. Este documento não certifica integrações
> live, nem altera os critérios do [baseline](../15-implementation-baseline/01-product-and-mvp.md).
> As evidências dos quatro gates foram coletadas em `main@fc794f4`; o redeploy posterior para `main@89b3f3a` trouxe apenas documentação e o vínculo opcional ticket↔cliente, verificado em staging.

## Gates e marco geral

| Gate/marco | Estado em 15/11/2026 | Evidência / limite |
|---|---|---|
| `MVP_CODE_INTEGRATED` | **PASS (15/11)** | Deploy `main@fc794f4`; migrate sem pendências; smoke local/público; jornada comercial sintética e demais evidências abaixo. |
| `MVP_OPERATIONAL_SECURITY` | **PASS (15/11)** | Backup cifrado com chave em custódia separada, restore isolado 155/155, invalidação de sessão, ausência de admin temporário e leitura sintética de segredo. |
| `MVP_SERVICE_DELIVERY` | **PASS (15/11)** | Ativação manual supervisionada de linha gratuita de teste CINEVISION (ID `214790811`) e readback independente diretamente no painel do fornecedor. Evidência da pós-condição na plataforma é declaração do operador; verificação independente não foi feita pela API. |
| `MVP_RENEWAL_AND_OPERATIONS` | **PASS (15/11)** | Renovação, replay, suporte e processador outbox único comprovados. |
| `MVP_STREAMMAX_OPERATIONAL` | **PASS (15/11)** | 4/4 gates PASS; entrega supervisionada vinculada à assinatura e readback independente no painel. Escrita automatizada no fornecedor está fora do escopo; ressalva de evidência declarativa da pós-condição na plataforma. |

## Evidências

### Código, deploy e operação

- Staging redeployado em `main@89b3f3a` (fast-forward verificado); rollback
  por imagens `rollback-fc794f4` preservado; marcador `.staging-revision`
  = `main@89b3f3a`.
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

- Fornecedor CINEVISION (painel autenticado do operador): linha de teste
  gratuita criada manualmente, ID `214790811`, plano `TESTE COMPLETO 6H`,
  categoria Teste, status Ativo, expira 15/11/2026 16:06, 1 conexão,
  R$ 0,00 e 0 créditos debitados. Readback independente diretamente no painel
  confirmou a linha ativa com o mesmo ID.
- Tenant sintético: pedido `01a1df55-d9ef-713e-a015-dc497a64949e`
  `SETTLED` (R$ 10,00), charge `01a1df56-27c0-70bb-bdc2-a4971a2aee60`
  `PAID`, pagamento `01a1df56-8877-77d5-9a69-742d8c043c79` `CONFIRMED`,
  assinatura `01a1df56-c3a6-7154-aa5f-ba24e5937919` `ACTIVE` com
  `external_ref=214790811`; operação
  `01a1df56-c5a9-7081-8d41-3eedce3ac7cb` `HUMAN_REQUIRED → SUCCEEDED`
  (`MANUAL`, adapter `manual-v1`); evidência `ACTIVATION_POSTCONDITION`
  `01a1df57-9801-766c-a2f3-78f6785c65ab`.
- Ledger: 1 `ORDER_SETTLEMENT` e 1 `PAYMENT_CONFIRMATION`, cada qual com
  2 entradas balanceadas de 1000 minor units. Replay da resolução com a mesma
  idempotency key retornou `201 SUCCEEDED` na mesma operação; total de
  operações permaneceu 3, sem duplicidade.
- Nenhuma escrita no fornecedor foi feita pela API:
  `ManualProviderOpsAdapter` retorna `MANUAL` sem chamada externa. A evidência
  de pós-condição na plataforma é declaração do operador sobre o readback;
  a verificação independente foi feita no painel do fornecedor, não pela API.

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

## Escopo e próximo passo

`MVP_STREAMMAX_OPERATIONAL` é o marco operacional interno single-tenant,
condicionado aos quatro gates acima. Não declara concluídos `MVP-PILOT`
(escopo de piloto) nem `MVP-SAAS` (produto SaaS multi-tenant); são escopos
distintos e não promovidos por este snapshot.

Próxima ação: manter esta evidência, repetir o ciclo na próxima renovação real
(`MVP-PILOT`) e revisar a linha de teste, que expira em 6h e não debitou
créditos. O tenant e o operador sintéticos permanecem para evidência.
