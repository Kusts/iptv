# Investigação da API CINEVISION — relatório profundo (2026-09-30)

> Classificação: relatório de investigação de provider; **não é política canônica de negócio nem contrato estável**.
> Data: 2026-09-30. Painel: SPA pública + API same-origin `/api` (versão observada hoje **X-App-Version 3.93**; baseline 19/09 era 3.92).
> Método desta sessão (GET-only, sem mutação): sessão autenticada real em Chrome normal (perfil separado, operador confirmou login), CDP em `localhost`, Playwright apenas acoplado ao Chrome (sem stealth); **11 GETs in-page com Bearer em memória = 10×200 `application/json` + 1×402 JSON esperado** (8 endpoints/templates distintos com 200: `auth/me`, customers-collection, customer-individual, servers, packages-price, integrations, servers-status, live-connections; + OpenAPI 402; servers e integrations repetidos no catálogo — 9 templates distintos no total); comparação Node HTTP com mesmo Bearer sem cookies (2 GETs, ambos 404 HTML — segunda leitura de metadados, sem retries evasivos); leitura estática dos bundles JS atuais. **Nenhuma mutação externa executada (nem trial)**.
> Canal das sondagens: `API_IN_BROWSER` = chamadas à API via sessão browser/CDP. Reduz seletores mas **mantém browser/sessão** — NÃO é o mesmo que um `CinevisionApiAdapter` server-to-server, que segue inviável hoje (Node 404, causa `UNCONFIRMED`).
> Documentos-base: `../11-research/cinevision-one-panel-evidence-2026-09-19.md`, `../04-specs/integrations/cinevision.md`, `../04-specs/integrations/cinevision-operation-catalog.md`, `../10-operations/cinevision-live-validation-plan.md`, `../15-implementation-baseline/10-integrations-certification.md`, `../15-implementation-baseline/18-implementation-plan.md`, `../15-implementation-baseline/19-open-items-and-validation.md`.
> Regra de leitura: campo `confidence` usa enum exato `OBSERVED` | `INFERRED` | `UNCONFIRMED`; o qualificador `live` / `frontend` / `historical` vai em `source/evidence`, nunca em `confidence`. Contrato write derivado só de JS declara runtime `UNCONFIRMED`. Nenhuma operação é "certificada por um 200".
> Regra de segredo/URL: o domínio não conhece URLs/tokens; URL e endpoint aparecem apenas no adapter ou como evidência sanitizada neste relatório. Segredos nunca vão para logs/docs/código. Corpos brutos de auth jamais são registrados; amostras abaixo são tipadas, sem valores reais.

## Convenção de evidência usada neste relatório

- `OBSERVED`: fato confirmado por evidência direta. Qualificador obrigatório em `source/evidence`: `live` (resposta HTTP real desta sessão), `frontend` (método/path/body visíveis em bundle JS atual — não prova servidor), `historical` (coleta 19/09, painel 3.92 — ver `../11-research/cinevision-one-panel-evidence-2026-09-19.md`).
- `INFERRED`: conclusão razoável a partir do conjunto acima, marcada como tal (ex.: mapeamento `add-courtesy-days` → `TRUST_RENEWAL`, backend "estilo Laravel" pelo envelope).
- `UNCONFIRMED`: alegação de UI/texto, mapeamento de ação dinâmica, ou contrato write sem prova live.
- Fichas de escrita só com forma JS: `confidence: OBSERVED` com literal `FRONTEND` em `source/evidence` + declaração explícita de runtime `UNCONFIRMED`. Mapeamento semântico não literal (ex.: trust) usa `confidence: INFERRED`.
- Proveniência de assets: `https://cinevision.panelbr.site/assets/<arquivo>-<sufixo>.js` (sufixo de build Vite, **não SHA**). Assets **não** estão no repositório; evidências são resumos sanitizados, sem bundles, sem segredos.
- Citações curtas de código usam literais curtos (ex.: `n.post`, `n.get`, `localStorage.token`).

---

## 1. Estado atual

### 1.1 Painel (hoje)

SPA Vue servida na origem do painel (entry HTML público + `assets/index-2o5hyxHZ.js`), API same-origin em `/api`, header atual `X-App-Version: 3.93` (`ApiService-OzZHLOn3.js`).

Confirmado hoje:

- **Leitura live via browser autenticado (`API_IN_BROWSER`) funciona nesta sessão: 10×200 + 1×402 (11 GETs).** Com Bearer em memória: `GET /api/auth/me` 200, `GET /api/customers?perPage=1` 200, `GET /api/customers/{id}` 200, `GET /api/servers` 200 (×2, catálogo repetido), `GET /api/packages/price` 200, `GET /api/integrations` 200 (×2, catálogo repetido), `GET /api/servers/status` 200 (`data` array; item com `name: string` — demais campos omitidos por whitelist, sem inferir objeto completo), `GET /api/customers/live-connections/{serverId}?perPage=1` 200 (`data[]` com itens tipados + `meta` paginado — ver §4/R9; **nenhum valor emitido**), `GET /api/reseller-api/v1/openapi.json` **402** `{"error":"integration_inactive",…,"expires_at":null}`. (Correções aplicadas: nunca "7 GETs 200 incluindo 402"; contagem atual 11 = 10×200 + 1×402.)
- **Comparação Node HTTP com o mesmo Bearer falhou diferente (2 GETs, ambos `404 text/html`).** Sem cookies, sem spoofing, sem retries evasivos — segunda leitura de metadados vale: instrumentação Cloudflare sem challenge confirmado → `HTTP_FAILURE`, causa `UNCONFIRMED` (ver §6).
- **JS atual confirma método/body de mais operações** (clientes, servidores, pacotes, webhooks/deliveries reseller, integrações, checkout, botbot), mas **contrato write em runtime permanece UNCONFIRMED**. Trial/writes: **sem execução** — pré-requisitos de contrato/readback/dispatch durável ausentes e nenhuma entidade descartável designada.
- **Reseller API inativa nesta conta** (402 firme). Parar exploração reseller no 402; `/me/webhooks` não retestado. Complemento: `GET /api/integrations` repetido com `resellerEntryPresent=false` para `id=reseller-api` e `raw.sections` ausentes — assim o endpoint de `generate-token` continua `unknown`. **NÃO concluir indisponibilidade comercial**: ausência desse `id` no catálogo desta amostra pode variar por namespace; o 402 da OpenAPI continua firme. Classificação: gate temporário `DISABLED`/inativo — `unsupported_for_automation` só se a capability exigisse bypass comprovado, nunca por 404 ou 402 isolados.
- **Developers (`panel_impersonate_token` SUPERADMIN, `Developers-C_ZxwWSP.js`)**: fato observado — a conta documentada não possui esse papel e essa superfície não é adequada para revenda; este relatório não cria política permanente sobre ela, apenas registra que não é caminho reseller ("This is not a reseller API"; `/api/integration/openapi.json` com 403 histórico).

### 1.2 Nosso repositório (estado real, com provas)

DDL `provider.provider_operations` (`db/migrations/202609201603_007_provider_fulfillment.sql:60-85`): colunas `tenant_id`, `provider_account_id`, `action`, `entity_type`, `entity_id`, `status DEFAULT 'REQUESTED'`, `idempotency_key NOT NULL`, `execution_channel NULL|'API'|'BROWSER'|'MANUAL'`, `adapter_version`, `requested_payload_json`, `result_summary_json`, `requested_at/started_at/completed_at`, `correlation_id`; checks: status em `('REQUESTED','QUEUED','RUNNING','VERIFYING','RETRY_WAIT','HUMAN_REQUIRED','SUCCEEDED','FAILED','CANCELLED')` (linha 81), canal em `('API','BROWSER','MANUAL')` (linha 82), unicidade `(tenant_id, provider_account_id, idempotency_key)` (linha 83) = **tenant binding + idempotency-key no banco**. Tabelas irmãs: `provider_operation_attempts` (tentativas numeradas, `error_class/code`, `trace_ref`, linhas 93-111), `provider_evidence` (classificação `C0-C3`, linhas 113-128), `provider_bindings` (amarração entidade↔`external_id`, linhas 37-58), `provider_accounts` com `secret_ref NOT NULL` (linhas 19-33).

Certeza de efeito ortogonal (`db/migrations/202609261700_017_trial_provider_effect.sql:19-33`): `effect_certainty IN ('KNOWN_APPLIED','KNOWN_NOT_APPLIED','UNKNOWN')` com shape `SUCCEEDED→KNOWN_APPLIED`, `FAILED/CANCELLED→KNOWN_NOT_APPLIED`, in-flight→`UNKNOWN`. Comentário do migration (linhas 5-12): efeito incerto reconcilia (`VERIFYING` + readback) antes de qualquer retry — nunca retry cego.

Outbox/auditoria/HITL implementados: `platform.outbox_messages` (`PENDING/PUBLISHING/PUBLISHED/FAILED`, `db/migrations/202609201530_001_platform.sql:160-180`); command bus executa handler **dentro de uma transação** (state + evento + outbox + audit atomicamente) — `apps/api/src/commands/command-bus.ts:225-234` (doc) e `330` (`result = await db.withTransaction<CommandResult<TOutput>>(scopeTenant, async (tx) => {`); auditoria escrita em `339-348` (`await tx.writeAudit({…})`). Trust renewal exige aprovação humana por padrão (`subscription.trust_renew` cria/reusa review `subscription_trust_renewal`, `apps/api/src/renewal/renewal.commands.ts:580-630`); recovery queue é fila trabalhada por humano (`recovery.resolve`, `renewal/recovery.controller.ts:55-81`).

Port real única: `ProviderOpsPort.requestOperation` (`apps/api/src/provider/provider-port.ts:43-53`); embarcados só `EchoProviderOpsAdapter` (linhas 67-91) e `ManualProviderOpsAdapter` → `HUMAN_REQUIRED` (linhas 94-100); gate de capability `UNAVAILABLE→MANUAL` (linhas 121-132); `secret_ref` só em memória, nunca persistido (`provider-port.ts:26-33`; `provider.commands.ts:450-459` carrega só metadados + `adapterVersion: ${port.name}-v1`, e caminho secret usa constante reservada `secret-required-v1`).

Chamadas reais à porta (trechos, sem alegar durabilidade pós-commit):

