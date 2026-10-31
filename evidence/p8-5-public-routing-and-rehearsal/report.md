# P8.5 — Public routing, B3, healthcheck e Infisical — relatório de missão (2026-10-31)

Branch: `feat/api/register-closed` @ `4f9ed7d` + working tree não commitado (B3 + 1 linha D).
Orquestração: MULTI_WORKER (3 explorers + coder D + tester C + reviewer + security-reviewer; Planner integrou).
Sem auditoria geral nova. Sem mutação externa. Sem deploy. Sem PR publicado.

## A. Cloudflare — origem pública ainda NÃO identificada (causa raiz aberta)

Evidência mínima desta missão (sem repetir 100x):

- DNS (2026-10-31, deste host): `staging-api` e `staging-web` → `104.21.64.48`, `172.67.176.12`, `2606:4700:3033::6815:4030`, `2606:4700:3033::ac43:b00c` (edge Cloudflare, proxied — esperado, não revela origem).
- `GET https://staging-api.synkroo.com.br/v1/health` (2x): `200`, `scheduler: enabled`, `tickSeconds: 60`, `version: 0.1.0`, requestIds `01a1927d-8fa2-…` e `01a1927d-cf93-…` (prefixo UUIDv7 igual = mesma janela temporal), `cf-cache-status: DYNAMIC`, `Server-Timing: cfOrigin;dur=605` (origem viva, não cache).
- `GET https://staging-web.synkroo.com.br/` (1x): `200`, `len=6140`, marcador `<!--vQfpGwqHmG1ErQZKiHYAQ-->` presente.
- `GET https://staging-api.synkroo.com.br/v1/health/ready` (1x): `200 {"status":"ok","checks":{"database":"ok"}}`.
- Config local esperada (repo): hostnames `staging-api/web.synkroo.com.br` → `127.0.0.1:3001/3000`, serviço `tunnel` (`cloudflare/cloudflared:latest`, `network_mode: host`, `TUNNEL_TOKEN=${IPTV_STAGING_TUNNEL_TOKEN}`), ingress remoto NÃO versionado (`config_src=cloudflare`), Tunnel ID do repo desconhecido (só `<tunnel-id>.cfargotunnel.com`); Tunnel ID `36b0d32e-…` e conector `f2a5fb2a-…` vêm da missão anterior, não revalidados aqui.
- Contraponto: `deploy/staging/.env.staging.example` fixa `API_SCHEDULER_ENABLED=0`, mas o público responde `enabled` — consistente com a conclusão P8.4 de origem divergente, mas NÃO prova qual origem (pode ser conector obsoleto, outro túnel, ingress remoto, Worker/proxy ou VPS antiga).

Não feito (exige operador): dashboard Zero Trust (túneis, rotas, conectores, ingress), inspeção da VPS antiga, `cloudflared` remotos, request-ID nos logs da origem pretendida.

Comandos exatos para o operador (alvo identificado, sem executar aqui):

```powershell
# Cloudflare (conta correta): listar túneis, rotas e conectores
# Dashboard: Zero Trust → Networks → Tunnels → iptv-staging → Public Hostnames + Connectors
# (registrar Tunnel ID, Connector IDs, versão, uptime, origem configurada antes de qualquer mutação)
# API equivalente (com token da conta): GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations + /connections
# VPS antiga (somente se acesso autorizado; NÃO imprimir .env):
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
systemctl list-units --type=service --state=running | Select-String "cloudflared|docker|iptv"
ps -ef | Select-String "cloudflared"   # NÃO matar por nome; confirmar tunnel id antes
cat ~/.cloudflared/config.yml  # tunnel id + ingress efetivo, se existir
ss -tlnp | Select-String "3000|3001"
```

Rollback: nenhuma mutação feita → nada a reverter. Antes de qualquer mutação futura: snapshot da rota/DNS/ingress, `docker compose config`, backup `.bak-pre-<tag>` (mode 600) + `md5sum`, deploy PINNED-COPY sem `git pull` na pasta remota (runbook `staging-deploy.md`).

