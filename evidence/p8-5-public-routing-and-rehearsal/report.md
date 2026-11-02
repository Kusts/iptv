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
- Config local esperada (repo): os serviços de staging são encaminhados a loopback por `cloudflared`; a configuração remota do ingress é gerenciada fora do repositório. IDs de túnel/conector e valores de token não são registrados aqui.
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

## Addendum 2026-10-31 — fatos consumados após autorização do operador

1. **PRs mergeados.** `#115 fix/deploy/api-healthcheck-exec` MERGED (`562ac5b`, CI 8/8 verde: build/adversarial/outbox-050-role-guards/security-scans). `#116 feat/api/register-closed` MERGED (`3934c33`, CI verde; conflito de CHANGELOG resolvido via merge commit `e482225` mantendo as duas linhas). `main` atual: `3934c33`.
2. **Causa raiz A PROVADA (não mais hipótese).** Duas instâncias do túnel de staging publicavam rotas concorrentes. A origem obsoleta foi identificada e o serviço de túnel não relacionado foi preservado. Identificadores, endereços de origem e topologia detalhada foram omitidos desta cópia pública.
3. **Correção aplicada.** A instância obsoleta foi parada com rollback disponível; a API de conexões passou a listar um conector; a saúde pública passou a indicar `scheduler: disabled`; a web deixou de exibir o marcador fantasma; e um `requestId` público foi correlacionado aos logs da origem correta.
4. **Incidente de sonda.** 1 `POST /v1/auth/register` de teste retornou `201` (B3 ainda não implantada no staging), criando usuário `probe-b3@example.invalid`; removido em seguida via DELETE com CASCADE verificado (`credentials 0`, `sessions 0`).
5. **Deploy em andamento.** Em `main@3934c33`, o fechamento do cadastro público foi habilitado e o rebuild/recreate da API foi iniciado. Pendente naquele momento: health, `403` público, suite B2 (100+100), login de conta autorizada, Infisical e rehearsal Asaas.
6. **Matriz de veredito atualizada.**

| Gate | Status | Evidência |
|---|---|---|
| PUBLIC_TUNNEL_STABLE | PASS (parcial) | rota provada e corrigida (1 conector, requestId correlacionado); B2 completa (100+100) pendente |
| PUBLIC_REGISTRATION_CLOSED | BLOCKED | B3 mergeada (3934c33), deploy em curso, sem prova pública ainda |
| STAGING_API_HEALTHY | BLOCKED | recreate da api em curso, healthy pendente |
| STAGING_VAULT_READY | BLOCKED | identidade/smoke pendentes |
| ASAAS_SELF_SERVICE_SANDBOX_VALIDATED | BLOCKED | não executado |
| FIRST_SALE_REHEARSAL_PASSED | BLOCKED | não executado |

## Addendum 2 — 2026-10-31 (staging correto, suite B2, Infisical travado)

Autor: subagente (P85-REPORT-ADDENDUM2). Escopo: registrar fatos consumados; sem segredos nem identificadores operacionais nesta cópia pública.

1. **B2 PASS completo — suite independente.** Executada por tester independente contra os hostnames públicos. O total agregado de requests não é reconstruível pelos itens registrados; por isso, não se afirma aqui um total nem proximidade ao teto:
   - health 100/100: `scheduler: disabled` (origem local correta);
   - web 100/100: sem marcador fantasma (só nonces CSP variam);
   - 20/20 pares público/loopback idênticos (bodies byte-idênticos excluindo `requestId`);
   - 20/20 concorrentes; 5/5 `requestId`s públicos encontrados nos logs locais;
   - 5/5 `POST /v1/auth/register` → `403 REGISTER_CLOSED`, `control.users` 3→3 (nenhum usuário criado).
   - Notas neutras (não invalidam): e-mail com `+` devolve `400` do ValidationPipe antes do gate; 5 sondas iniciais com JSON malformado por quoting deram `400` (nada criado).
