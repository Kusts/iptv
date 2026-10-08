# LOOP-BOLETO-2 — loop boleto via API até charge confirmável (PARADO aí)

- TASK_ID: LOOP-BOLETO-2
- Data (UTC): 2026-10-08
- Base: main@68dfd97 (merge #33 boleto; `apps/api/dist` reconstruído localmente via `pnpm --filter @iptv/api build` — artefato gitignored, `git status` limpo exceto este arquivo; sem commit/push)
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (scripts em `%TEMP%\opencode\iptv-loopblt2`, fora do repo; só presença/host/vereditos impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer chamada (qualquer outro host abortaria com BLOCKED e zero chamadas);
  zero segredos em outputs/arquivos (token de sessão, `ASAAS_API_KEY` nunca impressos nem persistidos no repo);
  lane piloto (`iptv-pilot`, :3200/:3201) NUNCA tocada — verificada apenas via leitura (`docker ps`/`docker compose ls`);
  produção NUNCA tocada.

## Lane scratch PRÓPRIA descartável (`-p iptv-loopblt2`) — MANTIDA UP p/ parte do refund

- Compose próprio em `%TEMP%` (fora do repo): só `postgres:17-alpine` em `127.0.0.1:55435`, projeto `iptv-loopblt2`, volume próprio.
- Migrations: 60/60 aplicadas (`iptv-migrate: applied=60 skipped=0`) contra o banco scratch.
- API: `apps/api/dist` reconstruído (agora com `BOLETO` — `dist-has-BOLETO` verificado por grep no bundle) e servida em `:3311` (processo local detached, pid registrado no TEMP) com `DATABASE_URL` do scratch + `ASAAS_ADAPTER=real` (do `.env`, só presença afirmada) — `GET /v1/health/ready → {"status":"ok","checks":{"database":"ok"}}`; boot-map contém `{/v1/billing-customers/provision, POST}` e `{/v1/charges, POST}`.
- Portas: 3311 e 55435 livres antes (staging :3000/:3001, cutover :3100/:3101, pilot :3200/:3201 intactos). **Lane NÃO destruída** (`down -v` NÃO executado — acesso registrado abaixo p/ a parte do refund).
- Acesso à lane: postgres `127.0.0.1:55435` (projeto `iptv-loopblt2`, compose em `%TEMP%\opencode\iptv-loopblt2\docker-compose.loopblt2.yml`); API `http://127.0.0.1:3311` (log em `%TEMP%\opencode\iptv-loopblt2\api-boot.log`); estado do driver em `%TEMP%\opencode\iptv-loopblt2\loopblt2-state.json` (contém token de sessão — FORA do repo, nunca commitado).

## Tabela passo:veredito (via NOSSA API na scratch lane, `ASAAS_ADAPTER=real`, `billingType BOLETO`)

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Gate 0 — afirmar `api-sandbox.asaas.com` antes de qualquer chamada | PASS | `env-gate0.cjs` (parse do `.env` em-processo) → `{adapter:"real", keyPresent:true, keyShape:"sandbox-shaped(redacted)", host:"api-sandbox.asaas.com", verdict:"SANDBOX_OFFICIAL"}` |
| 1. Registrar usuário/tenant descartável → person | PASS | `POST /v1/auth/register → 201` (tenant `01a11cf3-…`, user `01a11cf3-…`, `tokenPresent:true`); `GET /v1/auth/session → 200` (TCR obtido; header `x-tenant-context-revision` exigido); `POST /v1/crm/persons → 201` (person `01a11cf3-…`) |
| Seed de catálogo (lane descartável) | PASS | `catalog.products/plans/prices` via SQL direto no scratch: plano `e6177c09-…`, preço `1000` BRL (R$ 10,00) |
| 2a. Order (quote → submit) | PASS | `POST /v1/orders/quote → 201` (order `01a11cf3-…`, net `1000`); `POST /v1/orders/:id/submit → 201` (`AWAITING_PAYMENT`) |
| 2b. Charge SEM binding → `precondition_failed` esperado | PASS | `POST /v1/charges → 409 {code:PRECONDITION_FAILED}` ("no Asaas customer binding …; run billing.customer_provision first") — fail-closed antes de qualquer linha de charge, sem chamada ao provider |
| 2c. Provision binding (`POST /v1/billing-customers/provision`, sem `document` → sandbox resolve a constante de teste documentada) | PASS | `→ 201 {provisioned:true, providerCustomerId: cus_…}` (binding `cus_000009391945`) |
| 3. Order → charge BOLETO (auto-resolve binding, `billingType` threaded #33) | PASS | `POST /v1/charges {orderId, paymentMethod:"BOLETO", billingType:"BOLETO"} → 201 {status:PROCESSING, providerChargeId: pay_…}` (charge `01a11cf3-…`, `pay_ydgjll65319en1bz`, BRL 10.00, vencimento D+1 — pagamento BOLETO REAL criado no sandbox; binding persistido `ACCEPTED`) |
| Verificação read-only (sem simular) | PASS | `GET /v1/charges → PROCESSING` (`payment_method:BOLETO`, `paid_at:null`); `GET /v1/payments → []` (nenhum payment — confirmação ainda não ocorreu); `GET /v1/orders/:id → AWAITING_PAYMENT`; provider `GET /payments/pay_… → 200 {status:PENDING, billingType:BOLETO, value:10, dueDate:2026-10-09, invoiceUrlPresent:true}` — cobrança aguardando confirmação no dashboard |
| 4. PARAR antes de confirmar/simular/reconciliar/refundar | CUMPRIDO | Nenhum `receiveInCash`/simulação, webhook, `reconcile`, `refund.request/execute` chamado; nenhum `DELETE` no sandbox (pagamento + customer INTENCIONALMENTE vivos p/ a parte do refund); lane DB MANTIDA UP, ids de retomada abaixo |

## Retomada p/ parte do refund (charge aguardando confirmação no dashboard)

- Tenant: `01a11cf3-06e2-74a3-b34a-6c7543d7559e` · User: `01a11cf3-06f4-702b-8c08-e4192acde7a6` · Person: `01a11cf3-0763-773d-8271-27f746b3b512`
- Order: `01a11cf3-080e-74f9-b636-c0077255fef3` (AWAITING_PAYMENT, 1000 BRL) · Charge: `01a11cf3-0b37-758c-99fc-3559809329ae` (PROCESSING, `payment_method:BOLETO`, `paid_at:null`)
- Asaas customer: `cus_000009391945` · Asaas payment: `pay_ydgjll65319en1bz` (status sandbox `PENDING`, `billingType:BOLETO`, valor R$ 10,00, vencimento 2026-10-09, com `invoiceUrl`)
- Próximo passo do operador: no **dashboard sandbox**, confirmar/liquidar a cobrança `pay_ydgjll65319en1bz` (boleto) e SÓ ENTÃO seguir com webhook/reconcile/refund na lane `iptv-loopblt2` (API `:3311`, postgres `:55435`, token de sessão em `%TEMP%\opencode\iptv-loopblt2\loopblt2-state.json`).
- Limpeza pós-refund (quando autorizado, lane própria): `DELETE /payments/pay_ydgjll65319en1bz` + `DELETE /customers/cus_000009391945` no sandbox; depois `docker compose -p iptv-loopblt2 -f %TEMP%\opencode\iptv-loopblt2\docker-compose.loopblt2.yml down -v` + encerrar API pid.

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\iptv-loopblt2\env-gate0.cjs` → `SANDBOX_OFFICIAL` (sem segredos).
2. `docker compose -p iptv-loopblt2 -f %TEMP%\opencode\iptv-loopblt2\docker-compose.loopblt2.yml up -d postgres` → `iptv-loopblt2-postgres` em `127.0.0.1:55435` (pilot `iptv-pilot-api` :3201 intacto, só leitura).
3. `$env:DATABASE_URL='postgresql://iptv:iptv@127.0.0.1:55435/iptv'; node packages/database/dist/bin/iptv-migrate.js` → `applied=60 skipped=0`.
4. `pnpm --filter @iptv/api build` → exit 0; bundle contém `BOLETO` (`dist-has-BOLETO`); `git status` limpo (dist é gitignored).
5. `node %TEMP%\opencode\iptv-loopblt2\launch-api2.cjs` (lê `.env` em-processo, `PORT=3311`, `ASAAS_ADAPTER=real`) → `SANDBOX_OFFICIAL, pid 18160, port 3311`; `curl.exe -s http://127.0.0.1:3311/v1/health/ready` → `{"status":"ok","checks":{"database":"ok"}}`.
6. `node %TEMP%\opencode\iptv-loopblt2\loopblt2-driver.cjs A` → register/session/person/seed/quote/submit PASS; charge-sem-binding `409 PRECONDITION_FAILED`; provision `201 cus_…`; charge-boleto `201 PROCESSING pay_…`.
7. `node %TEMP%\opencode\iptv-loopblt2\loopblt2-driver.cjs V` → charges `PROCESSING/BOLETO`, payments `[]`, order `AWAITING_PAYMENT`, provider `PENDING/BOLETO/R$10/due 2026-10-09/invoiceUrl`, binding `PASS`, `stop-before-confirm:PASS-STOPPED`.
8. `pnpm --filter @iptv/api test --run test/commerce-billing.unit.test.ts` → **59/59 PASS** (fetch mockado, zero rede).

## Riscos residuais

- Resíduo intencional no sandbox (1 customer + 1 payment BOLETO de R$ 10,00, `PENDING`) até a parte do refund do operador — conta sandbox descartável, sem notificações (customer sem email/telefone). Lane local `iptv-loopblt2` MANTIDA UP de propósito (postgres + API) — derrubar só quando a parte do refund autorizar.
- Token de sessão da lane scratch vive em `%TEMP%\opencode\iptv-loopblt2\loopblt2-state.json` (fora do repo); expira com o banco scratch.
- `dist/` reconstruído localmente difere do `dist` anterior (agora com #33); é artefato gitignored, mas outro operador repetindo o loop precisa rebuildar após `git pull`.
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação vale para sandbox.
