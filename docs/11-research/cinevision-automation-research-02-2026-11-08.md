# CINEVISION-AUTOMATION-RESEARCH-02 — REA + Orca + alternativas (2026-11-08)

> **Veredito: `CINEVISION_AUTOMATION_BLOCKED`** — POC mínima não passou sem credenciais autorizadas e sem contornar o desafio. Nenhuma alternativa nova provou capacidade real sobre o Playwright atual.
> **Escopo:** investigação e POC mínima (§1–§9). Sem writes no CINEVISION, sem DB, sem deploy, sem PR. HEAD lido: `cb0dcab`. Painel: `https://cinevision.panelbr.site` (build atual observada: **v3.99**; anterior: 3.93/3.94). Sem segredos neste relatório; corpos brutos de auth nunca registrados.
> **Método:** REA 6.7.0 via CLI + Orca `orca tab`/`orca exec` (navegação, `network requests`, `eval`) + sondas HTTP Node read-only + leitura do código do Browser Worker (researcher `RESEARCH-02-FLOW-MAP`). Classificação por afirmação: `OBSERVED` / `INFERRED` / `UNKNOWN`.
> **Base anterior** (não repetida como nova): `docs/11-research/cinevision-api-investigation-2026-09-30.md` — SPA `/api` same-origin, Bearer `localStorage.token`, Reseller 402 `integration_inactive`, Node direto `HTTP_FAILURE` causa `UNCONFIRMED`.

---

## 1. REA — login e contratos (v3.99, OBSERVED no bundle público + Orca)

> **Fontes:** chunks baixados do ambiente autorizado do painel (sem credenciais, só leitura): entry `assets/KUjtVKu6.js` (2.597.696 bytes) e SignIn `assets/DM7ywDpH.js` (66.326 bytes) e ApiService `assets/B6kQOuaP.js` (52.323 bytes), todos via HTTP com `User-Agent` browser + `Referer` do painel; rota observada no Orca em `#/sign-in?redirect=/dashboard`. TRECHOS CURTOS só de fatos de contrato (sem reprodução de código). Nenhum bypass de captcha/desafio foi implementado.

