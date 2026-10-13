# Research — CINEVISION tela customers/edit (snapshot estático)

> Classification: provider evidence snapshot (static-only); NOT canonical business policy, NOT contract.
> Data: 2026-10-13.
> Alvo: `https://cinevision.panelbr.site/#/customers/edit/MeWexK4DnN` (exemplo de id; o documento descreve a tela, não o registro).
> Método: somente evidência estática pública — `index.html` + bundles `/assets/*.js` legíveis sem login — mais o dossier dinâmico de 19/09 (`cinevision-one-panel-evidence-2026-09-19.md`) e as SPECs `docs/04-specs/integrations/cinevision*.md`. Nenhum endpoint autenticado foi chamado, nenhum login foi feito, nenhum tráfego de rede da tela foi capturado.
> Versão observada: **3.94** (header `X-App-Version`; dossier 19/09 documentava 3.92; delta de versão NÃO auditado).
> Aviso de não-contrato: tudo abaixo é `OBSERVED-static` (nome de rota, método+path, nome de campo visível no bundle) ou `UNCONFIRMED-inferência` (intenção aparente do código). Nada foi validado contra tráfego real. Shapes de request/response body são `UNCONFIRMED`. Não usar como contrato de adapter sem a fase CDP dinâmica.
> Sem segredos neste documento. Sem código proprietário reproduzido — só método+path+nomes de campo/rota.
> Adendo FULL-08 (2026-10-13, Apêndice B): tráfego live OBSERVED-live em 7 loads (179 eventos, 30,4 s) — método+path+status por tela; bodies seguem não-capturados; nenhum write executado pelo agente.

## 1. Stack / arquitetura (OBSERVED-static)

- SPA **Vue 3** com **hash router** (todas as rotas `#/...`), título da página `Sigma` (white-label; dossier 19/09: CINEVISION ONE = Sigma Panel da `sigma.vin`).
- `index.html` referencia o bundle principal `/assets/DiTjp0aI.js` + **35 modulepreloads** (build Vite/Rollup em chunks, servido de `/assets/*`).
- Proteção **Cloudflare**: `curl` direto recebe 403 (desafio "Just a moment..."); fetch com UA de browser passa para o conteúdo público. Relevante para automação: bundle público é legível, mas qualquer chamada autenticada exigirá sessão real em browser (ver §8).
- Cliente HTTP **axios** (chunk `CeY9BByU.js`):
  - base `${window.location.origin}/api` (same-origin).
  - `Authorization: Bearer <localStorage.token>`.
  - `Accept: application/json`, `Locale: <localStorage.lang ?? en>`, `Accept-Language: <navigator.languages>`, `X-App-Version: 3.94`.
  - Verbos mapeados: `query`/`get` = GET, `post` = POST, `update`/`put` = PUT, `delete` = DELETE.
- Respostas no padrão **Laravel** (OBSERVED-static, consistente com 19/09): envelope `data`, paginação `data`/`links`/`meta`, erros `message`.
- Stores Pinia por domínio (um chunk cada): customers (`Dnbhmp3h.js`), servers (`CrE1Nx1I.js`), resellers (`xWnoy7s8.js`), auth (login/me/sessões/2FA), settings (`nk8Padb8.js`).

## 2. Auth / sessão (OBSERVED-static nomes de endpoint; comportamento dinâmico pendente)

- Login: `POST auth/login` → token opaco gravado em `localStorage.token` (string pura, sem JSON — confirmado em 19/09; bundle atual mantém a mesma chave).
- Bootstrap do app: `GET auth/me` (perfil + array de permissões + role) e `GET settings/public` (sem auth; feature flags e `version`).
- Sessão: `GET auth/refresh-token`, `POST auth/logout`, `POST auth/impersonate/:id`, `GET auth/active-sessions`, `DELETE auth/active-sessions/:id`.
- Conta: `PUT auth/update`, `auth/update-password`, `auth/update-locale {locale}`, `auth/update-aside-preferences`, `PUT auth/latest-changes`.
- 2FA: `PUT auth/twofactor-enable`, `PUT auth/twofactor-activate`, `PUT auth/twofactor-disable`, `PUT auth/twofactor-send-code` (UNCONFIRMED-inferência: mesma família do 19/09 — app/email/telegram).
- Suporte/recuperação: `POST`/`DELETE auth/support-validation-code`, `POST auth/forgot-password`, `POST auth/reset-password`, `POST auth/register`.
- Membership da revenda: `GET auth/membership-details/:id`, `GET auth/membership-check/:id`, `POST auth/membership-renew`.
- Toda chamada carrega `Authorization: Bearer` + `Locale` + `X-App-Version: 3.94` (§1). Status 401/402/403 documentados em 19/09 (não-autenticado / complemento inativo / `{"message":"Proibido"}`); **não re-observados nesta coleta estática** — pendente CDP.