- `apps/api/src/provider/provider.commands.ts:303` — `raw = await port.requestOperation({` (caminho secret; linhas 293-300 comentam: só a chamada é capturada; operação já-`REQUESTED` estaciona `VERIFYING/UNKNOWN`; "Crash/commit-failure protection is explicitly NOT claimed here").
- `apps/api/src/provider/provider.commands.ts:477` — `const result = await port.requestOperation({` (caminho echo/manual, após insert + `operation_requested.v1` em 444-476).
- `apps/api/src/fulfillment/fulfillment.commands.ts:238` — `const result = await port.requestOperation({` (`subscription.provision`, após insert + evento em 215-237); e `:446` — mesmo shape no caminho secret (linhas 440-443 comentam mesma disciplina).
- `apps/api/src/trial/trial.commands.ts:633` — `raw = await port.requestOperation({` (`trial.provision`, linhas 625-630 com mesma ressalva); e `:838` — caminho echo/manual (`trial-provision:${trial.id}:${attemptIndex}`).
- **Gap declarado no próprio código**: proteção contra crash/commit-failure **não** é alegada; Browser real segue bloqueado até dispatch pós-commit durável + readback. **Crash pre-send só é seguro se houver attempt durável gravado ANTES do send; `leaseExpired` não garante "não enviado". Recuperação deve reconciliar tudo em `dispatch_started` salvo prova de não-envio.** (Ver §10–§12.)

Worker CLI (`apps/browser-worker`): operação fixa única `cinevision.readIdentity` (`src/constants.ts:19`, `src/cli.ts:1-12` — flags desconhecidas falham fechado); probe read-only em `GET /api/auth/me` absoluto duas vezes via contexto da página (`src/operations/readIdentity.ts:9`, `:56-83`, `:256-270`); emite só booleanos, nada sensível sai do processo (linhas 37-39, 292-295); erros como códigos fixos (`constants.ts:52-65`).

Segredos — divergência registrada: o smoke LAB W0-09 resolveu credenciais via identidade Infisical dedicada `dev /browser-worker/*` (`viewer`, escrita negada 403) através de `BROWSER_INFISICAL_*` com refs fixas `infisical://dev/browser-worker/CINEVISION_URL|EMAIL|PASSWORD` (`src/constants.ts:32-36`, `src/secrets.ts:28-37`); já o `AGENTS.md` vigente mantém a regra antiga (ADR-0014 de Infisical **proposto, não implantado**; até gerenciador aprovado, credenciais no cofre do operador, nada no `.env`). Divergência real: LAB usou Infisical dev; regra do repo ainda diz proposto. Este relatório não resolve a divergência — registra como gap (§11).

Workflows: default local em processo **não durável**; Hatchet só com `HATCHET_API_TOKEN` (`apps/api/src/app.module.ts:160-162`, `packages/workflows/src/hatchet-adapter.ts:11-22`, `packages/workflows/src/local-adapter.ts:17-22`).

Renewal — correção importante: `renewal.commands` trata de **assinaturas/ciclos do nosso domínio** (`subscription.renew` abre o PRÓXIMO ciclo da MESMA assinatura; `subscription.trust_renew` é extensão limitada com review; `renewal.expire_overdue_due`, recovery queue — `apps/api/src/renewal/renewal.commands.ts:66-89`, `renewal-policy.ts:5-17`). **Nada disso é registro/renovação de domínio DNS.** A expressão "renewal de domínio" usada na v1 deste relatório está removida; `domain-registration-credits`/`billing/domain-orders` são artefatos financeiros/contas separados, não operação provider de assinatura.

Certificação runtime (neste repo): estados de certificação `UNCERTIFIED | SANDBOX_CERTIFIED | CERTIFIED` + eixo de disponibilidade separado `AVAILABLE | DEGRADED | UNAVAILABLE` (capability `provider.cinevision`). **Gap**: nenhum seed cria a linha `provider.cinevision` (`db/seeds/001_pilot_baseline.sql` só cria provider `cinevision` + conta placeholder `seed://not-a-real-secret/cinevision`, linhas 36-52) — gate global sem fixture é gap (§11).

### 1.3 Respostas A–H (correspondência exata com as perguntas do usuário)

- **A. Dá para substituir (parcialmente) o Browser pela API? (§4, §10)** Conclusão direta: hoje há 8 endpoints com leitura live via `API_IN_BROWSER` ("API in browser"), mas isso é **redução de seletores, não substituição do browser** — a sessão browser continua obrigatória. Substituição total (M2M) não: Reseller inativa (402). Material futuro (§10, diagrama): `CinevisionApiAdapter` preferido quando certificado → `CinevisionBrowserAdapter` fallback → `ManualProviderOpsAdapter` existente; `ProviderReadbackPort` ao lado em todos os caminhos.
- **B. Quais operações a API expõe? (§8 + Apêndice A)** Leituras com prova live (`API_IN_BROWSER`): `readIdentity`, `listCustomers`, `readCustomer`, `listServers`, `READ_SERVER_STATUS` (`servers/status`), `READ_LIVE_CONNECTIONS` (sessões, schema da amostra), `listPackagePrices`, `listIntegrations`, mais derivadas `READ_CREDIT_BALANCE` (campo `credits`), `READ_CUSTOMER_STATUS` e `READ_CONNECTIONS` (allowance/limite — **não** sessões). Detail/packages/bouquets de servidor, playlist, calculations, escritas W1–W10, reseller S1–S5 e checkout seguem forma JS (`FRONTEND`) e runtime `UNCONFIRMED`.
- **C. Oficial vs. interna — qual usar? (§3, §4)** Oficial (Reseller M2M): inativa + sem OpenAPI + HMAC/scopes/token-endpoint desconhecidos → fora de escopo até ativação. Interna (SPA): utilizável como leitura observada via browser + adapter versionado + readback; nunca como contrato presumido para escrita automática.
- **D. Cloudflare: aquisição e api/auth — o que trava? (§5, §6)** Hoje: Node 2 GETs →`404 HTML` (`HTTP_FAILURE`, causa `UNCONFIRMED`); W0-09: interstitial 403 naquela condição. `auth/me` funcionou na sessão browser (Bearer em memória); **dependência de cookies browser não demonstrada** — browser-200 vs Node-404 não isola cookies/transporte/UA/headers (dependência `unknown`). Marcadores isolados (script CF, `challenge-platform`) são insuficientes para declarar challenge.
- **E. Qual mecanismo de autenticação deve ser usado? (§5 + §7 p/ callbacks)** SPA: sessão browser com Bearer em memória (`localStorage.token` + headers §4); caminho futuro com `secret_ref` (fronteira PF-05, nunca valor persistido). Oficial M2M: token dedicado com schema `unknown` — **preferido condicionalmente** (se ativada + autorizada + OpenAPI acessível), sem admin (superfície de developers não é caminho reseller). Callbacks/webhooks de pagamento e direção gateway↔CineVision: ver §7 (webhook exato/auth `UNCONFIRMED`; nosso Asaas é nosso).
- **F. Estabilidade observada? (§9)** Painel versiona rápido (3.92→3.93); comportamento diferiu entre browser (200) e Node (404) — **causa desconhecida, sem alegação de sensibilidade de rede/IP**; Reseller paga/inativa; terceiros (gateways, BotBot terceiro, Pusher, Sentry) fora do nosso controle. Nada aqui autoriza SLA. Ameaças (threats) vs. observado (facts): instabilidade de contrato e drift são ameaças modeladas; o único fato é a divergência browser×Node nesta sessão.
- **G. Browser/HITL são obrigatórios? Quando? (§10, §12)** Sim até certificação: qualquer escrita real exige (i) leitor real provado antes, (ii) dispatch pós-commit durável (outbox + worker + attempt pré-send) antes de **qualquer** escrita, (iii) readback conclusivo; ambiguidade/drift/captcha/2FA → `HUMAN_REQUIRED`; destrutivas (`change-package`, mass) sempre com HITL e default `DISABLED`.
- **H. Arquitetura recomendada? (§10, diagrama abaixo)** `ProviderOpsPort.requestOperation` única; `CinevisionApiAdapter` preferido quando certificado → `CinevisionBrowserAdapter` fallback → classe existente `ManualProviderOpsAdapter`; `ProviderReadbackPort` ao lado em todos os caminhos; comandos com estado DB em transação + chamada externa pós-commit (hoje inline = gap, não recomendação); causa e efeito independentes; sem retry cego nem troca API→Browser cega.

---

## 2. Evidências anteriores

Base histórica (19/09, painel 3.92) — fonte: `../11-research/cinevision-one-panel-evidence-2026-09-19.md`:

- Painel = revenda IPTV white-label ("Sigma Panel", `sigma.vin`); não é app de streaming final (§1 do doc 19/09).
- Stack: Vue 3 + Vue Router hash + Pinia + Bootstrap 5/Metronic + vue-i18n/gettext + dayjs + vee-validate + SweetAlert2 + Pusher + Sentry + PWA + Meta Pixel (§2.1).
- API: base same-origin `/api`, Bearer `localStorage.token`, envelope **estilo Laravel** `{data, links, meta}` (**INFERRED** pelo formato — não prova backend Laravel), headers `Authorization: Bearer`, `Accept: application/json`, `Locale: pt`, `X-App-Version: 3.92`; erros `401/403 {"message":"Proibido"}/402 integration_inactive|addon_inactive` (§2.2).
- Auth/sessão: `GET /api/auth/me`, `GET /api/settings/public` (58 flags), `GET /api/auth/active-sessions`, 2FA app/Telegram/e-mail, inatividade 1440min, usuário/senha de cliente 9 chars numéricos (§3).
- Conta documentada: `ultra-reseller`, 2 créditos, ~60 permissões, sem permissões admin (§4).
- Domínio, integrações, settings, 155 rotas, dezenas de endpoints (§6–§10); limites: só front-end + REST, sem código de back-end (§13).

Base de decisão: `../04-specs/integrations/cinevision.md` (fulfillment externo; port semântica; API→adapter senão browser autorizado; `HUMAN_REQUIRED`; postcondition; trial 1h/3h/6h; `TRUST_RENEWAL` +3d ACTIVE ≤3d; reconciliação; importação de base; adult-content); `../04-specs/integrations/cinevision-operation-catalog.md` (catálogo semântico; contrato de adapter; `UNKNOWN_EFFECT→verify`); `../10-operations/cinevision-live-validation-plan.md` (matriz por operação; ordem read→…→destrutivas); `../15-implementation-baseline/10-integrations-certification.md` (eixos de certificação; gate browser adapter; **W0-09 2026-09-30**: bootstrap isolado provado, login real, read então bloqueado por interstitial, writes W0-10 rejeitados); `../15-implementation-baseline/18-implementation-plan.md` + `../15-implementation-baseline/19-open-items-and-validation.md` (Waves; gates M1–M5/G07).

A sessão de hoje **adiciona**: 3.92→3.93; read-browser **bloqueado em W0-09 naquela condição** vs. **10×200+1×402 hoje nesta sessão (11 GETs `API_IN_BROWSER`, 8 endpoints 200 distintos)** (condições distintas, sem contradição); heurística de challenge corrigida (ver §6).

---

## 3. Reseller API

Pergunta: existe M2M estável que dispense browser? **Não utilizável nesta conta.**

Live (Chrome autenticado, Bearer em memória): `GET /api/reseller-api/v1/openapi.json` → **402** `application/json` (`error: "integration_inactive"`, `integration_key` presente, `expires_at: null`). Parar no 402; `/me/webhooks` não retestado.

