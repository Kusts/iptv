# B1 fiel fechado — 2026-10-13 (conta Sandbox, lane piloto, operador executou o dashboard)

- TASK_ID: b1-evidence
- Data (UTC): 2026-10-13
- Base: `https://api-sandbox.asaas.com` (afirmado antes de qualquer chamada; fora deste arquivo não há segredos — nenhum token, webhook claro, hash, JWT, senha ou DATABASE_URL).
- Lane: piloto (`:3201`), canal `synkroo-iptv/ASAAS/ACTIVE`.

## Cobrança fiel (via nossa API na lane piloto)

- Charge interna `01a132a2-25a4-7368-9fa5-7ab801d99543` ↔ provider `pay_kwjsotvdjqadhynp` (PIX R$ 5,00).
- Customer `cus_000009442838` (novo, descartável, criado para este loop).
- Order `...252f...`: `AWAITING_PAYMENT → SETTLED`.
- Provider: `PENDING` + QR emitido → `RECEIVED` em 2026-10-12 via simulação no dashboard do operador.

## Tabela passo:veredito

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Webhook `POST /v1/webhooks/asaas/synkroo-iptv` | PASS | `→ 202 {accepted:true, deduped:false}` (confirmou inline) |
| Replay idêntico | PASS | `→ 202 {accepted:true, deduped:true}` (dedupe por `(tenant, asaas, event id)`; sem 2º efeito) |
| Fechamento de domínio | PASS | charge `PAID` + payment `CONFIRMED 500` + order `SETTLED` + ledger `PAYMENT_CONFIRMATION`/`ORDER_SETTLEMENT` balanceado |
| Reconcile direto | PASS-por-construção | `→ 409 PRECONDITION_FAILED` ("charge is PAID; reconcile requires PROCESSING") — o webhook já havia confirmado; recusa em vez de duplicar efeito |
| Entitlement | PASS-com-ressalva | zero linhas — ativação fora da lane, sem falha |
| Prova mecânica prévia `pay_mhjsoy439znjym1n` (direta, sem binding) | PASS-por-desenho | `→ 202` + `UNKNOWN_CHARGE OPEN` (desfecho correto por desenho) |
| Cleanup sandbox | PARCIAL-honesto | 3 customers deletados (`cus_...838`/`098`/`834`, `deleted:true`); 2 payments `RECEIVED` irremovíveis (`400 invalid_action` — resíduo conhecido); refund pulado por decisão do operador |
| Rollback | PASS | adapter piloto de volta a `echo`; override temporário deletado |

## Incidentes e residuais honestos

1. (a) Hash da linha pilot no banco default ficou órfão após rotação com segredo errado (original irrecuperável; rotação dedicada futura).
2. (b) Segredo errado inicial + trechos de env em logs de sessão — tratar logs como sensíveis.
3. (c) Túnel público `530` durante toda a janela (entrega Asaas→nós só via replay manual).
4. (d) Reconcile feliz no estado `PROCESSING` segue coberto só por testes.
5. (e) Usuário/membership de teste + 9 `UNKNOWN_CHARGE` sintéticas permanecem no banco piloto.

## Resíduo intencional no sandbox

- 2 payments `RECEIVED` (irremovíveis por regra do provider) + customer(s) de teste descartáveis; conta sandbox, sem notificações.
- Refund-live segue NÃO executado (decisão do operador) — sem promoção de F17; G07 intocado (diferido pós-MVP por ADR-0027).
