# IPTV — P8 Controlled Pilot Operational Execution Report

- Data (UTC): 2026-10-31
- SHA inicial = SHA final: `89f46d64547be5f7f3476161533e37fbf660a09f` (nenhuma mudança de código nesta missão)
- Branch: `main` (working tree clean antes e depois)
- CI do SHA: `success` em 2026-10-31T10:00:43Z (run `ci` sobre `89f46d6`)
- Issues: #86, #87, #88, #89 (todas OPEN no início e no fim)
- Estado anterior: `READY_FOR_CONTROLLED_PILOT` (`evidence/pilot-readiness-20261031/report.md`, SHA `c61c386`)
- Orquestração: MULTI_WORKER (explorer Fase A, infra Fase B, tester Fase C, backend probes D/E/F-diagnóstico, reviewer + security-reviewer independentes)

## Nota de escopo sobre o SHA (responde revisão independente)

O reviewer apontou que o relatório de prontidão referencia `c61c386` enquanto o HEAD é `89f46d6`.
Verificado: o delta `c61c386..89f46d6` é exclusivamente o merge #114 (`docs: integration
live certification and pilot readiness report`), com 2 arquivos alterados — `CHANGELOG.md` e
`evidence/pilot-readiness-20261031/report.md` (docs-only, zero runtime). CI `success` no próprio
`89f46d6` confirma o estado mergeado. O veredito `READY_FOR_CONTROLLED_PILOT` portanto se mantém
para o baseline atual quanto a código; nenhuma capability foi promovida por este relatório.

## A. Baseline

| Item | Estado |
|---|---|
| HEAD | `89f46d6` — `Merge pull request #114` (docs-only sobre `c61c386`) |
| Working tree | clean (antes e depois; nenhum diff) |
| CI | `success` no HEAD (2026-10-31T10:00:43Z); branch protection esperada (`build`, `security-scans`, `adversarial`, `outbox-050-role-guards`) |
| Issues | #86 (Asaas), #87 (WAHA), #88 (CINEVISION), #89 (E2E onboarding) — todas OPEN |
| Staging | loopback saudável: `iptv-staging-postgres` Up 43h healthy, `iptv-staging-api` healthy (127.0.0.1:3001), `iptv-staging-web` healthy (127.0.0.1:3000); `GET /v1/health` 200, `/v1/health/ready` 200, web `/`, `/settings/integrations`, `/settings/onboarding` 200 |
| Migrations | 67/67 aplicadas (`202610300003_067_waha_session_binding.sql` no topo); zero pendente; append-only respeitado |
| Túnel | `iptv-staging-tunnel` em crash-loop (exit 255, sem token) — pré-existente, intocado |
| Serviços | `iptv-postgres-1` (dev) Up healthy; `iptv-pilot-api` Up 7d **unhealthy** em :3201 (fora de escopo, registrado, intocado) |

## B. Ambiente

- **URL pública utilizada:** nenhuma. `INTEGRATIONS_PUBLIC_BASE_URL` AUSENTE em `.env`, `deploy/staging/.env.staging`, `.env.example` e `.env.staging.example` (verificação por presença, sem valores). Nenhuma origem HTTPS pública efetiva configurada.
- **Estado de autenticação:** sem conta de teste por procedimento autorizado. Login wall correto no staging loopback; `POST /v1/auth/register` existe na API (rate-limited) mas NÃO foi invocado (criaria conta sem procedimento — proibido pela missão). Seed `001_pilot_baseline.sql` cria user com `auth_subject` opaco sem senha (não logável). `.env` contém `PILOT_STAGING_PASSWORD` (presença apenas) sem e-mail/procedimento correspondente — inutilizável sem o operador.
- **Estado do túnel:** lane aprovada identificada (`staging-deploy.md`: Cloudflare Zero Trust tunnel `iptv-staging`, remote-managed). Único artefato local necessário: `IPTV_STAGING_TUNNEL_TOKEN` — ausente. Sem ele o `cloudflared` recusa `tunnel run`.
- **Banco e migrations:** staging-postgres 67/67; dev `iptv` vazio (0 tabelas, esperado — testes aplicam migrations sozinhos); DBs legados `*_test/fase5_*` intocados.
- **Scheduler/outbox:** staging API `API_SCHEDULER_ENABLED=0` + `LEGACY_OUTBOX_DRAIN_ENABLED=1` (armado porém idle); container outbox-worker inexistente (loop nunca iniciado); `.env.staging.outbox-worker` com `QUIESCED=1/DRAIN=0` mas sem container. **Decisão registrada: manter o modo legado-armado-idle até o gate de quiescência (`drain-state`, que exige auth) ser provado. NÃO iniciar outbox-worker agora.** Sem coexistência, sem Hatchet (inativo por ADR-0028).
- **Observabilidade:** staging `LOG_LEVEL=info`, `OTEL_SDK_DISABLED=true` (noop).

Gate B: **NÃO (público) / SIM (loopback local)** — stack íntegra para E2E via loopback assim que houver conta; público bloqueado nos 3 itens do operador.

## C. Integrações

