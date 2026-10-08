# P3B-ASAAS — Certificação Sandbox oficial (NENHUMA chamada fora de Sandbox)

- TASK_ID: P3B-ASAAS
- Data (UTC): 2026-10-08
- Base afirmada ANTES de qualquer chamada (leitura in-processo, só presença/veredito; nenhum valor impresso):
  **SANDBOX_OFFICIAL** — `ASAAS_BASE_URL` contém `sandbox.asaas.com`; `ASAAS_API_KEY: present (redacted)`,
  `ASAAS_ADAPTER: set (redacted, len 4)`. Qualquer base fora de `sandbox.asaas.com` abortaria com BLOCKED e zero chamadas.
- Regra aplicada: **zero chamadas fora de Sandbox**; **zero valores/headers/tokens/payloads com segredo** em outputs, logs ou arquivos.
  Única chamada live executada: 1× `GET /payments/<id-inexistente>` (somente leitura, efeito colateral nenhum).
  Nenhuma cobrança live foi criada; produção nunca tocada.
- Adapter em código: `EchoAsaasAdapter` (default, sem rede) + `RealAsaasAdapter` (env-gated `ASAAS_API_KEY`+`ASAAS_BASE_URL`;
  timeouts/transporte → `UNKNOWN`, sem auto-retry de create) — `apps/api/src/billing/asaas-port.ts`.

## Vereditos da matriz SPEC (contra Sandbox)

| Caso | Veredito | Evidência (resumida, sem segredos) |
|------|----------|-------------------------------------|
| PIX lifecycle (create→pay→confirmado) | SANDBOX_CERTIFIED (software) / BLOCKED (live) | Software: `EchoAsaasAdapter.createPixCharge` ok/failed/unknown + `RealAsaasAdapter` 2xx-com-id→KNOWN_APPLIED / sem-id→UNKNOWN / não-2xx→KNOWN_NOT_APPLIED; unit 51/51 verde (fetch mockado, sem rede). Live BLOCKED: o stub posta `/payments` só com `billingType/value/externalReference` (`asaas-port.ts:419`, sem vínculo de customer, que a API Asaas exige) — nenhum charge live criado e nenhuma simulação de pagamento executada (exigiria customer sandbox próprio + simulação via dashboard, gate do operador). |
| webhook auth (canal válido/inválido) | PASS (código; integração existente, não re-executada aqui) | `asaas-webhook.service.ts`: segredo por canal (`billing.tenant_channels.webhook_secret_hash`, timing-safe, sem fallback global); canal sem hash → 503 antes de efeitos. Integração cobre: segredo errado→401, endpoint desconhecido→404, alias legado `x-asaas-secret`→202, canônico `asaas-access-token` prevalece (`commerce-billing.integration.test.ts:537-560`). |
| duplicate webhook (1 efeito) | PASS (código; integração existente) | Inbox insert-once por (tenant, provider, external event id) + confirm idempotente (`payment-confirmation:<charge>`); 2ª entrega → `{deduped:true}`, 1 payment, nº de transactions inalterado (`commerce-billing.integration.test.ts:443-475`). |
| reordered/delayed webhook (converge sem duplicar) | PASS por mecanismo, com ressalva | Mesmo mecanismo do item duplicate (mesmo event id → dedupe; confirm idempotente; `?defer=1` + `drainPending` para delayed — `asaas-webhook.controller.ts:20-21`, `asaas-webhook.service.ts:249-259`). **Ressalva**: nenhum teste dedicado de reordenação observado; convergência decorre do mesmo id de evento + confirm idempotente. |
| reconciliation vs truth | PASS (unit 51/51) + PASS (live somente-leitura) | Unit mockado: RECEIVED/CONFIRMED/REFUNDED→PAID, OVERDUE→PENDING, 404→FAILED, 500→UNKNOWN, corpo malformado/transporte→UNKNOWN; guarda sintética (ref local nunca consultada como prova). Live: `GET` id inexistente `pay_*` → HTTP 404 → mapeado FAILED (prova conectividade + auth aceita — 404 e não 401 — sem efeitos). |
| refund flow (solicitação→HITL→execução) + concurrent/duplicate refund (sem over-refund) | PASS (código; integração existente) | `refund.request` só cria linha + HumanReview (nunca executa); aprovador ≠ solicitante; `refund.execute_approved` com `pg_advisory_xact_lock` por payment + TTL de aprovação + reserve-first; KNOWN_APPLIED posta reversão, KNOWN_NOT_APPLIED libera, UNKNOWN estaciona RECONCILING. Integração: 2 parciais concorrentes OK + 3º over-refund rejeitado (`:611`); aprovação stale rejeitada (`:688`); UNKNOWN→reconcile→applied (`:746`). |
| UNKNOWN effect (exceção, sem efeito duplicado) | PASS (unit 51/51) | Timeout/abort→UNKNOWN + ref `unknown-` (charge segue PROCESSING + reconcile, nunca auto-retry); ref sintética→UNKNOWN sem chamada; 2xx sem id→UNKNOWN; tampered amount→`AMOUNT_MISMATCH` (nunca confirma); charge desconhecido→`UNKNOWN_CHARGE` (integração `:477-535`). |
| ledger invariants (soma/transações balanceadas) | PASS (código; integração existente) | Confirmação idempotente posta Dr-caixa/Cr-receita + settlement tudo-ou-nada; todo teste de integração asserta `assertLedgerBalancedDb` (toda transaction ≥2 entries, net 0 por moeda — `:243-269`). |