| Pergunta (§2) | Resposta | Classe |
|---|---|---|
| **1. Bundle do login** | `KUjtVKu6.js` = entry (manifesto Vite `__vite__mapDeps`); `DM7ywDpH.js` = SignIn (contém `captcha` x5, `twofactor` x5, `sign-in` x5, `SignIn` x1, Cap UI); `B6kQOuaP.js` = ApiService (axios). Hashes mudam a cada build (Vite, não SHA). | `OBSERVED` |
| **2. URL completa (frontend)** | Base = `${window.location.origin}/api` (função nos chunks: `tr=()=>window.location.origin+"/api"`); chamadas relativas `auth/login`, `auth/me`. Origem efetiva alinhada ao painel: `https://cinevision.panelbr.site`. `GET /` = HTML SPA 200 (único app shell); `Document` entry `/assets/KUjtVKu6.js`; 17 `modulepreload`; CSS/tema/icons públicos. | `OBSERVED` |
| **3. Origem efetiva** | Same-origin. Scripts com `Origin: https://cinevision.panelbr.site`, `Referer: /`, cap 150/XHR `GET /api/settings/public` (200 JSON) e logo `/api/settings/logo/...` (200). Sem origem cruzada no caminho de auth. | `OBSERVED` (Orca `network requests` #1, #3, #24) |
| **4. Método e payload de auth** | **Login:** `POST` relativo `auth/login` (= `origin` + `/api/auth/login`) via `q.post("auth/login", e, {headers:{"X-Cap-Capable":"1"}})`. Payload atual (DOM do SignIn): chaves `{"cap-token","username","password","twofactor_code","twofactor_recovery_code","twofactor_challenge","twofactor_trusted_device_id"}` — `cap-token` injetado pelo Cap verification (`Click to verify you're a human`, grupo `Cap verification`, `@cap.js/wasm` carregado via jsdelivr). Chaves antigas `captcha`/`captchaChecked` do dossiê 09-30 **não** existem no build atual. Response data `token` → `saveToken`. | `OBSERVED` |
| **5. Headers do contrato normal** | ApiService (axios): interceptor define `Locale` (de `localStorage.lang` ?? `en`), `Accept-Language`, `X-App-Version: 3.99`; `setHeader()` define `Authorization: Bearer <token>` + `Accept: application/json`. Login adiciona `X-Cap-Capable: 1`. Server espelha `POST /api/auth/me` com sessão em memória (in-page). | `OBSERVED` |
| **6. Respostas/redirects do fluxo** | Não autorizado → rota SPA hash `#/sign-in?redirect=/dashboard` (Orca `snapshot` form). Em `KUjtVKu6.js`, se a resposta do login for **string** contendo `cf-footer-ip`/`Cloudflare`, o erro renderizado é `You have been blocked. Cloudflare Ray ID: ...` — challenge no POST é tratado em código. Em in-page não autenticado: `auth/me` e `servers` → **401** body HTML `<title>Unauthorized</title>` (única via Orca `eval`, sem Bearer). | `OBSERVED` |
| **7. Obtenção/renovação da sessão** | Sessão = **Bearer em `localStorage["token"]`** (chave: `$n="token"`, `saveToken/getToken/destroyToken` em `B6kQOuaP.js`; pre-login no Orca: chaves `lang,settings,pusherTransportTLS,global-actions-recent-items` — **sem** `token`, confirmando que só aparece pós-login). Obtenção: `token` do data do POST login → `saveToken` → `setHeader`. Renovação: 2FA endpoints `auth/twofactor-enable|disable` (visto), histórico `auth/refresh-token` **não** confirmado no build atual (não encontrado nos 25 chunks iniciais) — `refresh-token` em runtime é `UNKNOWN` neste build. TTL/cookie expiry do provedor: `UNKNOWN` (código do worker também não lê TTL; trata expiração como 401 observado). | `OBSERVED` / `UNKNOWN` (renovação) |
| **8. Identidade/servidores** | `GET /api/auth/me` = identidade (chamada só com token; sem token → 401). `GET /api/servers` = catálogo. Mapa worker (`readers.ts`) é o mesmo: `identity→/api/auth/me`, `servers→/api/servers`. Nenhuma escrita validava: Test 2 não executado (ver §5). | `OBSERVED` (forma) / `UNKNOWN` (conteúdo live com credencial) |
| **9. Cap / “protegido”** | Orca `snapshot`: texto `Sistema protegido contra bots e ferramentas de automação` + `v3.99`; runtime do Orca: hidden iframe `cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=a57504ef391a8ea4` + `POST .../jsd/oneshot/...` **200** (non-interactive, sem interstitial no load). Login exige Cap `cap-token` (gesture humano). | `OBSERVED` |

**Limite REA:** `analyze-javascript-application` no diretório local falhou com self-test Windows (`Open Windows path component [Temp]: file in use`), cobertura `partial`/`incomplete-module` — grafo semântico não usado como prova. `capture-browser-scenario` exige `browser/object`, `start_url/object`, `actions≥1` (erro de schema revelou o shape; cenário não executado nesta sessão por falta de credenciais para cenário autenticado). `list-browser-targets`/`analyze-web-bundle` exigem endpoint CDP loopback real: Orca é `orca-proxy-target`, sem listener `9222/9333/9229` (netstat vazio), portanto **integração REA↔Orca não comprovada** (§3). A reconstrução acima vale-se do fallback estático (bundle baixado + leitura de contexto) sobre evidência real; não presume código interno do servidor.

---

## 2. Comparação A / B / C

**A. Browser com sessão autorizada funcionando (forma; sem credencial neste ambiente)**

| Sinal | Valor |
|---|---|
| Efetivamente enviado pelo frontend | `axios` (base `origin+/api`) salvo `q.post("auth/login", payload, X-Cap-Capable=1)`; após token: `Authorization: Bearer ...` + `Accept: application/json` + `Locale/Accept-Language/X-App-Version: 3.99`. |
| Endpoint/método/payload/status | Login `POST /api/auth/login`; identidade `GET /api/auth/me`; servidores `GET /api/servers`. Status com sessão: não observado aqui (sem credenciais); a forma é o contrato atual. |
| Sensíveis | removidos (sem valores, apenas chaves/headers/status). |
| Classe | `OBSERVED` |

**B. Browser Worker da Contabo (histórico + arquitetura fresca)**

- Histórico da missão: `CHALLENGE_DETECTED` (Worker Chromium/Playwright). **Localização:** loop `detectChallenge()` roda **antes** do submit (budget `challengeWaitSeconds` default 45s, polls 2s) e também após submit/route-settle — i.e., o travamento quase sempre **ocorre antes de qualquer token existir**, na navegação/loading page (`researcher` mapeou `browser.ts:324-346`, `cinevisionCommand.ts:293-340`; `errors.ts:62-192` — 403 com interstitial estrutural → `CHALLENGE`, 403/404 sem → `HTTP_FAILURE`). **INFERRED:** o challenge da Contabo é o mesmo mecanismo (edge antes de login); não é `AUTH_FAILED`.
- Runtime de hoje local (Orca/Chromium sessão): **sem** interstitial — form renderizado e `jsd oneshot 200`. A diferença de ambiente (IP datacenter Contabo vs sessão local, headless fingerprint) explica o contraste mas o **sinal exato é `UNKNOWN`** — nunca provar “reputação de IP” sem isolar IP/UA/TLS/cookies (dossiê 09-30 contém a mesma correção).

**C. HTTP direto (fresco, Node sem credenciais)**

| Sonda (Node `fetch`, `Accept: application/json` salvo nota) | Status | Content-Type | `cf-mitigated` | Corpo | Classe |
|---|---|---|---|---|---|
| `GET /api/settings/public` (sem UA) | 200 | `application/json` | — | `{"data":[{"id":"BV4D3rLaqZ","variable":"site_name","value":"ONE",...` | `OBSERVED` |
| `GET /api/auth/me` (sem UA) | 404 | `text/html` (Apache IETF) | — | `404 Not Found` | `OBSERVED` |
| `GET /api/servers` | 404 | `text/html` | — | `404 Not Found` | `OBSERVED` |
| `GET /api/does-not-exist-zzz123` | 404 | `text/html` | — | `404 Not Found` (idêntico) | `OBSERVED` |
| `GET /` (sem UA) | 404 | `text/html` | — | `404 Not Found` | `OBSERVED` |
| `GET /assets/KUjtVKu6.js` (sem UA) | 404 | `text/html` | — | 195 bytes | `OBSERVED` |
| `GET /api/auth/me` (UA browser + `Accept-Language` + `X-App-Version`) | **403** | `text/html` | — | `Just a moment...` | `OBSERVED` |
| `GET /` (UA browser) | 403 | `text/html` | `challenge` | `Just a moment...` | `OBSERVED` |
| `GET /assets/KUjtVKu6.js` (UA browser + `Referer`) | 200 | `application/javascript` | — | 2.597.696 bytes | `OBSERVED` |
| **`GET /api/auth/me` in-page (Orca, real browser, sem token)** | **401** | HTML | — | `<title>Unauthorized</title>` | `OBSERVED` |
| **`GET /api/servers` in-page (Orca, sem token)** | **401** | HTML | — | (mesmo regime) | `OBSERVED` |

**Distinguindo erro de rota/contrato vs restrição de acesso:** a aplicação existe e responde `401` quando alcançada in-page; o `404` genérico via direto é **indistinguível de rota inexistente e de `GET /`** (mesmo corpo Apache) — logo **não prova rota inexistente**. O `403 "Just a moment..."` com UA de browser prova que a classificação edge depende de sinais de cliente (agora isolamos um eixo: só o UA muda `404→403`). Classificação: o 404 é **anterior ao app (edge)** — `HTTP_FAILURE` na taxonomia do repo; **causa detalhada (IP vs TLS JA3 vs cookies vs clearance) `UNKNOWN`**. Pin: `server: cloudflare` em todos, `cf-mitigated` vazio no `404` (não é challenge declarado) vs `challenge` no ROOT browser-UA — consistência com o `<script>` jsd/`oneshot` (Orca) que fornece clearance só ao browser executador.

---

## 3. Orca (investigação)

| Item | Resultado |
|---|---|
| Aba ligada ao projeto | `orca tab list` → aba `default` na worktree `iptv`; `navigate https://cinevision.panelbr.site` → `#/sign-in?redirect=/dashboard`, `title "Login | ONE"`. |
| Automação nativa | `orca exec --command "snapshot|get url|eval|network requests"` — snapshot do form (`e1 Usuário ou E-mail`, `e3 Senha`, `e5 Lembrar`, `e6 Continuar` + texto “protegido”), `localStorage.keys` sem `token` (pré-login), fetch in-page via `String.fromCharCode` (workaround do parser) provando `401` em `auth/me`/`servers`. `network requests` = 50 entradas (assets 200, `settings/public 200`, `logo 200`, `jsd oneshot POST 200`, `rum 204`, Sentry envelopes, `cap_wasm_bg.wasm` 200). |
| Sessão existente | **Nenhuma** reutilizável: só o perfil `default` (`tab profile list`) com aba no staging-web antes; nenhuma credencial CINEVISION autorizada local (`CINEVISION_EMAIL/PASSWORD/ALLOWED_ORIGIN` ausentes no processo). |
| Integração REA/DevTools | **não comprovada** (Orca sem CDP loopback exposto). REA foi usado pelo fallback CLI estático; Orca isolado foi PASS na observação. |

> **Orca browser para investigação: `PASS`. REA↔Orca como sinal único: `UNAVAILABLE` (não integrada).** Orca não vira dependência do StreamMax/Browser Worker (missão §3): nenhuma mudança em produção; issues #231/#232 ficam fora.

---

## 4. Alternativas avaliadas (ordem da missão)

Baseline a vencer (OBSERVED via researcher): Playwright/Chromium + perfil persistente por binding + lock + `API_IN_BROWSER` (`fetchProjectedInPage`, Bearer in-page que nunca sai do browser, allowlist `origin+/api`, 1 POST de login/re-auth, 401→1x reauth com fencing e budget bounded). Qualquer troca precisa provar **login fresco + leituras** sem humanos, ou a troca é cosmética.

| Alternativa | O que oferece além do Playwright atual? | Sessão nova/persistência/recuperação | Sem UI humana? | Node/API compatível | Dependências | Cloudflare | Veredito |
|---|---|---|---|---|---|---|---|
| **Browser Use** (open-source + Cloud) | Agent autônomo (LLM) + Cloud Chromium `$0.02/h` (stealth/fingerprint, proxies residenciais, CAPTCHA solving, `BROWSER_USE_PROFILE_ID` = cookies/logins, CDP via `agent-browser -p browseruse`). [repo 120k★](https://github.com/browser-use/browser-use) + `CLOUD.md`/docs do produto. | Nova sessão por chamado; perfil via `PROFILE_ID`; recuperação = reentregar task ao agente; sem `localStorage` direto de tenant/account (perfil é externo). | Sim (agente), **exceto** Cap/`CAPTCHA-solving` — recurso de evasão proibido pela missão (§4) e contratação de stealth/proxy para contornar o fornecedor proibida. | Python/TypeScript via `ChatOpenAI`/`Browser`/`use_cloud=True` (docs oficial `browser-use.com/llms.txt`); não é camada Node da API atual. | `uv add browser-use` + chave API + (opcional) proxy residencial pago. | Stealth bench 90.5% alegado; **não provado no CINEVISION**; solving não avaliável (proibido). | **DESCARTADO** (solver/stealth anti-CAPTCHA fora do escopo ético/limite; Cloud expõe credenciais/sessão a terceiros — exige autorização §6 ainda não dada; sem POC; sem ganho sobre Playwright já persistente). |
| **Steel** (OSS + Cloud) | Infra de browser em pool com “batteries”, `/sessions`: cookies/localStorage persistentes (cloud até 24h; OSS local), `solveCaptcha:true`, `useProxy:true`, `sessionContext` resume, CDP para Playwright/Puppeteer/Selenium. [repo 7.9k★](https://github.com/steel-dev/steel-browser) + [steel.dev](https://steel.dev). | OSs: `sessions.create({proxyUrl,dimensions})` → `connectOverCDP`; reload preserva state. Cloud: resume via `sessionContext`. TTL honesto do próprio produto (OSS sem `solveCaptcha` oficial garantido no Cloud free-tier 100h). | Sim (Chromium cloud/self-host). Self-host = sem exposição indep. | **Node** via `steel-sdk`/`connectOverCDP` (Node & Python SDKs, `baseURL` Cloud/self-host). | Serviço a mais (self-host Docker `ghcr.io/steel-dev/steel-browser` ou `steel-sdk` + conta Cloud). **Serviço/gateway novo** viola “não criar por padrão”. | Stealth/“anti-bot” no marketing; Cloud anuncia Turnstile/PerimeterX solver (proibido aqui). Sem prova CINEVISION. | **DESCARTADO** (duplica nossa persistência; nenhum endpoint prova login fresco no CINEVISION; Cloud dispensa sem autorização; self-host é novo serviço; solver proibido). *NÃO TESTADO em instalação — análise documental + baseline bastaram para descartar; instalar seria violar “não instalar todas”.* |
| **Browserless** (Cloud/self-host) | Managed Chromium + Session API (REST): `ttl≤30min`, `stealth:true`, `headless`, proxy, `Browserless.reconnect`, `DELETE /session/{id}`; `browser.disconnect()` preserva vs `close()` descarta; Puppeteer/Playwright. [blog Session API](https://www.browserless.io/blog/browserless-persisting-sessions-api-guide) + [session-management](https://www.browserless.io/blog/session-management). | Nova: `POST /session` → `connect` WS + `stop` URL. Retomada pós-crash via WS persistente; expiração por TTL (não automática como perfil local). | Sim (managed headless). Sem credenciais expostas pela sessão em si (só token API). | **Node** (`puppeteer.connect`/`connectOverCDP`) — o mais compatível dos três. | Token + TTL/lease a gerenciar; Self-host opcional. Sem instalar nesta missão. | Sem alegação CINEVISION; stealth resíduo em CF; sem resolver Cap. | **DESCARTADO** (mesma razão do Steel, sem prova de desafio; `TTL≤30min` pior que nosso perfil que sobrevive a restart; “self-hosted” aqui é novo serviço). *NÃO TESTADO por instalação.* |
| **Camoufox / Nodriver** (anti-detect) | Camoufox: Firefox patch C++ + fingerprint (canvas/WebGL/fonts/WebRTC) via Playwright Python (compatível). Nodriver: Chrome direto CDP (Python, sem shim Playwright, successor de `undetected-chromedriver`, AGPL-3). [Camoufox](https://camoufox.com) + [Nodriver vs Playwright 2026](https://bytetunnels.com/posts/nodriver-vs-playwright-which-is-stealthier-2026). | Nova: lançar engine custom (Camoufox `browser=...`) ou Chrome subprocesso; perfis = diretório do usuário; “persistência” é gestão própria. | Sim (engine). | **Python only** (`from camoufox.sync_api import Camoufox`, Nodriver asyncio Python+CDP) — exige sidecar Python ou rewrite do worker Node; sem valor de drop-in. | Build custom Firefox (Camoufox set/fetch) ou Chrome system + deps; licença AGPL/MPL com revisão comercial. | Antidetect é só um eixo (fingerprint de engine) — **não provado** que o challenge CINEVISION seja esse eixo (Orca Chrome 150 passou sem interstitial). Missão proíbe presumir que resolve. | **DESCARTADO** (sem vantagem técnica concreta demonstrável; imcompatível com nosso stack Node; não instala). |

**Seleção (§4):** *nenhuma* alternativa com maior possibilidade de acrescentar capacidade real sem violar limites. Instalar/provar hoje seria trocar a estrutura de sessão provada (perfil+lock+`API_IN_BROWSER`) por um serviço novo que ainda não demonstrou login fresco no CINEVISION.

---

## 5. POC mínima (§5) — executada até o bloqueio honesto

**Não modificou a API do StreamMax.** Credenciais locais: **ausentes** (`CINEVISION_EMAIL`/`CINEVISION_PASSWORD`/`CINEVISION_ALLOWED_ORIGIN` = `ABSENT` no processo; fontes autoritárias ficam no vault `secret_ref` — valores nunca lidos). Testes locais sem exposição externa foram executados; nenhum Teste exigiu enviar sessão/credencial a terceiros (nenhum Cloud foi contatado).

| Teste | Procedimento executado | Resultado |
|---|---|---|
| **1 — Sessão nova (sem cookies/auth anterior)** | Orca: `navigate` → `#/sign-in?redirect=/dashboard` (form `OBSERVED`). Login não subestimado: sem credenciais locais e sem sessão autorizada exposta, não se enviou credencial a ninguém; form **exige** Cap/humano (`cap-token` + “Click to verify you’re a human”). | **FAIL** (bloqueio: credenciais autorizadas ausentes + gesto Cap humano) |
| **2 — Leitura `read-identity` / `list-servers`** | Não executável sem sessão autenticada. Em alternativa (in-page sem token): `auth/me→401`, `servers→401` (Orca) — prova que a causa não é contrato, mas impede leitura válida. CLI Worker não invocado sem binding (falharia `CONFIG`). | **FAIL** |
| **3 — Repetibilidade (sessão independente nova)** | Sem Test 1, indeferido. Orca confirma repetibilidade da *navegação* (recarregar/native histórico) mas **nunca** ofereceu sessão reutilizada como prova de login. | **FAIL** |
| **4 — Recuperação (expiração simulada)** | Indeferido (depende de 1–3). Código já prevê 1x reauth bounded (`RESEARCH-02-FLOW-MAP` OBSERVED); não re-testado live. | **NÃO EXECUTADO** |
| **Cap/challenge do fornecedor** | Sem interstitial no load Orca (só `jsd oneshot 200`); **challenge bloqueante não apareceu aqui**. Hist. Contabo `CHALLENGE_DETECTED` (antes do submit). Registrado o bloqueio e encerrado o experimento correspondente, conforme §5 (“Se o fornecedor apresentar challenge que exija intervenção...”). | Registrado |

---

## 6. Serviços externos (§6)

Nenhum Browser Use Cloud/Steel/Browserless foi contactado; **nenhuma credencial/sessão real foi enviada** (autorização específica não solicitada sem necessidade — alternativas já descartadas no plano documental). Testes locais sem exposição: OK. Sem registrar valores sensíveis.

---

## 7. Decisão técnica (§7)

```
CINEVISION_AUTOMATION_BLOCKED
```

- **Testado:** bundle 3.99 do login (método/payload/headers/origem/redirects), Orca `navigate/snapshot/network/eval` (401 in-page vs 404/403 direto), sondas Node diretas (matriz UA/Referer/endpoint), mapa completo do Worker (researcher `RESEARCH-02-FLOW-MAP`), análise documental das 4 alternativas (Fontes primárias citadas). **Nada falhou por falta de evidência nova**: o bloqueio é o **Cap humano + credenciais no vault**, não infra.
- **Falhou como:** falha de **autenticação/sessão** (sem credenciais autorizadas + gesto Cap) + clássica **HTTP_FAILURE** no direto (edge antes do app). Não é falha de contrato (app prova `401` quando alcançado) nem de navegador local (Orca passou o load).
- **Descartadas, com motivo:** Browser Use (solver/stealth/proxies = evasão proibida + infra terceiro), Steel/Browserless (serviço novo, TT L/sessão gerenciável equivalente, sem prova), Camoufox/Nodriver (Python-only, sem evidência de que fingerprint de engine seja o eixo, AGPL, build extra).
- **Ainda não verificável sistemática:** com credenciais de operador autorizadas, o Orca (já `PASS`) ou o harness REA `capture-browser-scenario` *launch mode* poderiam observar um login real (endpoint, método, payload, `200` vs `302` vs Cap interstitial) — risco de fals positivo se reusar sessão antiga (missão §5). Permanece `UNKNOWN` até esse experimento autorizado.

---

## 8. Limites respeitados (§8)

Sem DB, sem writes no CINEVISION, sem Asaas, sem deploy, sem tocar Browser Worker de produção, sem nova infra, sem PR. Writes fora do repo apenas em temp (`~/Temp/opencode/*.js`, `~/Temp/cinevision-bundle-research02/*.js` — bundles **públicos**, sem segredos) e leitura de rede Orca (sem gravação no vault/DB). Orca não virou dependência de produção.

---

## 9. Entrega final (§9)

| Investigação | Resultado |
|---|---|
| REA — login e contratos | `OBSERVED` (método/payload/headers/refresh com limitações §1) |
| Causa do HTTP 404 | `CONFIRMED` (restrição de edge antes do app; sinal exato/IP-TLS/cookies ainda `UNKNOWN`) |
| Orca browser para investigação | `PASS` |
| Browser Use | `DESCARTADO` |
| Steel / Browserless | `DESCARTADO` |
| Sessão nova automática | `FAIL` |
| read-identity | `FAIL` |
| list-servers | `FAIL` |
| Nova sessão independente | `FAIL` |
| Recomendação final | `REJECT` (nova infra) / `HOLD` (caminho atual até experimento autorizado) |

**Menor caminho de implementação (se existir, sem novo serviço):** aguardar credenciais autorizadas de operador e repetir a POC com a *mesma* estrutura do Worker — `PostgresSecretsAdapter` resolve binding/`secret_ref` + `deriveIntegrationSecretRef(..., "CINEVISION_PASS")`, injeta `CINEVISION_EMAIL/PASSWORD` por invocação, spawna `apps/browser-worker/dist/cli.js` (`read-identity`/`list-servers`) com `CINEVISION_ALLOWED_ORIGIN`+`CINEVISION_LOGIN_PATH=/api/auth/login` e perfil persistente. É exatamente o que `integration.test` já faz (`cinevision-worker-probe.ts` / `integrations.commands.ts`, mapeado pelo researcher): nenhum serviço, banco ou gateway novo. Se o Cap exigir gesto humano no `cap-token`, o POC honesto deve declarar `CHALLENGE_DETECTED/HUMAN_REQUIRED` e parar — nunca automatizar o gesto (evasão proibida).

---

### Apêndice — fontes primárias e refs

- **Código/pesquisa do repo:** `apps/browser-worker/src/constants.ts:27-28,36-37` (read-identity `/api/auth/me`, `#/sign-in`), `config.ts` (origem/login-path/validação perfil), `policy.ts` (1 POST/login window/status), `browser.ts:292-381` (submit/challenge wait), `cinevisionCommand.ts:279-342,548-804` (1x reauth+fencing), `providers/cinevision/api-client.ts:98-214,328-577` (allowlist GET-only in-page), `errors.ts:62-192` (taxonomia sem presumir Cloudflare); `docs/11-research/cinevision-api-investigation-2026-09-30.md:§3-§6` (Reseller 402, headers 3.93, Node 404 `UNCONFIRMED`); subagent `ses_e4498f73fffew3n4apph9gGwQR` (`RESEARCH-02-FLOW-MAP`, OBSERVED/INFERRED/UNKNOWN por critério 1–9).
- **REA:** `rea@6.7.0`, `doctor` (harness sem engines nativos; web capture disponível), `capabilities` (playwrights web sem parse direto), `analyze-javascript-application --help`, `capture-browser-scenario --help` + erro de schema (`browser/object`, `start_url/object`, `actions≥1`), `list-browser-targets` (CDP). Skill stub `reverse-engineer-anything` v42 (fallback estático sem MCP).
- **Orca:** `orca tab list|create`, `tab profile list`, `browser identity get`, `exec --command "navigate|snapshot|eval|..."`, `exec ... "network requests|network request"`. RuntimeId `661c232b-...`, tab `18992dd6-...` (`default`), `set: /`, `Sign-in` refs `e1/e3/e5/e6`, `localStorage` 4 chaves sem `token`.
- **Alternativas (primárias):** [browser-use/browser-use](https://github.com/browser-use/browser-use) (README `use_cloud=True`, `BROWSER_USE_API_KEY`, `$0.02/h`); [steel-dev/steel-browser](https://github.com/steel-dev/steel-browser) (`/sessions`, `steel-sdk`, Docker `3000/9223`); [browserless-persisting-sessions-api-guide](https://www.browserless.io/blog/browserless-persisting-sessions-api-guide) + [session-management](https://www.browserless.io/blog/session-management) (`ttl≤30min`, `disconnect≠close`, `DELETE`); [Camoufox usage](https://camoufox.com/python/usage) + `camoufox sync_api` + [Nodriver comparison](https://bytetunnels.com/posts/nodriver-vs-playwright-which-is-stealthier-2026).
- **HTTP direto:** Node `fetch` (sem UA vs UA browser+`Referer`, `Accept-Language`, `X-App-Version`) + `probe2` (settings 200 nos dois UA; ROOT 404 vs 403 `cf-mitigated=challenge`; ASSET 404 vs 200). Orca `fetch` in-page: `settings/public→200`, `auth/me→401`, `servers→401` (401 HTML `<title>Unauthorized</title>`).

---

## Adendo 2026-11-08 — sessão autorizada no Orca (login manual do operador)

> **Natureza do adendo:** o operador logou manualmente no painel dentro da mesma aba Orca (`default`, `18992dd6-...`). Este adendo observa **somente** status e forma sanitizada; nenhum valor de token, e-mail, ID de cliente/servidor ou corpo bruto foi registrado. **Não** constitui prova de autenticação automática (§5): reuse de sessão manualmente obtida nunca prova login automático; os `FAIL` de sessão nova/repetibilidade abaixo permanecem para o caminho automatizado.

| Pergunta | Resultado observado | Classe |
|---|---|---|
| Dashboard autenticado | `url #/dashboard`, `title "Dashboard | ONE"`, `localStorage` passou a conter `token` e `remembered-logins` (antes só `lang,settings,pusherTransportTLS,global-actions-recent-items`); `snapshot` renderiza navegação do dashboard. | `OBSERVED` |
| **read-identity** (in-page, Bearer em memória) | `GET /api/auth/me` → **200**; forma root/contém `token` presente (`hasToken=true`) e chaves de identidade (nomes de campos, sem valores). Sem token, a mesma rota retorna **401** (prova §2-C acima). | `OBSERVED` (status/forma) |
| **list-servers** (in-page, Bearer em memória) | `GET /api/servers` → **200**; envelope `{data,links,meta}`; `data` com **2** servidores; `meta` com chaves `current_page,from,last_page,links,path,per_page,to,total` (sem IDs/valores). | `OBSERVED` |
| Contraste com Worker Contabo | Contabo retorna `CHALLENGE_DETECTED` **antes** de qualquer token existir (loop de detecção no carregamento). No Orca, o mesmo painel carregou sem interstitial e o login manual prosperou (`token` presente + leituras 200). A diferença é de **ambiente/sinal** (`UNKNOWN` qual eixo — IP/headless/TLS/clearance), não de contrato. | `OBSERVED` / `UNKNOWN` (sinal) |
| POST de login (forma) | Tipo/sucesso `INFERRED`: `token` presente + `auth/me 200` só ocorrem se o `POST /api/auth/login` (forma OBSERVED em §1: `cap-token,username,password,twofactor_*`, header `X-Cap-Capable: 1`) tiver vencido. A requisição pontual **não** foi recapturada (buffer `network requests` zerado após navegação) — status pontual exato permanece `UNKNOWN` sem novo login. | `INFERRED` / `UNKNOWN` (status pontual) |
| **Testes §5 com a sessão manual** | Test 1 (sessão nova automática) = instanciado manualmente, não automaticamente: **permanente `FAIL` para automação**. Test 2: **200 + forma válida sob sessão autorizada** (não automatizada). Test 3 / Test 4: pendentes de experimento automático futuro; reutilizar esta sessão não prova repetibilidade. | Atualização de evidência, **sem** mudar `CINEVISION_AUTOMATION_BLOCKED` |

**Implicação:** quando credenciais autorizadas existirem fora do browser manual (vault `secret_ref` existe no desenho Worker), a estrutura mais barata continua sendo a existente; nada aqui autoriza trocar de navegador (REJECT/HOLD do §9 permanece).

---

## Investigação 03 — Sessão autenticada Orca

> **Escopo:** mesma aba Orca já autenticada (`default`, `18992dd6-...`), desenvolvimento local. Somente leitura autorizada; nenhum logout/renovação executado, nenhuma compra/ativação/generate-token confirmado, nenhum token/cookie/senha copiado ou impresso. Preflight V3 `DETERMINISTIC_FALLBACK` (`hard_exclusion_security_sensitive`, zero workers) — investigação executada diretamente pelo agente, sem novo runtime de navegador. Orca permanece ferramenta de investigação, não dependência de produção. Linhas sensíveis (endereços, saldos, IDs) são citadas só por tipo/forma.

### 1. Prioridade A — Reseller API (a mais importante)

| Descoberta | Evidência | Classe |
|---|---|---|
| **Localizada no painel** | Entrada `id:"reseller-api"`, categoria `reseller-api`, título “API de Revenda” em `Automação e API` (`GET /api/integrations` → 200, 10 entradas). Card na UI: `API de Revenda` + link `Suporte` + botão `Ativar`. | `OBSERVED` |
| **Estado atual** | `status:"inactive"`, `is_active:false`, `isPaid:true`, `freeLicense:false`, `subscription:null`, `currentSubscription:null`, `hasRawSections:true`. `GET /api/settings/public` (61 variáveis) confirma postura comercial; `number_of_minutes_of_inactivity_to_logout=1440` (ver §2). | `OBSERVED` |
| **Ativação self-service?** | **Sim, paga via painel.** UI `#/integrations/reseller-api`: bloco `Assinar API de Revenda` (“Assine para ativar a integração da API de Revenda.”) botão `Assinar (R$ 49/mês)` (preço de catálogo, não crédito da conta). Ação no catálogo (`raw.sections[0]`, `id:"subscribe"`): `id:"subscribe-reseller-api"`, `method:"POST"`, `endpoint:null`, `kind:"primary"`, `body` com chaves `success_url`/`cancel_url`, `redirectKey:"checkoutUrl"`, `successMessage:"Assinatura ativada."` — fluxo de checkout direcionado (`INFERRED`: presente o redirect e o checkoutUrl; presente o endpoint exato permanece `UNKNOWN` sem clicar). **Nenhuma ação foi confirmada** (sem compra/ativa­ção/geração de token). | `OBSERVED` (existe e preço) / `INFERRED` (checkout) |
| **Condição do `402 integration_inactive`** | Sem assinatura ativa. O `402` histórico em `/api/reseller-api/v1/openapi.json` era nesta conta sem `subscription`/`currentSubscription`. **Hoje** `GET /api/reseller-api/v1/openapi.json` (Bearer) → **200** com schema Sigma Reseller API — o schema é acessível, mas a **ativação** segue `inactive/isPaid`. Logo, `402` ≠ rota ausente; **x-**condição comercial (assinatura ausente/não paga). Ver utilidade: `402` = gate por assinatura, não por contrato. | `OBSERVED` (antes 402→hoje 200) / `INFERRED` (causa comercial) |
| **Token permanente aute M2M?** | **Distinto do Bearer SPA.** OpenAPI `securitySchemes`: `bearerAuth` = `SigmaResellerApiToken` — “Reseller API token created from the panel's Reseller API integration page. The plaintext is shown exactly once. Each token is limited to its granted scopes and, optionally, to specific source IPs/CIDRs.”; `panelSessionAuth` = `Panel Sanctum session credential of a logged-in panel user. A Reseller API token is NOT accepted here.` Segurança global `[{bearerAuth:[]}]`. Operações `/me/webhooks`/`rotate-secret`/`deliveries` via `panelSessionAuth`. | `OBSERVED` |
| **Opera­ções oferecidas (OpenAPI)** | `paths` (28): `/me`, `/customers`, `/customers/by-username/{username}`, `/customers/{customer}`, `/customers/{customer}/renew`, `/customers/{customer}/package`, `/customers/{customer}/connections`, `/customers/{customer}/courtesy-days`, `/customers/{customer}/resync`, `/customers/{customer}/server-migration`, `/resellers`, `/resellers/{reseller}`, `/resellers/{reseller}/credits/add|remove|recharge`, `/packages`, `/servers`, `/reports/customers-count|resellers-count|membership|low-credits|new-resellers|expiring`, `/me/webhooks`, `/me/webhooks/{webhook}`, `/me/webhooks/{webhook}/rotate-secret`, `/me/webhooks/{webhook}/deliveries`. `GET /me` com Bearer SPA → **401** (prova de token M2M separado). Doc UI: `#/integrations/reseller-api/api-reference` + bloco “Documentação da API”. | `OBSERVED` |

**Classificação:** `M2M_SELF_SERVICE_AVAILABLE` — a ativação é self-service pelo painel (subscrição com `success_url`/`cancel_url`+checkout), **mas paga e não executada**, logo **autenticação M2M hoje sem token**: `Autenticação M2M = BLOCKED` (sem assinatura ativa nem `SigmaResellerApiToken`). Como a inscrição paga não pode rodar sem autorização, a hipótese mais forte é: ao concluir o checkout, o M2M passa a autenticar não-interativamente **sem navegador** (`Authorization: Bearer <SigmaResellerApiToken>`, com scopes e lista IP/CIDR); até lá, **não** é caminho desassistido usável.

### 2. Prioridade B — Autenticação e sessão

| Item | Evidência | Classe |
|---|---|---|
| Contrato real do login | Anterior (§1): `POST /api/auth/login` com `X-Cap-Capable: 1` e payload `{"cap-token","username","password","twofactor_code","twofactor_recovery_code","twofactor_challenge","twofactor_trusted_device_id"}`. Chave `token` em `localStorage` (`$n="token"`). | `OBSERVED` (bundle) |
| `cap-token` | Campo vazio (`""`) no estado inicial do SignIn; UI Cap (WASM) exige gesto humano “Click to verify” para gerar o token. Nenhuma resolução automática foi testada nem proposta (proibido). | `OBSERVED` |
| API key / token de integração / outro M2M | **Não** há API key alternativa para a SPA; o M2M é `SigmaResellerApiToken` (ver §1), **tokens dedicados** no OpenAPI — não há caminho “API-key SPA”. | `OBSERVED` |
| Como a sessão expira | `settings/public` variável `number_of_minutes_of_inactivity_to_logout=1440` (**24h de inatividade**). Sem TTL/longevidade de token observado em memória; `expiresAt` no catálogo de integrações é de assinatura (Reseller), não de sessão. | `OBSERVED` (inatividade) |
| Endpoint de renovação | `GET auth/refresh-token` em `KUjtVKu6.js` (`q.setHeader()` + `q.get("auth/refresh-token")` → `g(e)`): **somente se houver `token` válido** (`if(Wt.getToken())`); mutação via GET (dossiê 09-30, não executada aqui). `PUT auth/update-locale`, `PUT auth/update` complementam perfil. | `OBSERVED` (código) / não executado |
| Que condições retomam novo login? | Sem token (`401`), sem token válido/cap inválido, ou após inatividade 1440 min (401 provável). `need_reset_password=YES` força rota reset (dossiê) — via `auth/me` analytics, não observado aqui. | `INFERRED` |
| Sessão usuário vs integração | SPA usa Bearer Sanctum (`setHeader`) via `auth/login`; Reseller API usa `SigmaResellerApiToken` (scopes + IP/CIDR, plaintext once). Sessão usuário **não** é aceita como Reseller token e vice-versa (OpenAPI descrições). | `OBSERVED` |

**Critério §4:** existe uma autenticação desassistida suportada pelo próprio sistema — **o `SigmaResellerApiToken`** — mas **hoje bloqueada por assinatura inativa**. Sem a subscrição paga, a única sessão desassistida não existe; a outra via (Bearer SPA) ainda exige `cap-token` humano + fluxo de navegador — logo **não provado que a automação completa desassistida funcione hoje**.

### 3. Prioridade C — MVP (§5, só leitura autorizada)

> Leituras ao vivo (antes) + formas de bundle (depois) separadas. Sem criação de clientes, consumo de créditos, ativação/renovação real. Saldos/IDs nunca escritos; só tipo/contagem/forma.

| Funcionalidade | Endpoint (relativo a `origin+/api`) | Classe |
|---|---|---|
| Consultar saldo | Leitura via `GET /api/auth/me` → campo `credits` (número; unidade/precisão `UNKNOWN`, sem valor registrado). | `OBSERVED` (forma) |
| Listar servidores | `GET /api/servers` → 200, envelope `{data,links,meta}`, `data` com **2** itens; `meta` com `current_page,from,last_page,links,path,per_page,to,total`. | `OBSERVED` |
| Listar clientes | `GET /api/customers` com paginação (`f.perPage=20, deleted, orderBy/orderDirection`, abortável); `GET /api/customers?perPage=1` → 200 (confirmado). Envelope `{data[],links,meta}`, 20 por página por padrão. | `OBSERVED` |
| Consultar cliente | `GET /api/customers/{id}` → resolve objeto `data` (não `data.customer`). Forma JS + registro live histórico do dossiê; **não** executado com ID nesta sessão. | `OBSERVED` (JS) |
| Criar assinatura | **Escreve:** `POST /api/customers` (payload `e`) via `customers` store (`CaiF003a.js`); também `POST /customers/generate-credential {server_id,field}`. Forma JS, runtime `UNCONFIRMED` neste build. | `OBSERVED` (JS) |
| Ativar serviço | `POST /api/customers/{id}/activate-app {app_server_id}`; alternativamente `PUT /customers/{id}/server-migration {server_id,package_id}`. | `OBSERVED` (JS) |
| Renovar assinatura | `POST /api/customers/{id}/renew {package_id,connections,...}`; também `POST /customers/{id}/add-courtesy-days {}`, `POST /customers/{id}/renew-reminder {text}`, `POST /customers/{id}/change-package {package_id}`, `POST /customers/{id}/change-connections {package_id,connections}`. | `OBSERVED` (JS) |
| Consultar expiração | Campos do objeto customer: `status`, `expires_at`, `is_trial` (string `"YES"/"NO"`/`"true"/"false"` — normalização estrita) + `connections` (allowance, não sessões live). Via `GET /api/customers/{id}`. | `OBSERVED` |
| Consultar planos | `GET /api/packages/price` → 200 com **16** linhas (confirmado nesta sessão); pacote preço vivo. | `OBSERVED` |
| Outras leituras úteis | `GET /api/servers/status`, `GET /api/customers/live-connections/{serverId}`, `GET /api/customers/expiring`, `GET /api/customers/statistics`, `GET /api/customers/statistics/top10`, `GET /api/customers/{id}/playlist`, `GET /api/integrations` (200, 10 entradas), `GET /api/settings/public` (200, 61 vars), `GET /api/reseller-api/v1/openapi.json` (200). | `OBSERVED` |

**Contagem MVP (defensável):** **14** endpoints de leitura identificados (4 com GET real nesta sessão + 10 só-JS/forma) e **≈18 operações de escrita** no bundle (17 focais de cliente + 1 subscribe Reseller) — todas marcadas `OBSERVED (JS)` vs `OBSERVED (real-time GET)` conforme coluna.

### 4. Prioridade D — Viabilidade (§6)

| Caminho | Avaliação |
|---|---|
| **A. Reseller API M2M** | **Preferencial, mas BLOCKED hoje.** É o único fluxo não-interativo documentado (`bearerAuth`+scopes+IP allowlist, 28 ops). Bloqueio = `status:inactive`, `isPaid:true`, sem assinatura. Pós-checkout, três caminhos não-interativos comprovam-se via POC (auth automática + identidade + repetição), o que não foi testado. Veredito atual: **`AVAILABLE após assinatura paga; hoje BLOCKED`**. |
| **B. HTTP oficialmente suportado** | `SigmaResellerApiToken` é o único M2M suportado. Não há outro fluxo HTTP não-interativo aberto a clientes (SPA exige `cap-token` humano + Bearer). |
| **C. Browser Worker atual** | Não se prova aqui: renovação exige token válido (`GET auth/refresh-token`) ou `POST auth/login` com `cap-token`; expiração real (1440 min/inatividade) exigiria relogin com credenciais+Cap. Sessão Orca existente (manual) não demonstra autonomia. Não criar novo runtime. |

**Verificação mínima (§7) não aplicada a caminho novo:** nenhum teste de “auth automática” executado sobre dados (proibido escrever). A única prova nova é que a *infra* (`openapi`+`bearerAuth`+`GETs` 200) existe e responde; o token M2M em si não foi gerado nem validado. Quando o checkout ocorrer (com autorização), reaplicar os 5 checks §7 em POC isolada.

### 5. Limitações / incertezas

- Endpoint exato do checkout (`subscribe-reseller-api` `endpoint:null`) — **UNKNOWN** sem clicar; fluxo exato da subscrição (ACS provider) **UNKNOWN**.
- Contrato de geração/loop de `SigmaResellerApiToken` (escopos disponíveis, TTL, revogação) está fora do OpenAPI público acessível **sem assinatura**; assimetria de visibilidade (tokens UI após assinar).
- Rota/forma de renovação perde-se após expiração real do Bearer (refresh exige token ainda válido).
- Preço da subscrição e cobrança não são confundidos com créditos da conta: `Assinar (R$ 49/mês)` é preço de catálogo da integração; moeda/forma de cobrança do checkout **UNKNOWN**.

### 6. Relatório final da Investigação 03

| Investigação | Resultado |
|---|---|
| Sessão Orca autenticada | `PASS` |
| Reseller API localizada | `SIM` |
| Ativação self-service | `SIM` (paga via painel) |
| Autenticação M2M | `BLOCKED` (inativa hoje) |
| Renovação automática de sessão | `POSSIBLE` (token válido) |
| Endpoints do MVP mapeados | 14 leituras |
| Operações de escrita observadas no bundle | 18 |
| Automação 100% desassistida | `BLOCKED` |

**Veredito:** `CINEVISION_AUTOMATION_BLOCKED` — com uma única rota desassistida lícita identificada (Reseller API M2M via `SigmaResellerApiToken`), bloqueada hoje por assinatura inativa/paga. Sem `CINEVISION_M2M_PATH_FOUND` (token não gerado/testado) nem `CINEVISION_BROWSER_PATH_FOUND` (login sem humano não provado).




