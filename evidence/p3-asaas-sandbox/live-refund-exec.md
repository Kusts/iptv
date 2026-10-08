# LOOP-REFUND-1 — reconcile + pedido de refund parcial (PARADO antes de aprovar/executar)

- TASK_ID: LOOP-REFUND-1
- Data (UTC): 2026-10-08
- Base: sem alterações de código-fonte; só este arquivo criado; sem commit/push
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (scripts em `%TEMP%\opencode\iptv-loopblt2` e `%TEMP%\opencode\iptv-loopblt3`, fora do repo; só presença/host/vereditos impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer chamada (qualquer outro host abortaria com BLOCKED e zero chamadas);
  zero segredos em outputs/arquivos (token de sessão, `ASAAS_API_KEY` nunca impressos nem persistidos no repo);
  lane piloto (`iptv-pilot`, :3200/:3201) NUNCA tocada — verificada apenas via leitura (`docker ps`);
  produção NUNCA tocada.

## Lane scratch reutilizada (`-p iptv-loopblt2`) — MANTIDA UP

- Postgres próprio `127.0.0.1:55435` (projeto `iptv-loopblt2`) — saudável; API `http://127.0.0.1:3311` (`/v1/health/ready → ok`).
- Estado em `%TEMP%\opencode\iptv-loopblt3\loopblt3-state.json` (contém token — FORA do repo, nunca commitado).
- Driver desta task em `%TEMP%\opencode\iptv-loopblt3\looprefund1-driver.cjs` (fora do repo).

## Tabela passo:veredito (via NOSSA API na scratch lane, `ASAAS_ADAPTER=real`)

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Gate 0 — afirmar `api-sandbox.asaas.com` antes de qualquer chamada | PASS | parse do `.env` em-processo → `{adapter:"real", keyPresent:true, keyShape:"sandbox-shaped(redacted)", host:"api-sandbox.asaas.com", verdict:"SANDBOX_OFFICIAL"}` |
| Provider readback (somente status/valor) | PASS | `GET /v3/payments/pay_49lpfurhek93or49 → 200 {status:RECEIVED, billingType:BOLETO, value:10, confirmedDate:2026-10-08}` |
| 1. Reconcile da charge | PASS | `POST /v1/charges/01a11d3e-…/reconcile → 201 {status:PAID, outcome:confirmed}` (nota: 1ª tentativa sem header `x-tenant-context-revision` → `409 TENANT_CONTEXT_CONFLICT`, e sem corpo com `content-type` → `400`; corrigido com header TCR + sem `content-type` em POST sem corpo) |
| 1a. Charge PAID | PASS | `GET /v1/charges → {status:PAID, payment_method:BOLETO, amount_minor:1000, paid_at:2026-10-08T20:43:05.991Z}` |
| 1b. Payment CONFIRMED | PASS | `GET /v1/payments → {status:CONFIRMED, amount_minor:1000, confirmed_at:2026-10-08T20:43:05.991Z}` (id interno `01a11d41-…`) |
| 1c. Ledger balanceado | PASS | SQL read-only no scratch: `PAYMENT_CONFIRMATION` → `DEBIT CASH_ASAAS_PIX 1000` + `CREDIT RECEIVABLE_ORDERS 1000` BRL (deb=1000, cred=1000); order `SETTLED` |
| 1d. Exceptions vazias | PASS | `GET /v1/billing-exceptions → []` |
| 2. Refund request PARCIAL R$ 2,00 (`amountMinor:"200"`) | PASS | `POST /v1/refund-requests → 201 {status:UNDER_REVIEW}` (request `01a11d41-…`, review `01a11d41-…`); `GET /v1/refund-requests → UNDER_REVIEW, amount_minor:200, decided_at:null, executed_at:null` |
| 3. PARAR antes de aprovar/executar/limpar | CUMPRIDO | Nenhum `human_review.approve`, nenhum `refund-requests/:id/execute`, nenhum `DELETE` no sandbox; lane DB MANTIDA UP, ids de retomada abaixo |

## Retomada p/ aprovação do operador (refund UNDER_REVIEW — ponto de retomada)

- Charge: `01a11d3e-0fe4-75b0-a7ec-0c538eae273f` (PAID) · Order: `01a11d3e-0cd7-77cb-9c51-3aca4751fb29` (SETTLED)
- Asaas customer: `cus_000009394296` · Asaas payment: `pay_49lpfurhek93or49` (`RECEIVED` no sandbox)
- Payment interno: `01a11d41-5f87-7750-ba9b-2b61b628fef4` (CONFIRMED, 1000 BRL)
- Refund request: `01a11d41-619a-73a1-a767-eee15d357e64` (UNDER_REVIEW, 200 BRL) · Review: `01a11d41-619a-73a1-a767-f3bfb5569006`
- Próximo passo do OPERADOR no chat: aprovar (outro usuário que não o solicitante) e então executar — na lane `iptv-loopblt2` (API `:3311`, postgres `:55435`, token em `%TEMP%\opencode\iptv-loopblt3\loopblt3-state.json`).
- Limpeza pós-refund (quando autorizado): `DELETE /payments/pay_49lpfurhek93or49` + `DELETE /customers/cus_000009394296` no sandbox. Lane `iptv-loopblt2` compartilhada com a BOLETO-2 — derrubar (`down -v` + encerrar API) SOMENTE quando ambas as partes autorizarem.

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\iptv-loopblt2\env-gate0.cjs` → `SANDBOX_OFFICIAL` (sem segredos).
2. `curl.exe -s http://127.0.0.1:3311/v1/health/ready` → `{"status":"ok","checks":{"database":"ok"}}`; `docker ps` (leitura) → `iptv-loopblt2-postgres Up (healthy)` em `127.0.0.1:55435`; pilot intacto.
3. `node %TEMP%\opencode\iptv-loopblt3\looprefund1-driver.cjs` → gate `SANDBOX_OFFICIAL`; reconcile `201 PAID/confirmed`; verify charge `PAID` + payment `CONFIRMED` + exceptions `[]` + order `SETTLED`; provider `RECEIVED/BOLETO/10`; refund.request `201 UNDER_REVIEW`.
4. `node %TEMP%\opencode\iptv-loopblt3\ledger-check.cjs` (SQL read-only no scratch) → 2 linhas `PAYMENT_CONFIRMATION` (`CASH_ASAAS_PIX` DEBIT 1000 / `RECEIVABLE_ORDERS` CREDIT 1000 BRL), `balance:[{deb:1000, cred:1000}]`.

## Riscos residuais (LOOP-REFUND-1, antes da execução — superados abaixo, ver seção LOOP-REFUND-2)

- Resíduo intencional no sandbox (1 customer + 1 payment BOLETO `RECEIVED` de R$ 10,00) até aprovação/execução/limpeza do operador — conta sandbox descartável, sem notificações (customer sem email/telefone). Somado ao resíduo da BOLETO-2 (1 customer + 1 payment `PENDING`).
- Refund request `UNDER_REVIEW` de R$ 2,00 pendente de aprovação humana (outro aprovador exigido pelo revalidador) — sem efeito financeiro até `execute_approved`.
- Token de sessão desta task vive em `%TEMP%\opencode\iptv-loopblt3\loopblt3-state.json` (fora do repo); expira com o banco scratch. Estado da BOLETO-2 intocado.
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação vale para sandbox.

---

# LOOP-REFUND-2 — aprovação 2º humano + execute + verificação + limpeza (AUTORIZADO pelo operador no chat)

- TASK_ID: LOOP-REFUND-2
- Data (UTC): 2026-10-08
- Base: sem alterações de código-fonte; só esta seção ANEXADA a este arquivo; sem commit/push
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (drivers em `%TEMP%\opencode\iptv-loopblt3`, fora do repo; só presença/host/vereditos impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer chamada (qualquer outro host abortaria com BLOCKED e zero chamadas);
  zero segredos em outputs/arquivos (tokens de sessão, `ASAAS_API_KEY`, senhas nunca impressos nem persistidos no repo);
  lane piloto (`iptv-pilot`, :3200/:3201) NUNCA tocada — verificada apenas via leitura (`docker ps`);
  produção NUNCA tocada.
- Drivers desta task (fora do repo): `%TEMP%\opencode\iptv-loopblt3\looprefund2-driver.cjs` (aprovação+execute),
  `%TEMP%\opencode\iptv-loopblt3\looprefund2-partb.cjs` (verificação+probe+cleanup),
  `%TEMP%\opencode\iptv-loopblt3\cleanup-probe.cjs` (corpo do 400 no DELETE do payment).

## Tabela passo:veredito (via NOSSA API na scratch lane, `ASAAS_ADAPTER=real`)

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Gate 0 — afirmar `api-sandbox.asaas.com` antes de qualquer chamada | PASS | parse do `.env` em-processo → `SANDBOX_OFFICIAL` (`api-sandbox.asaas.com`, adapter `real`) |
| Lane scratch UP + pilot intacto | PASS | `GET /v1/health/ready → ok`; `docker ps` (leitura): `iptv-loopblt2-postgres Up (healthy)` em `127.0.0.1:55435`; pilot `:3200/:3201` Up, intocado |
| 1. Registro 2º humano + membership `tenant_owner` no tenant solicitante (owner SQL) + login | PASS | `POST /v1/auth/register → 201` (user `01a11d48-.`); owner-SQL `insert into control.tenant_memberships … tenant_owner/ACTIVE` (upsert por conflito); `POST /v1/auth/login → 200` + `GET /v1/auth/session` (TCR fresco do aprovador); sessão solicitante revalidada (`GET /v1/auth/session → 200`, TCR atualizado) |
| 2. Controle negativo: self-approval do solicitante | PASS (rejeitado como esperado) | `POST /v1/human-reviews/<review>/approve` (solicitante) → `409 PRECONDITION_FAILED` (revalidador `refundTargetRevalidator`: self-approval proibido) |
| 3. Aprovação do review por 2º humano | PASS | `POST /v1/human-reviews/01a11d41-…/approve` (aprovador, TCR próprio) → `201 {resolution:"APPROVED"}`; `GET /v1/refund-requests` → request `01a11d41-…` `APPROVED`, `amount_minor:200` |
| 4. Execute com a sessão solicitante | EXECUTADO, efeito `KNOWN_NOT_APPLIED` (ver finding) | `POST /v1/refund-requests/01a11d41-…/execute` (solicitante) → `201 {refundId:01a11d48-…, status:"FAILED", effectCertainty:"KNOWN_NOT_APPLIED"}` — provider recusou o refund (4xx no `POST /payments/pay_49lpfurhek93or49/refund`); request consumido (`EXECUTED`, `decided_at`+`executed_at` carimbados) |
| 5. Payment interno segue `CONFIRMED` 1000, sem reversão (correto p/ `KNOWN_NOT_APPLIED`) | PASS | `GET /v1/payments` → `CONFIRMED/1000`; SQL read-only: refund `FAILED/KNOWN_NOT_APPLIED/200` sem `provider_external_id`; zero linhas `REFUND_REVERSAL` (`finance.*`); nenhuma reversão postada — invariante preservado (só `KNOWN_APPLIED` finaliza + reverte) |
| 6. Provider readback | PASS (informativo) | `GET /v3/payments/pay_49lpfurhek93or49 → 200 {status:RECEIVED, value:10, invoiceNumber:18654571}` — cobrança intacta, nenhum efeito financeiro |
| 7. Reconcile do refund | PASS (rejeição esperada) | `POST /v1/refunds/<refund>/reconcile` → `409 PRECONDITION_FAILED` (`refund is FAILED; reconcile requires RECONCILING`) — terminal `FAILED` não reconcilia, por desenho |
| 8. Invariante sem over-refund (probe acima do restante) | PASS (rejeitado como esperado, zero efeito) | `POST /v1/refund-requests {paymentId, amountMinor:"1100"}` (restante 1000, refund anterior `FAILED` não consome) → `409 PRECONDITION_FAILED` (`over-refund rejected: 1100 exceeds remaining refundable 1000`); nenhum `refund.request` criado |
| 9. Cleanup sandbox | PARCIAL (limite do provedor, documentado) | `DELETE /v3/customers/cus_000009394296 → 200 {deleted:true}` (GET posterior: `deleted:true` — removido); `DELETE /v3/payments/pay_49lpfurhek93or49 → 400 invalid_action` (corpo: `Só é possível remover cobranças pendentes ou vencidas` — cobrança `RECEIVED` não pode ser removida, regra do Asaas) |
| 10. Lane MANTIDA UP (compartilhada com BOLETO-2) | CUMPRIDO | Nenhum `down -v`, nenhuma API encerrada; `KEPT-UP http://127.0.0.1:3311 + pg 127.0.0.1:55435` |

## FINDING principal (honesto): refund recusado pelo provedor — `KNOWN_NOT_APPLIED`

- O ciclo de domínio funcionou de ponta a ponta (request → 2º-humano aprova → execute serializado por payment → adapter real chamado com o id EXTERNO `pay_…`, nunca o UUID interno → recusa 4xx classificada `KNOWN_NOT_APPLIED` → refund `FAILED` terminal + request `EXECUTED`/consumido, sem ledger, sem efeito).
- O Asaas Sandbox recusou `POST /payments/pay_49lpfurhek93or49/refund {value:"2.00"}` com 4xx. A cobrança nasceu via `receiveInCash` (boleto confirmado em dinheiro, sem trânsito bancário) — o mesmo motivo documentado do `refund-live declarado (provider recusa cash-receipt)` no `CHANGELOG Unreleased` (P3B-live). Ou seja: **o caminho de execução está provado contra o provider real; o efeito `KNOWN_APPLIED/SUCCEEDED` exige liquidação fiel via dashboard (gate G1)**, fora do escopo desta task.
- Consequência p/ o critério 2 da task: `SUCCEEDED/APPLIED`, `PARTIALLY_REFUNDED` (1000→800) e reconciliação do refund **NÃO atingidos por recusa do provedor, não por falha do código** — nenhum retry forçado foi feito (novo `execute` exigiria novo request + nova aprovação humana; fora da autorização deste ciclo).

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\iptv-loopblt3\looprefund2-driver.cjs` (com `NODE_PATH` p/ `pg`; `ASAAS_*` só em-processo) → gate `SANDBOX_OFFICIAL`; `register2 201`; `membership2 tenant_owner`; `login2 200`; `session1-refresh`; `self-approve-control 409 PRECONDITION_FAILED` (controle negativo); `approve 201 APPROVED`; `request-state APPROVED/200`; `execute 201 FAILED/KNOWN_NOT_APPLIED` (`EXEC_IDS::{refundId:01a11d48-…, effectCertainty:KNOWN_NOT_APPLIED}`); `payment-state CONFIRMED/1000`.
2. `node %TEMP%\opencode\iptv-loopblt3\looprefund2-partb.cjs` → `db-state` (refund `FAILED/KNOWN_NOT_APPLIED/200` sem provider-ref; request `EXECUTED`; payment `CONFIRMED/1000`; `reversalLines:[]`); `provider 200 RECEIVED/10`; `reconcile-refund 409` (esperado); `over-refund-probe 409` (esperado); `cleanup-payment 400`; `cleanup-customer 200 deleted:true`; `cleanup-confirm payment 200/customer 200`; `lane KEPT-UP`.
3. `node %TEMP%\opencode\iptv-loopblt3\cleanup-probe.cjs` → `delPayHttp:400 errors:[{code:invalid_action, description:"…Só é possível remover cobranças pendentes ou vencidas."}]`; `getCusHttp:200 deletedFlag:true`.
4. Ajustes do driver durante a execução (fora do repo, sem efeito no produto): `require('pg')` via `NODE_PATH` (resolução de módulo a partir de `%TEMP%`); nomes reais das tabelas ledger (`finance.financial_transactions` + `finance.financial_ledger_entries`, colunas `financial_transaction_id`/`financial_account_id`/`direction`, migração `005_billing_finance`).

## Riscos residuais (pós-LOOP-REFUND-2)

- Resíduo no sandbox: 1 payment BOLETO `RECEIVED` de R$ 10,00 (`pay_49lpfurhek93or49`, invoice 18654571) **não removível** por regra do Asaas (só pendentes/vencidas) — conta sandbox descartável, sem notificações (customer removido). Somado ao resíduo da BOLETO-2 (1 customer + 1 payment `PENDING`, lane compartilhada UP).
- Customer `cus_000009394296` com `deleted:true` (removido; ainda legível com flag, comportamento do Asaas).
- Refund `01a11d48-…` terminal `FAILED/KNOWN_NOT_APPLIED` + request `EXECUTED` (consumido): novo ciclo de refund exige novo request + nova aprovação 2º-humano (G1: liquidação fiel via dashboard p/ efeito `KNOWN_APPLIED`).
- 2º usuário (`looprefund2-approver-…@example.test`, tenant próprio descartável + membership `tenant_owner` no tenant scratch) vive só no banco scratch; expira com ele. Tokens/senhas só em `%TEMP%` (fora do repo), nunca commitados.
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação vale para sandbox.
