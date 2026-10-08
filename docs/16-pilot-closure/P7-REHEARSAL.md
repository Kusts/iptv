# P7 — Dress rehearsal + failure drills (lane descartável, sem tráfego real)

> TASK_ID: P7-REHEARSAL · branch `closure/p7-rehearsal` · 2026-10-08.
> Evidência executável: `evidence/p7-rehearsal/report.md` (+ `drills.log`,
> `suites-summary.log`). Este doc é roteiro + resultados + gaps; em conflito
> com `docs/15-implementation-baseline/`, o baseline vence.
> **WhatsApp real é SIMULADO via webhook sintético na API local** (gap §5);
> lives M1/M2/B1/G07 NÃO autorizados e NÃO executados.

## 1. Roteiro executado

1. Subir lane descartável: projeto docker `iptv-rehearsal`, postgres próprio em
   `127.0.0.1:5439`, volume próprio; 59 migrations + seeds + roles; API
   `127.0.0.1:3211` como `iptv_app` (NOBYPASSRLS); web rebuildada contra a API
   (`127.0.0.1:3210`).
2. Fluxo simulado: registro → canal WAHA → inbound sintético → quarentena →
   duplicate (idempotente) → person → resolve (map) → conversa → 2º inbound
   ingerido → reply manual (echo) → copilot determinístico. Pernas profundas
   (trial→offer→order→charge→subscription→renewal→ticket→refund→HITL) via
   11 suites / 105 testes na lane.
3. Drills com recuperação verificada: WAHA down, provider down, DB restart,
   worker kill, model outage, duplicate webhook, stale approval, backup
   restore (reuso `scripts/backup-dr.sh`, DRILL PASS 296s), secret rotation.
4. Cleanup: processos parados, chave/workdir do drill triturados, lane destruída.

## 2. Resultados (vereditos)

| Perna / drill | Veredito | Evidência |
|---|---|---|
| Lane 001–059 + seeds + api(`iptv_app`)/web | PASS | `report.md` §1; ready `{"status":"ok"}`; web `/` 200 |
| Fluxo live (inbound→conversa→reply→copilot) | PASS | `drills.log` [flow]; dedupe `deduped:true`, 1 linha inbox |
| Pernas profundas (11 suites) | PASS 105/105 | `suites-summary.log` |
| PIX sandbox | SKIP motivado | B1 bloqueado — parar no charge PENDING do echo (`commerce-billing` cobre o caminho) |
| WAHA down → recovery | PASS | `FAILED` 0.1s sem retry, inbound imune; reboot → `SENT` |
| Provider down → recovery | PASS (suite) | `provider-dispatch` 19/19: VERIFYING/UNKNOWN, sem reenvio; sem variante live HTTP |
| DB restart → recovery | PASS com achado | ready 200 pós-reboot, contagens iguais; **API cai no restart (exit 1)** — follow-up |
| Worker kill → reclaim | PASS | kill -9; fence com lease vivo (`claimed:0`); reclaim pós-expiração (`claimed:1/published:1`), 0 stranded |
| Model outage → fallback | PASS (suite+live) | `agent-model-failure` 6/6 + `copilot/ask` 201; sem live chave+endpoint morto |
| Duplicate webhook | PASS | live + suite (`commerce-billing` duplicate no-op) |
| Stale approval | PASS (rejeição) | suite; re-execução pós-stale NÃO exercitada live |
| Backup restore | PASS | DRILL PASS 296s, pré==pós, gate canônico 59==59 |
| Secret rotation | PASS | reload sem claims abandonados; sessão antiga sobrevive |

## 3. Comandos de validação (literais)

```powershell
pnpm --filter @iptv/api exec vitest run test/golden-loop.integration.test.ts test/commerce-billing.integration.test.ts test/subscription-fulfillment.integration.test.ts test/renewal-retention.integration.test.ts test/support-hitl-center.integration.test.ts test/provider-dispatch.integration.test.ts test/trial-compat.integration.test.ts test/scheduler.integration.test.ts test/billing-rls-rehearsal.integration.test.ts test/agent-model-failure.test.ts test/waha-f05-f06.unit.test.ts --reporter=basic
# Test Files 11 passed (11) / Tests 105 passed (105)
python scripts/validate_docs.py   # verde; nenhum contrato/registry tocado
```

## 4. Achados para o Planner (não bloqueiam P7)

1. API cai em restart do DB (erro `pg` não tratado, exit 1) — propor handler +
   backoff no pool; compose `restart:` mitiga em produção.
2. `billing-rls-rehearsal` zera a senha de `iptv_app` no fim — boot da API com
   senha antiga falha 28P01 até re-senha (higiene do suite, sem defeito).
3. Leituras de conversa (`GET /v1/communications/conversations` → `[]`;
   copilot `0 aberta(s)`) divergem de 1 conversa OPEN no DB — possível scoping
   de read-model; writes funcionam.
4. Drill WARN `no manifest sidecar`; MSYS converte `/tmp/*` (usar paths
   `C:/…` + `MSYS_NO_PATHCONV=1` ao reusar `backup-dr.sh` no Windows).

## 5. Gaps declarados (dono: operador / Planner)

- WhatsApp real simulado (M1/M2): nenhum tráfego, sessão ou mídia reais.
- PIX/Asaas sandbox (B1/B2): nenhuma chamada externa; echo cobre o caminho.
- Compra MK (G07), CINEVISION writes, Hatchet/F12: fora deste rehearsal
  (cobertos por P3/P5 como BLOCKED com dono operador).
- Sem variante live HTTP para provider-down; sem re-execução pós-stale live;
  sem outage live com chave real.