## B. B3 (`AUTH_REGISTER_CLOSED`) — implementada e validada localmente, NÃO implantada

- Branch `feat/api/register-closed`: diff real em 8 arquivos (`CHANGELOG`, `app.module.ts` +6, `auth.controller.ts` +17, `vitest.config.ts` +5, `openapi.yaml` +11, `packages/config` +7, `config.test.ts` +35; fora isso só a linha D).
- Lógica: env `AUTH_REGISTER_CLOSED: z.enum(["0","1"]).default("1")`, `emptyToUndefined` (blank=ausente), valor inválido falha o boot; `POST /v1/auth/register` com `!== "0"` → `403 {code: REGISTER_CLOSED}` ANTES de body/DB/criação/audit; `RateLimitGuard` continua na frente (budgets cobrados, flood→429); `APP_CONFIG` injetado (nunca `process.env`); flag `0` preserva bootstrap byte-idêntico; login/logout/session inalterados; OpenAPI documenta o 403.
- Testes desta missão: `pnpm --filter @iptv/config test` → 69/69 PASS; `apps/api` `auth-register-closed.test.ts` → 10 passed, 2 skipped (suite DB pulada, `skipIf(!hasDb)`, sem `TEST_DATABASE_URL`, nenhum banco tocado).
- Security estático: APPROVED (sem bypass, sem criação antes do gate, sem cross-tenant no fluxo).
- Reviewer: sem defeito nos trechos inspecionados, mas CHANGES_REQUIRED formal (não conseguiu ler os diffs Git com suas ferramentas — suprido neste relatório pelo diff acima).
- Falta: suite com DB em Postgres descartável, gates locais completos, PR pequeno, CI remoto (build, adversarial, outbox-050-role-guards, security-scans), merge, deploy PINNED-COPY + `AUTH_REGISTER_CLOSED=1`, verificação pública.

## C. Docker healthcheck — correção mínima pronta, NÃO implantada

- Antes: `test: ["CMD-SHELL", "node -e \"fetch(...)\""]` (shell extra + quoting aninhado frágil).
- Depois (1 linha, `deploy/staging/docker-compose.staging.yml:119`):
  `test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/v1/health/ready').then(function(r){if(!r.ok)process.exit(1)}).catch(function(){process.exit(1)})"]`
- Preservados: endpoint `/v1/health/ready`, interval 30s, timeout 5s, retries 3, start_period 30s.
- Validação: `docker compose config --services` → EXIT 0 (`postgres,migrate,api,tunnel,web`); bloco api parseado com forma exec. Sem `up` (só validação). `postgres` permanece `CMD-SHELL` (precisa de `$$`).
- Entrega: manter SEPARADA da B3 (cherry-pick de 1 linha); CHANGELOG sugerido (não aplicado para não misturar):
  `fix(deploy): api healthcheck em forma exec (sem CMD-SHELL)`.

## D. Infisical — modelo corrigido, identidade NÃO provisionada

Achado do security-reviewer (procede, confirmado no código):