### Asaas (Issue #86)
- `.env`: `ASAAS_API_KEY`, `ASAAS_BASE_URL` (`https://api-sandbox.asaas.com/v3`), webhook do tenant — presentes (nomes apenas).
- Probe read-only desta missão: `GET /customers?limit=1 → 200`. Zero escritas, zero cobranças, zero webhooks criados.
- Evidência histórica mantida: B1 nominal PASS 2026-10-19 (PIX R$ 5,00 PAID+CONFIRMED+SETTLED, ledger balanceado) + B-refund fresh 2026-10-20 (`KNOWN_NOT_APPLIED` — limite do provider).
- Checkout sandbox via painel, webhook auto e `ASAAS_SELF_SERVICE_SANDBOX_VALIDATED`: **não executados** (exigem auth + base pública). Produção M4/M5: pendente decisão do operador. Sem `CERTIFIED`.

### WAHA (Issue #87)
- `.env`: `WAHA_BASE_URL/API_KEY/SESSION` — presentes (nomes apenas).
- Probe read-only desta missão: `GET /api/sessions → 200`. Zero sessões criadas, zero mensagens.
- Evidência histórica mantida: M1 adopt PASS + M2 drill PASS 2026-10-14, mídia + STT 2026-10-21.
- QR/pareamento/test-message via painel: **não executados** (exigem auth + número autorizado). `WAHA_SELF_SERVICE_LIVE_VALIDATED`: não declarado.

### CINEVISION (Issue #88)
- Credenciais no Infisical `dev /browser-worker/*` (identidade `viewer` read-only); `.env` só com config não-sensível.
- `read-identity` NÃO re-executado nesta missão por decisão deliberada: a evidência vigente (`HUMAN_REQUIRED/SECRET_UNAVAILABLE` fail-closed + challenge Cloudflare Step 3) já responde; re-rodar geraria tráfego live sem informação nova.
- Infisical inalcançável deste host (smoke → `login transport error`, falha de rota, não rejeição — validade das credenciais não testada).
- Leituras homologadas quando disponíveis; fulfillment manual (Caminho B) preparado e verificável; writes automáticos fora de escopo; importação live `NOT_WIRED` mantido por desenho (contract-before-code).
- Step 3 segue bloqueado por challenge (sem bypass, por regra).

### Registro de capabilities
Nenhuma capability `CERTIFIED`. Leituras CINEVISION `LAB_VALIDATED`; writes `LIVE VALIDATION REQUIRED`; WAHA send/inbound `IMPLEMENTED` (M1/M2 PASS); Asaas checkout `LIVE VALIDATION REQUIRED`/webhook `IMPLEMENTED`; Hatchet `IMPLEMENTED` (F12 BLOCKED); Infisical `LAB_VALIDATED`.

## D. Navegador

