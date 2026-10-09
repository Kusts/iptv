# P6 — Security gates + revisão (parte 1: CI e sessão; sem mudar runtime)

> TASK_ID: CODER-P6A · branch `closure/p6-hardening` · SPEC C8 (fatia 1)
> Escopo desta slice: jobs novos na CI + decisão de sessão documentada +
> revisão CORS/CSP/secrets/worker-creds/admin. **Nenhum runtime de auth,
> sessão, CORS ou header foi alterado aqui** — decisão + prova primeiro;
> migração HttpOnly (se um dia adotada) é plano, não implementação.

## 1. Matriz de controles

| # | Controle | Estado | Evidência / gate |
|---|---|---|---|
| S1 | Secret scan na CI (gitleaks 8.24.0 pinado, histórico + `--redact`) | NOVO, verde | job `security-scans` em `.github/workflows/ci.yml`; `.gitleaks.toml`; §2 |
| S2 | Dependency vuln scan (threshold high, baseline comparada) | NOVO, verde | `scripts/ci-audit-gate.py` + `tests/security/audit-baseline.json`; §3 |
| S3 | Suites adversariais em job próprio | NOVO, verde (17/17) | job `adversarial`; §4 |
| S4 | Migration/proof PG tests na CI | Existente, sem mudança | job `build` (`run_pg_fixture_tests.sh`) + `outbox-050-role-guards`; sem lacuna — nenhum job novo |
| S5 | Contracts/docs gates | Existente, sem mudança | `validate_docs.py`, `test_contracts.py`, `test_seed_contract.py` no `build` (+ guarda no self-test) |
| S6 | Self-test dos gates P6 | NOVO, verde (18/18) | `tests/security/test_ci_security_gates.py`, roda no `security-scans` |
| S7 | Branch governance | Compensação (protection indisponível) | §5 |
| S8 | Sessão localStorage vs HttpOnly | DECIDIDO: manter localStorage no pilot (aceitação explícita) | §6 |
| S9 | CORS | Revisado, sem achado bloqueante | §7 |
| S10 | CSP / security headers | GAP registrado, follow-up pós-pilot | §8 |
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
- Gate fail-closed contra falha operacional (patch desta branch): saída
  vazia do `pnpm audit` (comando morto: registry fora, shim ausente, rc != 0),
  JSON malformado e JSON estruturalmente inválido (não-objeto, sem
  `advisories` ou `advisories` não-dict) agora **FALHAM** com exit 1. Antes,
  `pnpm audit --json` morto com stdout vazio era interpretado como `{}` e
  produziria **PASS** indevido. O exit code do pnpm (!= 0 quando há
  vulnerabilidades, inclusive as reconhecidas) **não** decide o gate — o
  veredito vem do conteúdo do JSON; PASS só com JSON válido e zero
  high/critical fora da baseline (advisory nunca é mutado).
- Revisão da validação estrutural (fail-closed em 2 níveis, patch desta
  branch): a checagem anterior cobria só o formato externo, então payload
  como `{"advisories":{"999":{"title":"x"}},"metadata":{"vulnerabilities":{"high":1}}}`
  **passava** — severidade ausente não é blocking e `metadata` não era
  conferido. Agora: (1) todo registro em `advisories` precisa ser objeto com
  `severity` não-vazia do enum conhecido (`info`/`low`/`moderate`/`high`/
  `critical`) — auditamos TODAS as severidades, não só high/critical;
  (2) `metadata.vulnerabilities` precisa existir, com contador inteiro
  não-negativo para cada severidade do enum, sem campos desconhecidos;
  (3) os contadores precisam reconciliar 1:1 com os registros de
  `advisories` (contrato verificado contra saída real do
  `pnpm audit --json`, pnpm 10.15.0). Qualquer dado ausente, desconhecido ou
  inconsistente **FALHA** — o gate não decide sobre payload incompleto.
  Exit code != 0 do pnpm com payload válido e reconcilido continua
  legítimo e não decide o gate.