## 3. Mapa da rota edit + componentes (OBSERVED-static, chunk Dw1ozmUK.js)

| Hash | Nome da rota | Componente (chunk) | Uso aparente |
|---|---|---|---|
| `#/customers/edit/:id` | `apps-customers-edit` | `./BBAUQMjj.js` (CustomersAdd) | tela alvo deste dossier; modo edit quando `route.name = apps-customers-edit` |
| `#/customers/add` | (add) | `./BBAUQMjj.js` (CustomersAdd) | mesmo componente, modo criação |
| `#/customers` | (listing) | `./3rA2ticG.js` | listagem; destino de fallback em erro de load |
| `#/resellers/edit/:id` + `#/resellers/add` | (resellers) | `./rcw7h0Rx.js` | análogo para revendas (fora do escopo, citado p/ contraste) |
| `#/resellers` | (listing) | `./nZ-r9QiE.js` | listagem de revendas |

- Rota edit exige permissão `create customer` no meta do router (mesmo valor documentado em 19/09 para `/customers/edit/:id`; **não revalidado dinamicamente**).
- SmartTV: o componente lê `query.smartTv + customerId` (fluxo de ativação via TV — detalhe dinâmico pendente).
- Aba Audit: o componente referencia `auditable-type=customer` + `params.id` sob gate `view audit trail` (endpoint de auditoria exato pendente CDP; 19/09 cita `GET /api/audit/customers` para a tela de auditoria).

## 4. Catálogo de API relevante à tela (método | path | uso | confiança)

Base `/api`. Paths abaixo de `customers/` salvo indicação. Tudo `OBSERVED-static` (nome visível no store) salvo nota; shapes de body **UNCONFIRMED** em todos os casos.

| Método | Path | Uso na tela edit / entorno | Confiança |
|---|---|---|---|
| GET | `customers/:id` | **load da tela edit** (`load(id)` no mount) | OBSERVED-static + OBSERVED-live (Apêndice B — edit, 200) |
| PUT | `customers/:id` | **save da tela edit** (form inteiro) | OBSERVED-static |
| POST | `customers` | save no modo add (mesmo componente) | OBSERVED-static |
| POST | `customers/generate-credential {server_id, field}` | gerar credencial (campo username/password — qual campo exato pendente) | OBSERVED-static (path+body keys); semântica UNCONFIRMED |
| PUT | `customers/:id/toggle-status {}` | bloquear/desbloquear (ação fora do form; disponível na lista) | OBSERVED-static |
| PUT | `customers/:id/toggle-asn-lock` | trava ASN | OBSERVED-static |
| PUT | `customers/:id/toggle-isp-lock` | trava ISP | OBSERVED-static |
| POST | `customers/:id/resync {}` | resincronizar no servidor | OBSERVED-static |
| POST | `customers/:id/renew {package_id, connections, ...}` | renovar (resto do body UNCONFIRMED) | OBSERVED-static (path+keys citadas); resto UNCONFIRMED |
| POST | `customers/:id/renew-reminder {text}` | lembrete de renovação | OBSERVED-static |
| POST | `customers/:id/change-connections {package_id, connections}` | trocar nº de conexões | OBSERVED-static |
| POST | `customers/:id/change-package {package_id}` | trocar pacote | OBSERVED-static |
| GET | `customers/:id/playlist` | ver playlist/m3u | OBSERVED-static |
| POST | `customers/:id/add-courtesy-days {}` | dias de cortesia | OBSERVED-static |
| DELETE | `customers/:id` | excluir | OBSERVED-static |
| PUT | `customers/:id/server-migration {server_id, package_id}` | migrar de servidor | OBSERVED-static |
| POST | `customers/:id/activate-app {app_server_id, app_package_id}` | ativar app | OBSERVED-static |
| POST | `customers/:id/send-botbot {name, whatsapp}` | envio BotBot | OBSERVED-static |
| POST | `customers/calculate-plan-price {server_id, package_id, connections, plan_price, customer_id?}` | precificação no form | OBSERVED-static + OBSERVED-live (Apêndice B — edit, 200) |
| POST | `customers/calculate-customer-credits {server_id, package_id, connections, expiry_date}` | custo em créditos (criação) | OBSERVED-static + OBSERVED-live (Apêndice B — add, 200) |
| POST | `customers/:id/calculate-expiry-date-credits {expiry_date}` | custo ao editar validade | OBSERVED-static + OBSERVED-live (Apêndice B — edit, 200) |
| POST | `customers/:id/calculate-renew-credits {package_id, connections}` | custo de renovação | OBSERVED-static |
| POST | `customers/:id/calculate-connection-credits {package_id, connections}` | custo de conexões | OBSERVED-static |
| GET | `customers` (params filtro+paginação; `deleted` alterna) | listagem / excluídos | OBSERVED-static + OBSERVED-live (Apêndice B — customers, 200) |
| GET | `customers/expiring` | expirando (dashboard/assistente) | OBSERVED-static |
| GET | `customers/live-connections/:filter` | conexões ao vivo | OBSERVED-static |
| GET | `customers/statistics` (+ `/top10`) | estatísticas | OBSERVED-static |
| POST | `customers/move {resellerIdFrom, resellerIdTo}` | mover entre revendas | OBSERVED-static |
| POST | `customers/mass-delete` | exclusão em massa | OBSERVED-static |
| GET | `customers/export?query` → `{download_url}` | exportar | OBSERVED-static |
| POST | `customers/import/validate` (multipart `csv_file`/`server_id`/`package_id`) | validar importação | OBSERVED-static |
| POST | `customers/import` | importar | OBSERVED-static |
| POST | `customers/restore` | restaurar excluído | OBSERVED-static |

