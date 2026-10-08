# LOOP-PIX-3 — reconcile PIX + pedido de refund parcial R$ 1,00 (PARADO antes de aprovar/executar)

- TASK_ID: LOOP-PIX-3
- Data (UTC): 2026-10-08
- Base: sem alterações de código-fonte; só este arquivo criado; sem commit/push
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (drivers em `%TEMP%\opencode\iptv-loopblt2`, fora do repo; só presença/host/vereditos impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer chamada (qualquer outro host abortaria com BLOCKED e zero chamadas);
  zero segredos em outputs/arquivos (token de sessão, `ASAAS_API_KEY` nunca impressos nem persistidos no repo);
  lane piloto (`iptv-pilot`, :3200/:3201) NUNCA tocada — verificada apenas via leitura (`docker ps`);
  produção NUNCA tocada.

## Lane scratch reutilizada (`-p iptv-loopblt2`) — MANTIDA UP

- Postgres próprio `127.0.0.1:55435` (projeto `iptv-loopblt2`) — saudável ao início e ao fim (`Up (healthy)`); API `http://127.0.0.1:3311` (`/v1/health/ready → ok`).
- Estado em `%TEMP%\opencode\iptv-loopblt2\looppix2-state.json` (contém token — FORA do repo, nunca commitado; TCR refrescado via `GET /v1/auth/session` durante a task).
- Driver desta task em `%TEMP%\opencode\iptv-loopblt2\looppix3-refund-driver.cjs` + ledger em `looppix3-ledger2.cjs` (fora do repo).

## Tabela passo:veredito (via NOSSA API na scratch lane, `ASAAS_ADAPTER=real`)

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Gate 0 — afirmar `api-sandbox.asaas.com` antes de qualquer chamada | PASS | parse do `.env` em-processo → `{gate:"SANDBOX_OFFICIAL", host:"api-sandbox.asaas.com", adapter:"real"}` |
| Sessão refrescada (TCR fresco) | PASS | `GET /v1/auth/session → 200` (TCR atualizado no state) |
| Provider readback (somente status/valor) | PASS | `GET /v3/payments/pay_v2o0qw0j4ishv0nw → 200 {status:RECEIVED, billingType:PIX, value:5, confirmedDate:2026-10-08}` |
| 1. Reconcile da charge | PASS | `POST /v1/charges/01a11d52-22ba-7493-b7bb-084fc07f2c82/reconcile → 201 {status:PAID, outcome:confirmed}` (sem corpo, sem `content-type`, com header TCR — sem `409 TENANT_CONTEXT_CONFLICT`) |
| 1a. Charge PAID | PASS | `GET /v1/charges → {status:PAID, payment_method:PIX, amount_minor:500, paid_at:2026-10-08T21:06:53.596Z}` |
| 1b. Payment CONFIRMED | PASS | `GET /v1/payments → {status:CONFIRMED, amount_minor:500, confirmed_at:2026-10-08T21:06:53.596Z}` (id interno `01a11d57-281c-71d2-8b1d-49a73c0e5a83`) |
| 1c. Order SETTLED | PASS | `GET /v1/orders/01a11d52-1f4d-71cf-829f-c20f0b7df91b → 200 {status:SETTLED}` |
| 1d. Ledger balanceado | PASS | SQL read-only no scratch: `PAYMENT_CONFIRMATION` → `DEBIT CASH_ASAAS_PIX 500` + `CREDIT RECEIVABLE_ORDERS 500` BRL (`rows:2`, `balance:[{deb:500, cred:500}]`) |
| 1e. Exceptions vazias | PASS | `GET /v1/billing-exceptions → []` |
| 2. Refund request PARCIAL R$ 1,00 (`amountMinor:"100"`) | PASS | `POST /v1/refund-requests → 201 {status:UNDER_REVIEW}` (request `01a11d57-2971-75ca-bddc-6bc7b395b8d8`, review `01a11d57-2972-720c-a13f-3f6d518af9cc`); `GET /v1/refund-requests → UNDER_REVIEW, amount_minor:100, decided_at:null, executed_at:null` |
| 3. PARAR antes de aprovar/executar/limpar | CUMPRIDO | Nenhum `human_review.approve`, nenhum `refund-requests/:id/execute`, nenhum `DELETE` no sandbox; lane DB MANTIDA UP, ids de retomada abaixo |

## Retomada p/ aprovação do operador (refund UNDER_REVIEW — ponto de retomada)

- Charge: `01a11d52-22ba-7493-b7bb-084fc07f2c82` (PAID, PIX) · Order: `01a11d52-1f4d-71cf-829f-c20f0b7df91b` (SETTLED)
- Asaas customer: `cus_000009395615` · Asaas payment: `pay_v2o0qw0j4ishv0nw` (`RECEIVED` no sandbox, PIX R$ 5,00)
- Payment interno: `01a11d57-281c-71d2-8b1d-49a73c0e5a83` (CONFIRMED, 500 BRL)
- Refund request: `01a11d57-2971-75ca-bddc-6bc7b395b8d8` (UNDER_REVIEW, 100 BRL) · Review: `01a11d57-2972-720c-a13f-3f6d518af9cc`
- Próximo passo do OPERADOR no chat: aprovar (outro usuário que não o solicitante) e então executar — na lane `iptv-loopblt2` (API `:3311`, postgres `:55435`, token em `%TEMP%\opencode\iptv-loopblt2\looppix2-state.json`).
- Limpeza pós-refund (quando autorizado): `DELETE /payments/pay_v2o0qw0j4ishv0nw` + `DELETE /customers/cus_000009395615` no sandbox (nota: cobrança `RECEIVED` pode não ser removível por regra do Asaas — só pendentes/vencidas; ver LOOP-REFUND-2 §9). Lane `iptv-loopblt2` compartilhada com o loop boleto — derrubar (`down -v` + encerrar API) SOMENTE quando AMBOS os refunds autorizarem.

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\iptv-loopblt2\looppix3-refund-driver.cjs` (com `NODE_PATH` p/ `pg`; `ASAAS_*` só em-processo) → gate `SANDBOX_OFFICIAL`; `session-refresh 200`; `provider 200 RECEIVED/PIX/5`; `reconcile 201 PAID/confirmed`; `verify` charge `PAID/PIX/500` + payment `CONFIRMED/500` + order `SETTLED` + exceptions `[]`; `refund.request 201 UNDER_REVIEW` (`FULL_IDS::{requestId, reviewId, paymentInternalId}`); `refund-list UNDER_REVIEW/100`; `stop-before-approve STOPPED`.
2. `node %TEMP%\opencode\iptv-loopblt2\looppix3-ledger2.cjs` (SQL read-only no scratch) → `rows:2` (`CASH_ASAAS_PIX` DEBIT 500 / `RECEIVABLE_ORDERS` CREDIT 500 BRL), `balance:[{deb:500, cred:500}]`.
3. `curl.exe -s http://127.0.0.1:3311/v1/health/ready` → `{"status":"ok","checks":{"database":"ok"}}`; `docker ps` (leitura) → `iptv-loopblt2-postgres Up (healthy)` em `127.0.0.1:55435`; pilot `:3200/:3201` intacto (pilot-api `unhealthy` pré-existente, intocado — ver riscos).

## Incidente transitório durante a task (recuperado, sem efeito)

- Após o `refund.request`, o caminho TCP `127.0.0.1:55435` estagnou brevemente (`/v1/health/ready → unavailable/database:error`, conexões pg com timeout), enquanto o container seguia `Up (healthy)` e o postgres respondia normalmente via socket local (`pg_isready → accepting connections`, `pg_stat_activity` quase ocioso — diagnóstico read-only via `docker exec`).
- Recuperação espontânea em ~2 min sem nenhuma intervenção mutante; ledger então confirmado (`rows:2`, `balance 500/500`). Nenhum retry de escrita foi necessário (todas as mutações já haviam retornado `201` antes do episódio; nenhuma chamada foi repetida).
- Hipótese: soluço transitório de rede do port-forward no Windows e/ou contenção com outra task concorrente na lane compartilhada. Sem evidência de causa no repo.

## Riscos residuais

- Resíduo intencional no sandbox (1 customer + 1 payment PIX `RECEIVED` de R$ 5,00) até aprovação/execução/limpeza do operador — conta sandbox descartável, sem notificações (customer sem email/telefone). Somado ao resíduo do loop boleto (ver `live-refund-exec.md`).
- Refund request `UNDER_REVIEW` de R$ 1,00 pendente de aprovação humana (outro aprovador exigido pelo revalidador) — sem efeito financeiro até `execute_approved`.
- Token de sessão desta task vive em `%TEMP%\opencode\iptv-loopblt2\looppix2-state.json` (fora do repo); expira com o banco scratch.
- `iptv-pilot-api` reporta `unhealthy` no `docker ps` (pré-existente, lane NUNCA tocada por esta task — apenas observada via leitura).
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação vale para sandbox.

---

# LOOP-PIX-4 — aprovação 2º humano + execute + verificação + limpeza (AUTORIZADO pelo operador no chat)

- TASK_ID: LOOP-PIX-4
- Data (UTC): 2026-10-08
- Base: sem alterações de código-fonte; só esta seção ANEXADA a este arquivo; sem commit/push
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (drivers em `%TEMP%\opencode\iptv-loopblt2`, fora do repo; só presença/host/vereditos impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer chamada (qualquer outro host abortaria com BLOCKED e zero chamadas);
  zero segredos em outputs/arquivos (tokens de sessão, `ASAAS_API_KEY`, senhas nunca impressos nem persistidos no repo);
  lane piloto (`iptv-pilot`, :3200/:3201) NUNCA tocada — verificada apenas via leitura (`docker ps`, `Up (healthy)`, intocada);
  produção NUNCA tocada.
- Drivers desta task (fora do repo): `%TEMP%\opencode\iptv-loopblt2\looppix4-driver.cjs` (registro 2º humano + self-approval negativo + approve + execute),
  `looppix4-partb.cjs` (reconcile + verificação — com 2 queries de ledger corrigidas nas partes C/E),
  `looppix4-partc.cjs` (verificação corrigida + probe + cleanup),
  `looppix4-partd.cjs` (over-probe verdadeiro + listagem),
  `looppix4-parte.cjs` (rejeição da sonda acidental + prefixo do provider-ref). Estado em `looppix2-state.json` + `looppix4-exec.json` (fora do repo).

## Tabela passo:veredito (via NOSSA API na scratch lane, `ASAAS_ADAPTER=real`)

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Gate 0 — afirmar `api-sandbox.asaas.com` antes de qualquer chamada | PASS | parse do `.env` em-processo → `SANDBOX_OFFICIAL` (`api-sandbox.asaas.com`, adapter `real`) |
| Lane scratch UP + pilot intacto | PASS | `GET /v1/health/ready → ok`; `docker ps` (leitura): `iptv-loopblt2-postgres Up (healthy)` em `127.0.0.1:55435`; pilot `:3200/:3201` Up, intocado |
| 1. Registro 2º humano + membership `tenant_owner` no tenant solicitante (owner SQL) + login | PASS | `POST /v1/auth/register → 201` (user `01a11d5d-.`); owner-SQL `insert into control.tenant_memberships … tenant_owner/ACTIVE` (upsert por conflito); `POST /v1/auth/login → 200` + `GET /v1/auth/session` (TCR fresco do aprovador); sessão solicitante revalidada (`GET /v1/auth/session → 200`, TCR atualizado) |
| 2. Controle negativo: self-approval do solicitante | PASS (rejeitado como esperado) | `POST /v1/human-reviews/01a11d57-…/approve` (solicitante) → `409 PRECONDITION_FAILED` (`stale approval rejected: self-approval forbidden: the requester cannot approve their own refund`) |
| 3. Aprovação do review por 2º humano | PASS | `POST /v1/human-reviews/01a11d57-2972-…/approve` (aprovador, TCR próprio) → `201 {resolution:"APPROVED"}`; `GET /v1/refund-requests` → request `01a11d57-2971-…` `APPROVED`, `amount_minor:100`, `decided_at` carimbado |
| 4. Execute com a sessão solicitante | EXECUTADO, efeito `UNKNOWN` → `KNOWN_NOT_APPLIED` após reconcile (ver finding) | `POST /v1/refund-requests/01a11d57-2971-…/execute` (solicitante) → `201 {refundId:01a11d5e-…, status:"RECONCILING", effectCertainty:"UNKNOWN"}`; `POST /v1/refunds/01a11d5e-…/reconcile → 201 {status:"FAILED", effectCertainty:"KNOWN_NOT_APPLIED"}` — provider recusou o refund; request consumido (`EXECUTED`, `decided_at`+`executed_at` carimbados) |
| 5. Payment interno segue `CONFIRMED` 500, sem reversão (correto p/ `KNOWN_NOT_APPLIED`) | PASS | `GET /v1/payments` → `CONFIRMED/500`; SQL read-only: refund `FAILED/KNOWN_NOT_APPLIED/100` com `provider_external_id` = ref da cobrança externa (prefixo `pay_v2o0qw0j`, reserva, não refund real); zero linhas `REFUND_REVERSAL` (`finance.*`, `deb:0/cred:0`) — invariante preservado (só `KNOWN_APPLIED` finaliza + reverte) |
| 6. Provider readback | PASS (informativo) | `GET /v3/payments/pay_v2o0qw0j4ishv0nw → 200 {status:RECEIVED, value:5, invoiceNumber:18656061}` — cobrança intacta; `GET …/refunds/<provider-ref> → 404` (nenhum objeto refund no provider — nada aplicado) |
| 7. Invariante sem over-refund (probe VERDADEIRO acima do restante) | PASS (rejeitado como esperado, zero efeito) | `POST /v1/refund-requests {paymentId, amountMinor:"600"}` (restante 500, refund anterior `FAILED` não consome) → `409 PRECONDITION_FAILED` (`over-refund rejected: 600 exceeds remaining refundable 500`); nenhum `refund.request` criado |
| 7b. Sonda intermediária 500 (= restante, não over) + correção | COMPORTAMENTO CORRETO + LIMPO | `amountMinor:"500"` → `201` (aceito corretamente: 500 = restante 500, não é over — erro da sonda, não do código); `POST /v1/human-reviews/<review-da-sonda>/reject` (solicitante) → `201 {resolution:"REJECTED"}`; lista final: `100/EXECUTED` + `500/REJECTED`, nenhum `UNDER_REVIEW` pendente |
| 8. Cleanup sandbox | PARCIAL (limite do provedor, documentado) | `DELETE /v3/customers/cus_000009395615 → 200 {deleted:true}` (GET posterior: `deleted:true` — removido); `DELETE /v3/payments/pay_v2o0qw0j4ishv0nw → 400 invalid_action` (`A cobrança [18656061] não pode ser removida: Só é possível remover cobranças pendentes ou vencidas` — cobrança `RECEIVED` não removível, regra do Asaas) |
| 9. Lane MANTIDA UP (compartilhada com o loop boleto) | CUMPRIDO | Nenhum `down -v`, nenhuma API encerrada; `KEPT-UP http://127.0.0.1:3311 + pg 127.0.0.1:55435`; `ready → ok` ao fim |

## FINDING principal (honesto): refund recusado pelo provedor — `KNOWN_NOT_APPLIED`

- O ciclo de domínio funcionou de ponta a ponta (request → 2º-humano aprova → execute serializado por payment → adapter real chamado com o id EXTERNO `pay_…`, nunca o UUID interno → recusa classificada `KNOWN_NOT_APPLIED` → refund `FAILED` terminal + request `EXECUTED`/consumido, sem ledger, sem efeito).
- O Asaas Sandbox recusou o refund do PIX `RECEIVED` (mesmo padrão do `refund-live declarado (provider recusa cash-receipt)` no `CHANGELOG Unreleased`, P3B-live — aqui sem `receiveInCash` explícito, mas cobrança liquidada fora de trânsito bancário contestável). Ou seja: **o caminho de execução está provado contra o provider real; o efeito `KNOWN_APPLIED/SUCCEEDED` exige liquidação fiel via dashboard (gate G1)**, fora do escopo desta task.
- Consequência p/ o critério 2 da task: `SUCCEEDED/APPLIED`, `PARTIALLY_REFUNDED` (500→400) e reconciliação do refund **NÃO atingidos por recusa do provedor, não por falha do código** — nenhum retry forçado foi feito (novo `execute` exigiria novo request + nova aprovação humana; fora da autorização deste ciclo).

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\iptv-loopblt2\looppix4-driver.cjs` (com `NODE_PATH` p/ `pg`; `ASAAS_*` só em-processo) → gate `SANDBOX_OFFICIAL`; `register2 201`; `membership2 tenant_owner`; `login2 200`; `session1-refresh`; `self-approve-control 409 PRECONDITION_FAILED` (controle negativo); `approve 201 APPROVED`; `request-state APPROVED/100`; `execute 201 RECONCILING/UNKNOWN` (`EXEC_IDS::{refundId:01a11d5e-…, effectCertainty:UNKNOWN}`); `payment-state CONFIRMED/500`.
2. `node %TEMP%\opencode\iptv-loopblt2\looppix4-partb.cjs` → `reconcile-refund 201 FAILED/KNOWN_NOT_APPLIED`; falha de query de ledger (`t.type` inexistente — corrigida nas partes C/E; sem efeito no produto).
3. `node %TEMP%\opencode\iptv-loopblt2\looppix4-partc.cjs` → `payment CONFIRMED/500`; `request EXECUTED/100`; `db-state` refund `FAILED/KNOWN_NOT_APPLIED/100` + `reversalLines:0`; `provider RECEIVED/5`; `provider-refund 404`; `over-refund-probe 500 → 201` (sonda equivocada: 500 = restante); `cleanup-payment 400`; `cleanup-customer 200 deleted:true`; `cleanup-confirm payment 200 RECEIVED/customer deleted:true`; `lane KEPT-UP`.
4. `node %TEMP%\opencode\iptv-loopblt2\looppix4-partd.cjs` → `request-list` (500 `UNDER_REVIEW` + 100 `EXECUTED`); `over-refund-probe-600 → 409 PRECONDITION_FAILED` (`600 exceeds remaining refundable 500`, PASS verdadeiro).
5. `node %TEMP%\opencode\iptv-loopblt2\looppix4-parte.cjs` → `requests-db` (review da sonda 500: `01a11d5f-.`); `provider-ref-prefix pay_v2o0qw0j` (reserva = cobrança externa); `reject-probe500 201 REJECTED`; `request-list-after` (100 `EXECUTED` + 500 `REJECTED`, zero pendente); `lane KEPT-UP`.
6. Ajustes dos drivers durante a execução (fora do repo, sem efeito no produto): colunas reais do ledger (`finance.financial_transactions.transaction_type`, `finance.financial_accounts.account_code`, sem `billing.ledger_*`); sem `GET /v1/refunds` (lista inexistente — estado do refund via `billing.refunds` SQL read-only); ordenação por `started_at` (sem `created_at` em `billing.refunds`).

## Riscos residuais (pós-LOOP-PIX-4)

- Resíduo no sandbox: 1 payment PIX `RECEIVED` de R$ 5,00 (`pay_v2o0qw0j4ishv0nw`, invoice 18656061) **não removível** por regra do Asaas (só pendentes/vencidas) — conta sandbox descartável, sem notificações (customer removido). Somado ao resíduo do loop boleto (ver `live-refund-exec.md` § Riscos).
- Customer `cus_000009395615` com `deleted:true` (removido; ainda legível com flag, comportamento do Asaas).
- Refund `01a11d5e-844c-7693-9cf5-eb5f79e7144b` terminal `FAILED/KNOWN_NOT_APPLIED` + request `01a11d57-2971-75ca-bddc-6bc7b395b8d8` `EXECUTED` (consumido); sonda 500 `REJECTED` (sem efeito): novo ciclo de refund exige novo request + nova aprovação 2º-humano (G1: liquidação fiel via dashboard p/ efeito `KNOWN_APPLIED`).
- 2º usuário (`looppix4-approver-…@example.test`, tenant próprio descartável + membership `tenant_owner` no tenant scratch) vive só no banco scratch; expira com ele. Tokens/senhas só em `%TEMP%` (fora do repo), nunca commitados.
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação vale para sandbox.