- Baseline 2026-10-09 (pós-overrides `pnpm.overrides` no root, drift
  conferido a cada CI pelo gate): **8 advisories — 5 moderate (report-only),
  3 high/critical reconhecidos com `reason` + `followup`**:
  - `tinypool` critical ×2 (via vitest): **dev-only** (pool de workers do
    runner de teste; exploit exige código já no processo de teste). Só
    resolve com migração **Vitest 3 → 4** (`tinypool>=2.1.2` é major de
    tinypool; vitest 3.2.7 fixa `^1.1.1` no lockfile).
  - `@opentelemetry/propagator-jaeger` high ×1 (transitive-only do SDK de
    trace 1.30.1): nunca importado/registrado no código (propagação é só W3C
    traceparent); o DoS exige JaegerPropagator processando header
    malformado — inalcançável aqui; sai com bump do SDK.
  - moderate report-only (threshold high): `@opentelemetry/core`,
    `vitest`, `@vitest/mocker` e `next` ×2 (cache poisoning SSG/ISR).
  - **Resolvidos in-place nesta branch** (removidos da baseline):
    `fastify` high ×4 (override `^5.12.5` via `@nestjs/platform-fastify`),
    `postcss` high ×2 (`^8.5.23`), `sharp` high ×1 (`^0.35.5`),
    `source-map-js` high ×1 (`^1.2.2`).
- Resultado local: `AUDIT-GATE PASS: nenhum high/critical novo` (exit 0;
  8 totais, 3 high/critical, 3 ack, 0 novos).