Frontend (forma JS, sem prova live) — `resellerApi-DoKFwzcJ.js`: `GET reseller-api/v1/me`; `GET+POST me/webhooks {url, events, active}`; `PUT/DELETE me/webhooks/{id}`; `POST rotate-secret {}`; `GET me/webhooks/{id}/deliveries?page&per_page&status`; formas esperadas de webhook e delivery (só JS). `ResellerApiReferencePage-B0P5xgIQ.js`: Scalar com fetch do OpenAPI remoto — sem schema business embutido; **não listar endpoints business como "iguais ao SPA"**. `WebhookSecretShownOnceModal-jsWHSw6_.js` (claims UI, `UNCONFIRMED`): HMAC signed POST; escopo "próprios clientes/revendas"; eventos `customer.*/customer_order.*/reseller.*/credits.*/credit_order.*`; delivery `pending/delivered/failed/dead_letter/cancelled_*`; header/algoritmo/canonicalização/retry/TTL `unknown`. Validação de URL (bloqueio de host privado) só em frontend. `IntegrationPage-BlYq1WO-.js` (`generate-token`, "full access…shown once"): endpoint exato **desconhecido** (depende de `raw.sections`). `integrations/resellerApi`, `…/current-subscription`, `POST …/subscribe {success_url, cancel_url}`: forma JS, sem prova, sem compra executada.

Não afirmar M2M: auth formal/scopes **UNCONFIRMED**; Bearer de gestão ≠ prova M2M. Developers/SUPERADMIN: fato registrado em §1.1, sem política permanente. `resync_webhook` (templates + "3s/3fail/1min") é texto UI; endpoint indisponível nesta conta.

Implicação: sem ativação paga + OpenAPI + credencial M2M dedicada, Reseller **não** é alternativa ao browser. Após ativação, exigir OpenAPI versionada, auth, scopes, HMAC canônico, retry/TTL — tudo em lab antes de escrita.

---

## 4. Internal SPA API

API same-origin consumida pelo painel (`/api/*`) — **interna/privada**, sem estabilidade prometida.

Base/headers (hoje, `ApiService-OzZHLOn3.js`): origin + `/api`; `Authorization: Bearer <localStorage.token>`, `Accept: application/json`, `Locale` + `Accept-Language`, `X-App-Version: 3.93`.

Leituras live (10×200 + 1×402; tipos sem valores; canal `API_IN_BROWSER`):

| Endpoint | Forma (tipos) |
|---|---|
| `GET /api/auth/me` | Perfil no root + `READ_CREDIT_BALANCE` (`credits: number`; unidade/precisão `unknown`) e `token: string` (**segredo — nunca logar corpo**) |
| `GET /api/customers?perPage=1` | `Customer[]` paginado (`data: Customer[]`, `links`, `meta`) + `READ_CUSTOMER_STATUS` / `READ_CONNECTIONS` (allowance) via campos do customer |
| `GET /api/customers/{id}` | `data` **é** o objeto Customer (não existe campo `data.customer`); amostra: `id/user_id/server_id/package_id: string`, `status: string`, **`is_trial: STRING`**, `connections: number`, `has_multiple_connections: boolean`, `expires_at: string`, `plan_price: number`, demais PII/playlist nulos **nesta amostra**, `whatsapp` com mascaramento do nosso script (sem alegar masking global pelo provider). Amostra ≠ schema; **não persistir como dado real** |
| `GET /api/servers` (×2) | `data: Server[]`, `links`, `meta` (notação de tipo — `[]` nunca significou "vazio"; amostras não eram vazias) |
| `GET /api/servers/status` | `data` array; item com `name: string` (whitelist explícita — **outros campos omitidos, sem inferir objeto completo**) |
| `GET /api/customers/live-connections/{serverId}?perPage=1` | `data[]` com item `{id: string, user_username: string, max_connections: number, reseller_username: string, stream_display_name: string, user_agent: string, date_start_timestamp: number}` (schema da amostra, tipos apenas, **nenhum valor emitido**) + `meta {current_page, from, last_page, per_page, to, total: numbers}`. É **sessões live** — distinto de `READ_CONNECTIONS` (allowance/limite do customer) |
| `GET /api/packages/price` | `data: Price[]`, `links`, `meta` (não confundir com `/api/packages` 403 admin) |
| `GET /api/integrations` (×2) | `data: Integration[]` + aviso/CTA (amostra toda inativa; segunda leitura com `resellerEntryPresent=false` para `id=reseller-api`, `raw.sections` ausentes) |
| `GET /api/reseller-api/v1/openapi.json` | **402** `integration_inactive` (ver §3) |

Formas JS (`FRONTEND`, runtime `UNCONFIRMED`): `customer-BPdT3J4I.js` (`GET customers` com filtros/sort; `GET customers/{id}`; `POST customers` via `CustomersAdd-DxcjWNce.js`; `POST …/renew` via `RenewModal-ByjzDfqI.js`; `PUT …/toggle-status {}`; `POST …/change-connections`; `POST …/add-courtesy-days {}` via `AddCourtesyDaysModal-DfYdoqur.js`; `PUT …/server-migration` via `MigrateServerModal-CWhJ_8Zx.js`; `GET …/playlist` **não executado**; `POST …/generate-credential`; `POST …/calculate-*` vários; `POST …/resync {}`; `POST …/change-package {package_id}`; `PUT …/send-botbot`); `server-DLt7mB8X.js` (detail/packages/bouquets — **não retestados live**; só `servers/status` tem prova live); `package-DbaTjTbR.js`; `integrations-Dpvoeg50.js` (+ actions dinâmicas, mapeamento exato `unknown`); `checkout-DmWi7OV0.js` (público — backend + callbacks terceiros **INFERRED**, webhook exato **UNCONFIRMED**).

Regras: leitura live = snapshot por conta/versão, não certificado; escrita = `UNCONFIRMED` até prova por operação; `toggle-status {}` sem corpo = perigoso (ver §8–§9).

---

## 5. Autenticação

| Superfície | Auth | Fonte |
|---|---|---|
| SPA browser | Bearer `localStorage.token` + headers §4 | `OBSERVED` (`live` + `frontend` `ApiService-OzZHLOn3.js`) |
| Login | `POST` body `{username, password, captcha, captchaChecked, twofactor_code, twofactor_recovery_code, twofactor_trusted_device_id}` (passthrough cliente; required servidor `unknown`) | `OBSERVED` (`frontend` `SignIn-Cr604mKY.js`) |
| Sessão | `GET auth/me`, `GET auth/refresh-token` (**mutação de sessão via GET — não executar sem necessidade**), `PUT auth/update` | `OBSERVED` (`frontend` `auth-21PiyWfB.js`) |
| Reseller M2M | `unknown` (sem OpenAPI; `generate-token` sem endpoint) | `UNCONFIRMED` |
| Developers/admin | fato §1.1/§3; sem política permanente | `OBSERVED` (`frontend`, conta sem papel) |

2FA manual existe; captcha fixo como solver é proibido (`HUMAN_REQUIRED`). Nosso repo: `secret_ref` só em memória/fronteira PF-05, nunca em `requested_payload_json`/eventos/auditoria.

---

## 6. Cloudflare

Fatos: Node 2 GETs, ambos `404 text/html` com instrumentação CF (sem retries evasivos); segunda comparação com metadados normais: `server: cloudflare`, `cf-mitigated: NÃO challenge`, `title: NOT_FOUND`, `generic404: true`, `jsDetectionScript: true`, `cfChl: false`, `challengeForm: false`, `spaApp: false` → **`HTTP_FAILURE`, não challenge**; causa `UNCONFIRMED` (cookies/transporte/IP/headers sem prova). W0-09: interstitial 403 ("Um momento…") naquela condição. "Reputação de IP" como causa é hipótese, não fato.

### 6.1 Taxonomia de erros (códigos padronizados do usuário — causa × efeito)

| Código | Causa (o que aconteceu) | Efeito (o que afirmar) | Observação |
|---|---|---|---|
| `CHALLENGE` | interstitial/checkbox/Turnstile observável (`cfChl/challengeForm` ou "Um momento…" persistente) | efeito `UNKNOWN`; `HUMAN_REQUIRED` + cooldown | **Marcadores isolados (script CF, `challenge-platform`) são insuficientes** |
| `AUTH_FAILED` | credencial inválida provada (login rejeitado) | `KNOWN_NOT_APPLIED`; sem retry de credencial | Não inferir de 403/404 |
| `SESSION_EXPIRED` | sessão expirada provada (ex.: 401 após 200 anterior na mesma sessão) | `UNKNOWN` até readback; re-login autorizado | Não inferir de 403 HTML |
| `PERMISSION_DENIED` | `403 {"message":"Proibido"}` JSON ou redirect por `meta.permission/role` | `KNOWN_NOT_APPLIED` (leitura negada) | **403 HTML interstitial ≠ 403 JSON de permissão — 403 sozinho nunca prova falta de auth/permissão** |
| `INTEGRATION_INACTIVE` | `402 integration_inactive/addon_inactive` JSON | `KNOWN_NOT_APPLIED`; parar exploração | Prova live §3 |
| `RATE_LIMITED` | 429 ou interstitial por taxa provada | `UNKNOWN`; backoff, sem retry agressivo | Não presumir sem sinal |
| `HTTP_FAILURE` | status/corpo inesperado sem semântica (ex.: Node 404 HTML hoje) | `UNKNOWN`; causa `UNCONFIRMED` | Caso de hoje |
| `BAD_RESPONSE` | corpo fora do schema (ex.: `is_trial` string, HTML onde era JSON) | `UNKNOWN`; normalização defensiva | Prova live §4 |
| `UI_DRIFT` | DOM/versão diferente do pin (`3.93` vs esperado) | `UNKNOWN`; `HUMAN_REQUIRED`, adapter `DEGRADED` | Regra browser |
| `POSTCONDITION_MISMATCH` | readback diverge da intenção | `UNKNOWN`; reconciliar, sem retry cego | Princípio §10 |
| `UNKNOWN_EFFECT` | qualquer write sem ack/readback conclusivo | `UNKNOWN` (`VERIFYING`); reconciliar primeiro | Default de crash |
| `TRANSPORT` | falha de rede/timeout antes de prova | `UNKNOWN`; causa e efeito independentes | Nunca "não enviado" sem prova |

---

## 7. BotBot / Gateways