Apoio (stores vizinhos, necessários p/ popular selects da tela):

| Método | Path | Uso | Confiança |
|---|---|---|---|
| GET | `servers` / `servers/:id` | lista e detalhe de servidor | OBSERVED-static |
| GET | `servers/bouquets/:id[/true]` | bouquets por servidor | OBSERVED-static + OBSERVED-live (Apêndice B — edit, 200) |
| GET | `servers/packages/:id` | pacotes por servidor | OBSERVED-static |
| GET | `servers/limit`, `servers/licence`, `servers/status`, `servers/:id/customer-count` | limites/licença/status/contagem | OBSERVED-static |
| GET | `settings/public` | flags (`allow_edit_customers_bouquets`, formatos de username, etc.) | OBSERVED-static + OBSERVED-live (Apêndice B — 7/7 loads, 200) |
| GET | `auth/me` | permissões que abrem/fecham gates da tela (§5) | OBSERVED-static + OBSERVED-live (Apêndice B — 7/7 loads, 200) |
| GET | `resellers/list` | apoio selects/filtros (fora do §4 estático) | OBSERVED-live (Apêndice B — customers, edit, resellers; 200) |
| GET | `resellers` | listagem de revendas (fora do §4 estático) | OBSERVED-live (Apêndice B — resellers; 200) |
| GET | `resellers/roles` | papéis de revenda (fora do §4 estático) | OBSERVED-live (Apêndice B — resellers; 200) |
| GET | `audit/record/customer/:id` | aba Audit do edit (fora do §4 estático; 19/09 citava `audit/customers`) | OBSERVED-live (Apêndice B — edit; 200) |

> Promoções FULL-08 (2026-10-13): os endpoints acima marcados OBSERVED-live foram observados no tráfego do Apêndice B (só método+path+status, sem bodies). Todo o resto do §4 segue OBSERVED-static ou UNCONFIRMED.

## 5. Lógica da tela edit campo-a-campo (OBSERVED-static nomes; regras dinâmicas pendentes)