## Comandos (literais sanitizados) + saídas resumidas

1. `node <tmp>/asaas-env-check.cjs` (lê `.env` in-processo, imprime só presença/veredito)
   → `ASAAS_ADAPTER: set-redacted`, `ASAAS_API_KEY: set-redacted`, `ASAAS_BASE_URL: set-redacted`, `baseVerdict: SANDBOX_OFFICIAL`. Nenhum segredo impresso.
2. `pnpm --filter @iptv/api test --run test/commerce-billing.unit.test.ts`
   → **51/51 PASS** (`commerce-billing.unit.test.ts`, fetch mockado, zero rede). Cobre mapeamentos PAID/PENDING/FAILED/UNKNOWN, guardas de namespace sintético/echo, BRL-only, refund por id externo (nunca uuid interno).
3. `node <tmp>/asaas-sandbox-probe.cjs` (afirma Sandbox ou aborta; 1× GET somente-leitura de id inexistente `pay_*`, imprime só status/efeito/forma)
   → `affirmed: SANDBOX_OFFICIAL`, `keyPresent: true`, `httpStatus: 404`, `mappedEffect: FAILED`, `sideEffects: none`. Nenhum segredo impresso; nenhuma escrita.
4. `node <tmp>/asaas-db-check.cjs` → `TEST_DATABASE_URL: empty-absent` — sem banco descartável; suítes de integração
   (`commerce-billing.integration.test.ts`, `billing-rls-rehearsal`) citadas como evidência de código, NÃO re-executadas aqui.

## Referências de contrato (leitura, sem alteração)

- `apps/api/src/billing/asaas-port.ts` (Echo default + Real env-gated, UNKNOWN sem retry, guardas de namespace)
- `apps/api/src/billing/asaas-normalizer.ts` (PAID/chargeback/unknown; amount UNTRUSTED, confirm valida contra charge interno)
- `apps/api/src/billing/asaas-webhook.{controller,service}.ts` (auth por canal timing-safe, 202 fast ack, `?defer=1` + `drainPending`)
- `apps/api/src/billing/billing.commands.ts` (charge create/reconcile, confirm idempotente, refund HITL + advisory lock + TTL)
- `apps/api/test/commerce-billing.unit.test.ts` (51 testes, fetch mockado), `apps/api/test/commerce-billing.integration.test.ts` (happy path, dedupe, tamper, auth, refunds concorrentes/stale/UNKNOWN, ledger)
- `docs/04-specs/integrations/asaas.md` (contrato at-least-once, idempotência, reconciliação, failure behavior)

## BLOCKERS — pedidos ao operador (produção NUNCA autorizada aqui)

- **B1 (lifecycle live completo):** pede-se autorizar explicitamente: (a) customer sandbox próprio descartável;
  (b) evolução do `RealAsaasAdapter.createPixCharge` para vínculo de customer (hoje o stub não envia customer);
  (c) janela para 1× create descartável + simulação de pagamento via dashboard/API sandbox + webhook PAID + reconcile vs truth + refund live + limpeza.
  Sem B1, o item PIX-live permanece BLOCKED e nada é promovido além do certificado em software.
- **B2 (re-execução integração):** prover `TEST_DATABASE_URL` descartável e VAZIO exportado no shell para rodar
  `commerce-billing.integration.test.ts` + `billing-rls-rehearsal` (migrations aplicadas pelo próprio `beforeAll`).