- `SecretsWriterPort` é obrigatório: `integrations.commands.ts` usa `putSecret` (Asaas `ASAAS_API_KEY`, CINEVISION, `ASAAS_WEBHOOK_TOKEN` em `webhook_ensure`) + `deleteSecret` como compensação. Read-only quebraria `configure`/`webhook_ensure` (falha fail-closed).
- Desalinhamento de ambiente: refs de integração são `infisical://<environment>/integrations/<tenant>/<provider>/<KEY>` onde `<environment>` = `SANDBOX|PRODUCTION` (enum do comando, `integrations.commands.ts:177`), NÃO `staging`. `INFISICAL_ENVIRONMENT=staging` (exemplo) é só fallback; refs carregam o próprio env (`packages/secrets/src/index.ts:744-752`, README).
- Identidade correta `iptv-api-staging`: Universal Auth no MESMO projeto, com leitura de segredos de app (env `staging`) + leitura/escrita+exclusão RESTRITAS a `integrations/<tenant>/<provider>/*` nos envs `SANDBOX` (rehearsal) e, quando autorizado, `PRODUCTION`; sem acesso a namespace do Browser Worker (`BROWSER_INFISICAL_*` separado), sem outros projetos/envs. `delete` no namespace autorizado é necessário (compensação). Docs antigas que dizem "read-only" estão erradas para a Central de Integrações.
- Smoke NÃO executado (exige identidade): login Universal Auth, leitura permitida/negada, put/get/update/delete em namespace de teste sintético, escrita negada fora de escopo, sem segredo em log — via `packages/secrets/scripts/infisical-smoke.mjs` + caminho da API (`resolveSecretsWriterPort` ≠ Noop).

Procedimento do operador (quando autorizado): criar identidade → vincular projeto → conceder envs `staging` (leitura app) + `SANDBOX` (leitura/escrita `integrations/*`) → entregar `INFISICAL_{SITE_URL,PROJECT_ID,CLIENT_ID,CLIENT_SECRET}` pelo canal seguro → configurar `.env.staging` → recriar só `api` → confirmar adapter real (não Noop) → smoke sintético.

## E. Asaas Sandbox — NÃO executado (gates acima vermelhos)

Nenhum `configure`, `test`, `webhook_ensure`, pedido, PIX, pagamento, liquidação, assinatura ou fulfillment foi executado. Sem efeitos financeiros.

## F. Bloqueios restantes (ação exata, responsável, evidência necessária)

1. Rota pública real (Tunnel ID, conectores, ingress, VPS antiga) — operador Cloudflare/VPS — evidência: `PUBLIC_TUNNEL_STABLE` com request-IDs públicos nos logs da origem pretendida + 100x consistente (só após correção).
2. B3: PR + CI + deploy + verificação pública — operador (publicar PR/merge/deploy) + agente (suite com DB descartável) — evidência: `403 REGISTER_CLOSED` no hostname público + login existente OK.
3. Healthcheck: deploy da linha + `docker ps` healthy + `depends_on` satisfeito — operador (deploy) — evidência: `STAGING_API_HEALTHY`.
4. Infisical: criar identidade com escopos corrigidos + smoke — operador (cofre) — evidência: `STAGING_VAULT_READY`.
5. Rehearsal Asaas Sandbox + `FIRST_SALE_REHEARSAL_PASSED` — operador + agente (após 1–4) — evidência: pedido SETTLED, pagamento CONFIRMED, ledger balanceado, assinatura única.

## G. Veredito

| Gate | Status | Evidência |
|---|---|---|
| PUBLIC_TUNNEL_STABLE | BLOCKED | §A: 4 probes mínimas (2 health + ready + web), DNS edge, origem não identificada; sem mutação |
| PUBLIC_REGISTRATION_CLOSED | BLOCKED | §B: 69 + 10 PASS locais, sem deploy, sem prova pública |
| STAGING_API_HEALTHY | BLOCKED | §C: fix 1 linha + compose config PASS, sem deploy |
| STAGING_VAULT_READY | BLOCKED | §D: modelo corrigido (SANDBOX, não só staging), sem identidade, sem smoke |
| ASAAS_SELF_SERVICE_SANDBOX_VALIDATED | BLOCKED | §E: não executado |
| FIRST_SALE_REHEARSAL_PASSED | BLOCKED | §E: não executado |

Estado de engenharia: B3 + healthcheck prontos para PRs pequenos e separados (CI com DB pendente).
Estado operacional: `BLOCKED_OPERATOR_ACTION` (Cloudflare/VPS, Infisical, deploy, PR). Nenhuma nova missão P8.6 necessária — retomar deste handoff.