Catálogo live inativo (§4); formas em `integrations-Dpvoeg50.js` (`GET/PUT/DELETE integrations…`, `raw.sections[]`, actions dinâmicas com mapeamento `unknown`). Amostra (sem valores): BotBot (`messaging`: fila/agendamento/logs/teste; `PUT …/send-botbot {name, whatsapp}`; `GET botbot/logs?type=`; trigger `chatbot/{userId}/{packageId}` **perigoso — não chamar**; serviço terceiro referenciado, nunca sondado); Asaas (`api_key`, `pix_key`); MP (`public_key`, `access_token`, `accept_pix_only`); paggpay (`api_key`, `activationUrl`); PayPal (`client_id/client_secret`); Stripe (`secret_key`). `webhookUrl` ausente no snapshot **não prova** ausência backend. Checkout (X1): backend + callbacks **INFERRED**; webhook exato/auth/direção **UNCONFIRMED**. Nosso `POST /v1/webhooks/asaas/:tenantKey` é **nosso**, não do CineVision.

---

## 8. Operações — tabela exigida

Colunas exigidas: Capability | Endpoint | Canal | Evidência | Confidence | Situação (+ Método). `Confidence` = enum exato; qualificador em Evidência. `data: X[]` = notação de tipo. Canal `API_IN_BROWSER` = chamadas API via sessão browser/CDP (reduz seletores, mantém browser/sessão); distinto de adapter server-to-server (inviável hoje).

| Capability | Endpoint | Canal | Método | Evidência | Confidence | Situação |
|---|---|---|---|---|---|---|
| `READ_IDENTITY` | `/api/auth/me` | SPA/Browser | GET | `live` (200 `application/json` hoje) + `frontend` (`ApiService`) + `historical` | `OBSERVED` | Snapshot OK; **não certificado**; corpo com segredo, nunca logar |
| `READ_CREDIT_BALANCE` | `/api/auth/me` (campo `credits: number`) | SPA/Browser | GET | `live` (saldo number; unidade/precisão `unknown`) | `OBSERVED` | Saldo lido; unidade pendente; **não certificado** |
| `LIST_CUSTOMERS` | `/api/customers` | SPA/Browser | GET | `live` (`perPage=1`) + `frontend` (filtros/sort) + `historical` | `OBSERVED` | Página OK; filtros combinados pendentes |
| `READ_CUSTOMER` | `/api/customers/{id}` | SPA/Browser | GET | `live` (tipos; `is_trial` string) | `OBSERVED` | Snapshot OK; schema completo pendente |
| `READ_CUSTOMER_STATUS` | via campos do customer (`status`, `expires_at`, `is_trial`) | SPA/Browser | GET | `live` (mesma resposta R3) | `OBSERVED` | Derivado, sem endpoint próprio |
| `READ_CONNECTIONS` (allowance/limite) | via campos (`connections`, `has_multiple_connections`) | `API_IN_BROWSER` | GET | `live` (mesma resposta R3) | `OBSERVED` | Derivado = limite contratado; **NÃO é sessões live** |
| `LIST_SERVERS` | `/api/servers` | `API_IN_BROWSER` | GET | `live` (×2) + `frontend` + `historical` | `OBSERVED` | Snapshot OK; **não certificado** |
| `READ_SERVER_STATUS` | `/api/servers/status` | `API_IN_BROWSER` | GET | `live` (200; `data` array, item `name: string`, resto omitido) | `OBSERVED` | Status observado; objeto completo não inferido |
| `READ_SERVER` (detail/packages/bouquets) | `/api/servers/{id}`, `/api/servers/packages/{id}`, `/api/servers/bouquets/{id}[/true]` | SPA/Browser | GET | `frontend` (`server-DLt7mB8X.js`) + `historical` | `UNCONFIRMED` | **Não retestados live**; só `servers/status` tem prova live |
| `LIST_PACKAGE_PRICES` | `/api/packages/price` | SPA/Browser | GET | `live` + `frontend` + `historical` | `OBSERVED` | Snapshot OK; unidade `plan_price` pendente |
| `LIST_INTEGRATIONS` | `/api/integrations` | SPA/Browser | GET | `live` (amostra inativa) + `frontend` | `OBSERVED` | Catálogo OK; ativação pendente |
| `READ_PLAYLIST` | `/api/customers/{id}/playlist` | SPA/Browser | GET | `frontend` (não executado) | `UNCONFIRMED` | Forma JS |
| `READ_LIVE_CONNECTIONS` (sessões) | `/api/customers/live-connections/{serverId}?perPage=1` | `API_IN_BROWSER` | GET | `live` (200; item `{id, user_username, max_connections, reseller_username, stream_display_name, user_agent, date_start_timestamp}` + `meta` paginado; tipos, sem valores) | `OBSERVED` | Sessões live observadas; **não certificado** |
| `CALCULATE_*` | `/api/customers/calculate-*` (5 variantes) | SPA/Browser | POST | `frontend` (resposta `credits_required` esperada em JS; **não executar sem autorização de teste; nome POST não prova pureza**) | `UNCONFIRMED` | Forma JS; pureza/idempotência por provar |
| `CREATE_TRIAL`/`CREATE_CUSTOMER` | `/api/customers` | SPA/Browser | POST | `frontend` (`CustomersAdd`) | `OBSERVED` | **Forma FRONTEND; runtime UNCONFIRMED** |
| `RENEW_CUSTOMER` | `/api/customers/{id}/renew` | SPA/Browser | POST | `frontend` (`RenewModal`) | `OBSERVED` | **Forma FRONTEND; runtime UNCONFIRMED** |
| `TRUST_RENEWAL` | `/api/customers/{id}/add-courtesy-days {}` | SPA/Browser | POST | `frontend` (forma) + regra domínio piloto | `INFERRED` | Mapeamento semântico inferido; runtime `UNCONFIRMED` |
| `BLOCK`/`UNBLOCK` | `/api/customers/{id}/toggle-status {}` | SPA/Browser | PUT | `frontend` literal (body `{}`; risco de toggle `INFERRED`) | `OBSERVED` | **Forma FRONTEND; backend/duplicata UNCONFIRMED; retry só com readback** |
| `CHANGE_CONNECTIONS` | `/api/customers/{id}/change-connections` | SPA/Browser | POST | `frontend` | `OBSERVED` | **Forma FRONTEND; runtime UNCONFIRMED** |
| `MIGRATE_SERVER` | `/api/customers/{id}/server-migration` | SPA/Browser | PUT | `frontend` (claim "sem créditos" não prova) | `OBSERVED` | **Forma FRONTEND; runtime UNCONFIRMED** |
| `SYNC_CUSTOMER` | `/api/customers/{id}/resync {}` | SPA/Browser | POST | `frontend` | `OBSERVED` | **Forma FRONTEND; runtime UNCONFIRMED** |
| `CHANGE_PACKAGE` | `/api/customers/{id}/change-package` | SPA/Browser | POST | `frontend` (UI alega destrutivo) | `OBSERVED` | **Inventário perigoso; default DISABLED** |
| `GENERATE_CREDENTIAL` (candidato) | `/api/customers/generate-credential` | SPA/Browser | POST | `frontend` (sem `{id}`, body `{server_id, field}`) | `OBSERVED` | **Forma FRONTEND; efeitos runtime UNKNOWN; retry proibido por precaução** |
| `SEND_BOTBOT` | `/api/customers/{id}/send-botbot` | SPA/Browser | PUT | `frontend` | `OBSERVED` | **Forma FRONTEND; runtime UNCONFIRMED** |
| `RESELLER_SELF` | `/api/reseller-api/v1/me` | Reseller | GET | `frontend` + `live` 402 no OpenAPI | `UNCONFIRMED` | Integração inativa |
| `RESELLER_WEBHOOKS` | `/api/reseller-api/v1/me/webhooks…` + `rotate-secret` | Reseller | GET/POST/PUT/DELETE | `frontend` (não retestado) | `UNCONFIRMED` | Parado no 402 |
| `RESELLER_DELIVERIES` | `…/webhooks/{id}/deliveries` | Reseller | GET | `frontend` | `UNCONFIRMED` | Parado no 402 |
| `RESELLER_SUBSCRIPTION` | `/api/integrations/resellerApi…` + `subscribe` | SPA/Reseller | GET/POST | `frontend` + `live` 402 | `UNCONFIRMED` | Sem compra executada |
| `RESELLER_TOKEN` | ação `generate-token` (endpoint exato `unknown`) | SPA/Reseller | `unknown` | `frontend` (texto UI) | `UNCONFIRMED` | Sem endpoint; sem scopes |
| `CHECKOUT_*` | `/api/checkout/…`, `/api/payment-check/…` | Público | GET/POST | `frontend` | `UNCONFIRMED` | Fluxo cliente final; backend INFERRED |

Fichas completas de 18 campos no Apêndice A (mesmos valores de `confidence`/`evidence` desta tabela).

---

## 9. Riscos

Técnicos: contrato interno instável (pin 3.93 + `adapter_version` + kill-switch); `toggle-status` com body `{}` (risco de toggle `INFERRED`; backend `UNCONFIRMED`; readback antes de retry); `is_trial` string (normalização defensiva); `change-package` destrutivo (fora de automático); cálculos sem prova (sem precificação); actions dinâmicas sem mapeamento (não adivinhar).
Segurança: auth com segredo (nunca logar); segredos só via `secret_ref`/cofre (divergência Infisical §1.2 como gap); captcha/2FA→`HUMAN_REQUIRED`; URLs com efeito (chatbot GET) nunca sondar; validação de webhook só-frontend não prova backend.
Estabilidade do provider: versionamento rápido; comportamento browser×Node diferiu nesta sessão, causa desconhecida (sem alegar sensibilidade de rede/IP); Reseller paga/inativa; terceiros fora de controle.
Comerciais: unidade de `credits`/`plan_price` indefinida; claims de UI ("sem créditos", "30d") não são prova; Trial como qualificação (1 primary).
Operacionais: sem outbox/worker/readback = perda/duplicata (§10–§12); 62 testes antigos não re-executados hoje; campos PII/playlist nulos **nesta amostra** (sem alegar mascaramento global pelo provider — o `whatsapp` mascarado acima é mascaramento do nosso próprio script de coleta; dados sensíveis nunca são emitidos pelo script, nenhuma afirmação sobre masking do provider); Node↔browser sem equivalência (runbook proíbe validar um pelo outro).

---

## 10. Recomendação arquitetural

