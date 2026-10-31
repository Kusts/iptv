# IPTV — P8.1 Follow-up Operacional (desbloqueio e primeira venda de teste)

- Data (UTC): 2026-10-31
- Código avaliado: `89f46d64547be5f7f3476161533e37fbf660a09f` (main = origin/main, CI `success` no HEAD em 2026-10-31T10:00:43Z, cf. P8 anterior)
- Branch local: `docs/p8-pilot-operation-20261031` — commit `e59137c` (1 ahead de main, 0 behind; docs-only)
- Nota de escopo SHA (responde review independente): o relatório P8 anterior declara `SHA inicial = final: 89f46d6` porque descreve o **estado do código** avaliado; `e59137c` é o commit **documental** que empacota esse relatório + linha de CHANGELOG sobre o mesmo código. Delta `main...HEAD`: 2 arquivos, 120 insertions (`CHANGELOG.md` + `evidence/p8-pilot-operation-20261031/report.md`), zero runtime. Nenhuma capability promovida pelo empacotamento.
- Orquestração desta missão: MULTI_WORKER (explorer auth, explorer infra, backend flows + reviewer/security independentes; Planner coordenou e integrou)
- Issues: #86, #87, #88, #89 (todas OPEN; nenhum fechamento nesta missão)

## A. Estado da entrega

| Item | Estado |
|---|---|
| Branch | `docs/p8-pilot-operation-20261031` presente, HEAD `e59137c` |
| Compatibilidade | `main == origin/main == 89f46d6`; `HEAD` 1 ahead / 0 behind; sem divergência |
| Diff | `--stat main...HEAD`: `CHANGELOG.md` + `evidence/p8-pilot-operation-20261031/report.md` (docs-only) |
| Segredos | Scan do diff por padrões (`aact_`, `sk_live`, Bearer, PRIVATE KEY, `password/api_key =`) — 0 ocorrências |
| Gates documentais locais | `scripts/validate_docs.py` OK; `tests/contracts/test_contracts.py` 21/21 OK; `tests/contracts/test_seed_contract.py` 5/5 OK |
| CI | Reutilizada do P8 (`success` em `89f46d6`); nenhum novo push, nenhum novo run disparado |
| PR | **NÃO publicado** (reserva ao operador, cf. missão). Comandos e descrição prontos abaixo |

Publicação preparada (sem executar — reserva do operador):

```powershell
git checkout docs/p8-pilot-operation-20261031
git log --oneline -3
git diff --stat main...HEAD
git push -u origin docs/p8-pilot-operation-20261031
gh pr create --title "docs: P8 controlled pilot operational execution report (BLOCKED_OPERATOR_ACTION, #86, #87, #88, #89)" --body-file C:\Users\walis\AppData\Local\Temp\opencode\p8-pr-body.md
```

Descrição de PR pronta (`p8-pr-body.md`): objetivo — publicar execução operacional P8 sem mudança de código; evidências — `evidence/p8-pilot-operation-20261031/report.md` (staging loopback re-verificado, fail-closed auth, probes read-only, 6 capturas sanitizadas) + gates Python verdes; resultado — `READY_FOR_CONTROLLED_PILOT` (código) / `BLOCKED_OPERATOR_ACTION` (operação); bloqueios externos — 7 itens §F do relatório (conta staging, base pública, token túnel, WhatsApp, CINEVISION Step 3, M4/M5, P8-Operação); relação com P8 — entrada P8-PILOT.md mantida, nenhuma capability `CERTIFIED`, operação não iniciada.

## B. Acessos

