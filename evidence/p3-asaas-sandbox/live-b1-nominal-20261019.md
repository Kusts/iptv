# B1 nominal fechado — 2026-10-19 (conta Sandbox, staging Contabo, sem replay manual)

- TASK_ID: b1-evidence
- Data (UTC): 2026-10-19
- Base: `https://api-sandbox.asaas.com/v3` (fora deste arquivo não há segredos — nenhum token, segredo de webhook, hash, senha ou DATABASE_URL).
- Lane: staging Contabo (`/home/deploy/iptv-staging`, fresh provision, migrate 60/60, túnel `iptv-staging` com 4 conexões, origem loopback).
- Tenant: `Operacao Piloto`, canal `piloto-iptv/ASAAS/ACTIVE` (bind criado nesta sessão; segredo gerado no host e entregue ao operador para o dashboard).

## Ciclo nominal (via API pública, adapter `real`)

- Person `01a1543a-6182-…` → quote → order `01a1543a-64c6-…`: `DRAFT → AWAITING_PAYMENT`.
- Provision Asaas → customer `cus_000009568951` (descartável, criado para este loop).
- `charge.create` → charge interna `01a1543b-e2a0-…` ↔ provider `pay_eofskqiotc4kvifs` (PIX R$ 5,00, `PROCESSING`, `effectUncertain=false`).
- Operador simulou o pagamento no dashboard; webhook Asaas entregou SOZINHO:
  `POST /v1/webhooks/asaas/piloto-iptv → 202` (exatamente 1 entrega em 90 min de logs; nenhum replay manual).
- Fechamento: charge `PAID` + payment `CONFIRMED` (1 linha, 500 BRL) + order `SETTLED` + ledger `DEBIT 2×1000 = CREDIT 2×1000` (balanceado).

## Tabela passo:veredito

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Webhook nominal | PASS | `→ 202` em 366 ms, confirmação inline, 1 entrega total |
| Fechamento de domínio | PASS | charge `PAID` + payment `CONFIRMED` + order `SETTLED` + ledger balanceado |
| Reconcile direto pós-PAID | PASS-por-construção | `→ 409 PRECONDITION_FAILED` ("charge is PAID; reconcile requires PROCESSING") — recusa em vez de duplicar efeito |
| Dedupe/carga duplicada | PASS-código | F01 (`commerce-billing` duplicate webhook no-op) + 1 payment row (sem duplicata) |
| Cleanup sandbox | PASS | customer `cus_000009568951` deletado (`DELETE → 200`) |
| Refund-live | NÃO executado | decisão do operador (igual ao loop 2026-10-13) — sem promoção de F17 |

## Incidentes e residuais honestos

1. Conta piloto inicial descartada e recriada (higiene de credencial; tenant órfãos `Piloto` e `Piloto Operacao` permanecem com linhas de auditoria — FK append-only, sem efeito operacional).
2. Valor de `ASAAS_API_KEY` no `.env` local carrega aspas simples (proteção contra `$` do compose); compose remove no container (166 chars efetivos). Probes manuais com aspas falham 401 — comportamento esperado, não defeito.
3. Payment `RECEIVED` correspondente permanece no sandbox (irremovível por regra do provider, como no loop anterior).
4. Scheduler segue `disabled` no staging Contabo (caminho F13 coberto por suíte; ativação é passo operacional separado).
5. Outbox worker dedicado NÃO ativado no staging Contabo (drain legacy default; ativação 051 é procedimento operacional separado).