1. **Porta única** `ProviderOpsPort.requestOperation` (`provider-port.ts:43-53`); só echo/manual embarcados; gate `UNAVAILABLE→MANUAL`.
2. **Canal explícito: `API_IN_BROWSER` ≠ adapter server-to-server.** Leituras live de hoje usam a API via sessão browser/CDP: reduz seletores/DOM, mas **mantém browser + sessão** (cookies, perfil, Bearer em memória). Um `CinevisionApiAdapter` server-to-server (Node direto) segue **inviável hoje** (2 GETs Node → 404 `HTTP_FAILURE`, causa `UNCONFIRMED`). Não tratar `API_IN_BROWSER` como prova de viabilidade server-to-server.
3. **`CinevisionApiAdapter` futuro implementa a mesma porta** (com `adapter_version` próprio + `secret_ref` PF-05); browser = estratégia versionada, **não** implementação real embarcada. **Preferência condicional**: Reseller API primeiro **se** ativada + autorizada + OpenAPI acessível (M2M formal); SPA direta server-to-server **condicionalmente bloqueada** pelo Node 404 de causa desconhecida — reavaliar só com equivalência provada.
4. **Readers privados→`ProviderReadbackPort`** (`verify: ReadbackQuery→ReadbackResult`, `provider-port.ts:176-178`); semântica de domínio nunca recebe seletores/rotas/credenciais.
5. **Transação DB-only + chamada externa pós-commit é o desenho futuro.** Nesse desenho, somente operações DB devem ocorrer no callback transacional; o worker chama a porta **após o commit**. **Hoje**, o command bus aguarda o handler dentro de `withTransaction` (`command-bus.ts:330-350`), e o handler aguarda `port.requestOperation` **dentro desse callback, antes do commit** (ex.: `provider.commands.ts:477-489`; `trial.commands.ts:838-851`; `fulfillment.commands.ts:238-253`). Os efeitos externos não participam da atomicidade do banco: rollback não desfaz uma ação no provider. Este é o **gap declarado**, não proteção pós-commit já implementada. A proveniência `adapter/adapterVersion` persistida continua necessária para o gate do stub (`provider-port.ts:191-251`).
6. **Pós-commit durável (design obrigatório antes de qualquer escrita real, inclusive trial)**: outbox (`platform.outbox_messages`) + worker + **attempt durável ANTES do send** + lease + ack/readback. Reassumir envio só quando houver prova de que ele não começou. Um attempt gravado ou lease expirado, isoladamente, **não** prova ausência de envio; recuperação de `dispatch_started` sem resultado exige reconciliação. Crash após possível envio sem ack = `UNKNOWN` (`VERIFYING` + `effect_certainty=UNKNOWN`, shape em `017:27-33`); **nunca retry cego, nunca troca API→Browser cega**; causa e efeito independentes (tabela §6.1). **Trial/writes sem execução** até contrato + readback + dispatch durável + entidade descartável designada.

```text
"API in browser" (hoje, leitura) × material futuro (escrita) — aliases distintos

  Comandos ──► ProviderOpsPort.requestOperation (única porta real)
                   │
                   ├──► CinevisionApiAdapter  (PREFERIDO quando CERTIFIED;
                   │     Reseller M2M se ativada+OpenAPI, senão SPA direta
                   │     server-to-server se equivalência provada)
                   │         │  + ProviderReadbackPort (readers privados)
                   │
                   ├──► CinevisionBrowserAdapter (FALLBACK versionado;
                   │     inclui API_IN_BROWSER + DOM quando preciso;
                   │     mesma porta, adapter_version próprio)
                   │         │  + ProviderReadbackPort (readers privados)
                   │
                   └──► ManualProviderOpsAdapter (EXISTENTE, ManualProviderOpsAdapter;
                         HUMAN_REQUIRED; sem readback automático)

  Desenho de classe (pseudocódigo, não implementação):

  interface ProviderOpsPort {
    requestOperation(input: ProviderOperationRequest): Promise<AdapterResult>;
  }
  class CinevisionApiAdapter implements ProviderOpsPort {  // preferido se CERTIFIED
    name = "cinevision-api";
    requiresSecretRef = true;  // M2M dedicado ou sessão gerenciada
  }
  class CinevisionBrowserAdapter implements ProviderOpsPort {  // fallback
    name = "cinevision-browser";
    requiresSecretRef = true;  // worker CLI + secret_ref, nunca valor
  }
  // ManualProviderOpsAdapter já existe (provider-port.ts:94-100).
  // ProviderReadbackPort.verify acompanha TODOS os caminhos acima.
```
7. **Classificação de automação**: `unsupported_for_automation` **APENAS** quando a capability exigisse bypass comprovado (anti-bot, solver, escalonamento) — nunca por 404 ou 402 isolados. Estado atual das superfícies bloqueadas: gate temporário `DISABLED`/inativo (Reseller) e `HTTP_FAILURE` de causa desconhecida (Node direto).
8. **Segredo/URL**: domínio sem URLs/tokens; URL/endpoint só no adapter ou evidência sanitizada; segredos nunca em logs/docs/código.
9. **Renewal do nosso domínio = assinaturas/ciclos** (`subscription.renew/trust_renew`, §1.2) — sem confusão com DNS.

---

## 11. Gaps

Certificação (correção aplicada): o runtime conhece **apenas** `UNCERTIFIED | SANDBOX_CERTIFIED | CERTIFIED` para certificação e, em eixo separado, disponibilidade `AVAILABLE | DEGRADED | UNAVAILABLE` (capability `provider.cinevision`). `CANARY_VALIDATED` **não** existe no runtime — é estágio do processo (conta real controlada, volume mínimo) entre `SANDBOX_CERTIFIED` e `CERTIFIED`, e qualquer enum novo exige **migração append-only futura**, nunca mapeamento silencioso. Laterais do baseline (`CERTIFIED_WITH_LIMITATIONS` = `CERTIFIED` + limitações; `RECERTIFICATION_REQUIRED` = gatilho para `DEGRADED`; `REJECTED` = terminal) continuam válidos como qualificadores. **Gap**: gate global `provider.cinevision` sem seed (ver §1.2) — nenhum ambiente novo parte de estado conhecido.
Operacionais: paginação/filtros/erros/latência das leituras; unidade `credits`/`plan_price`; objeto completo de `servers/status` e detail/packages/bouquets; playlist/calculations sem prova; todas as escritas sem idempotência/duplicata/retry provados e sem entidade descartável designada; Reseller sem OpenAPI/HMAC/retry/TTL/scopes/token-endpoint; checkout/BotBot/gateways sem traces; `reservation_token`/`expires_at_tz`/`bouquets`/multi-server/créditos recorrentes; divergência Infisical LAB×regra (§1.2); 62 testes não re-executados.

---

## 12. Plano de implementação

Dependências robustas (outbox **antes** de qualquer escrita; leitor real **antes** de trial; **toda escrita só após readback conclusivo demonstrado + dispatch durável provado**; cálculos só com autorização e sem presumir pureza):

| Fase | Escopo | Pré-requisito | Saída |
|---|---|---|---|
| 0. Pin + matriz | painel 3.93, conta segura, `adapter_version`, matriz por capability | Este relatório | Casos predeclared (conta/versão/carga) |
| 1. Leitor real | R1–R4/R6–R7 + `READ_CREDIT_BALANCE/STATUS/CONNECTIONS` em conta segura | Fase 0 | Snapshots; base para `SANDBOX_CERTIFIED` (read) |
| 2. Dispatch durável | outbox + worker + attempt pré-send + lease + readback | Fase 0 | Crash antes/depois demonstrados com `UNKNOWN` correto; **sem esta fase, nenhuma escrita real (W0-10 segue rejeitado)** |
| 3. Trial | W1 (1h/3h/6h) + elegibilidade interna antes da porta | Fases 1–2 + M3 | Credenciais/janela + readback |
| 4. Sync/readback | W7 + readers (`readCustomer/balance/live`) | Fases 1–2 | `conclusive:true` demonstrado |
| 5. Renew/migrate/connections | W2/W6/W5 em conta segura | Fases 1–2 (+ M6 futuro) | Expiry/conexões/binding verificados |
| 6. Block/unblock/trust | W4 (readback prévio obrigatório) + W3 (+3d exatos) | Fases 1–2 | Estado = intenção; trust exatamente +3d |
| 7. Playlist/credentials | R8 + W9-candidato sem vazar segredo (sem alegar rotação) | Fases 1–2 | Snapshot observado; efeitos W9 seguem UNKNOWN |
| 8. Calculations | R10 **só após autorização de teste; sem assumir POST puro pelo nome** | Fases 1–2 + autorização | `credits_required`/breakdown + unidade fechada |
| 9. Destrutivas por último | W8 e mass-delete/move, HITL, default `DISABLED` | Fases 1–2 + gate humano | Escopo + rollback provados |
| 10. Reseller (se ativada) | S1–S5 após assinatura + OpenAPI + M2M | Ativação comercial | Auth/scopes/HMAC/retry/TTL provados |
| 11. Canary→certify | estágio canary (processo) → `CERTIFIED` (+limitações) | Todas as provas | Métricas + fallback + gatilho de recertificação |

Promoção por capability (matriz completa, dono nomeado, limitações/fallback registrados; lab ≠ cliente real; canary ≠ escala). Drift/402-403 inesperado → `DEGRADED` + `HUMAN_REQUIRED` + re-pin. Nenhum runtime/config/migration/teste foi alterado por este relatório.

---

## Apêndice A — Fichas por operação (18 campos)

Perfil SPA herdado: base origin + `/api`; headers `Authorization: Bearer + Accept: application/json + Locale/Accept-Language + X-App-Version: 3.93`; envelope estilo Laravel `{data, links, meta}` (**INFERRED**); erros §6.1. Perfil Reseller herdado: base `…/api/reseller-api/v1`; auth M2M `unknown`; HMAC/retry/TTL `unknown`.

### A.1 Leituras SPA

#### Ficha R1 — `READ_IDENTITY` (`GET auth/me`)

- `semantic_operation`: `READ_IDENTITY`
- `HTTP method`: `GET`
- `endpoint`: `/api/auth/me`
- `authentication`: Bearer sessão SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: nenhum
- `response schema`: `{id, username, name, status, credits: number, permissions: string[], role, token: string, …}` (tipos; `token` = segredo)
- `error responses`: `SESSION_EXPIRED` (401); `PERMISSION_DENIED` (403 JSON); `CHALLENGE`/`HTTP_FAILURE` (403/404 HTML por condição, ver §6)
- `required permissions`: sessão válida
- `preconditions`: login confirmado pelo operador; token em memória
- `observable postcondition`: perfil + `permissions[]` + `role`
- `idempotency behavior`: idempotente
- `duplicate behavior`: sem efeito
- `retry safety`: seguro (sem acoplar `refresh-token` sem necessidade)
- `provider-side effects`: nenhum
- `confidence`: `OBSERVED`
- `source/evidence`: `live` (200 hoje, browser) + `frontend` (`ApiService-OzZHLOn3.js`) + `historical` (doc 19/09 §3–§4)

#### Ficha R1b — `READ_CREDIT_BALANCE` (campo `credits` de `/api/auth/me`)

- `semantic_operation`: `READ_CREDIT_BALANCE`
- `HTTP method`: `GET`
- `endpoint`: `/api/auth/me` (campo `credits`)
- `authentication`: Bearer sessão SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: nenhum
- `response schema`: `{credits: number}` (unidade/precisão `unknown`)
- `error responses`: mesmos de R1
- `required permissions`: sessão válida
- `preconditions`: sessão
- `observable postcondition`: saldo number observado (**não** é crédito certificado para cobrança)
- `idempotency behavior`: idempotente
- `duplicate behavior`: sem efeito
- `retry safety`: seguro
- `provider-side effects`: nenhum
- `confidence`: `OBSERVED`
- `source/evidence`: `live` (saldo number hoje) — **crédito incluído explicitamente, sem omitir**

