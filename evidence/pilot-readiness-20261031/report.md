# IPTV — Integration Live Certification & Pilot Readiness Report

- Data (UTC): 2026-10-31
- SHA inicial = SHA final: `c61c3862662ae951f16da2f383297fa764b6fa7d` (nenhuma mudança de código nesta missão)
- Branch: `main` (branch protection: 4 checks obrigatórios — `build`, `security-scans`, `adversarial`, `outbox-050-role-guards`)
- CI do SHA: run `41171049515` — 4/4 `success`
- Issues: #86, #87, #88, #89 (todas OPEN no início; ver §Fase 7)
- PR #83: draft SPEC original — ver §Fase 7
- PR #113: MERGED (runbook + guia S5C)

## A. Estado do projeto

| Item | Estado |
|---|---|
| HEAD | `c61c386` — `docs: integrations operator runbook and user guide (S5C, #89) (#113)` |
| CI | 4/4 PASS (`build`, `security-scans`, `adversarial`, `outbox-050-role-guards`) |
| Gates Python locais | `validate_docs.py` OK, `test_contracts.py` 21/21 OK, `test_seed_contract.py` 5/5 OK |
| `pnpm lint` | 12/12 pacotes OK |
| `pnpm typecheck` | 20/20 tasks OK |
| `pnpm test` (paralelo) | 17/20 — 2 flakes sob carga, ambos verdes em re-run isolado (workflows hatchet-import-timeout 30s; 1 teste web não nomeado). `@iptv/api` isolado: 889 passed / 479 skipped (skips = integração sem banco; `TEST_DATABASE_URL` vazio). Integração com banco coberta pela CI + B3 full-matrix 2026-10-30 (`CHANGELOG`, PostgreSQL 17 descartável, 1267 passed). |
| `pnpm build` | 12/12 OK |
| Staging local | Refrescado para `c61c386` nesta missão: `migrate` 4 aplicadas (total 67, depois no-op 0/67), api/web/postgres `healthy`, `/v1/health/ready` 200, `/` + `/settings/integrations` + `/settings/onboarding` 200 (antes 404 em build velho). Serviço `tunnel` NÃO tocado: crash-loop pré-existente por falta de token do operador. |
| Migrations | Append-only respeitado; nenhum volume/banco apagado. |

## B. Integrações

| Integração | Implementação | Testes automatizados | Testes reais | Certificação |
|---|---|---|---|---|
| Asaas (conexão/teste/webhook) | IMPLEMENTED (S1–S2, hub + wizard + `webhook_ensure`) | LAB_VALIDATED (units + integração com doubles; rotação E2E S5B 14/14) | LIVE (sandbox): B1 nominal PASS 2026-10-19 + ciclo refund-fresh 2026-10-20; re-verificado hoje `GET /customers?limit=1 → 200` (read-only, zero escritas) | Sandbox: validado (nominal). Produção (M4/M5): pendente decisão do operador. Sem `CERTIFIED` declarado. |
| WhatsApp/WAHA (sessão/QR/mensagens) | IMPLEMENTED (S3a–S3c: sessão por tenant, QR proxy, test-message, inbound) | LAB_VALIDATED (web 11/11 + integração 12/12 mockados) | LIVE: M1 adopt PASS + M2 drill PASS 2026-10-14, mídia + STT 2026-10-21; re-verificado hoje `GET /api/sessions → 200` (admin, read-only) | Parcial live (texto + mídia). Multi-sessão/reconnect profundo/timelock: fora de escopo ou nunca provocar. Sem `CERTIFIED` declarado. |
| CINEVISION (conta/leituras) | IMPLEMENTED (S4a conta+probe, S4b UI, worker GET-only 11 comandos) | LAB_VALIDATED (worker 261/261; probe 13/13 + 8/8 mockados) | LIVE reads: GET-only 2026-10-05 (identity + 11 contratos). Hoje: CLI `read-identity` → `HUMAN_REQUIRED/SECRET_UNAVAILABLE` (fail-closed, zero escritas). Step 3 bloqueado por challenge Cloudflare 2026-10-13 (sem bypass, por regra). | Reads: LAB_VALIDATED. Writes: `LIVE VALIDATION REQUIRED` por desenho (contract-before-code). Caminho adotado: fulfillment manual/supervisionado. |
| CINEVISION (importação) | IMPLEMENTED com fail-closed `NOT_WIRED` em produção (S4c + UI S4d) | LAB_VALIDATED (8/8 com doubles, replay/tamper/isolamento) | Nenhum live (por desenho — wiring prod exige Steps 3–5) | `NOT_WIRED` confirmado e mantido: correção agora violaria a regra contract-before-code. Limitação registrada, não defeito. |
| Onboarding | IMPLEMENTED (S5a: 10 etapas, estados reais + manuais honestos) | LAB_VALIDATED (web 5/5 mockado) | Navegador real (headless, sem auth): `/`, `/settings/integrations`, `/settings/onboarding` 200, login wall correto, zero erros de console (1× 401 esperado de sonda de sessão). Walk autenticado: `BLOCKED_EXTERNAL` (sem conta de teste; sem página de signup). | Estados manuais já rotulados ("confirmação manual", "marco local — sem cobrança"). Nenhuma correção necessária. |

