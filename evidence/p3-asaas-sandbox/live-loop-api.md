# LOOP-VIA-API — Golden Loop Sandbox via nossa API (NUNCA produção, NUNCA lane piloto)

- TASK_ID: LOOP-VIA-API
- Data (UTC): 2026-10-08
- Base: main@78dc78a (inclui #30 binding; sem alterações de código-fonte; `apps/api/dist` reconstruído localmente via `pnpm --filter @iptv/api build` — artefato gitignored, `git status` limpo exceto este arquivo; sem commit/push)
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (scripts em `%TEMP%\opencode\iptv-loopapi`, fora do repo; só presença/host/vereditos impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer chamada (qualquer outro host abortaria com BLOCKED e zero chamadas);
  zero segredos em outputs/arquivos (token de sessão, `ASAAS_API_KEY` e `webhook_secret` nunca impressos nem persistidos no repo);
  lane piloto (`iptv-pilot`, :3200/:3201) NUNCA tocada — verificada apenas via leitura (`docker ps`/`docker compose ls`);
  produção NUNCA tocada.

## Lane scratch descartável (`-p iptv-loopapi`)

- Compose próprio em `%TEMP%` (fora do repo): só `postgres:17-alpine` em `127.0.0.1:55434`, projeto `iptv-loopapi`, volume próprio.
- Migrations: 60/60 aplicadas (`iptv-migrate: applied=60 skipped=0`) contra o banco scratch.
- API: `apps/api/dist` reconstruído (o `dist` anterior NÃO continha `POST /v1/billing-customers/provision` — prova de staleness: route-map sem a rota; após rebuild a rota aparece no boot-map) e servida em `:3301` com `DATABASE_URL` do scratch + `ASAAS_ADAPTER=real` (do `.env`, só presença afirmada) — `GET /v1/health/ready → {database:ok}`.
- Portas: 3300/3301 e 55434 livres antes (staging :3000/:3001, cutover :3100/:3101, pilot :3200/:3201 intactos).

## Tabela passo:veredito (via NOSSA API na scratch lane, `ASAAS_ADAPTER=real`)

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Gate 0 — afirmar `api-sandbox.asaas.com` antes de qualquer chamada | PASS | `loopapi-env-check.cjs` (parse do `.env` em-processo) → `{adapter:"real", keyPresent:true, keyShape:"sandbox-shaped(redacted)", host:"api-sandbox.asaas.com", verdict:"SANDBOX_OFFICIAL"}` |
| 1. Registrar usuário/tenant descartável → person | PASS | `POST /v1/auth/register → 201` (tenant `01a11cc9-…`, user `01a11cc9-…`, `tokenPresent:true`); `GET /v1/auth/session → 200` (TCR obtido; header `x-tenant-context-revision` exigido — sem ele, `409 TENANT_CONTEXT_CONFLICT`); `POST /v1/crm/persons → 201` (person `01a11cc9-…`) |
| Seed de catálogo (lane descartável) | PASS | `catalog.products/plans/prices` via SQL direto no scratch: plano `98c8f0b7-…`, preço `500` BRL |
| 2a. Order (quote → submit) | PASS | `POST /v1/orders/quote → 201` (order `01a11cc9-…`, net `500`); `POST /v1/orders/:id/submit → 201` (`status:AWAITING_PAYMENT`) |
| 2b. Charge SEM binding → `precondition_failed` esperado | PASS | `POST /v1/charges → 409 {code:PRECONDITION_FAILED}` ("no Asaas customer binding for person …; run billing.customer_provision first") — fail-closed antes de qualquer linha de charge, sem chamada ao provider |
| 2c. Provision binding (`POST /v1/billing-customers/provision`, sem `document` → sandbox resolve a constante de teste documentada) | PASS | `→ 201 {provisioned:true, providerCustomerId: cus_…}` (binding `cus_000009390786`) |
| 3. Order → charge (auto-resolve binding) | PASS | `POST /v1/charges → 201 {status:PROCESSING, providerChargeId: pay_…}` (charge `01a11cc9-…`, `pay_hhnybloyqkj2072a`, BRL 5.00, vencimento D+1 — pagamento REAL criado no sandbox) |
| 4a. Simular pagamento (`receiveInCash`) | PASS-com-ressalva | `POST /payments/{id}/receiveInCash {paymentDate, value:5.0, notifyCustomer:false} → 200`; `GET /payments/{id} → PENDING → RECEIVED_IN_CASH, value 5`. Achado: sem `value` no body o provider recusa (`400 invalid_object`: "valor mínimo … R$ 1,00") — o DTO oficial (`PaymentReceiveInCashRequestDTO`) confirma `value` como campo esperado. **Ressalva**: semântica de recebimento em dinheiro, NÃO liquidação PIX (igual live-b1) |
| 4b. Webhook via nossa API + duplicate replay | PASS | Canal `billing.tenant_channels` inserido via SQL no scratch (tenantKey `loopapi-muzvjegf`, segredo aleatório em TEMP, nunca no repo). `POST /v1/webhooks/asaas/:tenantKey {PAYMENT_RECEIVED, pay_…, value 5.0 BRL} → 202 {accepted:true, deduped:false}` (confirmou inline); replay idêntico → `202 {accepted:true, deduped:true}` (dedupe por `(tenant, asaas, event id)`) |
| 4c. Reconcile | PASS-por-construção | `POST /v1/charges/:id/reconcile → 409 PRECONDITION_FAILED "charge is PAID; reconcile requires PROCESSING"` — o webhook já havia confirmado; o reconcile recusou em vez de duplicar o efeito (exactly-once provado pelo caminho negativo) |
| 4d. Payment PAID + ledger balanceado + 1 efeito | PASS | `GET /v1/payments → 1 payment CONFIRMED 500 BRL`; `GET /v1/charges → PAID (paid_at setado)`; `GET /v1/orders/:id → SETTLED (settled 500)`; SQL: `PAYMENT_CONFIRMATION` (2 entries, balanced) + `ORDER_SETTLEMENT` (2 entries, balanced), `ledgerBalanced:true`, `exceptions:[]`, inbox `1 PROCESSED` (só a 1ª entrega; o replay não criou linha) |
| 5. PARAR antes do refund | CUMPRIDO | Nenhum `refund.request/execute` chamado; nenhum `DELETE` no sandbox (pagamento + customer INTENCIONALMENTE vivos p/ o próximo item do operador); lane DB será destruída no cleanup, ids de retomada abaixo |

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\loopapi-env-check.cjs` → `SANDBOX_OFFICIAL` (sem segredos).
2. `docker compose -p iptv-loopapi -f %TEMP%\opencode\iptv-loopapi\docker-compose.loopapi.yml up -d postgres` → `iptv-loopapi-postgres Up (healthy)` em `127.0.0.1:55434`.
3. `node packages/database/dist/bin/iptv-migrate.js` (com `DATABASE_URL` do scratch) → `applied=60 skipped=0`.
4. `pnpm --filter @iptv/api build` → exit 0; `git status` limpo (dist é gitignored).
5. API em `:3301` (processo local, env do scratch) → boot-map contém `{/v1/billing-customers/provision, POST}`; `/v1/health/ready → ok`.
6. `node %TEMP%\opencode\iptv-loopapi\loopapi-driver.cjs A` → register/person/quote/submit PASS; charge-sem-binding `409 PRECONDITION_FAILED`; provision `201 cus_…`; charge `201 PROCESSING pay_…`.
7. `… driver.cjs B` (gate sandbox + `receiveInCash` + readback) → `200` + `RECEIVED_IN_CASH` (após incluir `value:5.0`, cf. DTO oficial).
8. `… driver.cjs C` (canal + webhook ×2) → `202 deduped:false` + `202 deduped:true`.
9. `… driver.cjs D` (reconcile + verificação) → reconcile `409` (já PAID); payment CONFIRMED; order SETTLED; `ledgerBalanced:true`; `loop-verdict:PASS`.
10. `pnpm --filter @iptv/api test --run test/commerce-billing.unit.test.ts` → **55/55 PASS** (fetch mockado, zero rede).

## Ponto de retomada p/ refund (BLOQUEADO até liquidação real)

- Tenant: `01a11cc9-8105-73a7-995f-6ceca2045704` · Order: `01a11cc9-81fe-774e-9fe6-908bacecd626` (SETTLED 500) · Charge: `01a11cc9-8528-74d0-98bd-b968e56275ff` (PAID) · Payment: `01a11cca-1b90-778f-b7b4-19691d77d7ad` (CONFIRMED 500 BRL) · Asaas customer: `cus_000009390786` · Asaas payment: `pay_hhnybloyqkj2072a` (status sandbox `RECEIVED_IN_CASH`, valor R$ 5,00).
- Próximo passo do operador: no **dashboard sandbox**, simular o pagamento da cobrança `pay_hhnybloyqkj2072a` (obter status RECEIVED via PIX) e SÓ ENTÃO tentar refund parcial via nossa API (`refund.request → approve → execute_approved`) ou `POST /payments/{id}/refund` direto; recebimento-em-dinheiro NÃO qualifica (provider recusa com `400 invalid_object`, já provado em live-b1).
- Nota: a lane DB foi destruída (`down -v`); a retomada via nossa API exige re-executar as fases A–D (idempotente, ~3 min) OU operar direto no sandbox com o `pay_` acima. Limpeza pós-refund (quando autorizado): `DELETE /payments/pay_hhnybloyqkj2072a` + `DELETE /customers/cus_000009390786` no sandbox.

## Riscos residuais

- `receiveInCash` ≠ liquidação PIX: o PAID aqui decorre do mapeamento `RECEIVED_IN_CASH→PAID` (mesmo normalizador do unit 55/55); refund-live segue exigindo RECEIVED via dashboard.
- `dist/` reconstruído localmente difere do `dist` anterior (stale, sem a rota de provision); é artefato gitignored, mas outro operador repetindo o loop precisa rebuildar após `git pull`.
- Resíduo intencional no sandbox (1 customer + 1 payment de R$ 5,00) até o refund do operador — conta sandbox descartável, sem notificações (customer sem email/telefone).
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação vale para sandbox.