#### Ficha R2 — `LIST_CUSTOMERS` (`GET customers`)

- `semantic_operation`: `LIST_CUSTOMERS`
- `HTTP method`: `GET`
- `endpoint`: `/api/customers`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: `perPage, page, username, userId, serverId, packageId, expiryFrom/To, createdFrom/To, status, isTrial, connections, orderBy, orderDirection`
- `request body/schema`: nenhum
- `response schema`: `{data: Customer[], links, meta{current_page, last_page, per_page, total}}`
- `error responses`: `PERMISSION_DENIED` (403 JSON); `SESSION_EXPIRED` (401)
- `required permissions`: sessão (leitura OK live)
- `preconditions`: sessão + paginação explícita
- `observable postcondition`: página + `meta`
- `idempotency behavior`: idempotente
- `duplicate behavior`: sem efeito
- `retry safety`: seguro
- `provider-side effects`: nenhum
- `confidence`: `OBSERVED`
- `source/evidence`: `live` (`perPage=1` hoje) + `frontend` (params, `customer-BPdT3J4I.js`) + `historical`

#### Ficha R3 — `READ_CUSTOMER` (`GET customers/{id}`) + derivadas

- `semantic_operation`: `READ_CUSTOMER` (+ `READ_CUSTOMER_STATUS`, `READ_CONNECTIONS` via campos)
- `HTTP method`: `GET`
- `endpoint`: `/api/customers/{id}`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: nenhum
- `response schema`: `{data: Customer}` — `data` **é** o objeto Customer (não existe campo `data.customer`) — com `id/user_id/server_id/package_id: string`, `status: string`, `is_trial: STRING`, `connections: number`, `has_multiple_connections: boolean`, `expires_at: string`, `plan_price: number`, demais PII/playlist nulos **nesta amostra**, `whatsapp` com mascaramento do nosso script (amostra, não schema; sem alegar masking global pelo provider)
- `error responses`: `SESSION_EXPIRED`/`PERMISSION_DENIED`/`BAD_RESPONSE` (404/HTML por condição)
- `required permissions`: sessão
- `preconditions`: `id` da própria conta
- `observable postcondition`: `data: Customer` tipado; `READ_CUSTOMER_STATUS` (`status/expires_at/is_trial`) e `READ_CONNECTIONS` (`connections/has_multiple_connections`) derivados sem endpoint próprio
- `idempotency behavior`: idempotente
- `duplicate behavior`: sem efeito
- `retry safety`: seguro
- `provider-side effects`: nenhum
- `confidence`: `OBSERVED`
- `source/evidence`: `live` (200 hoje) + `frontend` + `historical`

#### Ficha R4 — `LIST_SERVERS` (`GET servers`)

- `semantic_operation`: `LIST_SERVERS`
- `HTTP method`: `GET`
- `endpoint`: `/api/servers`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: `unknown` (nenhum confirmado)
- `request body/schema`: nenhum
- `response schema`: `{data: Server[], links, meta}` (notação de tipo)
- `error responses`: `SESSION_EXPIRED`/`PERMISSION_DENIED`
- `required permissions`: `view server` (`historical`)
- `preconditions`: sessão
- `observable postcondition`: lista + meta
- `idempotency behavior`: idempotente
- `duplicate behavior`: sem efeito
- `retry safety`: seguro
- `provider-side effects`: nenhum
- `confidence`: `OBSERVED`
- `source/evidence`: `live` (200) + `frontend` (`server-DLt7mB8X.js`) + `historical`

#### Ficha R5 — `READ_SERVER_STATUS` (live) + detail/packages/bouquets (não retestados)

- `semantic_operation`: `READ_SERVER_STATUS` (+ `READ_SERVER` detail/auxiliares)
- `HTTP method`: `GET`
- `endpoint`: `/api/servers/status` (live) + `/api/servers/{id}`, `/api/servers/packages/{id}`, `/api/servers/bouquets/{id}[/true]` (forma JS, não retestados)
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: sufixo `/true` em bouquets (semântica `unknown`)
- `request body/schema`: nenhum
- `response schema`: `servers/status`: `data` array, item com `name: string` (whitelist — outros campos omitidos, sem inferir completo); detail/packages/bouquets: `unknown`
- `error responses`: `SESSION_EXPIRED`/`PERMISSION_DENIED` (esperados nos não retestados)
- `required permissions`: `view server` e afins (`historical`)
- `preconditions`: sessão (+ `serverId` nos auxiliares)
- `observable postcondition`: status observado live; demais snapshots a provar
- `idempotency behavior`: idempotente (leitura)
- `duplicate behavior`: sem efeito
- `retry safety`: seguro (leitura)
- `provider-side effects`: nenhum
- `confidence`: `OBSERVED`
- `source/evidence`: `live` (200 em `servers/status`) + `frontend` (`server-DLt7mB8X.js` p/ demais) + `historical`; detail/packages/bouquets runtime `UNCONFIRMED`

#### Ficha R6 — `LIST_PACKAGE_PRICES` (`GET packages/price`)

- `semantic_operation`: `LIST_PACKAGE_PRICES`
- `HTTP method`: `GET`
- `endpoint`: `/api/packages/price`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: `unknown` (`/{id}` em detalhe JS)
- `request body/schema`: nenhum
- `response schema`: `{data: Price[], links, meta}`; campos `historical` `{id, server_id, name, status, is_trial, plan_price, my_plan_price, credits, duration, duration_in}`; unidade `plan_price` `unknown`
- `error responses`: `SESSION_EXPIRED`/`PERMISSION_DENIED` (`/api/packages` sem `/price` = 403 admin histórico)
- `required permissions`: `access reseller pages` (`historical`)
- `preconditions`: sessão
- `observable postcondition`: tabela + meta
- `idempotency behavior`: idempotente
- `duplicate behavior`: sem efeito
- `retry safety`: seguro
- `provider-side effects`: nenhum
- `confidence`: `OBSERVED`
- `source/evidence`: `live` (200) + `frontend` (`package-DbaTjTbR.js`) + `historical`

#### Ficha R7 — `LIST_INTEGRATIONS` (`GET integrations`)

- `semantic_operation`: `LIST_INTEGRATIONS`
- `HTTP method`: `GET`
- `endpoint`: `/api/integrations`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: nenhum
- `response schema`: `{data: Integration[], warning/cta}`; amostra toda inativa; `webhookUrl` ausente; segunda leitura com `resellerEntryPresent=false` para `id=reseller-api`, `raw.sections` ausentes (endpoint `generate-token` segue `unknown`; sem conclusão comercial — namespace pode variar)
- `error responses`: `SESSION_EXPIRED`/`PERMISSION_DENIED`
- `required permissions`: sessão
- `preconditions`: sessão
- `observable postcondition`: catálogo + flags
- `idempotency behavior`: idempotente
- `duplicate behavior`: sem efeito
- `retry safety`: seguro
- `provider-side effects`: nenhum
- `confidence`: `OBSERVED`
- `source/evidence`: `live` (200, ×2) + `frontend` (`integrations-Dpvoeg50.js`) + `historical`

#### Ficha R8 — `READ_PLAYLIST` (`GET customers/{id}/playlist`)

- `semantic_operation`: `READ_PLAYLIST`
- `HTTP method`: `GET`
- `endpoint`: `/api/customers/{id}/playlist`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: `unknown`
- `request body/schema`: nenhum
- `response schema`: `unknown` (não executado)
- `error responses`: `unknown`
- `required permissions`: `unknown`
- `preconditions`: sessão + customer próprio
- `observable postcondition`: playlist/bouquets/M3U (a provar)
- `idempotency behavior`: idempotente em teoria; a provar
- `duplicate behavior`: `unknown`
- `retry safety`: leitura presumida segura; confirmar sem efeito
- `provider-side effects`: presumido nenhum; runtime `UNCONFIRMED`
- `confidence`: `UNCONFIRMED`
- `source/evidence`: `frontend` (`customer-BPdT3J4I.js`); runtime `UNCONFIRMED`

#### Ficha R9 — `READ_LIVE_CONNECTIONS` (sessões, live)

- `semantic_operation`: `READ_LIVE_CONNECTIONS` (sessões live — distinto de `READ_CONNECTIONS`/allowance da ficha R3)
- `HTTP method`: `GET`
- `endpoint`: `/api/customers/live-connections/{serverId}?perPage=1`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: `perPage=1` (observado; demais `unknown`)
- `request body/schema`: nenhum
- `response schema`: `data[]` com item `{id: string, user_username: string, max_connections: number, reseller_username: string, stream_display_name: string, user_agent: string, date_start_timestamp: number}` (tipos da amostra, **nenhum valor emitido**) + `meta {current_page, from, last_page, per_page, to, total: numbers}`
- `error responses`: `SESSION_EXPIRED`/`PERMISSION_DENIED` (esperados)
- `required permissions`: `see live connections` (`historical`)
- `preconditions`: sessão + `serverId`
- `observable postcondition`: snapshot de sessões (observado; não certificado)
- `idempotency behavior`: idempotente
- `duplicate behavior`: sem efeito
- `retry safety`: seguro (leitura)
- `provider-side effects`: nenhum
- `confidence`: `OBSERVED`
- `source/evidence`: `live` (200 hoje, `API_IN_BROWSER`) + `frontend` (forma) + `historical` (permissão)

#### Ficha R10 — `CALCULATE_*` (`POST …/calculate-*`)

