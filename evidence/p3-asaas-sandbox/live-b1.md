# P3B-LIVE — Asaas Sandbox: primeiro lifecycle PIX descartável (NUNCA produção)

- TASK_ID: P3B-LIVE
- Data (UTC): 2026-10-08
- Autorização: operador autorizou Sandbox descartável (sem dinheiro real). Produção SEGUE proibida.
- Regra aplicada: `ASAAS_*` lidos SOMENTE em-processo (scripts em `%TEMP%`, fora do repo);
  base Sandbox oficial afirmada ANTES de qualquer chamada; zero segredos/payloads em outputs/arquivos;
  nenhum commit, nenhum código alterado. Este arquivo é a ÚNICA escrita no repo.

## Gate 0 — afirmação de base (antes de qualquer chamada)

- `ASAAS_BASE_URL` (host, não-segredo): `api-sandbox.asaas.com`
- Veredito: **SANDBOX_OFFICIAL** — confere com a tabela oficial `docs.asaas.com/docs/sandbox`
  (Sandbox `https://api-sandbox.asaas.com/v3` × Produção `https://api.asaas.com/v3`).
  Qualquer host fora desse teria abortado com BLOCKED e zero chamadas.
- `ASAAS_API_KEY`: presente (redacted, shape `$aact_…` de sandbox). `ASAAS_ADAPTER=real` (não-segredo).
- Nota: checagem estrita antiga aceitava só `sandbox.asaas.com` (host legado); a doc oficial atual
  usa `api-sandbox.asaas.com` — gate atualizado contra a fonte primária, produção (`api.asaas.com`) segue recusada.

