# P3B-FULL-LOOP — Golden Loop Sandbox via nossa API (NUNCA produção, NUNCA lane piloto)

- TASK_ID: P3B-FULL-LOOP
- Data (UTC): 2026-10-08
- Base: main@5052b85 + #29 (sem alterações de código; este arquivo é a ÚNICA escrita no repo; sem commit/push)
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (script em `%TEMP%`, fora do repo; só presença/host/veredito impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer consideração de chamada; zero segredos/payloads em outputs/arquivos;
  lane piloto (`iptv-pilot`, :3200/:3201) NUNCA tocada — verificada apenas via `docker ps`/`docker compose ls` (leitura);
  produção NUNCA tocada; NENHUMA chamada live Asaas executada neste loop (zero writes, nada a limpar no sandbox).

## Gate 0 — afirmação de base (antes de qualquer chamada; leitura em-processo, sem valores)

- `node %TEMP%\opencode\p3b-loop-env-check.cjs` (parse do `.env` em-processo; imprime só presença/host/veredito)
  → `{adapterPresent:true, keyPresent:true, host:"api-sandbox.asaas.com", verdict:"SANDBOX_OFFICIAL"}`.
  Nenhum segredo impresso. Qualquer host fora de `api-sandbox.asaas.com` abortaria com BLOCKED e zero chamadas.
- Piloto intacta (somente leitura): `docker ps` mostra `iptv-pilot-api` (127.0.0.1:3201), `iptv-pilot-web` (127.0.0.1:3200),
  `iptv-pilot-postgres`, `iptv-pilot-outbox-worker` em `Up`; `docker compose ls` confirma projetos
  `iptv-cutover`, `iptv-pilot`, `iptv-staging-p0` — nenhum comando foi executado contra eles.

## Tabela passo:veredito:evidência

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| 1. Lane scratch fresca (`-p iptv-loop-N`, migrate + seeds) com `ASAAS_ADAPTER=real` → Sandbox | NÃO-EXECUTADA (bloqueio a jusante provado estaticamente) | Lane NÃO criada de propósito: o passo 2 está BLOCKED por gap de contrato (abaixo) com resultado determinístico (400 `invalid_object` sem `customer`, já provado no diagnóstico live-b1). Criar infra (postgres+API em portas livres) só para reproduzir um 400 conhecido adicionaria risco de conflito com 4 stacks ativas sem valor. Nada a destruir (nenhum container/volume/rede `iptv-loop-*` criado). |
| 2a. Registrar usuário/tenant descartável via nossa API | BLOCKED (herdado do gap do charge) | Não tentado: sem charge funcional não há loop a ancorar; criação avulsa de tenant sem o restante do ciclo seria resíduo sem propósito. Rotas de ordem existem (`POST /v1/orders/quote`, `POST /v1/orders/:id/submit` — `commerce.controller.ts:85-100`) mas não acionadas. |
| 2b. Criar order → charge via nossa API com `ASAAS_ADAPTER=real` | BLOCKED (gap de wiring, determinístico) | `chargeCreateInput` NÃO tem `providerCustomerId` (`billing.commands.ts:171-176`); o handler chama `port.createPixCharge({chargeId, valueMinor, currency, payer:{personId}})` SEM o binding (`:300-305`); o insert em `billing.charge_provider_bindings` grava `external_customer_id: null` (`:336`). O `RealAsaasAdapter` envia `customer` SOMENTE quando o binding explícito existe (`asaas-port.ts:458-470`); sem ele o provider rejeita (400 `invalid_object` — diagnóstico já provado em `live-b1.md`: "PIX exige CPF/CNPJ do customer"). Resultado esperado via nossa API: `KNOWN_NOT_APPLIED` + charge PENDING com ref `rejected-*`, sem PROCESSING/PAID a jusante. Nenhuma chamada live feita para re-provar o 400. |
| 2c. Pagamento provider (binding + `receiveInCash`) | DECLARADO-não-executado | Herdado do 2b (sem charge PROCESSING não há `pay_*` para simular). Mecanismo documentado em live-b1 (ressalva: semântica de dinheiro, não liquidação PIX). Zero chamadas. |
| 2d. Webhook (duplicate + reordered replays) via nossa API | SOFTWARE-VERIFIED (citado, não re-executado aqui) | `commerce-billing.integration.test.ts` 16/16 + unit 55/55 cobrem dedupe/inbox/confirm idempotente (ver live-b1 §tabela + VALIDATION abaixo). Entrega Asaas→nós ao vivo segue arquiteturalmente impossível contra localhost (G2 de live-b1, mantido). |
| 2e. Reconcile vs truth | SOFTWARE-VERIFIED (citado) | Mesmo suite 16/16 ("webhook PAID → payment → balanced ledger → SETTLED", "UNKNOWN refund reconciles to applied"). Zero chamadas live. |
| 2f. Refund live | DECLARADO-não-executado (provider recusa, já provado) | `POST /payments/{id}/refund` contra recebimento-em-dinheiro → 400 `invalid_object` "somente cobranças recebidas ou confirmadas" (live-b1, 3 ciclos). Exigiria liquidação PIX via dashboard (G1 de live-b1, gate do operador). Nenhum dinheiro movido. |
| 2g. Ledger balanceado + 1 efeito econômico | SOFTWARE-VERIFIED (citado) | Todo teste de integração asserta `assertLedgerBalancedDb`; confirmação idempotente + settlement tudo-ou-nada (`billing.commands.ts:435-473`). Sem ciclo live, sem nova asserção. |
| 3. Gaps: corrigir se trivial ou RECORD | RECORDED (não implementado — decisão arquitetural do Planner) | Ver "GAP-LOOP-1" abaixo. Nenhum código alterado. |
| 4. Cleanup (sandbox + lane) | N/A — nada a limpar | Zero writes sandbox neste task (nenhum customer/charge criado); nenhuma lane `iptv-loop-*` criada (nenhum `docker down -v` necessário). Piloto/staging/cutover/test intactos. |

## GAP-LOOP-1 (operator-gate): `charge.create` não thread `providerCustomerId` — wiring NÃO-trivialmente-seguro

- Fatos (leitura, sem alteração):
  - Contrato de entrada: `chargeCreateInput = { orderId, paymentMethod, idempotencyKey?, dueAt? }` — sem campo de customer do provider
    (`apps/api/src/billing/billing.commands.ts:171-176`).
  - Chamada ao port: `{ chargeId, valueMinor, currency, payer: { personId } }` — sem `providerCustomerId` (`:297-306`).
  - Persistência: `charge_provider_bindings.external_customer_id: null` sempre (`:329-342`, `:336`).
  - Port aceita o binding (`PixChargeRequest.providerCustomerId?`, `asaas-port.ts:24-44`) e o envia quando presente (`:458-470`);
    sem ele, o stub posta sem `customer` e o provider rejeita (400 → `KNOWN_NOT_APPLIED`, charge fica PENDING — `:483-490`).
  - Não existe mapa pessoa→customer-Asaas no schema: a única coluna é `billing.charge_provider_bindings.external_customer_id`
    (`202609201601_005_billing_finance.sql:186-201`), sempre gravada null; nenhum endpoint a provisiona.
  - Contrato público: `POST /v1/charges` repassa `body` ao `charge.create` (`billing.controller.ts:84-93`); OpenAPI só cita
    `/v1/orders/{orderId}/charges` (`openapi.yaml:539`) — sem `providerCustomerId` em nenhum dos dois.
  - Requisito oculto do provider (live-b1): PIX exige customer com CPF/CNPJ — mesmo com wiring, o customer descartável
    precisa ser provisionado (com tax-id de teste) ANTES do charge, e nenhum endpoint faz isso hoje.
- Por que NÃO implementei (motivo exigido pela delegação):
  1. **Fronteira de confiança (Planner-owned):** aceitar `providerCustomerId` no request permite a qualquer chamador com
     `billing.charge.write` vincular QUALQUER customer Asaas do tenant (inclusive de outra pessoa) — sem validação de
     propriedade pessoa↔customer, que hoje não existe em lugar nenhum. A alternativa (lookup server-side pessoa→customer)
     exige nova tabela/fluxo de onboarding (cf. SPEC `05-provider-fulfillment`: idempotência por `(tenant, provider,
     external_customer_id)`) — decisão arquitetural, não microedição.
  2. **Contrato público:** adicionaria campo ao `charge.create` (+ OpenAPI + validação de formato `cus_*`/ownership) —
     mudança de contrato que o Planner deve aprovar.
  3. **Wiring sozinho não fecha o loop:** sem endpoint de provisionamento de customer (com CPF de teste) + canal/secret
     de webhook por tenant + URL pública (G2) + liquidação PIX via dashboard (G1), o loop seguiria BLOCKED nos passos
     seguintes. Implementar metade criaria vetor de spoofing sem entregar o golden loop.
- Sketch MÍNIMO (não aplicado; para decisão do Planner): `chargeCreateInput += { providerCustomerId: z.string().regex(/^cus_[A-Za-z0-9]+$/).optional() }`
  → thread no `createPixCharge` → persistir em `external_customer_id` → validar propriedade (pessoa↔customer) + teste de
  ownership (binding чужой rejeitado) + OpenAPI. Provisionamento de customer (com tax-id) como passo explícito separado.

## Gaps herdados de live-b1 (mantidos, não re-testados ao vivo)

- **G1 (liquidação PIX fiel):** exige clique manual no dashboard sandbox; sem ele, refund-live segue declarado.
- **G2 (webhook Asaas→nós ao vivo):** exige URL pública/túnel + tenant/canal ativos; localhost inalcançável.
- **G3 (reorder dedicado):** sem teste de reorder no suite; 1 teste `defer`+fora-de-ordem fecharia a ressalva (software).

## Comandos (literais sanitizados) + saídas resumidas

1. `node C:\Users\walis\AppData\Local\Temp\opencode\p3b-loop-env-check.cjs`
   → `{"adapterPresent":true,"keyPresent":true,"host":"api-sandbox.asaas.com","verdict":"SANDBOX_OFFICIAL"}` (sem segredos).
2. `docker ps --format ... | Select-Object -First 30` (somente leitura)
   → `iptv-pilot-*` Up (:3200/:3201), mais `iptv-cutover-*`, `iptv-staging-*`, `iptv-pg-test`, `buildx` — nada tocado.
3. `docker compose ls | Select-Object -First 20` (somente leitura)
   → `iptv-cutover`, `iptv-pilot`, `iptv-staging-p0` running — nada tocado.
4. `pnpm --filter @iptv/api test --run test/commerce-billing.unit.test.ts`
   → **55/55 PASS** (fetch mockado, zero rede; cobre PAID/PENDING/FAILED/UNKNOWN, guardas de namespace, BRL-only, refund por id externo).
5. Citados sem re-execução (sem banco descartável provisionado aqui; `TEST_DATABASE_URL` NÃO exportado):
   `commerce-billing.integration.test.ts` 16/16 + `billing-rls-rehearsal` (evidência em live-b1 §34 item 6, container removido após).

## Riscos residuais

- Loop via nossa API contra Sandbox SEGUE NÃO-CERTIFICADO (nenhum charge/processamento/liquidação via API neste task).
- Qualquer tentativa futura com `ASAAS_ADAPTER=real` sem GAP-LOOP-1 resolvido reproduz determinísticamente PENDING + `rejected-*`.
- 4 stacks ativas (pilot/cutover/staging/test-pg); lane futura `iptv-loop-N` deve usar portas livres (ex.: API 32xx sem colisão
  com 3000/3001/3100/3101/3200/3201) + projeto/volume/rede próprios + `docker down -v` do próprio projeto no fim.
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação, quando obtida, vale para sandbox.

## Recomendação ao Planner

1. Decidir o desenho de customer-binding (campo explícito validado vs. mapa pessoa→customer + endpoint de provisionamento com
   tax-id de teste) — GAP-LOOP-1 é pré-requisito de qualquer golden loop via nossa API; sem ele, P3B-FULL-LOOP permanece
   LIVE-BLOCKED por construção.
2. Só então autorizar nova janela sandbox descartável: lane `iptv-loop-N` → tenant/order/charge via API → dashboard (G1) →
   webhook via túnel (G2) → reconcile → refund parcial → cleanup, com evidência nesta mesma pasta.
3. Considerar o teste de reorder dedicado (G3, só software) em paralelo — independe do sandbox.