- **Ciclo de vida**: mount com `params.id` → `GET customers/:id` → preenche form; erro de load volta ao listing (`#/customers`). Save em modo edit = `PUT customers/:id` com o **form inteiro**; modo add = `POST customers`. (Sequência de chamadas e tratamento de erro visual **pendentes de CDP**.)
- **Imutáveis na tela**: `server_id` e `package_id` — a troca acontece fora da tela via Migrate (`server-migration`) / Change (`change-package`) na lista. (UNCONFIRMED-inferência a partir da ausência de escrita desses campos no componente edit; confirmar via DOM.)
- **Campos do form** (nomes OBSERVED-static): `server_id`, `package_id`, `trial_hours`, `connections`, `bouquets`, `mac_address`, `username`, `password` (+ tokens de reserva), `playlist`, `user_id`, `expires_at_tz`, `plan_price`, `name`, `email`, `telegram`, `whatsapp`, `note`, `connection_type` (valores `TV`/`IPTV`/`OTT`/`BILLING`), flags `is_trial`/`is_mag`/`is_migrated`/`is_asnlock`/`is_isplock`/`is_restreamer`, `child_packages`.
- **Gates por permissão/propriedade** (nomes OBSERVED-static; efeito visual exato pendente CDP):
  - `user_id` visível/editável sob gate `edit customer reseller`.
  - `expires_at_tz` sob gate `edit customer expiry date`.
  - `plan_price` sob gate `can edit customer plan price`.
  - `name`/`email`/`telegram`/`whatsapp`/`note` com visibilidade por dono vs `parent_can_edit_personal_data`.
  - aba Audit sob gate `view audit trail`.
- **Regras de credencial** (de `settings/public` + 19/09; aplicação na tela pendente): username numérico, exatamente 9 caracteres para usuário/senha (`username_format`, `minimum/maximum_number_of_characters_username_password`).
- **Cálculos**: os 5 endpoints `calculate-*` (§4) sugerem recálculo de preço/créditos ao mexer em servidor/pacote/conexões/validade — ordem dos triggers e UX **pendentes de CDP**.

## 6. Como plugar no ProviderOpsPort / API_IN_BROWSER

- Estratégia vigente no repo (SPEC `cinevision.md`, `constants.ts`): `provider.cinevision` com gate `UNAVAILABLE → MANUAL`; adapters Echo/Manual; única porta `ProviderOpsPort` (`apps/api/src/provider/provider-port.ts`); leitores GET-only em `apps/browser-worker/src/providers/cinevision/`; `CINEVISION_READ_COMMANDS` com 11 reads; `READ_IDENTITY_PATH = /api/auth/me`; estratégia `API_IN_BROWSER` (fetch in-page same-origin com Bearer de `localStorage.token`, projeção por allowlist).
- O que esta tela acrescenta ao mapa: **candidatos futuros, NÃO certificados** —
  - leitura: `GET customers/:id` espelha `readCustomer` (já certificado como comando CLI); `GET customers/:id/playlist` espelha leitura de playlist/conexões.
  - escrita (todas **fora de escopo** até certificação + credenciais do operador no vault + contrato por operação observado): `PUT customers/:id`, `toggle-status`, `toggle-asn-lock`/`toggle-isp-lock`, `resync`, `renew`, `change-connections`, `change-package`, `server-migration`, `add-courtesy-days`, `send-botbot`, `renew-reminder`, `activate-app`.
- MK Ativador é supplier separado Deferred (ADR-0027), sem relação com esta tela.
- Nenhuma mudança de porta/adapter/contrato é proposta neste dossier (proibido pelo escopo: sem alterar `docs/15-implementation-baseline`, `docs/05-contracts`, `db/migrations`, schemas/ports).

## 7. Limites (o que este dossier NÃO afirma)

- **Sem tráfego real**: nenhum request/response foi capturado; bodies, query params completos, códigos de status, mensagens de erro e paginação da tela edit são UNCONFIRMED.
- **WAF Cloudflare**: bundles públicos são legíveis, mas chamadas autenticadas via `curl`/headless limpo falham no desafio; a fase dinâmica precisa de browser real com sessão do operador.
- **Versão**: delta 3.92 → 3.94 não auditado (changelog do painel em `#/changelog` não lido; endpoint `PUT auth/latest-changes` não chamado).
- **Permissões**: a conta que veria cada gate é desconhecida nesta coleta (sem `auth/me`); efeitos visuais dos gates são inferência.
- **Sem PII**: nenhum dado de cliente real foi acessado; o id `MeWexK4DnN` na URL é tratado como opaco.
- **Nota pós-FULL-08**: o "sem tráfego real" acima refere-se à fase estática; o Apêndice B consolida tráfego live (método+path+status, sem bodies).