- **Telas testadas (Playwright 1.64 + chromium-headless-shell, loopback):** `/`, `/settings/integrations`, `/settings/onboarding` (desktop 1280×800 + mobile 390×844) + `/login` — 6 capturas sanitizadas (sem segredos/PII) em `C:\Users\walis\AppData\Local\Temp\opencode\p8-fasec\` (`01-home.png`, `02-login.png`, `03-integrations.png`, `04-onboarding.png`, `05-login-mobile.png`, `06-home-mobile.png`; hashes idênticos por viewport = mesma tela de login).
- **Fluxo autenticado:** login wall correto (`router.replace` → `/login`, H1 "Control Center", form e-mail+senha, sem signup). **BLOQUEADO** — sem conta de teste por procedimento autorizado; fluxo login→tenant→dashboard→integrações (3 cards)→onboarding (10 passos)→reload/persistência não executável.
- **Console/hidratação:** 0 pageerrors em 6/6; 1 console-error em 1 página = `401` do probe `GET /v1/auth/session` sem token (fail-closed esperado). Hidratação OK; sem overflow horizontal desktop/mobile.
- **API fail-closed:** `GET /v1/integrations` sem token → 401 `UNAUTHENTICATED`; `GET /v1/auth/session` sem token → 401; `POST /v1/auth/login` sintético → 401 `INVALID_CREDENTIALS` (mensagem genérica, sem enumeração).
- **Onboarding:** confirmações locais já rotuladas como manuais (evidência histórica); walk autenticado não realizado — diferença explícita mantida.

Gate C: **bloqueado externamente (auth), não reprovado** — evidência de login wall + fail-closed + capturas.

## E. Primeira venda

- **Sandbox ou produção:** nenhum dos dois executado. Rehearsal completo NÃO executado (exige auth + tenant + webhook + scheduler) — e NÃO é classificado como venda.
- **Pré-condições (todas verificadas):** tenant autorizado — pendente (sem auth); conta/cliente consentido — pendente; plano/preço — não alcançado; integração financeira apropriada — sandbox configurado, webhook não; fulfillment manual (Caminho B) — definido; operador disponível — requerido; observabilidade — noop local; reversão — conhecida via runbook; autorização financeira real — não solicitada nem concedida.
- **Runbook:** `docs/10-operations/runbooks/pilot-first-sale.md` aplicável assim que desbloqueado (quote→submit→provision→charge PIX→webhook PAID→settlement→from-order→fulfillment manual→resolve).
- **Reconciliação financeira:** nada a reconciliar (zero efeitos criados nesta missão).
- Gate G: **não atingido** — `FIRST_SALE_REHEARSAL_PASSED` e `FIRST_LIVE_SALE_VERIFIED` ambos pendentes; estado aplicável: `BLOCKED_OPERATOR_AUTHORIZATION` (pré-condições preparadas, auth ausente).

## F. Bloqueios

| # | O que falta | Quem age | Autorização necessária | Próxima ação concreta | Evidência que encerra |
|---|---|---|---|---|---|
| 1 | Conta de teste staging (e-mail + procedimento) | Operador (Better Auth) | Criação de conta interna de staging | Informar e-mail da conta de `PILOT_STAGING_PASSWORD`, OU autorizar `POST /v1/auth/register` no loopback com descarte posterior, OU prover seed documentado | Walk autenticado 10 passos com screenshots + console limpo |
| 2 | `INTEGRATIONS_PUBLIC_BASE_URL` por lane | Operador | Definição de origem pública | Preencher no `.env.staging` da lane após o túnel | `webhook_ensure` sai de 503 para PUT-or-POST real (`providerWebhookId` + 202) |
| 3 | `IPTV_STAGING_TUNNEL_TOKEN` | Operador (Cloudflare Zero Trust) | Leitura do token do tunnel `iptv-staging` | Preencher host-only + `up -d tunnel` | `curl https://staging-api…/v1/health` 200 (smoke §5 staging-deploy) |
| 4 | Número WhatsApp autorizado | Operador | Uso de número real para pareamento | Parear via painel → QR → WORKING → test-message → inbound | Repetir matriz M1 na lane atual |
| 5 | Sessão CINEVISION Step 3 | Operador (IP limpo/janela supervisionada) | Acesso ao painel oficial | Probe criar→deletar com fence (caminhos a/b/c do relato 2026-10-13) | Template Steps 3–5 preenchido |
| 6 | Decisão Asaas M4/M5 | Operador | Canário produção (conta/valor/janela) | Autorização explícita com parâmetros | Reconciliação vs verdade do provider |
| 7 | Execução P8-Operação | Operador | Tráfego real autorizado | Runbook first-sale + ciclo de renewal | Relatório de operação do piloto |

Atualização vs lista de 31/10: os 7 itens permanecem; o que mudou é que staging loopback, fail-closed de auth e probes read-only foram re-verificados no HEAD atual, e o modo scheduler/outbox recomendado é **legado-armado-idle até o gate de quiescência**.

**Achado de segurança (security-reviewer, MÉDIO, não-bloqueante desta missão):** `POST /v1/auth/register` (`apps/api/src/auth/auth.controller.ts:68-85`) cria conta sem autenticação (rate-limit 10/h por identidade, 20/h por origem) sem fluxo correspondente na UI. Se cadastro público não faz parte do piloto, o operador deve desabilitar a rota ou exigir convite/allowlist antes de expor o staging — não corrigido aqui (mudança de superfície de auth fora do escopo "sem refatoração ampla").

**Regra de correções:** nenhum defeito interno comprovado nesta missão → nenhuma correção, nenhum PR, nenhum teste novo. Flakes e limitações já documentados não foram reabertos.

## G. P8

- **Estado da operação:** não iniciada. Primeira venda (rehearsal ou live) pendente de desbloqueio auth.
- **Métricas disponíveis:** nenhuma de operação (zero tráfego). Coleta futura: conversão, human handling, worker failures, provider failures, wrong-action, reconciliation, duplicate effects, queue age, support, cost — janela mínima 1 ciclo de renewal (P8-PILOT.md).
- **Janela de renovação:** não aberta. `PILOT_OPERATION_COMPLETE` NÃO declarado (exige ciclo transcorrido).
- **Pendências de saída:** todas as de P8-PILOT.md §Saída (regressões, SLO medido, backup/restore repetido, capability register, runbooks exercitados, fallback humano provado, reconciliação limpa, cleanup de providers).

## H. Veredito

**`BLOCKED_OPERATOR_ACTION`**

- Código: `READY_FOR_CONTROLLED_PILOT` mantido para `89f46d6` (delta docs-only + CI verde no HEAD).
- Operação: bloqueada em conta de teste staging (desbloqueia C/D/E/F/G), `INTEGRATIONS_PUBLIC_BASE_URL` + token do túnel (desbloqueiam webhook público), número WhatsApp, sessão CINEVISION Step 3, decisão M4/M5.
- Explicitamente NÃO declarado: `FIRST_SALE_REHEARSAL_PASSED`, `FIRST_LIVE_SALE_VERIFIED`, `PILOT_IN_PROGRESS`, `PILOT_OPERATION_COMPLETE`, qualquer `CERTIFIED`.
- Este relatório não substitui os estados canônicos das capabilities (`integrations-capability-status.md` + `platform.capabilities` via migration+evento).