- **Follow-up VITEST4 executado neste repo** (branch
  `closure/security-vitest4-20261009`, sobre o HEAD 9ef38b8 do PR #38):
  Vitest 3 → 4 nos 12 workspaces (`vitest: ^4.1.11`; lockfile resolve
  **vitest 4.1.11** + `@vitest/*` 4.1.11; `vite` segue **7.3.6**, dentro do
  peer `^6||^7||^8`). A linha Vitest 4 **não depende mais de `tinypool`**
  (`grep tinypool pnpm-lock.yaml`: 0 ocorrências), então saem da árvore:
  - `vitest` + `@vitest/mocker` moderate (path traversal via redirect mock,
    patched em `>=4.1.11` — é exatamente o piso mínimo exigido);
  - `tinypool` critical ×2 (`GHSA-5gmw-xhrv-c9v3`,
    `GHSA-85c8-ppgw-ccpr`) — **removidos da baseline por resolução real**
    (não mute): `pnpm audit --json` vivo passa a reportar **4 advisories,
    0 critical**.
  - Estado atual do gate (validado ao vivo): **4 totais — 3 moderate
    report-only (`@opentelemetry/core`, `next` ×2) + 1 high reconhecido
    (`propagator-jaeger`)**; `AUDIT-GATE PASS` (exit 0; 1 high/critical,
    1 ack, 0 novos). A baseline encolheu para o único achado high/critical
    que ainda exige trabalho fora desta fatia.
  - Sem adaptação de config: os 11 `vitest.config.ts` só usam
    `include`/`testTimeout`/`maxWorkers`/`hookTimeout`/`environment`
    (`jsdom`, já dependência própria de `apps/web`) — todos válidos em
    Vitest 4. Regressão medida: **1175 testes unitários verdes** sem
    `TEST_DATABASE_URL` (320 de integração *skipped* por
    `describe.skipIf(!hasDb)`) e, com banco descartável fresco, zero
    falha de teste — `@iptv/api` **916/916**, `@iptv/database` **28/28**,
    `@iptv/outbox-worker` **60/60** (ressalva de exit: o run com DB não
    encerra limpo no teardown do outbox-worker — §12.1); `pnpm build`
    12/12; lint 12/12; typecheck 20/20.

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

## 8. CSP / security headers — GAP (follow-up, sem runtime nesta slice)

Achado: a API não usa helmet nem emite `Content-Security-Policy`,
`Strict-Transport-Security`, `X-Content-Type-Options`,
`Referrer-Policy` ou `frame-ancestors` (`main.ts` só registra CORS;
`next.config.mjs` sem `headers()`). Risco pilot contido (API é JSON sem
conteúdo ativo; web é SSR Next padrão), mas endurecer headers é barato e
deve entrar numa slice pós-pilot — registrado aqui, não implementado por
vedação de runtime desta fatia.

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
- `python scripts/ci-audit-gate.py`: **PASS** (8 totais, 3 high/critical,
  3 ack, 0 novos) — incluindo o patch fail-closed: saída vazia/JSON
  inválido/sem `advisories` falham; exit code != 0 do pnpm com advisories
  válidos não decide o gate (veredito pelo JSON). Payload real do registry
  reconciliado 1:1 (`metadata.vulnerabilities` vs registros); controle
  negativo com a mesma saída real adulterada (severidade `HIGH` +
  contador inflado) → FAIL.
- `python tests/security/test_ci_security_gates.py`: **18/18 OK** (6
  anteriores + 12 de estresse do gate com `subprocess.run` mockado, sem
  rede: comando morto + saída vazia, JSON malformado, JSON inválido
  estruturalmente/sem advisories, advisory sem severidade (payload
  adversarial do revisor `{"999":{"title":"x"}}`), severidade
  desconhecida/não-string, registro advisory não-objeto, contador de
  `metadata.vulnerabilities` divergente dos registros, metadata/
  vulnerabilities ausente, campo do enum faltando, contador
  negativo/string/float/bool, campo desconhecido, audit válido com achado
  novo → falha, audit válido com achados reconhecidos → PASS).
- `python -c yaml.safe_load(ci.yml)`: 4 jobs
  (`build`, `outbox-050-role-guards`, `security-scans`, `adversarial`).
- Adversariais em PG scratch descartável: **17/17** (container removido).
- actionlint indisponível localmente → validação por parse YAML + espelho
  dos stanzas de service/setup já usados nos jobs existentes.
- CI existente intocada: diff do workflow só **adiciona** jobs; `build` e
  `outbox-050-role-guards` byte-idênticos.

### 12.1 Validação do follow-up Vitest 4 (branch `closure/security-vitest4-20261009`)

- Instalação: `pnpm install` atualizou o lockfile (vitest 4.1.11 +
  `@vitest/*` 4.1.11; `vite` 7.3.6 mantido; **tinypool removido** da árvore)
  e `pnpm install --frozen-lockfile` reprova o lockfile sincronizado
  (exit 0). Escopo da mudança: 12 `package.json` (faixa
  `"vitest": "^3.2.4"` → `"^4.1.11"`), lockfile e baseline de audit.
  Nenhum `vitest.config.ts` precisou de adaptação (nada de breaking change
  verificada nas configs em uso).
- `python scripts/ci-audit-gate.py`: **PASS** (4 totais, 1 high/critical,
  1 ack, 0 novos). Baseline encolhida só pelos 2 critical do tinypool
  comprovadamente ausentes do lockfile novo (STALE→removido); nenhum mute.
- `python tests/security/test_ci_security_gates.py`: 18/18 OK.
- `pnpm lint` 12/12, `pnpm typecheck` 20/20, `pnpm build` 12/12.
- `pnpm test` sem `TEST_DATABASE_URL`: 20/20 tasks; **1175 passed**,
  **320 skipped** (todos `*.integration.test.ts` sob
  `describe.skipIf(!hasDb)`).
- `pnpm test` com banco descartável **frio e vazio** criado só para a
  validação (descartado depois): **zero falha de teste de aplicação** —
  `@iptv/api` 77 arquivos / **916 testes passed**, `@iptv/database`
  **28/28**, `@iptv/outbox-worker` **60/60**. O run completo, porém,
  **não encerrou com exit limpo**: com a suíte completa em paralelo, o
  `afterAll` de `apps/outbox-worker/test/worker.integration.test.ts`
  estoura o `hookTimeout` default de 10s neste host lento — a falha é de
  **teardown/exit do comando, não de asserção**, portanto o run com DB
  **não é verde de ponta a ponta** (testes verdes, comando vermelho no
  teardown).
- A falha de teardown é **pré-existente e não é regressão desta slice**:
  reproduzida IDÊNTICA no worktree principal com **Vitest 3** (controle
  A/B), sem o upgrade — mesmo `afterAll`/`hookTimeout`. Fica como
  candidato a follow-up de higiene (`hookTimeout: 120_000` espelhando
  `apps/api` e `packages/database`).

## Follow-ups (fora desta slice)

1. ~~Migração **Vitest 3 → 4** (resolve `tinypool` critical ×2 e os moderates
   `vitest`/`@vitest/mocker`; `tinypool>=2.1.2` é major — slice dedicada com
   regressão; §3).~~ **FEITO** em `closure/security-vitest4-20261009`
   (PR-followup do #38): vitest 4.1.11 nos 12 workspaces, baseline podada
   para 1 high/critical, gate PASS, regressão sem falha de teste — com o
   run de DB sem exit limpo no teardown do outbox-worker (§3, §12.1).
2. Manutenção dos `pnpm.overrides` desta branch (fastify/postcss/sharp/
   source-map-js): remover cada override quando o bump nativo do dependente
   (nest/next/vitest) fluir com a correção, para não deixar pin transitivo
   defasado (§3).
3. Bump `@opentelemetry/sdk-trace-node` quando major viável (resolve
   `propagator-jaeger` high; hoje 1.30.1, §3).
4. Security headers + rate-limit na API (§8, §11).
5. Reduzir TTL de sessão / rotação (§6).
6. `CODEOWNERS` + proteção de branch quando o plano GitHub permitir (§5).
7. Dataset red-team de prompt-injection (§4).