## 8. Próximos passos — fase CDP dinâmica (pendente, ato do operador)

Pré-requisito: sessão logada do operador em browser real (as credenciais CINEVISION/MK vivem no cofre do operador via Infisical — nunca neste repo). Sequência sugerida, sem executar nada agora:

1. `list_browser_targets` — confirmar o target da sessão autenticada.
2. `inspect_web_page` em `#/customers/edit/:id` — DOM renderizado, valores, estados disabled/hidden por gate, ordem das abas, modais (Migrate/Change/Renew/Resync).
3. `analyze_web_bundle` — mapear chunk do componente a handlers (save, calculate-*, generate-credential).
4. `observe` (rede) — capturar `GET customers/:id` + `PUT customers/:id` reais: bodies, respostas, erros (422/403/402), triggers dos `calculate-*`, e o endpoint da aba Audit.
5. Promover então, e só então, os itens UNCONFIRMED a contrato observado por operação — pré-requisito para qualquer certificação de escrita (que segue bloqueada até vault do operador + certificação por operação).

Guardrails obrigatórios da fase CDP:

- **Observação GET (segura, read-only)**: `GET customers/:id`, `GET servers*`, `GET settings/public` e `GET auth/me` podem ser observados via `observe` sem mutação — ainda assim sem persistir resposta crua (ver sanitização abaixo).
- **Escrita PUT/POST/DELETE (perigosa, gateada)**: em especial `PUT customers/:id`, SOMENTE com autorização explícita e específica do operador para aquela operação, e sobre cliente de teste descartável criado para a sonda — **nunca sobre o `MeWexK4DnN` real** citado neste dossier. A conta do painel segue a decisão vigente em `docs/15-implementation-baseline/10-integrations-certification.md` (sem conta descartável de painel; canary na conta designada do operador) — este dossier não cria conta nem altera a decisão.
- **Sanitização antes de persistir qualquer evidência**: remover `Authorization`/tokens, cookies, senhas, contatos (`whatsapp`/`email`/`telegram`), URLs de playlist/m3u, tokens de reserva e demais PII; registrar apenas método+path+nomes de campo e shapes normalizados. **Proibido colar valores crus** (headers, bodies, URLs com token) no repo.
- **Caminho de certificação inalterado**: estratégia `API_IN_BROWSER` + porta `ProviderOpsPort` (§6); nenhuma escrita é certificada por este dossier.

## 9. Critérios de promoção UNCONFIRMED→observado e gate de certificação

- Nada neste dossier sai de `UNCONFIRMED-inferência` sem a fase CDP: a promoção exige tráfego real capturado via `observe` em sessão do operador (método+path do request, status, envelope da resposta e — para writes — readback), com evidência sanitizada registrada e datada.
- Gate de referência: `docs/15-implementation-baseline/10-integrations-certification.md` — Step 3 (sonda do contrato real de escrita em sessão manual operada por humano), cleanup obrigatório da sonda (exclusão do cliente de teste + restauração da contagem) e final step (os gates só mudam com todos os campos de evidência preenchidos por observação live; falha de cleanup bloqueia a promoção). Qualquer certificação de escrita desta tela segue bloqueada até vault do operador + contrato por operação observado + certificação por operação.
- Status após este dossier: todos os itens §§2–5 permanecem `OBSERVED-static` ou `UNCONFIRMED`; zero capacidades promovidas, zero certificação alterada.

## Apêndice A — Fase dinâmica parcial, Dashboard (edit NÃO observado)

> **Destaque: NADA do formulário de edição foi observado nesta fase.** O CDP tinha APENAS 1 page target na origem — `Dashboard | CINEVISION ONE` (`https://cinevision.panelbr.site/#/dashboard?showNotice=1`); nenhum target `#/customers/edit` existia. Toda a evidência abaixo descreve o Dashboard, não a tela edit. Sessão: `2026-10-13T15:04:10–15:04:15Z`, REA passivo (`list`/`inspect`/`analyze`), Chrome/155 via CDP `127.0.0.1:9222`. Limites do provider: sem headers/bodies/cookies/valores; `completeness = policy_filtered + attach_limited`; `dropped_events = 0`.

