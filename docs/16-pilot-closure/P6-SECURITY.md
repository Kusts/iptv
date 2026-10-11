# P6 — Security gates + revisão (parte 1: CI e sessão; sem mudar runtime)

> TASK_ID: CODER-P6A · branch `closure/p6-hardening` · SPEC C8 (fatia 1)
> Escopo desta slice: jobs novos na CI + decisão de sessão documentada +
> revisão CORS/CSP/secrets/worker-creds/admin. **Nenhum runtime de auth,
> sessão, CORS ou header foi alterado aqui** — decisão + prova primeiro;
> migração HttpOnly (se um dia adotada) é plano, não implementação.
>
> **Atualização posterior (issue #44, subfatia frame policy web):** o §8 foi
> atualizado porque `apps/web/next.config.mjs` passou a emitir
> `frame-ancestors 'none'` + `X-Frame-Options: DENY` em todas as rotas web.
> As seções 1–11 acima permanecem fiéis ao escopo original do P6a; a nota de
> "nenhum header alterado" descreve aquela slice, não o estado atual.

## 1. Matriz de controles

| # | Controle | Estado | Evidência / gate |
|---|---|---|---|
| S1 | Secret scan na CI (gitleaks 8.24.0 pinado, histórico + `--redact`) | NOVO, verde | job `security-scans` em `.github/workflows/ci.yml`; `.gitleaks.toml`; §2 |
| S2 | Dependency vuln scan (threshold high, baseline comparada) | NOVO, verde | `scripts/ci-audit-gate.py` + `tests/security/audit-baseline.json`; §3 |
| S3 | Suites adversariais em job próprio | NOVO, verde (17/17) | job `adversarial`; §4 |
| S4 | Migration/proof PG tests na CI | Existente, sem mudança | job `build` (`run_pg_fixture_tests.sh`) + `outbox-050-role-guards`; sem lacuna — nenhum job novo |
| S5 | Contracts/docs gates | Existente, sem mudança | `validate_docs.py`, `test_contracts.py`, `test_seed_contract.py` no `build` (+ guarda no self-test) |
| S6 | Self-test dos gates P6 | NOVO, verde (6/6) | `tests/security/test_ci_security_gates.py`, roda no `security-scans` |
| S7 | Branch governance | Compensação (protection indisponível) | §5 |
| S8 | Sessão localStorage vs HttpOnly | DECIDIDO: manter localStorage no pilot (aceitação explícita) | §6 |
| S9 | CORS | Revisado, sem achado bloqueante | §7 |
| S10 | CSP / security headers | PARCIAL: frame policy web implementada; rate-limit/API headers/CSP geral pendentes (issue #44) | §8 |
| S11 | Secrets no repo/CI | Revisado; scan verde | §9 |
| S12 | Worker credentials | Revisado, fail-closed | §10 |
| S13 | Admin endpoints | Revisado; sem rate-limit dedicado (follow-up) | §11 |

## 2. Secret scanning

- Ferramenta: gitleaks **8.24.0** (versão pinada no job; binário baixado do
  release oficial sobre TLS; mesma versão validada localmente).
- Cobertura: `detect` sobre o histórico completo (`fetch-depth: 0` no
  checkout) — 119 commits / ~8,5 MB varridos localmente.
- Resultado local: **0 leaks** com `.gitleaks.toml` (antes do allowlist: 4
  achados, todos triados como falso-positivo — abaixo).
- Achados triados (allowlist cirúrgica, `regexTarget="secret"` + path por
  AND — um segredo real novo nesses arquivos continua falhando):
  - `apps/api/test/billing-rls-rehearsal.integration.test.ts:89`
    `p13-fix1-asaas-secret` — fixture sintética (só trafega hasheada via
    `sha256Hex` + header de teste).
  - `apps/api/test/experiments-w16.integration.test.ts:219`
    `w16-exposure-idem` — idempotency-key de fixture.
  - `apps/api/test/trial-dispatch.unit.test.ts:1689`
    `n3-arbitrary-resolve-key` — idempotencyKey de fixture.
  - `docs/06-decisions/ADR-0015-auth-better-auth.md:18`
    `2FA/passkeys/organization` — prosa do ADR.
- Sem segredos em logs: o job usa `--redact` (verificado localmente com
  controle positivo/negativo: token sintético `github-pat` detectado com
  valor exibido como `REDACTED`, exit 1).
- Nota: `.env` local (gitignored) contém `BETTER_AUTH_SECRET` real de dev —
  esperado; o scan da CI roda em checkout fresco sem `.env`. Prova de que o
  gitignore segura o segredo local.

## 3. Dependency audit

- Threshold documentado: **high** (blocking = high + critical; moderate/low
  são report-only no log do gate).
- Mecanismo: `scripts/ci-audit-gate.py` (stdlib apenas) compara
  `pnpm audit --json` contra `tests/security/audit-baseline.json` e **falha
  só em high/critical NOVO**; entradas resolvidas upstream viram aviso
  STALE sem quebrar o build.
- Baseline 2026-10-08: 19 advisories (9 moderate, **8 high, 2 critical** —
  os 10 reconhecidos com `reason` + `followup` cada):
  - `tinypool` critical ×2 (via vitest): **dev-only** (pool de workers do
    runner de teste; exploit exige código já no processo de teste).
    Follow-up: bump do vitest quando `tinypool>=2.1.2` fluir.
  - `fastify` high ×4 (via `@nestjs/platform-fastify`, **runtime da API**:
    body replacement, auth bypass via URL malformada, validation bypasses).
    Reconhecidos porque o upgrade exige bump peer-compatível do NestJS —
    mudança runtime com regressão, fora desta slice. Revalidados a cada
    CI; qualquer advisory novo falha o gate.
    Follow-up: slice dedicada de upgrade fastify/nest com regressão.
  - `postcss` high ×2, `sharp` high ×1 (via next): **build-time** (CSS/imagem
    próprios no build; sem input de atacante no pipeline).
  - `source-map-js` high ×1 (via vitest/vite): **dev-only**.
  - `next` moderate ×2 (cache poisoning SSG/ISR): report-only pelo threshold.
- Resultado local: `AUDIT-GATE PASS: nenhum high/critical novo` (exit 0).

## 4. Suites adversariais (job `adversarial`, PG próprio descartável)

| Suite | Cobre | Resultado local |
|---|---|---|
| `test/agent-shadow-approval.integration.test.ts` | bus nega tool/comando não autorizado, cross-tenant (F09/F10 núcleo) | PASS |
| `test/agent-model-failure.test.ts` | recusa ruidosa em falha de modelo, sem envio | PASS (6/6) |
| `test/rls-tenant-context.integration.test.ts` | isolamento de tenant no contexto (F10) | PASS |
| Total | | **3 arquivos, 17/17** em PG scratch descartável (container removido após) |

Limitação honesta (herdada da P5): não há dataset dedicado de red-team de
prompt-injection além do fail-closed do bus + recusas do harness; cobertura
é negação/guardas, não adversário gerativo. Não bloqueia o pilot.

## 5. Branch governance (protection indisponível → compensação)

- Verificação somente-leitura: `gh api repos/Kusts/iptv/branches/main/protection`
  → **HTTP 403**: *"Upgrade to GitHub Pro or make this repository public to
  enable this feature."* Repositório privado sem Pro: **branch protection e
  rulesets indisponíveis** — nenhuma escrita foi tentada.
- Compensações registradas (vigoram até o repo ter proteção nativa):
  1. Gates CI obrigatórios por convenção: `build` (lint+typecheck+test+build+
     provas PG+3 gates Python) + `outbox-050-role-guards` +
     `security-scans` + `adversarial` — PR só integra com tudo verde.
  2. Review humano em todo PR; sem merge automático; sem push direto em
     `main` (convenção social + histórico auditável).
  3. Sem `CODEOWNERS` hoje — follow-up (fora do write-scope desta slice).

## 6. Decisão de sessão: localStorage vs HttpOnly — DECIDIDA

Fato atual: bearer em `localStorage` (`TOKEN_KEY = "iptv.session_token"`,
`apps/web/lib/api.ts:13,36-48`), enviado via header `Authorization`
(nunca em query string — grep sem ocorrência de `?token=`/`access_token=`).
Legível por qualquer JS da página ⇒ **XSS = roubo de sessão**.

| | localStorage (atual) | HttpOnly cookie + SameSite |
|---|---|---|
| XSS rouba sessão? | Sim (compensar) | Não (JS não lê) |
| CSRF | N/A (header manual, sem auto-attach) | Vira requisito: tokens anti-CSRF por escrita |
| CORS | `credentials:false` (atual, simples) | `credentials:true` + allowlist (superfície maior) |
| Cross-tab | `storage` event (já implementado e testado) | Redesign (ex.: BroadcastChannel) |
| Logout/401 | Limpeza local + broadcast (pronto) | Cookie cleared pelo servidor + CSRF no logout |
| Custo agora | Zero (endurecer) | Slice runtime grande pré-pilot |

**DECISÃO: manter `localStorage` no pilot — aceitação explícita do risco,
com compensações verificadas (não implementadas aqui porque já existem):**

1. Sem `dangerouslySetInnerHTML` na web (grep: 0 ocorrências) — reduz a
   principal fonte de XSS persistente/refletido no próprio código.
2. Token nunca em URL, log ou marcador cross-tab (`SESSION_SIGNAL` carrega
   só `timestamp:random`, não-secreto por construção).
3. 401 autoritativo limpa token + revisão + cache e faz broadcast
   (`api.ts:198-222`); logout é local-first com limpeza síncrona.
4. Sessão server-side com TTL (default 168h em `packages/auth`) e estado
   `ACTIVE` — revogação existe no servidor.

Risco residual aceito: XSS via dependência comprometida ou vetor não
coberto ainda exfiltra o bearer; janela padrão de 7 dias amplia o impacto
(follow-up: reduzir TTL/rotacionar — pós-pilot).

**Plano de migração HttpOnly (aberto, NÃO implementar nesta slice):**
cookie `Secure`+`HttpOnly`+`SameSite=Lax` (Strict avaliado contra top-level
navigations do pilot) emitido no login; CSRF token (double-submit ou
sincronizador) em todo POST; `registerApiCors` com `credentials:true`;
sinal cross-tab migrado para `BroadcastChannel`; logout via endpoint que
limpa o cookie; suíte de regressão das guards anti-race do `auth.tsx`
(teletransporte de token em módulo some — `getToken()` vira leitura de
sessão). Gatilho de reavaliação: qualquer XSS confirmado ou dependência
web crítica sem patch.

## 7. CORS — revisado, sem achado bloqueante

`apps/api/src/api-cors.ts` (+ `main.ts:30`): allowlist explícita de origens
(`CORS_ALLOWED_ORIGINS`, vazia = nega tudo — sem fallback localhost),
`credentials:false`, métodos `GET/HEAD/POST/OPTIONS`, 7 headers
allowlistados. Sem `origin:true`, sem `*`, sem reflexão.
Observação (não-achado): `asaas-access-token` no allowlist é intencional
para tooling de provider via browser, documentado no próprio arquivo.

## 8. CSP / security headers — PARCIAL: frame policy web implementada (issue #44)

**Subfatia de baixo risco implementada nesta branch (issue #44,
`closure/security-public-auth-20261010`):**

- `apps/web/next.config.mjs` ganhou `headers()` global com uma única regra
  `source: "/:path*"` (catch-all — todas as rotas web, sem `has`/`missing`)
  emitindo **exatamente dois headers**: `Content-Security-Policy:
  frame-ancestors 'none'` e `X-Frame-Options: DENY`.
- Motivo do par: `frame-ancestors 'none'` é o mecanismo moderno e
  `X-Frame-Options: DENY` cobre navegadores antigos sem suporte à diretiva.
- Prova por teste de regressão: `apps/web/test/frame-policy.test.ts` (7 asserts,
  roda em `pnpm --filter @iptv/web test`) chama o `headers()` real da config,
  aplica o matcher do Next às rotas top-level descobertas de `apps/web/app` e
  a caminhos aninhados/assets, e trava aplicação incondicional e valores exatos.
- Prova por HTTP real: build de produção + servidor standalone local
  (porta 3999) — `/`, `/login`, `/crm` responderam HTTP 200 e `/growth/abc`
  respondeu 404, **todos** com os dois headers. Nenhum outro header de
  segurança foi adicionado.

**Ainda pendente nesta seção (segue GAP; issue #44 registra o restante):**

1. **Rate limiting / throttling na API** — permanece sem implementação
   (grep `throttle|rate.?limit`: 0). Login/cadastro são endpoints públicos;
   não há controle compensatório de ingress comprovado nesta revisão. Não
   liberar exposição pública irrestrita até fechar o issue #44 ou obter
   evidência de mitigação equivalente autorizada.
2. **Security headers da API** (`Strict-Transport-Security`,
   `X-Content-Type-Options`, `Referrer-Policy`, helmet) — fora do escopo desta
   subfatia, que toca só a web.
3. **CSP geral** (`default-src`/`script-src`/`style-src` com nonce) — deliberada
   e explicitamente fora: CSP ampla exige inventariar os recursos inline do
   App Router e quebraria a UI sem uma fatia dedicada. A CSP emitida agora é
   apenas a diretiva de framing.
4. **Exposição pública / auth pública** — o issue #44 foi aberto para registrar
   o conjunto (auth + framing); a presente subfatia cobre somente framing web.
   Nenhuma mudança de auth, CORS, sessão ou autorização foi feita aqui.

**Estado honesto:** frame policy web = implementada e verificada. Rate limit,
headers de API, CSP geral e exposição pública = **pendentes**. Nada nesta seção
declara "security pass" do piloto; a matriz S10 continua GAP residual.

## 9. Secrets — revisado

- `.env.example`: só placeholders/defaults; chaves Asaas com `$` exigem
  aspas simples (documentado + armadilha conhecida no AGENTS.md).
- Segredos reais: via ambiente local (`.env` gitignored) ou refs
  `infisical://` (ADR-0014, `packages/secrets`); nenhum valor cru no repo
  (scan §2 verde no histórico completo).
- CI: nenhum segredo além do `GITHUB_TOKEN` implícito; gitleaks com
  `--redact` garante que um futuro achado não vaza valor no log.

## 10. Worker credentials — revisado, fail-closed

Credenciais CINEVISION/MK **nunca** como valores crus: o worker resolve 3
refs fixas via identidade `BROWSER_INFISICAL_*` e recusa boot sem elas
(`apps/browser-worker`; `.env.example:197-220` comentado por desenho).
Sem achado.

## 11. Admin endpoints — revisado

- `POST/GET v1/admin/outbox` (`outbox.controller.ts`) e
  `v1/admin/provider-dispatch`: `AuthGuard` + `isPlatformAdmin` explícito
  (403 caso contrário), derivado de `users.is_platform_admin` (migração
  012) — sem bypass por membership de tenant.
- Observação: sem rate-limit/throttling dedicado na API (grep
  `throttle|rate.?limit`: 0). Pilot de baixo volume + auth obrigatória
  contém o risco; follow-up pós-pilot (mesma slice dos headers §8).

## 12. Validação desta slice

- `gitleaks detect --source . --config .gitleaks.toml --redact` (8.24.0,
  119 commits): **no leaks found**, exit 0.
- `python scripts/ci-audit-gate.py`: **PASS** (19 totais, 10 ack, 0 novos).
- `python tests/security/test_ci_security_gates.py`: **6/6 OK**.
- `python -c yaml.safe_load(ci.yml)`: 4 jobs
  (`build`, `outbox-050-role-guards`, `security-scans`, `adversarial`).
- Adversariais em PG scratch descartável: **17/17** (container removido).
- actionlint indisponível localmente → validação por parse YAML + espelho
  dos stanzas de service/setup já usados nos jobs existentes.
- CI existente intocada: diff do workflow só **adiciona** jobs; `build` e
  `outbox-050-role-guards` byte-idênticos.

## Follow-ups (fora desta slice)

1. Slice dedicada de upgrade fastify/nest (4 high runtime, §3).
2. Security headers + rate-limit na API (§8, §11). Nota: a frame policy web
   (`frame-ancestors 'none'` + `X-Frame-Options: DENY`) já está implementada
   (§8) — o que resta neste item é rate-limit/throttling e os headers da API.
3. Reduzir TTL de sessão / rotação (§6).
4. `CODEOWNERS` + proteção de branch quando o plano GitHub permitir (§5).
5. Dataset red-team de prompt-injection (§4).