## Tabela passo:veredito:evidência

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| customer descartável | PASS (live) | `POST /customers` → 200, id `cus_…` (name+externalReference descartáveis, sem email/telefone → sem notificações sandbox; `notificationDisabled:true`). |
| charge PIX mínimo | PASS (live) | `POST /payments` (contrato exato do `RealAsaasAdapter.createPixCharge`: `billingType/value/dueDate/externalReference` + vínculo `customer`, header `access_token`) → 200, id `pay_…`, valor BRL 5.00, vencimento D+1. Achado: 1ª tentativa 400 `invalid_object` — PIX exige CPF/CNPJ do customer; corrigido com CPF de teste sandbox + limpeza total, sem resíduo. |
| simular pagamento | PASS-com-ressalva (live) | `POST /payments/{id}/receiveInCash` (mecanismo documentado de homologação, ref. oficial `confirmar-recebimento-em-dinheiro`, gera `PAYMENT_RECEIVED`) → 200. **Ressalva**: semântica de recebimento em dinheiro, NÃO liquidação PIX (liquidação PIX real no sandbox é manual via dashboard — gate explícito abaixo, sem bloqueio do restante). |
| confirmar PAID | PASS (live) | `GET /payments/{id}` → 200, status `RECEIVED_IN_CASH` → mapeado PAID (mesmo mapeamento do normalizador; unit 55/55 cobre RECEIVED/CONFIRMED→PAID). |
| webhook duplicate | PASS (re-executado, banco descartável) | `commerce-billing.integration.test.ts` → "duplicate webhook delivery is a no-op (inbox dedupe + idempotent confirm)" PASS contra PostgreSQL 17 descartável (container removido após). Entrega Asaas→nós ao vivo não ocorre (localhost inalcançável pelo sandbox — arquitetural, declarado). |
| webhook reordered | PASS por mecanismo, com ressalva | Mesmo mecanismo do duplicate (mesmo event id → dedupe; confirm idempotente; `?defer=1` + `drainPending`). **Ressalva**: sem teste dedicado de reordenação no suite; convergência decorre do mesmo id de evento + confirm idempotente. |
| reconcile | PASS (re-executado, banco descartável) | Happy path "webhook PAID → payment → balanced ledger → SETTLED" + "UNKNOWN refund … reconciles to applied" PASS no mesmo run 16/16. |
| refund parcial | DECLARADO-não-executado (seguro por recusa do provider) | `POST /payments/{id}/refund` {2.00} → 400 `invalid_object`: "Somente é possível estornar cobranças recebidas ou confirmadas." Recebimento-em-dinheiro não qualifica; estorno exigiria liquidação PIX via dashboard (gate). Nenhum dinheiro movido (sandbox de qualquer forma). |
| cleanup | PASS (live, resíduo zero) | `DELETE /payments/{id}` → 200 + `DELETE /customers/{id}` → 200 em TODOS os runs (incl. runs de diagnóstico). Conta sandbox sem registros do ciclo. |

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\p3b-env-check.cjs` (só presença via `process.env`) → tudo `absent`
   (API carrega `.env`, shell não) — motivou leitura do arquivo em-processo.
2. `node %TEMP%\opencode\p3b-env-file.cjs` (parse do `.env` em-processo, só vereditos)
   → key `present-sandbox-shaped(redacted)`; host com 21 chars (não `sandbox.asaas.com`) — motivou checagem fina.
3. `node %TEMP%\opencode\p3b-env-host.cjs` (só não-segredos) → `ADAPTER=real`, host `api-sandbox.asaas.com`.
4. Web (fonte primária): `docs.asaas.com/docs/sandbox` (tabela Sandbox×Produção) +
   `docs/como-testar-funcionalidades` (operações simuladas manualmente) +
   references `confirmar-recebimento-em-dinheiro`, `estornar-cobranca`, `excluir-cobranca`, `remover-cliente`.
5. `node %TEMP%\opencode\p3b-live-probe.cjs` (gate hard-coded de hostname + log sanitizado: só
   método, path-template, status, enums e shapes) → run diagnóstico 400/CPF (limpo) → run lifecycle
   completo (customer 200, charge 200, receiveInCash 200, readback PAID, refund 400-declarado,
   delete charge 200, delete customer 200) → run confirmação do motivo do refund (limpo).
6. `docker run -d --name p3b-disposable-pg -p 55433:5432 postgres:17-alpine` → pronto;
   `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres pnpm --filter @iptv/api test --run test/commerce-billing.integration.test.ts`
   → **16/16 PASS** (migrations aplicadas pelo `beforeAll`); `docker rm -f p3b-disposable-pg` → removido.
7. `pnpm --filter @iptv/api test --run test/commerce-billing.unit.test.ts` → **55/55 PASS**
   (fetch mockado, zero rede; cobre PAID/PENDING/FAILED/UNKNOWN, guardas, BRL-only, refund por id externo).

## Itens SANDBOX-CERTIFIED (nesta data)

- Criação de customer descartável + cobrança PIX mínima vinculada (contrato do adapter real, live).
- Simulação de recebimento via mecanismo documentado + confirmação PAID via readback (live).
- Webhook duplicate (dedupe + confirm idempotente), tamper-safety, refunds concorrentes/over-refund,
  stale-approval, UNKNOWN→reconcile, ledger balanceado (re-executados 16/16 + 55/55).
- Limpeza total do ciclo (charge + customer deletados; container descartável removido).

## BLOCKERS / gates explícitos (pedidos ao operador; produção NUNCA autorizada aqui)

- **G1 (liquidação PIX fiel):** exige clique manual no dashboard sandbox ("simular pagamento" na cobrança)
  para obter status RECEIVED via PIX; só então refund `/refund` parcial seria tentável ao vivo.
  Sem G1, liquidação-PIX e refund-live permanecem declarados, não certificados.
- **G2 (webhook Asaas→nós ao vivo):** exige URL pública (túnel) cadastrada no sandbox + tenant/canal ativos;
  localhost é inalcançável pelo provider. Replays locais cobrem a mecânica, não a entrega.
- **G3 (reordenação dedicada):** sem teste de reorder no suite; considerar 1 teste `defer`+entrega fora de
  ordem para fechar a ressalva (software, sem sandbox).

## Riscos residuais

- CPF de teste em sandbox descartável (registro deletado; sem notificações; validação simulada, sem Receita).
- `RealAsaasAdapter` TS não foi executado diretamente (sem runtime TS isolado sem tocar o repo);
  o probe replicou 1:1 seu contrato HTTP (path, header, campos do body) — divergência futura do stub
  exigiria re-certificação.
- Comportamento sandbox ≠ produção (documentado pelo próprio Asaas); certificação vale para sandbox.
