# B-REFUND-FRESH — ciclo refund PIX R$ 5,00 + cleanup total (AUTORIZADO pelo operador no chat)

- TASK_ID: BREFUND-P4-20261020
- Data (UTC): 2026-10-20
- Base: sem alterações de código-fonte; só este arquivo criado; sem commit/push
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (drivers em `%TEMP%\opencode\iptv-brefund1020`, fora do repo; só presença/host/vereditos impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer chamada (Gate0 `SANDBOX_OFFICIAL`; qualquer outro host abortaria com BLOCKED e zero chamadas);
  zero segredos em outputs/arquivos (token de sessão, `ASAAS_API_KEY` nunca impressos nem persistidos no repo);
  lane piloto (`iptv-pilot`, :3200/:3201), staging e produção NUNCA tocadas — verificadas apenas via leitura (`docker ps`);
  somente os 2 ids autorizados foram alvo de `DELETE` (`cus_000009592646`, `pay_sq353j63nbux79cv`).

## Lane scratch (`-p iptv-brefund1020`) — DERRUBADA ao fim (cleanup total)

- Postgres próprio `127.0.0.1:55436` (container `iptv-brefund1020-postgres`, sem labels compose — criado via `docker run`); API `http://127.0.0.1:3320` (`/v1/health/ready → ok` durante o ciclo).
- Estado em `%TEMP%\opencode\iptv-brefund1020\brefund-state.json` (contém token — FORA do repo, nunca commitado).
- Driver desta task (fora do repo): `%TEMP%\opencode\iptv-brefund1020\brefund-p4-cleanup.cjs` (Gate0 + 2 DELETEs + 2 GETs de confirmação).
- Ciclo prévio (P1–P3, mesma lane): charge PIX R$ 5,00 → reconcile → refund-request parcial → 2º humano aprova → execute → reconcile `FAILED/KNOWN_NOT_APPLIED`
  (provider recusou; request consumido `EXECUTED`) → over-refund probe 600 rejeitada `409` (comportamento correto).

## Tabela passo:veredito (cleanup P4, direto no provider sandbox)

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Gate 0 — afirmar `api-sandbox.asaas.com` antes de qualquer chamada | PASS | parse do `.env` em-processo → `{gate:"SANDBOX_OFFICIAL", host:"api-sandbox.asaas.com"}` (chave em forma sandbox, só presença afirmada) |
| 1. `DELETE /v3/customers/cus_000009592646` | PASS | `→ 200 {deleted:true}` (customer removido) |
| 1a. Confirmação pós-DELETE do customer | PASS | `GET /v3/customers/cus_000009592646 → 200 {deleted:true, object:"customer"}` (ainda legível com flag, comportamento do Asaas) |
| 2. `DELETE /v3/payments/pay_sq353j63nbux79cv` | NÃO-REMOVÍVEL, limite do provedor (aceito e documentado) | `→ 400 invalid_action` (`A cobrança [19153025] não pode ser removida: Só é possível remover cobranças pendentes ou vencidas` — cobrança `RECEIVED` não removível, regra do Asaas) |
| 2a. Confirmação pós-DELETE do payment | PASS (informativo) | `GET /v3/payments/pay_sq353j63nbux79cv → 200 {deleted:false, status:"RECEIVED", billingType:"PIX", value:5, invoiceNumber:"19153025"}` — cobrança intacta |
| 3. Lane DERRUBADA | CUMPRIDO | API parada (`taskkill /F` no pid da lane; `:3320` sem LISTENING); container `iptv-brefund1020-postgres` removido (`docker rm -f`); volume anônimo da lane removido (dangling, criado 2026-10-20T17:37:52Z, ~3 min antes da lane — atribuição por tempo + dangling); `:3320` e `:55436` sem LISTENING (só `TIME_WAIT` residuais); demais containers intactos (`docker ps`: pilot/staging/ted-local/hatchet intocados) |
| 4. Pilot/staging/prod | NUNCA TOCADOS | somente leitura via `docker ps`; nenhum DELETE fora dos 2 ids; nenhum segredo em arquivo/repo |

## FINDING principal (honesto): refund recusado pelo provedor — `KNOWN_NOT_APPLIED`

- O ciclo de domínio funcionou de ponta a ponta (request → 2º-humano aprova → execute serializado por payment → adapter real chamado com o id EXTERNO `pay_…` →
  recusa classificada `KNOWN_NOT_APPLIED` → refund `FAILED` terminal + request `EXECUTED`/consumido, sem ledger de reversão, sem efeito financeiro).
- O Asaas Sandbox recusou o refund do PIX `RECEIVED` (mesmo padrão dos loops anteriores: cobrança liquidada fora de trânsito bancário contestável).
  Ou seja: **o caminho de execução está provado contra o provider real; o efeito `KNOWN_APPLIED/SUCCEEDED` exige liquidação fiel via dashboard (gate G1)**,
  fora do escopo desta task. Nenhum retry forçado (novo `execute` exigiria novo request + nova aprovação humana).

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\iptv-brefund1020\brefund-p4-cleanup.cjs` → gate `SANDBOX_OFFICIAL`;
   `cleanup-customer-delete 200 {deleted:true}`; `cleanup-customer-confirm 200 {deleted:true}`;
   `cleanup-payment-delete 400 invalid_action` (só pendentes/vencidas); `cleanup-payment-confirm 200 RECEIVED/PIX/5/invoice 19153025`.
2. `taskkill /F /PID <api-pid> /T` (primeira tentativa sem `/F` recusada pelo SO; com `/F` ÊXITO) → `curl.exe http://127.0.0.1:3320/v1/health/ready` sem resposta (API fora do ar).
3. `docker rm -f iptv-brefund1020-postgres` → container removido; `docker volume rm 63d8a2e…` (dangling de 2026-10-20T17:37:52Z) → removido;
   `docker ps` (leitura) → lane ausente, demais containers intactos; `netstat` → `:3320`/`:55436` sem LISTENING.
4. `git status --short` → limpo exceto este arquivo novo (não commitado — Planner commita; CHANGELOG o Planner anexa).

## Resíduos finais (pós-cleanup total)

- Resíduo no sandbox: 1 payment PIX `RECEIVED` de R$ 5,00 (`pay_sq353j63nbux79cv`, invoice 19153025) **não removível** por regra do Asaas (só pendentes/vencidas) —
  conta sandbox descartável, sem notificações (customer removido). Nenhum outro resíduo do ciclo no sandbox.
- Customer `cus_000009592646` com `deleted:true` (removido; ainda legível com flag, comportamento do Asaas).
- Refund interno terminal `FAILED/KNOWN_NOT_APPLIED` + request `EXECUTED` (consumido): viviam só no banco scratch — **destruídos com a lane** (`rm -f` + volume removido).
- State/drivers em `%TEMP%\opencode\iptv-brefund1020\` (fora do repo, com token de sessão) — **mantidos de propósito** como trilha de auditoria dos vereditos acima;
  expiram sozinhos (tokens vinculados ao banco destruído); remoção manual com `Remove-Item -Recurse` quando o operador quiser.
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação vale para sandbox.