2. **Deploy staging correto.** Em `main@3934c33`, o cadastro público retornou `403 REGISTER_CLOSED`; a API ficou healthy e as migrations foram aplicadas. Gates C e D PASS.
3. **Stack antigo retirado.** O banco foi respaldado antes da retirada; volume e imagens foram preservados e o rollback permaneceu disponível. O túnel de staging foi reduzido à origem intencional; serviços não relacionados permaneceram intactos.
4. **Infisical BLOCKED com diagnóstico.** O adapter selecionava Infisical (não noop), mas o login excedia o timeout apesar de a origem alcançar DNS/TCP/TLS. O endpoint público do vault ainda apontava para uma instalação indisponível e a VPS nova não tinha rotas do serviço. Sem cofre funcional, `configure`/`webhook_ensure` falhavam fechado.
5. **Matriz atualizada.**

   | Gate | Status | Evidência |
   |---|---|---|
   | PUBLIC_TUNNEL_STABLE | PASS | §1–2: 100+100 + loopback idêntico + requestIds nos logs locais |
   | PUBLIC_REGISTRATION_CLOSED | PASS | §1–2: 403 público + `control.users` estável, flag ativa no staging |
   | STAGING_API_HEALTHY | PASS | §2: `api` healthy, healthcheck exec, `migrate` OK |
   | STAGING_VAULT_READY | BLOCKED | §4: login trava, cofre inacessível |
   | ASAAS_SELF_SERVICE | BLOCKED | depende do cofre |
   | FIRST_SALE_REHEARSAL_PASSED | BLOCKED | depende do cofre |

   Pendentes naquele momento: acesso autenticado do operador para login/rehearsal e decisão sobre o Infisical.

## Addendum 3 — 2026-10-31 (Infisical novo do zero, compat adapter, smoke E5 VERDE)

Autor: subagente (P85-REPORT-ADDENDUM3B). Escopo: registrar fatos consumados; sem valores de segredo ou identificadores de infraestrutura nesta cópia pública.