## C. Testes reais (desta missão + evidências do operador)

- Asaas Sandbox `GET /customers?limit=1 → 200` (2026-10-31, credencial local, read-only). Prova de conectividade/autenticação sem escritas.
- WAHA admin `GET /api/sessions → 200` (2026-10-31, read-only). Prova de admin key válida e servidor alcançável.
- CINEVISION `read-identity` → `HUMAN_REQUIRED/SECRET_UNAVAILABLE` (2026-10-31, fail-closed correto, nenhuma credencial enviada).
- E2E navegador staging local (2026-10-31, screenshots em `%TEMP%/opencode/e2e-shots`): 3 rotas 200, login wall, sem erros.
- Evidências do operador (verificadas — substantivas, sem segredos, com incidentes honestos):
  - `evidence/p3-asaas-sandbox/live-b1-nominal-20261019.md` — PIX R$ 5,00 PAID + CONFIRMED + SETTLED + ledger balanceado, webhook 1 entrega 202, reconcile 409 pós-PAID, customer deletado.
  - `evidence/p3-asaas-sandbox/live-b-refund-fresh-20261020.md` — execução provada contra provider real (`KNOWN_NOT_APPLIED` — sandbox recusa refund de PIX RECEIVED, limite do provider); cleanup total da lane.
  - `evidence/p3-waha/m1-adopt-20261014.md` — send 201 + entrega + inbound PROCESSED + replay `deduped:true`.
  - `evidence/p3-waha/m2-drill-20261014.md`, `m1-media-live-20261021.md`, `stt-groq-live-20261021.md`.
  - `evidence/p3-cinevision/step3-blocked-challenge-20261013.md` — STOP correto, sem bypass.
- NÃO realizados (bloqueio externo, não falha): checkout sandbox via painel, pareamento QR com número real, Step 3 CINEVISION, walk autenticado do onboarding.

## D. Limitações

1. Nenhuma capability recebe `CERTIFIED` (regra do register: só gate final com todos os campos).
2. CINEVISION importação segue `NOT_WIRED` em produção por desenho (wiring exige Steps 3–5).
3. CINEVISION writes seguem `UNCERTIFIED`/`HUMAN_REQUIRED` (fulfillment manual/supervisionado adotado).
4. Onboarding: conta/equipe, preferências, autonomia e go-live são confirmações locais honestas (sem endpoint — S5 follow-ups).
5. WAHA: mídia/audio outbound, multi-sessão e reconnect profundo não implementados (N-A).
6. `pnpm test` paralelo tem 2 flakes sob carga (documentados em §A; CI verde).
7. Staging local sem exposição pública (tunnel sem token) e sem `INTEGRATIONS_PUBLIC_BASE_URL` (webhook auto → 503 fail-closed, modo manual documentado no runbook).

## E. Próximas ações do operador

| # | O que fornecer | Onde configurar | Como testar | Evidência que encerra |
|---|---|---|---|---|
| 1 | Conta de teste do staging (e-mail + senha) | Criar via Better Auth no staging local ou informar existente | Walk autenticado do onboarding no navegador (Fase 5, 10 passos) | Screenshots + console limpo + estados por etapa |
| 2 | `INTEGRATIONS_PUBLIC_BASE_URL` por lane | `.env` da lane / `deploy/staging/.env.staging` (arquivo gitignored, nunca no repo) | `POST /v1/integrations/asaas/webhook` deve sair de 503 para PUT-or-POST real | `providerWebhookId` + 202 no ingress |
| 3 | Token do túnel local (opcional) | `IPTV_STAGING_TUNNEL_TOKEN` no `.env.staging` + `up -d tunnel` | `curl https://staging-api…/v1/health` 200 | Smoke §5 do runbook staging-deploy |
| 4 | Número de teste autorizado (WhatsApp) | Parear via painel `Configurações → Integrações → WhatsApp` | QR → WORKING → test-message → inbound | Repetir matriz M1 na lane atual |
| 5 | Sessão para CINEVISION Step 3 (caminhos a/b/c do relato 2026-10-13) | Browser do operador ou janela supervisionada | Probe criar→deletar com fence | Preencher template Steps 3–5 do gate |
| 6 | Decisão M4/M5 (canário produção Asaas) | Autorização explícita para conta/valor/janela | Gate Asaas (duplicadas/reordenadas/atrasadas + refund) | Reconciliação vs verdade do provider |
| 7 | Executar P8-Operação | Runbook `pilot-first-sale.md` + P8 §§Operação/Saída | Primeira venda, ciclo de renewal, métricas | Relatório de operação do piloto |

## F. Veredito

**`READY_FOR_CONTROLLED_PILOT`** — engenharia completa e lab-validada no SHA `c61c386` (CI 4/4, staging local refrescado e saudável, P8-entrada com gates B1/B2/M1/M2/G07/F12 verificados por evidência do operador), restando exclusivamente atos do operador (§E, sobretudo 1 e 7). Não se declara `PILOT_OPERATION_COMPLETE` (operação não executada) nem `CERTIFIED` para qualquer capability.