- **Conta staging:** nenhuma conta de teste por procedimento autorizado. `PILOT_STAGING_PASSWORD` presente no `.env` (nome apenas) sem e-mail/procedimento correspondente — inutilizável. Seed `001_pilot_baseline.sql` cria user `seed:admin:pilot` sem credenciais (não logável). `POST /v1/auth/register` **NÃO invocado** nesta missão (criaria conta sem procedimento — proibido).
- **Procedimento suportado (via explorer + código):** não existe endpoint/script de bootstrap de platform admin. Caminho autorizado: DB owner executa `UPDATE control.users SET is_platform_admin = true WHERE id = '<user_id>'` (usuário ACTIVE pré-existente), confirma com `SELECT`, prefere login via `POST /v1/auth/login` após a flag; valida com `GET /v1/admin/outbox/drain-state` (exige `AuthGuard + PlatformAdminGuard`, deve sair de 403 para 200). Revogação: flag `false` + `DELETE FROM control.auth_sessions WHERE user_id = '<user_id>'`. Nunca habilitar cadastro público para facilitar testes.
- **Túnel:** `deploy/staging/.env.staging` **sem** `IPTV_STAGING_TUNNEL_TOKEN` (só placeholders comentados em `.example`); `CLOUDFLARE_TUNNEL_TOKEN` idem. Nenhum `config.yml`/túnel versionado no repo. Staging local nesta sessão com `docker ps` vazio (sem listeners em 3000/3001) — loopback saudável do P8 não re-levantado aqui para não mascarar os bloqueios de conta/rede.
- **`INTEGRATIONS_PUBLIC_BASE_URL`:** ausente em `.env`, `deploy/staging/.env.staging` e exemplos (só comentários em `.example`). Sem origem pública efetiva configurada. `.env.staging` contém (nomes apenas) `API_SCHEDULER_ENABLED` + `LEGACY_OUTBOX_DRAIN_ENABLED`.

## C. Navegador

- E2E autenticado **não executado** — sem conta autorizada. Gate `AUTHENTICATED_BROWSER_E2E_PASS`: **não atingido** → `BLOCKED_OPERATOR_ACCOUNT`. Nenhuma nova captura foi produzida para não repetir auditoria já aprovada; as 6 capturas sanitizadas do P8 (login wall, fail-closed 401, 0 pageerrors) permanecem válidas como evidência de estado não-autenticado.
- Quando a conta existir (10 passos): staging loopback → login → sessão → tenant → dashboard → `/settings/integrations` → `/settings/onboarding` → estados → navegação → reload → persistência/permissões, com screenshots sanitizadas + console.

## D. Asaas

- Conectividade read-only histórica mantida (B1 nominal PIX R$ 5,00 + B-refund `KNOWN_NOT_APPLIED`); nenhum novo probe com efeitos nesta missão.
- Conexão self-service pelo painel **não executada** (exige admin staging + credencial Sandbox autorizada para a lane). Sequência mapeada e pronta: `configure(SANDBOX)` → `test` (espera `CONNECTED_READ_ONLY`) → `webhook_ensure` (auto) ou modo manual no dashboard → validação de persistência/reload. Gate `ASAAS_SELF_SERVICE_SANDBOX_VALIDATED`: **não declarado**.
- Webhook auto **não executado** (sem base pública → `webhook_ensure` falharia 503 `WEBHOOK_BASE_URL_NOT_CONFIGURED` por desenho). Sem simulação de sucesso.
- Checkout Sandbox **não executado**. Pré-requisitos e runbook (`pilot-first-sale.md` + `integrations-hub-operator.md`) verificados como aplicáveis quando desbloqueado.

## E. Venda

- Primeira venda (rehearsal ou live): **não executada**. Nenhum cliente/cotação/pedido/cobrança/pagamento/assinatura criado nesta missão. Nada a reconciliar (zero efeitos).
-Pré-condições confirmadas como pendentes de desbloqueio: tenant+cliente autorizados, catálogo/plano, binding Asaas, permissões (`commerce.order.write`, `billing.charge.write`, `billing.read`, `subscription.write`, `provider.operation.write`), scheduler (`API_SCHEDULER_ENABLED=1` no runbook), modo outbox (legado-armado-idle mantido até gate de quiescência com auth — **não iniciar outbox-worker agora**), fulfillment manual Caminho B, observabilidade noop local.
- Fluxo pronto quando desbloqueado: cliente → quote → submit → provision → charge PIX → pagamento Sandbox → webhook PAID → PAID/CONFIRMED/SETTLED → from-order → fulfillment `HUMAN_REQUIRED` → ativação manual no painel → `resolve` → reconciliação. Ativação CINEVISION real só após confirmação do operador autorizado.
- Gates `FIRST_SALE_REHEARSAL_PASSED` / `FIRST_LIVE_SALE_VERIFIED`: **não declarados**.

