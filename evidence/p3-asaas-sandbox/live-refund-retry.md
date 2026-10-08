# LOOP-BOLETO-3 — nova charge boleto vinculada (PARADA em aguardando-confirmação-dashboard)

- TASK_ID: LOOP-BOLETO-3
- Data (UTC): 2026-10-08
- Base: main@68dfd97 (merge #33 boleto; sem alterações de código-fonte; `apps/api/dist` reutilizado como está — threading `billingType` verificado no bundle (`asaas-port.js`); `git status` limpo exceto este arquivo + `live-loop-boleto.md` do worker irmão, intocado; sem commit/push)
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (scripts em `%TEMP%\opencode\iptv-loopblt2` e `%TEMP%\opencode\iptv-loopblt3`, fora do repo; só presença/host/vereditos impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer chamada (qualquer outro host abortaria com BLOCKED e zero chamadas);
  zero segredos em outputs/arquivos (token de sessão, `ASAAS_API_KEY` nunca impressos nem persistidos no repo);
  lane piloto (`iptv-pilot`, :3200/:3201) NUNCA tocada — verificada apenas via leitura (`docker ps`);
  produção NUNCA tocada.

## Lane scratch REUTILIZADA (`-p iptv-loopblt2`) — MANTIDA UP

- Postgres próprio `127.0.0.1:55435` (projeto `iptv-loopblt2`, compose em `%TEMP%\opencode\iptv-loopblt2\docker-compose.loopblt2.yml`) — saudável no reuso; API `http://127.0.0.1:3311` (`/v1/health/ready → ok`) reutilizada sem rebuild nem restart.
- Estado desta task em arquivo PRÓPRIO `%TEMP%\opencode\iptv-loopblt3\loopblt3-state.json` (contém token de sessão — FORA do repo, nunca commitado); o estado da LOOP-BOLETO-2 (`loopblt2-state.json`) NÃO foi tocado.
- Driver próprio `%TEMP%\opencode\iptv-loopblt3\loopblt3-driver.cjs` (cópia do driver da BOLETO-2 com tags `LoopBoleto3`, mesmo `API`/`PG`).

## Tabela passo:veredito (via NOSSA API na scratch lane, `ASAAS_ADAPTER=real`, `billingType BOLETO`, R$ 10,00)

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Gate 0 — afirmar `api-sandbox.asaas.com` antes de qualquer chamada | PASS | `env-gate0.cjs` (parse do `.env` em-processo) → `{adapter:"real", keyPresent:true, keyShape:"sandbox-shaped(redacted)", host:"api-sandbox.asaas.com", verdict:"SANDBOX_OFFICIAL"}` |
| Dist contém threading `billingType` (#33) | PASS | `billingType` presente em `apps/api/dist` (`asaas-port.js` e mais 4 ocorrências); API `:3311` com `/v1/health/ready → ok` |
| 1. Registrar usuário/tenant descartável → person | PASS | `POST /v1/auth/register → 201` (tenant `01a11d3e-…`, user `01a11d3e-…`, `tokenPresent:true`); `GET /v1/auth/session → 200` (TCR obtido); `POST /v1/crm/persons → 201` (person `01a11d3e-…`) |
| Seed de catálogo (lane descartável) | PASS | `catalog.products/plans/prices` via SQL direto no scratch: plano `ff57408d-…`, preço `1000` BRL (R$ 10,00) |
| 2a. Order (quote → submit) | PASS | `POST /v1/orders/quote → 201` (order `01a11d3e-…`, net `1000`); `POST /v1/orders/:id/submit → 201` (`AWAITING_PAYMENT`) |
| 2b. Charge SEM binding → `precondition_failed` esperado | PASS | `POST /v1/charges → 409 {code:PRECONDITION_FAILED}` ("no Asaas customer binding …; run billing.customer_provision first") — fail-closed antes de qualquer linha de charge, sem chamada ao provider |
| 2c. Provision binding (`POST /v1/billing-customers/provision`, sem `document` → sandbox resolve a constante de teste documentada) | PASS | `→ 201 {provisioned:true, providerCustomerId: cus_…}` (binding `cus_000009394296`) |
| 3. Order → charge BOLETO (auto-resolve binding) | PASS | `POST /v1/charges {orderId, paymentMethod:"BOLETO", billingType:"BOLETO"} → 201 {status:PROCESSING, providerChargeId: pay_…}` (charge `01a11d3e-…`, `pay_49lpfurhek93or49`, BRL 10.00, vencimento D+1 — pagamento BOLETO REAL criado no sandbox; binding `ACCEPTED` persistido) |
| Verificação read-only (sem simular) | PASS | `GET /v1/charges → PROCESSING` (`payment_method:BOLETO`, `paid_at:null`); `GET /v1/payments → []` (nenhum payment — confirmação ainda não ocorreu); `GET /v1/orders/:id → AWAITING_PAYMENT`; provider `GET /payments/pay_… → 200 {status:PENDING, billingType:BOLETO, value:10, dueDate:2026-10-09, invoiceUrlPresent:true}` — cobrança aguardando confirmação no dashboard |
| 4. PARAR antes de confirmar/simular/reconciliar/refundar | CUMPRIDO | Nenhum `receiveInCash`/simulação, webhook, `reconcile`, `refund.request/execute` chamado; nenhum `DELETE` no sandbox (pagamento + customer INTENCIONALMENTE vivos p/ confirmação dashboard); lane DB MANTIDA UP, ids de retomada abaixo |

## Retomada p/ confirmação dashboard (payment PENDING — ponto de retomada)

- Tenant: `01a11d3e-0bbe-72a2-a0b1-368d4589f773` · User: `01a11d3e-0bcb-7780-8090-d283e6539bfd` · Person: `01a11d3e-0c35-725c-8870-825f013a5d82`
- Order: `01a11d3e-0cd7-77cb-9c51-3aca4751fb29` (AWAITING_PAYMENT, 1000 BRL) · Charge: `01a11d3e-0fe4-75b0-a7ec-0c538eae273f` (PROCESSING, `payment_method:BOLETO`, `paid_at:null`)
- Asaas customer: `cus_000009394296` · Asaas payment: `pay_49lpfurhek93or49` (status sandbox `PENDING`, `billingType:BOLETO`, valor R$ 10,00, vencimento 2026-10-09, com `invoiceUrl`)
- Próximo passo do operador: no **dashboard sandbox**, confirmar/liquidar a cobrança `pay_49lpfurhek93or49` (boleto) e SÓ ENTÃO seguir com webhook/reconcile/refund na lane `iptv-loopblt2` (API `:3311`, postgres `:55435`, token de sessão desta task em `%TEMP%\opencode\iptv-loopblt3\loopblt3-state.json`).
- Limpeza pós-refund (quando autorizado): `DELETE /payments/pay_49lpfurhek93or49` + `DELETE /customers/cus_000009394296` no sandbox. Lane `iptv-loopblt2` compartilhada com a BOLETO-2 — derrubar (`down -v` + encerrar API) SOMENTE quando ambas as partes autorizarem.

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\iptv-loopblt2\env-gate0.cjs` → `SANDBOX_OFFICIAL` (sem segredos).
2. `docker ps` (leitura) → `iptv-loopblt2-postgres Up (healthy)` em `127.0.0.1:55435`; pilot `iptv-pilot-*` intacto, só leitura.
3. `curl.exe http://127.0.0.1:3311/v1/health/ready` → `{"status":"ok","checks":{"database":"ok"}}` (lane reutilizada, sem rebuild/restart).
4. `node %TEMP%\opencode\iptv-loopblt3\loopblt3-driver.cjs A` → register/session/person/seed/quote/submit PASS; charge-sem-binding `409 PRECONDITION_FAILED`; provision `201 cus_…`; charge-boleto `201 PROCESSING pay_…`.
5. `node %TEMP%\opencode\iptv-loopblt3\loopblt3-driver.cjs V` → charges `PROCESSING/BOLETO`, payments `[]`, order `AWAITING_PAYMENT`, provider `PENDING/BOLETO/R$10/due 2026-10-09/invoiceUrl`, binding `PASS`, `stop-before-confirm:PASS-STOPPED`.

## Riscos residuais

- Resíduo intencional no sandbox (1 customer + 1 payment BOLETO de R$ 10,00, `PENDING`) até a confirmação/refund do operador — conta sandbox descartável, sem notificações (customer sem email/telefone). Somado ao resíduo da BOLETO-2 (1 customer + 1 payment BOLETO `PENDING`).
- Token de sessão desta task vive em `%TEMP%\opencode\iptv-loopblt3\loopblt3-state.json` (fora do repo); expira com o banco scratch. Estado da BOLETO-2 intocado.
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação vale para sandbox.