1. **Infisical novo do zero em VPS dedicada.** Compose do runbook com digest pinado conferido; segredos gerados no servidor em arquivo com permissão restrita; três serviços healthy; `/api/status` 200 local. O DNS foi corrigido da instalação indisponível para a nova VPS; HTTPS público 200 e proxy reverso ativo.
2. **Bootstrap.** Conta administrativa e projeto dedicado foram criados, com ambiente `sandbox` e identidade machine de Universal Auth com membership administrativo no projeto. Uma identidade duplicada e um segredo temporário perdido foram removidos/revogados. Identificadores de contas, projeto e identidade foram omitidos.
3. **Incompatibilidades provadas adapter × servidor v0.165.16 e correções.** (a) environment uppercase → 404 — fix: `transportEnv` lowercase só no transporte (PR #118, merge `da88feb`); (b) pastas precisam existir — criadas via API; (c) DELETE exige body JSON (422 sem) — fix; (d) duplicado retorna 400 "already exists" (não 409) — fix com inspeção de corpo (PR #119, merge `da3cbe1`). Deploy staging em `main@da3cbe1`, api healthy.
4. **Smoke E5 VERDE via adapter real no container.** PUT `created=true`, GET match, UPDATE match, DELETE `gone=true`; escrita fora de namespace negada (`MALFORMED_REF`); env `production` negado; nenhum segredo em log. Ressalva: role admin no projeto dedicado (roles custom / folder-access granulares exigem plano Enterprise); compensações: projeto dedicado, guards de namespace no código, identidade separada do Browser Worker. Gate STAGING_VAULT_READY: PASS com ressalva documentada.
5. **Matriz final.**

   | Gate | Status | Evidência |
   |---|---|---|
   | PUBLIC_TUNNEL_STABLE | PASS | Addendum 2 §1–2 (suite B2: health, web, pares público/loopback, concorrência e cadastro fechado) |
   | PUBLIC_REGISTRATION_CLOSED | PASS | Addendum 2 §1–2 (403 público + `control.users` estável) |
   | STAGING_API_HEALTHY | PASS | §3: deploy `main@da3cbe1`, api healthy |
   | STAGING_VAULT_READY | PASS (ressalva) | §4: smoke E5 VERDE; role admin no projeto dedicado (Enterprise exigido p/ granular) |
   | ASAAS_SELF_SERVICE_SANDBOX_VALIDATED | BLOCKED | credencial Sandbox do operador pendente |
   | FIRST_SALE_REHEARSAL_PASSED | BLOCKED | idem + checkout |

   Rollbacks registrados: backup de banco e preservação de volume/imagens; reversão de DNS e do túnel disponíveis para o operador.

## Addendum 4 — 2026-10-31 (bug /v3/v3/, fiação por tenant, G1 + rehearsal G)

Autor: subagente (P85-REPORT-ADDENDUM4). Escopo: registrar fatos consumados; sem segredos (só IDs públicos; sem tokens/senhas/chaves).

1. **Bug `/v3/v3/` provado e corrigido.** `ASAAS_HOSTS`/`ASAAS_TENANT_HOSTS` terminam com `/v3`, mas 5 call sites concatenavam `/v3/...` (probe, fallback de customers, list/create/update de webhook) → 404 sistemático. Cobranças (paths relativos) intactas. Fix PR #120 (merge `a73b7b5`) + teste de URLs. Fiação morta: `commands.provider` injetava `asaasPort` fixo do env, sombreando `resolveAsaasPortForTenant` (S2C) — fix PR #121 (merge `be8f550`). Deploy staging em `main@be8f550`.
2. **Débitos técnicos registrados (não bloqueiam o rehearsal, viram follow-up).** (a) `handleConfigure` não cria pastas do tenant no cofre (servidor v0.165 exige pasta pré-existente; criada manualmente para o tenant); (b) comando `test`/webhook com 404 mapeado de forma indistinguível (mensagem "webhook save" também para falha no list); (c) role admin no projeto Infisical dedicado (granular exige Enterprise).
3. **G1 Asaas Sandbox pelo produto: PASS.** `configure` criou binding DRAFT, `test` atingiu CONNECTED_READ_ONLY, `webhook_ensure` ficou ACTIVE com token de autenticação presente; ingress respondeu 401 sem autenticação e 202 com autenticação.
4. **G2 FIRST_SALE_REHEARSAL: fluxo financeiro completo provado.** Um rehearsal Sandbox concluiu a cobrança PIX via webhook: charge PAID, payment CONFIRMED, order SETTLED e ledger balanceado. Há uma única assinatura em PENDING_ACTIVATION e a operação de fulfillment está em HUMAN_REQUIRED; a ativação no painel do fornecedor continua pendente e não foi declarada entregue. O recovery de charges respondeu com sucesso e não houve duplicação de entidades. A exceção UNKNOWN_CHARGE refere-se a uma sonda sintética sem mutação.
5. **Matriz final.**

   | Gate | Status | Evidência |
   |---|---|---|
   | PUBLIC_TUNNEL_STABLE | PASS | Addendum 2 §1–2 (suite B2: health, web, pares público/loopback, concorrência e cadastro fechado) |
   | PUBLIC_REGISTRATION_CLOSED | PASS | Addendum 2 §1–2 (403 público + `control.users` estável) |
   | STAGING_API_HEALTHY | PASS | §1: deploy staging em `main@be8f550` |
   | STAGING_VAULT_READY | PASS (ressalva) | Addendum 3 §4 + §2: smoke E5 VERDE; role admin (Enterprise exigido p/ granular) |
   | ASAAS_SELF_SERVICE_SANDBOX_VALIDATED | PASS | §3: via produto, com pastas manuais |
   | FIRST_SALE_REHEARSAL_PASSED | PASS PARCIAL | §4: fluxo financeiro completo provado; fulfillment aguarda ativação do operador no painel |

   Pendentes do operador: ativação CINEVISION + resolve da operation; rotação e revogação das credenciais temporárias; merge #117; decisão sobre follow-ups (ensureFolder, granularidade, mensagem 404).