- `semantic_operation`: `CALCULATE_*`
- `HTTP method`: `POST`
- `endpoint`: `/api/customers/calculate-plan-price`, `/api/customers/calculate-customer-credits`, `/api/customers/{id}/calculate-connection-credits`, `/api/customers/{id}/calculate-renew-credits`, `/api/customers/calculate-expiry-date-credits`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{server_id, package_id, connections, plan_price, customer_id?, expiry_date}` por variante (required `unknown`)
- `response schema`: `{credits_required, breakdown}` esperado em JS, sem prova live
- `error responses`: `unknown`
- `required permissions`: `unknown`
- `preconditions`: sessão + ids válidos + **autorização de teste** (nome POST não prova pureza)
- `observable postcondition`: estimativa (a provar que não muta)
- `idempotency behavior`: `unknown` — tratar como mutação potencial
- `duplicate behavior`: `unknown`
- `retry safety`: sem retry automático em fluxo de cobrança
- `provider-side effects`: presumido nenhum; runtime `UNCONFIRMED`
- `confidence`: `UNCONFIRMED`
- `source/evidence`: `frontend` (`customer-BPdT3J4I.js`); runtime `UNCONFIRMED`; **live não executado**

### A.2 Escritas SPA (forma `FRONTEND`; runtime `UNCONFIRMED` — nenhuma mutação executada)

#### Ficha W1 — `CREATE_CUSTOMER` / `CREATE_TRIAL` (`POST customers`)

- `semantic_operation`: `CREATE_CUSTOMER` / `CREATE_TRIAL`
- `HTTP method`: `POST`
- `endpoint`: `/api/customers`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{server_id, package_id, trial_hours, connections, username, password, reservation_token?, bouquets, expires_at_tz, plan_price, contacts}` (required `unknown`; 1/3/6h em docs)
- `response schema`: `unknown`
- `error responses`: `unknown` (`RATE_LIMITED`/trial-blocker a provar)
- `required permissions`: `create customer` (`historical`)
- `preconditions`: elegibilidade interna de Trial antes da porta; servidor/pacote válidos
- `observable postcondition`: `READ_CUSTOMER` re-lê + credenciais/janela (a provar)
- `idempotency behavior`: `unknown` — exigir idempotency-key do adapter
- `duplicate behavior`: `unknown`
- `retry safety`: inseguro até `KNOWN_NOT_APPLIED` conclusivo
- `provider-side effects`: criação + consumo de créditos (a provar)
- `confidence`: `OBSERVED`
- `source/evidence`: `frontend` (`CustomersAdd-DxcjWNce.js`) + `historical`; **forma FRONTEND; runtime UNCONFIRMED**

#### Ficha W2 — `RENEW_CUSTOMER` (`POST customers/{id}/renew`)

- `semantic_operation`: `RENEW_CUSTOMER` (nossa renovação de assinatura usa `subscription.renew` + `subscription.provision` no repo; este endpoint é o fulfillment do provider)
- `HTTP method`: `POST`
- `endpoint`: `/api/customers/{id}/renew`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{package_id, connections, …i}` (`i`: `reference/create_manual_customer_order/manual_payment_total`; required `unknown`)
- `response schema`: `unknown`
- `error responses`: `unknown`
- `required permissions`: `unknown` (rota histórica `create customer`)
- `preconditions`: customer próprio + pacote/conexões válidos
- `observable postcondition`: expiry/entitlement reflete período (a provar)
- `idempotency behavior`: `unknown`
- `duplicate behavior`: `unknown` (duplo renew = risco financeiro)
- `retry safety`: inseguro até prova
- `provider-side effects`: extensão + créditos (a provar)
- `confidence`: `OBSERVED`
- `source/evidence`: `frontend` (`RenewModal-ByjzDfqI.js`); **forma FRONTEND; runtime UNCONFIRMED**

#### Ficha W3 — `TRUST_RENEWAL` (`POST …/add-courtesy-days`)

- `semantic_operation`: `TRUST_RENEWAL`
- `HTTP method`: `POST`
- `endpoint`: `/api/customers/{id}/add-courtesy-days`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{}` (texto "+3 dias grátis every30days")
- `response schema`: `unknown`
- `error responses`: `unknown` (elegibilidade `ACTIVE ≤3d` válida por piloto)
- `required permissions`: `unknown`
- `preconditions`: `ACTIVE` + `≤3 dias restantes`
- `observable postcondition`: expiry +3 dias exatos (a provar)
- `idempotency behavior`: `unknown`
- `duplicate behavior`: `unknown`
- `retry safety`: inseguro até prova
- `provider-side effects`: extensão de cortesia (mapeamento inferido; "30d" só UI)
- `confidence`: `INFERRED`
- `source/evidence`: `frontend` (`AddCourtesyDaysModal-DfYdoqur.js`) + regra piloto (`cinevision.md`); **mapeamento INFERRED; runtime UNCONFIRMED**

#### Ficha W4 — `BLOCK` / `UNBLOCK` (`PUT …/toggle-status`)

- `semantic_operation`: `BLOCK_CUSTOMER` / `UNBLOCK_CUSTOMER`
- `HTTP method`: `PUT`
- `endpoint`: `/api/customers/{id}/toggle-status`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{}` (vazio; target não observado)
- `response schema`: `unknown`
- `error responses`: `unknown`
- `required permissions`: `block/unblock customers` (`historical`)
- `preconditions`: estado atual lido (obrigatório por precaução)
- `observable postcondition`: estado = intenção (a provar)
- `idempotency behavior`: `unknown` (runtime; risco de não-idempotência é `INFERRED` de nome/body "toggle" + `{}` — não fato de backend)
- `duplicate behavior`: `unknown` (runtime; inversão em duplicata é risco `INFERRED`, não comportamento provado)
- `retry safety`: proibido sem readback prévio (blocker mantido por precaução, independente de fato)
- `provider-side effects`: suspensão/restauração (a provar)
- `confidence`: `OBSERVED`
- `source/evidence`: `frontend` literal (`customer-BPdT3J4I.js`); **forma FRONTEND; backend/idempotência/duplicata runtime UNCONFIRMED**

#### Ficha W5 — `CHANGE_CONNECTIONS` (`POST …/change-connections`)

- `semantic_operation`: `CHANGE_CONNECTIONS`
- `HTTP method`: `POST`
- `endpoint`: `/api/customers/{id}/change-connections`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{package_id, connections}` (required `unknown`)
- `response schema`: `unknown`
- `error responses`: `unknown`
- `required permissions`: `unknown` (`charge credits for extra connections` histórico)
- `preconditions`: pacote com conexões; aviso comercial (herda expiração; sem remoção pro-rata)
- `observable postcondition`: quantidade = solicitada (a provar)
- `idempotency behavior`: `unknown`
- `duplicate behavior`: `unknown`
- `retry safety`: inseguro até prova
- `provider-side effects`: recorrente por ciclo (a provar)
- `confidence`: `OBSERVED`
- `source/evidence`: `frontend`; **forma FRONTEND; runtime UNCONFIRMED**

#### Ficha W6 — `MIGRATE_SERVER` (`PUT …/server-migration`)

- `semantic_operation`: `MIGRATE_SERVER`
- `HTTP method`: `PUT`
- `endpoint`: `/api/customers/{id}/server-migration`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{server_id, package_id}` (claim "sem créditos" não prova)
- `response schema`: `unknown`
- `error responses`: `unknown`
- `required permissions`: `migrate server` (`historical`)
- `preconditions`: binding atual + target válido
- `observable postcondition`: binding = target + serviço válido (a provar)
- `idempotency behavior`: `unknown`
- `duplicate behavior`: `unknown`
- `retry safety`: inseguro até prova
- `provider-side effects`: migração + possível custo (a provar)
- `confidence`: `OBSERVED`
- `source/evidence`: `frontend` (`MigrateServerModal-CWhJ_8Zx.js`); **forma FRONTEND; runtime UNCONFIRMED**

#### Ficha W7 — `SYNC_CUSTOMER` (`POST …/resync`)

- `semantic_operation`: `SYNC_CUSTOMER`
- `HTTP method`: `POST`
- `endpoint`: `/api/customers/{id}/resync`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{}` (forma JS)
- `response schema`: `unknown`
- `error responses`: `unknown`
- `required permissions`: `unknown`
- `preconditions`: customer válido
- `observable postcondition`: representação atualiza e é re-lida (a provar)
- `idempotency behavior`: presumido seguro; `UNCONFIRMED`
- `duplicate behavior`: `unknown`
- `retry safety`: exige readback mesmo assim
- `provider-side effects`: refresh (a provar)
- `confidence`: `OBSERVED`
- `source/evidence`: `frontend`; **forma FRONTEND; runtime UNCONFIRMED**

#### Ficha W8 — `CHANGE_PACKAGE` (inventário perigoso)

- `semantic_operation`: `CHANGE_PACKAGE` (fora do port; inventário, não recomendação)
- `HTTP method`: `POST`
- `endpoint`: `/api/customers/{id}/change-package`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{package_id}` (required `unknown`)
- `response schema`: `unknown`
- `error responses`: `unknown`
- `required permissions`: `unknown`
- `preconditions`: HITL + conta controlada (UI alega "delete all servers")
- `observable postcondition`: pacote = target sem perda (a provar)
- `idempotency behavior`: `unknown`
- `duplicate behavior`: `unknown`
- `retry safety`: proibido retry até prova + gate
- `provider-side effects`: destrutivo alegado (a provar)
- `confidence`: `OBSERVED`
- `source/evidence`: `frontend`; **forma FRONTEND; runtime UNCONFIRMED; default DISABLED**

#### Ficha W9 — `GENERATE_CREDENTIAL` (`POST customers/generate-credential`, candidato)

- `semantic_operation`: `GENERATE_CREDENTIAL` (candidato — endpoint sem `{id}` de customer e body só `{server_id, field}`; **não mapear `FETCH_CREDENTIALS`, rotação ou invalidação**: nada disso foi observado)
- `HTTP method`: `POST`
- `endpoint`: `/api/customers/generate-credential`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{server_id, field}` (required `unknown`)
- `response schema`: `unknown` (tratar como segredo se um dia observado)
- `error responses`: `unknown`
- `required permissions`: `unknown`
- `preconditions`: `unknown` (servidor/campo válidos presumidos, sem prova)
- `observable postcondition`: `unknown` (a provar; sem afirmação de credencial nova/rotacionada)
- `idempotency behavior`: `unknown` (runtime)
- `duplicate behavior`: `unknown` (runtime)
- `retry safety`: proibido (precaução, independente de fato — efeito desconhecido)
- `provider-side effects`: `unknown` (runtime)
- `confidence`: `OBSERVED`
- `source/evidence`: `frontend`; **forma FRONTEND literal; runtime UNCONFIRMED em todos os campos de efeito**

#### Ficha W10 — `SEND_BOTBOT` (`PUT customers/{id}/send-botbot`)