| Item | Achado | Confiança |
|---|---|---|
| Fallback | CDP com 1 único target (Dashboard); observado o Dashboard, não o form edit | OBSERVED-live |
| DOM | 3301 nós; 2 `FORM`; INPUTs combobox custom **sem atributo `name`** (só `type`/`class`/`autocomplete`/`tabindex`/`role`/`readonly`/`spellcheck`/`aria-*`/`value`/`style`/`id`); botões/DIVs estruturais; texto de accessibility não aprovado (1214 excluídos); sem valores retidos | OBSERVED-live |
| Rede (janela 5s) | zero requests `/api/*` (`network.requests = []`); só paths estáticos `/api/apple-touch-icon.png` e `/api/manifest.webmanifest` no DOM; coverage começa no attach (`prior_activity_available = false`) | OBSERVED-live |
| Storage (só NOMES, valores redigidos) | `local_storage = [lang, token, settings, pusherTransportTLS, remembered-logins, global-actions-recent-items]`; `session = [sentryReplaySession]`; `cache = [workbox-precache-v2]`; `indexed_db = []` | OBSERVED-live |
| Bundle (74/74 scripts, source maps não buscadas) | DELTA abaixo | OBSERVED-live (literais) |

### DELTA estático (§4) × dinâmico (este apêndice)

- **CONFIRMADO (literais no bundle live)**: `POST customers/calculate-plan-price` e `POST customers/calculate-customer-credits`; família `customers/*` e `resellers/*` presente com semântica POST/GET coerente.
- **NÃO-CONFIRMADO (ausência ≠ contradição)**: literal `GET`/`PUT customers/:id`, `bouquets/*`, `resellers/list`, rotas `#/customers/edit` (`routes = []` — roteamento via `addRoute` genérico; `baseURL` axios + template literals com `:id` não capturados como literais; a tela observada é a home, não o chunk de customers).
- **NOVO (fora do §4 estático)**: `customers/generate-credential`, `customers/move`, `customers/mass-delete`, `customers/import` (+`/validate`), `customers/restore`, `customers/expiring`, `customers/statistics` (+`/top10`); `resellers/move`, `restore` (+`/preview`), `remove`, `unban-ip-address`, `membership-reminder`, `customers-count` (`-by-server`); `servers/*` amplo; `notices/*`, `subpanels` (POST), `changelog` (GET), `/dashboard/*`.
- **Reafirmação**: `GET`/`PUT customers/:id` e todos os bodies seguem **UNCONFIRMED**; falta observação com usuário operando a tela edit (sequência do §8 inalterada).

*Target/evidence IDs efêmeros omitidos por serem descartáveis; sem segredos neste apêndice (só nomes de chaves, sem valores).* Seção numerada 1–9 inalterada.

## Apêndice B — Plataforma completa — tráfego por tela (OBSERVED-live, FULL-08)

> TASK FULL-08, 2026-10-13: 7 loads (≈6 telas + 1 revisita determinística do edit), 179 eventos em 30,4 s, ordem de recebimento sem causalidade. Base `/api` (exceto telemetria Sentry externa). Só método+path+status; bodies/headers não capturados. Rotas SPA não literais (hash router); `fetch_source_maps: false`. Nenhum PUT/POST de escrita executado pelo agente — os POSTs `calculate-*` e o envelope Sentry foram disparados pelo próprio SPA em loads de leitura; zero click/fill/logout.

Padrão global: a SPA faz GET pareado `auth/me` + `settings/public` a cada navegação hash (7/7 loads, todos 200).

