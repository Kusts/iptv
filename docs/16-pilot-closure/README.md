# Pilot Closure — Wave 17 (execução)

> Status: **IN_EXECUTION — P0** (2026-10-07)
> SPEC de origem: `IPTV Pilot Closure SPEC v1` + `IPTV Pilot Closure PLAN v1`
> (recebidos do operador nesta sessão; texto integral na proposta, não
> duplicado aqui).
> Revisão normativa: [`SPEC-PLAN-REVIEW.md`](SPEC-PLAN-REVIEW.md)
> Autoridade: este diretório **complementa** `docs/15-implementation-baseline/`
> e não o substitui. Em conflito, o baseline vence até ADR/revisão que o
> atualize (ver REVIEW §1).
> Registro de entrega: `CHANGELOG.md` (`## Unreleased`).

## Decisões jev (MCP jev, nesta sessão)

- `jev_decide`: interlock via **migration 051** com autoridade em DB
  (`opt_a_051_db`, conf. 0.66); documentar em **novo `docs/16-pilot-closure/`**
  (conf. 0.98); implementação em **fatias P0 primeiro** (conf. 0.97).
- `jev_gate` (migration 051 + docs + drift): `confirm`, risco 2.02, não-produção.
  Autorização do operador: pedido explícito "inicie a implementação completa".

## Fatias P0 (PRs `closure/p0-*`, um PLAN, sem PR gigante)

| Slice | Escopo | Dono | Estado |
|---|---|---|---|
| `p0-docs` | REVIEW + este README + drift count-agnostic + CHANGELOG | Planner | DONE nesta sessão |
| `p0-outbox-interlock` | migration 051 + gate legacy em DB + claim gate + testes | coder → tester → reviewer | DONE (Round 2 APPROVED + PASS) |
| `p0-worker-p2s` | shutdown/batch accounting + heartbeat em drain + roleGuard database-wide | coder → tester → reviewer | DONE (incluído no mesmo ciclo) |
| `p0-015-integration` | 015 pós-051 (postura+lifecycle sob WORKER; 016 mantém CAS/NULL/rollback) | coder → tester → reviewer | DONE (tester PASS ponta a ponta 001–016; reviewer R2 BLOCKED-somente-por-falta-de-shell suprido por evidência do planner: diff confirma só arquivos do escopo P0 aprovado, migrations 001–050 intactas, 3 gates Python verdes) |
| `p0-staging-10` | staging da issue #10 com 051 (cutover+rollback+restore com owners) | infra → tester → reviewer | DONE (tester PASS ao vivo + reviewer APPROVED; commit neste branch) |

## Ordem após P0 (PLAN v1, sem nova SPEC)

```text
P1 RLS ──────┬─ P2 Agent/Workflow (após contratos P1)
             ├─ P4 Frontend (usa backend existente)
             └─ preparação P3 (certificações só após staging seguro)
P3 live → P5 E2E → P6 Ops → P7 rehearsal → P8 pilot
```

## P1 status

| Slice | Escopo | Estado |
|---|---|---|
| `P1.1` inventário | `scripts/rls-inventory.sh` + `P1-RLS-INVENTORY.md` + `evidence/rls-inventory/20261007/` (26/149/21/5) | DONE nesta sessão (tester PASS + reviewer APPROVED; branch `closure/p1-rls-inventory`) |
| `P1.3` billing+finance (Tier 0, dinheiro-primeiro) | resolver `billing.tenant_channels` (043-shaped) + charges/payments/refunds/bindings/reconciliation + ledger/transactions/allocations/reversals + provas adversariais | DONE nesta sessão: 052 + 017/018 + wraps + rehearsal 5/5 sob `iptv_app` (tester PASS; reviewer final indisponível — self-review planner, re-review no PR); follow-ups P1-exit recorded (webhook-e2e, TOCTOU, sweep) |
| `P1.2` platform spine | inbox, idempotency, audit, domain events, global/hybrid catalogs (outbox feito) | DONE nesta sessão: 053 + 054 + 019/020/021 (tester PASS + reviewer APPROVED) |
| `P1.4–P1.6` | transacional → operacional → analítico + runtimes cross-tenant por tabela | P1.4 + P1.5 DONE; P1.6 DONE (059 + 026, tester PASS) — RLS cobre 149 - globals; resta P1-exit (cutover) |
| `P1-exit` | wraps residuais + matriz A/B + staging cutover + PgBouncer | DONE: parte 1 (matriz 16/16, tester PASS) + parte 2 (staging 059 A/B 4/4 direto/pooler, runbook CONDICIONAL); sem tester/reviewer independente na parte 2 — revalidar no merge |

## P2 status

| Slice | Escopo | Estado |
|---|---|---|
| `P2a` ADR + evals | ADR-0026 KEEP + 08 reescrita + fixtures 08–16 + thresholds | DONE (tester PASS) |
| `P2b` budgets/fallback | budgets/timeouts/fallback no harness + 18 testes | DONE (tester PASS 35/35) |
| `P2c` Hatchet gate | certificação W0-04 | NÃO certificável neste ambiente (sem servidor/token); local honesto + F12 BLOCKED (jev) |

## P3 status

| Slice | Escopo | Estado |
|---|---|---|
| `P3` integrações | Asaas software + stub customer; WAHA código/sintético; CINEVISION/MK/Infisical gates; Hatchet BLOCKED; register + `P3-INTEGRATIONS.md` + `evidence/p3-*/` | DONE sem live (tester PASS; lives = gates de operador: B1/B2, M1/M2, G07, Steps 3/6–9, F12) |

## P4 status

| Slice | Escopo | Estado |
|---|---|---|
| `P4a` revenue-ops | /crm /trials /billing /fulfillment /renewals /inventory + helper + NAV | DONE (tester PASS 116) |
| `P4b` growth/admin | /growth /referrals /resellers /finance /analytics + ext copilot/lar + NAV | DONE (tester PASS 122) |

## Artefatos finais (C9 + PLAN — acompanhar aqui)

RLS inventory · Worker inventory · Integration certification register ·
Agent evaluation report · Workflow runtime ADR · E2E G/F evidence matrix ·
Staging evidence · DR evidence · Security closure report · Performance report ·
Pilot evidence report · final release readiness report.
