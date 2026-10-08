# LOOP-PIX-2 — nova charge PIX vinculada (PARADA em PENDING p/ confirmação dashboard)

- TASK_ID: LOOP-PIX-2
- Data (UTC): 2026-10-08
- Base: main@68dfd97 (merge #33 boleto; `apps/api/dist` já reconstruído pela task anterior com `BOLETO` — PIX default inalterado; `git status` limpo exceto evidências; sem commit/push)
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (scripts em `%TEMP%\opencode\iptv-loopblt2`, fora do repo; só presença/host/vereditos impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer chamada (qualquer outro host abortaria com BLOCKED e zero chamadas);
  zero segredos em outputs/arquivos (token de sessão, `ASAAS_API_KEY` nunca impressos nem persistidos no repo);
  lane piloto (`iptv-pilot`, :3200/:3201) NUNCA tocada — verificada apenas via leitura (`docker ps`);
  produção NUNCA tocada.

## Lane scratch REUTILIZADA (`-p iptv-loopblt2`) — MANTIDA UP p/ refund-live

- Lane da task LOOP-BOLETO-2 encontrada saudável e reutilizada: postgres `127.0.0.1:55435` (projeto `iptv-loopblt2`), API `http://127.0.0.1:3311` com `GET /v1/health/ready → {"status":"ok","checks":{"database":"ok"}}`, `ASAAS_ADAPTER=real`.
- Novo tenant/user/person descartável (sem interferência na charge boleto `pay_ydgjll65319en1bz`, que permanece viva no sandbox).
- **Lane NÃO destruída** (`down -v` NÃO executado — ids de retomada abaixo p/ o refund-live PIX).

## Tabela passo:veredito (via NOSSA API na lane, `ASAAS_ADAPTER=real`, `billingType` PIX default, R$ 5,00)

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Gate 0 — afirmar `api-sandbox.asaas.com` antes de qualquer chamada | PASS | `env-gate0.cjs` (parse do `.env` em-processo) → `{adapter:"real", keyPresent:true, keyShape:"sandbox-shaped(redacted)", host:"api-sandbox.asaas.com", verdict:"SANDBOX_OFFICIAL"}` |
| 1. Registrar usuário/tenant descartável → person | PASS | `POST /v1/auth/register → 201` (tenant `01a11d52-…`, user `01a11d52-…`, `tokenPresent:true`); `GET /v1/auth/session → 200` (TCR obtido); `POST /v1/crm/persons → 201` (person `01a11d52-…`) |
| Seed de catálogo (lane descartável, R$ 5,00) | PASS | `catalog.products/plans/prices` via SQL direto no scratch: plano `06d20122-…`, preço `500` BRL (R$ 5,00) |
| 2a. Order (quote → submit) | PASS | `POST /v1/orders/quote → 201` (order `01a11d52-…`, net `500`); `POST /v1/orders/:id/submit → 201` (`AWAITING_PAYMENT`) |
| 2b. Charge SEM binding → `precondition_failed` esperado | PASS | `POST /v1/charges → 409 {code:PRECONDITION_FAILED}` ("no Asaas customer binding …; run billing.customer_provision first") — fail-closed antes de qualquer linha de charge, sem chamada ao provider |
| 2c. Provision binding (`POST /v1/billing-customers/provision`, sem `document` → sandbox resolve a constante de teste) | PASS | `→ 201 {provisioned:true, providerCustomerId: cus_…}` (binding `cus_000009395615`) |
| 3. Order → charge PIX (default, sem `billingType` explícito) | PASS | `POST /v1/charges {orderId} → 201 {status:PROCESSING, providerChargeId: pay_…}` (charge `01a11d52-…`, `pay_v2o0qw0j4ishv0nw`, BRL 5.00 — pagamento PIX REAL criado no sandbox; binding persistido `ACCEPTED`) |
| Verificação read-only (sem simular) | PASS | `GET /v1/charges → PROCESSING` (`payment_method:PIX`, `paid_at:null`); `GET /v1/payments → []` (nenhum payment — confirmação ainda não ocorreu); `GET /v1/orders/:id → AWAITING_PAYMENT`; provider `GET /payments/pay_… → 200 {status:PENDING, billingType:PIX, value:5, dueDate:2026-10-09}` — cobrança aguardando confirmação no dashboard |
| 4. PARAR antes de simular/confirmar/reconciliar/refundar | CUMPRIDO | Nenhuma simulação, webhook, `reconcile`, `refund.request/execute` chamado; nenhum `DELETE` no sandbox (pagamento + customer INTENCIONALMENTE vivos p/ o refund-live); lane DB MANTIDA UP, ids de retomada abaixo |

## Retomada p/ refund-live PIX (charge aguardando confirmação no dashboard)

- Tenant: `01a11d52-1da1-7118-8267-7b7b09119851` · User: `01a11d52-1db2-753a-9129-e21d955e190a` · Person: `01a11d52-1e89-719f-b20d-b345ebb32cf3`
- Order: `01a11d52-1f4d-71cf-829f-c20f0b7df91b` (AWAITING_PAYMENT, 500 BRL) · Charge: `01a11d52-22ba-7493-b7bb-084fc07f2c82` (PROCESSING, `payment_method:PIX`, `paid_at:null`)
- Asaas customer: `cus_000009395615` · Asaas payment: `pay_v2o0qw0j4ishv0nw` (status sandbox `PENDING`, `billingType:PIX`, valor R$ 5,00, vencimento 2026-10-09)
- Próximo passo do operador: no **dashboard sandbox**, confirmar/liquidar a cobrança `pay_v2o0qw0j4ishv0nw` (PIX) e SÓ ENTÃO seguir com webhook/reconcile/refund na lane `iptv-loopblt2` (API `:3311`, postgres `:55435`, token de sessão em `%TEMP%\opencode\iptv-loopblt2\looppix2-state.json`).
- Limpeza pós-refund (quando autorizado): `DELETE /payments/pay_v2o0qw0j4ishv0nw` + `DELETE /customers/cus_000009395615` no sandbox; lane compartilhada com o loop boleto — derrubar (`down -v` + encerrar API pid) SÓ quando AMBOS os refunds autorizarem.

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\iptv-loopblt2\env-gate0.cjs` → `SANDBOX_OFFICIAL` (sem segredos).
2. `docker ps --format ...` (somente leitura) → `iptv-loopblt2-postgres` UP `:55435`; `iptv-pilot-api/web/postgres` intactos; `curl.exe http://127.0.0.1:3311/v1/health/ready` → `{"status":"ok","checks":{"database":"ok"}}` (lane reutilizada, nenhum rebuild/re-migrate).
3. `node %TEMP%\opencode\iptv-loopblt2\looppix2-driver.cjs A` → register/session/person/seed/quote/submit PASS; charge-sem-binding `409 PRECONDITION_FAILED`; provision `201 cus_…`; charge-pix `201 PROCESSING pay_…`.
4. `node %TEMP%\opencode\iptv-loopblt2\looppix2-driver.cjs V` → charges `PROCESSING/PIX`, payments `[]`, order `AWAITING_PAYMENT`, provider `PENDING/PIX/R$5/due 2026-10-09`, binding `PASS`, `stop-before-confirm:PASS-STOPPED`.

## Riscos residuais

- Resíduo intencional no sandbox (1 customer + 1 payment PIX de R$ 5,00, `PENDING`, + o par boleto R$ 10,00 da task anterior) até o refund-live do operador — conta sandbox descartável, sem notificações (customer sem email/telefone). Lane local `iptv-loopblt2` MANTIDA UP de propósito — derrubar só quando AMBOS os refunds autorizarem.
- Token de sessão da lane scratch vive em `%TEMP%\opencode\iptv-loopblt2\looppix2-state.json` (fora do repo); expira com o banco scratch.
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação vale para sandbox.