| Tela | Método | Path | Status | Params relevantes |
|---|---|---|---|---|
| dashboard | GET | `auth/me` | 200 | — |
| dashboard | GET | `settings/public` | 200 | — |
| dashboard | POST | `logs.smart-ti.com/api/2/envelope` (telemetria Sentry externa) | 200 | — |
| dashboard | — | 1 tentativa inicial sem resposta pareada (`fail:?`, só no 1º load) | n/a | — |
| customers | GET | `auth/me` | 200 | — |
| customers | GET | `settings/public` | 200 | — |
| customers | GET | `customers` | 200 | `page, username, serverId, packageId, expiryFrom, expiryTo, createdFrom, createdTo, status, isTrial, connections, perPage` |
| customers | GET | `resellers/list` | 200 | — |
| edit `MeWexK4DnN` (2 visitas idênticas) | GET | `auth/me` | 200 | — |
| edit `MeWexK4DnN` | GET | `settings/public` | 200 | — |
| edit `MeWexK4DnN` | GET | `resellers/list` | 200 | — |
| edit `MeWexK4DnN` | GET | `customers/MeWexK4DnN` | 200 | `:id` opaco como path param |
| edit `MeWexK4DnN` | GET | `audit/record/customer/MeWexK4DnN` | 200 | `:id` opaco como path param |
| edit `MeWexK4DnN` | GET | `servers/bouquets/BV4D3rLaqZ/true` | 200 | `:id` opaco + flag literal `true` |
| edit `MeWexK4DnN` | POST | `customers/calculate-plan-price` | 200 | disparado pelo SPA no load de leitura |
| edit `MeWexK4DnN` | POST | `customers/MeWexK4DnN/calculate-expiry-date-credits` | 200 | `:id` opaco; disparado pelo SPA no load |
| add | GET | `auth/me` | 200 | — |
| add | GET | `settings/public` | 200 | — |
| add | POST | `customers/calculate-customer-credits` | 200 | disparado pelo SPA no load; sem `GET customer`, sem bouquets, sem audit |
| resellers | GET | `auth/me` | 200 | — |
| resellers | GET | `settings/public` | 200 | — |
| resellers | GET | `resellers/list` | 200 | — |
| resellers | GET | `resellers` | 200 | `page, username, parentUserId, status, membershipActive, role, onlyThisReseller, creditsReadonly, lastRechargeFrom, lastRechargeTo, createdFrom, createdTo, countServer, perPage` |
| resellers | GET | `resellers/roles` | 200 | — |
| account-settings | GET | `auth/me` | 200 | tela mais quieta |
| account-settings | GET | `settings/public` | 200 | tela mais quieta |

### Form edit — rótulos e contagens (OBSERVED-live, só rótulos, sem valores)

- 22 inputs (16 text + 5 checkbox + 1 number), 0 select nativo, 2 textareas, 3 forms, 38 botões; 0 `role=tab` (sem tabs ARIA; "páginas 1–31" = paginação).
- Rótulos: Plano, Referência, Créditos, Observação particular, Servidor, Usuário, Senha, Vencimento (Opcional)…, Valor do Plano, Bouquets, Nome, E-mail, Telegram, WhatsApp, Observações.
- Seções: Renovar, Adicionar Créditos, Nova Mensagem, Detalhes do Cliente.
- Botões (amostra): Salvar, Cancelar, Renovar, Adicionar, Teste Rápido, Copiar e Fechar, Copiar, Excluir, Fechar, Ações.

### Storage / worker (só NOMES, sem valores)

- `localStorage`: `lang, token, settings, resellers-listing-filterData, resellers-per-page, customers-listing-filterData, global-actions-recent-items, customers-per-page, customers-listing-filter, pusherTransportTLS, remembered-logins, resellers-listing-filter`.
- `session`: `sentryReplaySession`; `cache`: `workbox-precache-v2`; 1 worker blob ativo.

### Bundle-only — seguem UNCONFIRMED (não observados no tráfego; ausência ≠ contradição)

Bundle 88/88 scripts, 409 arestas, 153 endpoints estáticos, 0 rotas literais. Seguem UNCONFIRMED por não aparecerem no tráfego FULL-08: `dashboard/charts/*`, `dashboard/metrics/*`, `customers/import*`, `customers/mass-delete`, `customers/move`, `customers/generate-credential`, `customers/statistics/top10`, `servers/test-*`, `panel-migration`, `migrate-single-customer`, `settings/domains/*`, `notices/list`, `exports`, `users/online-count`, `resellers/low-credits`, `membership-reminder`, `auth/twofactor-*`, `auth/refresh-token`, `auth/forgot-password`, `auth/reset-password`, `auth/membership-renew`. Nenhuma contradição observada entre bundle e tráfego.

### Reafirmações

- Bodies (request/response) seguem não-capturados; shapes de body seguem UNCONFIRMED.
- Nenhum write foi executado pelo agente (nenhum PUT/DELETE; POSTs `calculate-*` e Sentry disparados pelo próprio SPA em loads de leitura; zero click/fill/logout).
- Seções numeradas 1–9 inalteradas; este apêndice é não-numerado.