- `semantic_operation`: `SEND_BOTBOT_MESSAGE` (auxiliar; fora do port canônico)
- `HTTP method`: `PUT`
- `endpoint`: `/api/customers/{id}/send-botbot`
- `authentication`: Bearer SPA (herdado)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{name, whatsapp}` (required `unknown`)
- `response schema`: `unknown`
- `error responses`: `unknown`
- `required permissions`: `unknown` (BotBot configurado)
- `preconditions`: BotBot ativo + contato válido
- `observable postcondition`: mensagem enfileirada/entregue (via logs; a provar)
- `idempotency behavior`: `unknown`
- `duplicate behavior`: `unknown` (risco de spam)
- `retry safety`: inseguro (efeito mensageiro externo)
- `provider-side effects`: envio WhatsApp (alegado)
- `confidence`: `OBSERVED`
- `source/evidence`: `frontend`; **forma FRONTEND; runtime UNCONFIRMED**

### A.3 Reseller (integração inativa — tudo `UNCONFIRMED`)

#### Ficha S1 — `RESELLER_SELF` (`GET reseller-api/v1/me`)

- `semantic_operation`: `RESELLER_SELF`
- `HTTP method`: `GET`
- `endpoint`: `/api/reseller-api/v1/me`
- `authentication`: `unknown` (M2M formal `UNCONFIRMED`)
- `required headers`: `unknown`
- `query parameters`: nenhum
- `request body/schema`: nenhum
- `response schema`: `unknown`
- `error responses`: `INTEGRATION_INACTIVE` (402 no OpenAPI)
- `required permissions`: ativação paga
- `preconditions`: integração ativa (falso hoje)
- `observable postcondition`: perfil reseller (a provar)
- `idempotency behavior`: leitura (presumido)
- `duplicate behavior`: sem efeito (presumido)
- `retry safety`: não sondar contra 402 repetidamente
- `provider-side effects`: nenhum
- `confidence`: `UNCONFIRMED`
- `source/evidence`: `frontend` (`resellerApi-DoKFwzcJ.js`) + `live` (402 no OpenAPI); parado no 402

#### Ficha S2 — `RESELLER_WEBHOOKS` (CRUD + rotate)

- `semantic_operation`: `RESELLER_WEBHOOKS`
- `HTTP method`: `GET, POST, PUT, DELETE` + `POST rotate-secret {}`
- `endpoint`: `/api/reseller-api/v1/me/webhooks`, `/api/reseller-api/v1/me/webhooks/{id}`, `…/rotate-secret`
- `authentication`: `unknown`
- `required headers`: `unknown`
- `query parameters`: nenhum no CRUD
- `request body/schema`: `{url, events, active}` (required `unknown`); rotate `{}`
- `response schema`: `{id, url, events, active, consecutive_failures, paused_at, created_at}` + secret uma vez (esperado JS)
- `error responses`: `INTEGRATION_INACTIVE`; validação de URL só-frontend
- `required permissions`: integração ativa
- `preconditions`: integração ativa + URL HTTPS própria
- `observable postcondition`: webhook persistido + secret uma vez (a provar)
- `idempotency behavior`: `unknown` (rotate: retry proibido por precaução)
- `duplicate behavior`: `unknown`
- `retry safety`: leitura OK; `POST/rotate` inseguros até prova
- `provider-side effects`: `unknown` (registro/rotação alegados em JS; runtime `UNCONFIRMED`)
- `confidence`: `UNCONFIRMED`
- `source/evidence`: `frontend` (`resellerApi-DoKFwzcJ.js`, `WebhookSecretShownOnceModal`); não retestado além do 402

#### Ficha S3 — `RESELLER_DELIVERIES` (`GET …/deliveries`)

- `semantic_operation`: `RESELLER_DELIVERIES`
- `HTTP method`: `GET`
- `endpoint`: `/api/reseller-api/v1/me/webhooks/{id}/deliveries`
- `authentication`: `unknown`
- `required headers`: `unknown`
- `query parameters`: `page, per_page, status` (forma JS)
- `request body/schema`: nenhum
- `response schema`: `{id, webhook_id, event, attempt, http_status, response_excerpt, latency_ms, status, timestamps, payload}` (esperado JS)
- `error responses`: `INTEGRATION_INACTIVE`; estados só-JS
- `required permissions`: integração ativa
- `preconditions`: webhook existente
- `observable postcondition`: lista (a provar)
- `idempotency behavior`: leitura
- `duplicate behavior`: sem efeito
- `retry safety`: seguro como leitura (após ativação)
- `provider-side effects`: nenhum
- `confidence`: `UNCONFIRMED`
- `source/evidence`: `frontend`; runtime `UNCONFIRMED`

#### Ficha S4 — `RESELLER_SUBSCRIPTION`

- `semantic_operation`: `RESELLER_SUBSCRIPTION`
- `HTTP method`: `GET, GET, POST`
- `endpoint`: `/api/integrations/resellerApi`, `…/current-subscription`, `…/subscribe`
- `authentication`: sessão p/ gestão (provável; `UNCONFIRMED`)
- `required headers`: `unknown`
- `query parameters`: nenhum
- `request body/schema`: `{success_url, cancel_url}` (required `unknown`)
- `response schema`: `unknown` (`expires_at: null` no 402)
- `error responses`: `INTEGRATION_INACTIVE`
- `required permissions`: sessão + pagamento/ativação
- `preconditions`: permissão de compra; URLs de retorno
- `observable postcondition`: assinatura ativa + OpenAPI 200 (nenhuma compra executada)
- `idempotency behavior`: `unknown`
- `duplicate behavior`: `unknown` (cobrança dupla)
- `retry safety`: proibido sem gate comercial
- `provider-side effects`: cobrança/ativação (alegado)
- `confidence`: `UNCONFIRMED`
- `source/evidence`: `frontend` + `live` (402)

#### Ficha S5 — `RESELLER_TOKEN` (`generate-token`)

- `semantic_operation`: `RESELLER_TOKEN`
- `HTTP method`: `unknown` (ação dinâmica; via `/integrations/{id}/actions` ou endpoint de servidor — não adivinhar)
- `endpoint`: `unknown` (depende de `raw.sections`)
- `authentication`: sessão (gestão); resultado "full access…shown once" (texto UI)
- `required headers`: `unknown`
- `query parameters`: `unknown`
- `request body/schema`: `unknown`
- `response schema`: token uma vez (formato `unknown`; segredo)
- `error responses`: `unknown`
- `required permissions`: integração ativa (presumido)
- `preconditions`: integração ativa + HITL
- `observable postcondition`: token no cofre, nunca em log (a provar)
- `idempotency behavior`: `unknown` (retry proibido por precaução)
- `duplicate behavior`: invalidação anterior `unknown`
- `retry safety`: proibido retry (precaução)
- `provider-side effects`: `unknown` (emissão alegada em texto UI; runtime `UNCONFIRMED`)
- `confidence`: `UNCONFIRMED`
- `source/evidence`: `frontend` (texto); runtime `UNCONFIRMED`; sem scopes formais

### A.4 Auxiliares (inventário)

#### Ficha X1 — `CHECKOUT_*`

- `semantic_operation`: `CHECKOUT_*`
- `HTTP method`: `GET, POST, GET`
- `endpoint`: `/api/checkout/{domainId}/{customerId}/plan-details`, `/api/checkout/{domainId}/{customerId}/renew`, `/api/payment-check/{orderId}`
- `authentication`: nenhuma (público; `promocode?` opcional)
- `required headers`: `unknown`
- `query parameters`: `promocode?`
- `request body/schema`: `{package_id, promocode, contacts/payment, meta_tracking_context}` (required `unknown`)
- `response schema`: `unknown` (poll 5s)
- `error responses`: `unknown`
- `required permissions`: nenhuma (link `renew_url`)
- `preconditions`: link válido
- `observable postcondition`: pedido/pagamento + confirmação (`INFERRED`; a provar)
- `idempotency behavior`: `unknown`
- `duplicate behavior`: `unknown` (cobrança dupla)
- `retry safety`: inseguro até prova
- `provider-side effects`: pagamento no backend + callbacks (`INFERRED`)
- `confidence`: `UNCONFIRMED`
- `source/evidence`: `frontend` (`checkout-DmWi7OV0.js`); webhook exato `UNCONFIRMED`

#### Ficha X2 — BotBot/ChatBot

- `semantic_operation`: `SEND_BOTBOT_MESSAGE` (ver W10) + logs/trigger
- `HTTP method`: `PUT` (send) + `GET` (logs) + trigger `chatbot/{userId}/{packageId}` (**não chamar**)
- `endpoint`: `/api/customers/{id}/send-botbot`, `/api/botbot/logs`, `origin/api/chatbot/{userId}/{packageId}`
- `authentication`: Bearer SPA (send/logs); trigger `unknown`
- `required headers`: herdado SPA (send/logs)
- `query parameters`: `type=customer|reseller` (logs)
- `request body/schema`: `{name, whatsapp}` (send)
- `response schema`: `unknown`
- `error responses`: `unknown`
- `required permissions`: BotBot configurado
- `preconditions`: BotBot ativo
- `observable postcondition`: mensagem/logs (a provar)
- `idempotency behavior`: `unknown`
- `duplicate behavior`: `unknown`
- `retry safety`: inseguro onde há efeito
- `provider-side effects`: envio (alegado); terceiro `INFERRED`, nunca sondado
- `confidence`: `UNCONFIRMED`
- `source/evidence`: `frontend` + `historical` (§6.12 doc 19/09)

#### Ficha X3 — gateways (`PUT integrations/{id}`)

- `semantic_operation`: `CONFIGURE_GATEWAY` (config do revendedor no painel deles)
- `HTTP method`: `PUT`
- `endpoint`: `/api/integrations/{id}`
- `authentication`: Bearer SPA (presumido; efeito `UNCONFIRMED`)
- `required headers`: herdado SPA
- `query parameters`: nenhum
- `request body/schema`: `{user_config: {…por gateway…}}` (required `unknown`; sem valores reais)
- `response schema`: `unknown`
- `error responses`: `unknown`
- `required permissions`: sessão (presumido)
- `preconditions`: credencial válida no cofre
- `observable postcondition`: `is_active` + cobrança de teste (nunca dinheiro real sem gate M4/M5)
- `idempotency behavior`: `unknown`
- `duplicate behavior`: `unknown`
- `retry safety`: inseguro (credencial + dinheiro)
- `provider-side effects`: configuração + potencial cobrança (alegado)
- `confidence`: `UNCONFIRMED`
- `source/evidence`: `live` (catálogo inativo) + `frontend`; runtime `UNCONFIRMED`

---

## Apêndice B — Correção da heurística de challenge

Detector amplo marcou "challenge" por `challenge-platform`; metadados normais corrigiram (`cfChl: false`, `challengeForm: false`, `title: NOT_FOUND`, `generic404: true`) → `HTTP_FAILURE`. Script CF isolado não prova bloqueio; interstitial W0-09 (403 HTML) vale **naquela condição**. Runbooks devem exigir `cfChl/challengeForm`/interstitial observável antes de `CHALLENGE_DETECTED`.

## Apêndice C — Fontes, limitações, ownership

- Assets por URL + sufixo build (não SHA), sem bundle no repo, sem segredos/valores; auth nunca logado.
- Limites: sem mutação (trial/writes sem execução por pré-requisitos + sem entidade descartável); sem OpenAPI reseller (402 firme; `reseller-api` ausente no catálogo sem conclusão comercial); sem equivalência Node↔browser (2 GETs 404); 62 testes não re-executados; amostras mascaradas, não dados persistidos.
- Orquestração: preflight `DELEGATED` (researcher + repo explorer, Jev advisory); sem subdelegação, sem sondagem, sem compras. **WORKER OWNERSHIP: Planner coleta o complemento live; este worker não faz rede.**