## F. WAHA e CINEVISION

- **WAHA:** nenhum pareamento/mensagem nesta missão (exige número autorizado + auth). Estado `BLOCKED_OPERATOR_PHONE` mantido. Sem provocação de timelock.
- **CINEVISION:** nenhum probe live re-executado (decisão deliberada — evidência `HUMAN_REQUIRED/SECRET_UNAVAILABLE` + challenge Step 3 continua vigente; re-rodar geraria tráfego sem informação nova). `NOT_WIRED` (importação live), writes `UNCERTIFIED`, fulfillment manual supervisionado preservados. Sem bypass de challenge/CAPTCHA/2FA/Cloudflare.
- Nenhuma limitação convertida em implementação nesta missão (regra: sem features pós-MVP, sem refatoração ampla).

## G. Intervenções do operador (bloqueios restantes)

| # | Recurso exato | Justificativa | Local | Procedimento | Evidência que encerra |
|---|---|---|---|---|---|
| 1 | Conta de teste staging (e-mail + flag `is_platform_admin`) | Desbloqueia C/D/E/F/G (E2E autenticado, hub, checkout, venda) | Banco staging (DB owner) + login | `UPDATE control.users SET is_platform_admin=true WHERE id='<user_id>'`; login via `/v1/auth/login`; revogar com flag `false` + delete sessões | Walk 10 passos com screenshots + console limpo |
| 2 | `INTEGRATIONS_PUBLIC_BASE_URL` por lane | Desbloqueia `webhook_ensure` auto (sem ela 503 por desenho) | `deploy/staging/.env.staging` (gitignored) | Preencher `scheme://host[:port]` público após túnel/dominio ativo | `webhook_ensure` retorna `providerWebhookId` + 202 |
| 3 | `IPTV_STAGING_TUNNEL_TOKEN` (ou confirmação de domínio próprio via Traefik) | Expõe staging publicamente p/ webhooks | Host-only + `up -d tunnel` (ou Traefik `Host()` externo) | Operador informa hostname ativo + qual token está em uso (sem exibir valor) | `curl https://<HOST>/v1/health` 200 (smoke §5 staging-deploy) |
| 4 | Decisão `POST /v1/auth/register` público | Rota aceita cadastro anônimo (cria user + tenant novo; sem join cross-tenant, sem escalada a admin — confirmado por review independente). Antes de expor staging: desabilitar rota ou exigir invite/allowlist | Código (PR separado) + config | PR separado com teste de regressão (sem convite → negação sem criar user/tenant/membership) | Teste verde + rota travada em staging |
| 5 | Número WhatsApp autorizado | Pareamento QR → WORKING → test-message → inbound | Painel hub `/settings/integrations` | Provisionar sessão por tenant, escanear QR, validar | Repetir matriz M1 na lane atual |
| 6 | Sessão CINEVISION Step 3 | Leituras Step 3–5 + write contract real | Browser do operador / janela supervisionada | Probe criar→deletar com fence (caminhos a/b/c do relato 2026-10-13) | Template Steps 3–5 preenchido |
| 7 | Decisão Asaas M4/M5 + execução P8-Operação | Canário produção e operação do piloto (observação ≥1 ciclo renewal) | Autorização explícita (conta/valor/janela) + runbook first-sale | Operador autoriza; engenharia acompanha sem operar tráfego real | Reconciliação vs verdade do provider + relatório de operação |

## H. Veredito

**`BLOCKED_OPERATOR_ACTION`** (código `READY_FOR_CONTROLLED_PILOT` mantido para `89f46d6`).

- Explicitamente **NÃO** declarados: `FIRST_SALE_REHEARSAL_PASSED`, `FIRST_LIVE_SALE_VERIFIED`, `PILOT_IN_PROGRESS`, `PILOT_OPERATION_COMPLETE`, qualquer `CERTIFIED`.
- Condição de parada atingida: conta staging e URL pública não obteníveis por meios autorizados → investigação + procedimentos + testes independentes + bloqueios documentados, sem novas tentativas repetitivas.
- Próximo passo útil: operador executa G1–G3; então E2E autenticado → Asaas self-service Sandbox → rehearsal até assinatura/fulfillment supervisionado.
