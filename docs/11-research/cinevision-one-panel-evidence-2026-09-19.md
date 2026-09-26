# Research Evidence — CINEVISION ONE Panel

> Classification: provider evidence snapshot; not canonical business policy.  
> Collected baseline: 2026-09-19.  
> Review: Auto-reviewed v0.14 — source retained for adapter discovery; validated pilot rules in current Domain/SPEC override older assumptions in this evidence snapshot.

---

# CINEVISION ONE — Documentação Completa do Painel Web

> **Versão do painel documentada:** 3.92
> **Data da coleta:** 19/09/2026
> **URL:** `https://cinevision.panelbr.site/#/dashboard`
> **Método de coleta:** navegação autenticada real (Chrome com sessão logada) via Chrome DevTools Protocol, percorrendo 107 rotas, capturando DOM renderizado, formulários, tabelas, botões, chamadas de rede e as definições do roteador Vue.
> **Escopo:** front-end do painel (SPA) + API REST consumida. Não há acesso ao código-fonte do back-end.
> **Finalidade deste documento:** permitir que outro agente de IA entenda o sistema, seus recursos, sua estrutura de navegação, seus fluxos e sua API sem precisar acessar o site.

---

## Sumário

1. [O que é o sistema](#1-o-que-é-o-sistema)
2. [Stack técnica e arquitetura](#2-stack-técnica-e-arquitetura)
3. [Autenticação, sessão e segurança](#3-autenticação-sessão-e-segurança)
4. [Papéis, permissões e escopo da conta documentada](#4-papéis-permissões-e-escopo-da-conta-documentada)
5. [Mapa de navegação (menu lateral)](#5-mapa-de-navegação-menu-lateral)
6. [Conceitos de domínio e modelos de dados](#6-conceitos-de-domínio-e-modelos-de-dados)
7. [Integrações e gateways de pagamento](#7-integrações-e-gateways-de-pagamento)
8. [Configurações públicas do painel (feature flags)](#8-configurações-públicas-do-painel-feature-flags)
9. [Catálogo completo de rotas (155 rotas)](#9-catálogo-completo-de-rotas-155-rotas)
10. [Endpoints da API observados](#10-endpoints-da-api-observados)
11. [Documentação detalhada por módulo](#11-documentação-detalhada-por-módulo)
12. [Histórico de versões (changelog)](#12-histórico-de-versões-changelog)
13. [Limitações e lacunas da coleta](#13-limitações-e-lacunas-da-coleta)

---

## 1. O que é o sistema

**CINEVISION ONE** é um **painel de gestão para revenda de IPTV** (white-label do software "Sigma Panel", da `sigma.vin` — ver a marca "Sigma" na Análise de IA e no domínio `panel_url`). Ele não é um app de streaming para o assinante final: é a ferramenta administrativa do **revendedor** que cria, renova, bloqueia e cobra **clientes** de IPTV, compra **créditos** do provedor, gere **revendas subordinadas**, **mensalistas**, **servidores**, **planos** e **pacotes de crédito**, além de automações de cobrança/suporte via WhatsApp (**BotBot**) e relatórios financeiros e de auditoria.

O usuário-tipo navega por um painel autenticado com:

- **Dashboard** com métricas de clientes, receita recorrente (MRR), churn, retenção, previsão de receita, "receita perdida" e uma **Análise de IA (Sigma)**.
- **Gestão de clientes**: listagem com filtros, criação/edição, conexões ao vivo, estatísticas, excluídos, cupons de desconto, migração de clientes, exclusão em massa, movimentação entre revendas, mensagens agendadas/enfileiradas do BotBot e auditoria.
- **Gestão de revendas** (sub-revendas): listagem, criação, transações de créditos, link de indicação, restauração, exclusão, movimentação, importação, migração de painel, logs do BotBot, estatísticas, histórico de logins e auditoria.
- **Mensalistas**: renovação, atualização em massa e lembretes.
- **Financeiro**: vendas de créditos, renovações de clientes, renovações de mensalistas e créditos de registro de domínio.
- **Relatórios**: novos conteúdos, estatísticas de servidores.
- **Sistema**: servidores, avisos, template de playlist, campanhas de bônus de crédito, planos, pacotes de crédito, bloqueio de testes, planos de mensalista, subpainéis, permissões, auditoria do sistema, logs de requisições.
- **Configurações**: gerais, domínios, notificações, manutenção, backup, clientes, revendas, estilo, desenvolvedores e cópia de configurações.
- **Utilitários**: ChatBot, desbloqueio de IP, solicitação de funcionalidades, changelog, domínios.
- **Conta**: perfil, integrações, segurança/2FA, sessões ativas, compra de créditos, tickets de suporte.

Há ainda **rotas públicas** (fora do login): `#/sign-in`, `#/forgot-password`, `#/reset-password`, `#/reset-password-with-token/:token`, e páginas de **checkout/renovação** acessadas pelo cliente final (`#/checkout/:domainId/:customerId`, `#/cs/:domainId/:resellerId`, `#/rs/:domainId/:resellerId`, `#/membership/confirmation/:status` etc.).

---

## 2. Stack técnica e arquitetura

### 2.1 Frontend

| Item | Evidência |
|---|---|
| **Vue 3** (Composition API, build ESM) | assets `runtime-core.esm-bundler`, `runtime-dom.esm-bundler`, `vue-router`, `pinia` |
| **Vue Router em modo hash** | todas as URLs são `#/...`; `router.getRoutes()` acessível no app |
| **Pinia** (estado global) | asset `pinia-*.js` |
| **Bootstrap 5** + tema próprio (padrão Metronic) | asset `bootstrap.esm-*.js`; chaves `kt_theme_mode_value` / `kt_theme_mode_menu` no localStorage |
| **vue-i18n / gettext** | assets `vue-i18n`, `gettext`; cabeçalho `Locale: pt`; setting `locale = pt-BR` |
| **dayjs** | asset `dayjs.min-*.js`; componente `DateTime` |
| **vee-validate** | asset `vee-validate-*.js` (validação de formulários) |
| **SweetAlert2** | asset `sweetalert2.all-*.js` (diálogos e confirmações) |
| **Font Awesome** (duotone/light/regular) | `fa-duotone-900.woff2`, `fa-light-300.woff2`, `fa-regular-400.woff2` |
| **Pusher** (WebSocket em tempo real) | asset `PusherService`; chave `pusherTransportTLS` no localStorage |
| **Sentry** (`@sentry/vue` 10.48.0) + Session Replay | envio para `logs.smart-ti.com`; `sentryReplaySession` no sessionStorage |
| **PWA** (Workbox) | `manifest.webmanifest`, `workbox-window.prod`, `ReloadPrompt`, `pwa-192x192.png` |
| **Meta Pixel / tracking** | asset `meta-tracking-*.js`; integração `meta-pixel` |

Build em chunks (Vite/Rollup), servido de `/assets/*`. O layout é mobile-aware (`useMobileShell`, `mobile-glass-nav`).

### 2.2 API de back-end

- Base **same-origin** em `/api` (`https://cinevision.panelbr.site/api/...`).
- Autenticação por **token Bearer** guardado em `localStorage.token` (string opaca de 54 caracteres).
- Respostas no padrão **Laravel**: envelope `{"data": ...}`, paginação com `data`, `links`, `meta` (`current_page`, `last_page`, `per_page`, `total`) e mensagens de erro como `{"message": "..."}`.
- Cabeçalhos enviados pelo app em todas as chamadas: `Authorization: Bearer <token>`, `Accept: application/json`, `Locale: pt`, `X-App-Version: 3.92`.
- Erros observados: `401` (não autenticado), `403` (`{"message":"Proibido"}` — permissão ausente), `402` (integração/complemento pago inativo, com `error`, `integration_key`/`addon_key`).

### 2.3 Infra e terceiros

- **Cloudflare** protege o domínio (desafio "Just a moment..." para clientes não navegacionais — relevante para automação: um browser real autenticado passa, um headless limpo não).
- **Sentry** em `logs.smart-ti.com` (projeto `sentry-release=3.92`).
- **Pusher** para eventos em tempo real.
- **Gateways de pagamento** por conta: Asaas, Mercado Pago (primário/secundário), paggpay, PayPal, Stripe.
- **BotBot**: automação de mensagens WhatsApp (agendamento, fila, logs, teste automático, lembretes de mensalista).

---

## 3. Autenticação, sessão e segurança

### 3.1 Fluxo

1. O usuário acessa `#/sign-in` e envia credenciais para a API de auth.
2. A API devolve um **token** que o app grava em `localStorage.token` (string pura, sem JSON).
3. Toda chamada à API usa `Authorization: Bearer <token>`.
4. Na inicialização, o app chama `GET /api/auth/me`, que devolve o perfil completo **incluindo o array de permissões** e o `role`; e `GET /api/settings/public`, que traz configurações e feature flags do painel.
5. Rotas autenticadas têm `meta.middleware = "auth"`; rotas protegidas por permissão têm `meta.permission` / `meta.permissionsAny` / `meta.role`.

### 3.2 Rotas de conta/segurança

| Recurso | Rota | Endpoint |
|---|---|---|
| Perfil | `#/account-settings` | `GET /api/auth/me` |
| Segurança/2FA | `#/account-security` | `GET /api/auth/me` |
| Sessões ativas | `#/active-sessions` | `GET /api/auth/active-sessions` |
| Histórico de logins do usuário | `#/active-sessions` | `GET /api/audit/my-sign-in-logs` |
| Sair | `#/sign-out` | — |
| Esqueci a senha | `#/forgot-password` | — |
| Redefinir senha | `#/reset-password` | — |
| Redefinir por token | `#/reset-password-with-token/:token` | — |

### 3.3 2FA e sessões

O perfil expõe permissões de 2FA por **app autenticador**, **Telegram** e **e-mail** (`setup 2-step verification using an app/telegram/email for their account`). O badge do topo mostra o estado ("2FA Desativada").

`GET /api/auth/active-sessions` retorna sessões com: `id`, `current`, `createdAt`, `lastSeenAt` (relativo, ex.: "há 3 horas"), e `sessionDetails` com **device** (model/type), **OS** (nome), **browser** (nome/versão), **location** (país/cidade/região), `isMaster`, `isSupport` e **ipAddress**. Há ação de encerrar sessões.

### 3.4 Políticas de segurança do painel

- `number_of_minutes_of_inactivity_to_logout = 1440` (24h).
- `minimum_number_of_characters_username_password = 9` e `maximum_number_of_characters_username_password = 9` (usuário/senha de cliente com exatamente 9 caracteres).
- `username_format = numeric`.
- `reseller_password_must_include_symbol = 0`.
- `allow_reseller_login_if_zero_credits = 2`.
- `unban-ip-address` (`#/unban-ip-address`, permissão `unban ip address`) para liberar IPs banidos.
- Auditoria completa: `#/customers/audit`, `#/resellers/audit`, `#/system/audit`, `#/resellers/sign-in-logs`, `#/system/server-request-logs`.

---

## 4. Papéis, permissões e escopo da conta documentada

### 4.1 Papéis

`GET /api/resellers/roles` retorna três papéis (contagem de usuários no momento da coleta):

| Papel | Usuários |
|---|---|
| `ultra-reseller` | 33 |
| `master-reseller` | 58 |
| `reseller` | 52 |

Permissões relacionadas a papéis: `create ultra-reseller`, `create master-reseller`, `create reseller`, `create new resellers`, `edit reseller master reseller`, `login as any reseller`.

### 4.2 Conta usada na coleta

- **Usuário:** conta de coleta identificada no painel (e-mail e nome omitidos deste repositório)
- **Papel:** `ultra-reseller`
- **Créditos:** 2
- **Idioma:** `pt`
- **Criada por link de indicação**; revenda bloqueada e desbloqueada em 15/06/2026.

### 4.3 Permissões da conta (array retornado por `/api/auth/me`)

```
edit customer expiry date, edit customer username, login as any reseller,
can set plan price below master, can setup membership, edit customer password,
can edit customer plan price, send message to subresellers, create ultra-reseller,
create master-reseller, create reseller, create customer, view notice,
view audit trail, transfer credits, remove credits, sell credits, view server,
use chatbot, view trialblocker, use reseller referral link, can see server statistics,
can see credit transactions, access support ticket, charge credits for extra connections,
see live connections, see new content, use customer migration, setup own package prices,
setup own credit package prices, purchase credits, delete customer, delete reseller,
view sign-in logs, set credit price below master, block customers, unblock customers,
block resellers, unblock resellers, access reseller pages, create new resellers,
view own credits count, view own logged in username, use chatbot automated test,
enforce customers username rules, enforce customers password rules, see to expire count,
migrate server, charge credit to update the customer expiry date, edit reseller dns,
activate app, send message to own subresellers, create customer coupon,
view deleted customers, allow option to show contact details to subresellers,
view online users, setup 2-step verification using an app for their account,
setup 2-step verification using telegram for their account,
setup 2-step verification using email for their account, see server status,
view m3u buttons in customers page, view credits count, edit reseller master reseller,
migrate customers using m3u
```

**Não possui** (por isso recebeu `403`/redirect): `update general settings`, `update customers settings`, `update resellers settings`, `update notifications settings`, `update maintenance settings`, `update domain settings`, `update domains settings`, `update style settings`, `update developers settings`, `update backup settings`, `create server`, `create package`, `create credit-package`, `create trialblocker`, `create membership plans`, `create subpanels`, `create credit-bonus-campaign`, `create notice`, `create content request`, `manage content request`, `can purchase domain`, `unban ip address`, `create subpanels` (feature-request), e os papéis `super-admin` (`/system/permissions`, `/system/audit`, `/system/server-request-logs`, `/billing/domain-orders`, `/utilities/domains/all`).

### 4.4 Comportamento de acesso negado

1. **Rota com `meta.role: super-admin`** → o roteador redireciona para `#/dashboard` (a rota nem é renderizada).
2. **Rota permitida no roteador, mas endpoint negado** → a página renderiza o "shell" e o `GET` correspondente retorna `403 {"message":"Proibido"}`; a tela fica sem dados.
3. **Integração/complemento pago inativo** → `402` com `{"error":"integration_inactive"|"addon_inactive", "message": "...", "integration_key"/"addon_key": "..."}`.

---

## 5. Mapa de navegação (menu lateral)

O menu lateral (aside) é **colapsável por grupos** e usa classes `menu-item` / `menu-link` / `collapsible-group`. Estrutura observada:

```
Visão geral
├─ Dashboard                       #/dashboard
├─ Avisos (badge 1)                #/notices
├─ Comprar Créditos [Comprar]      #/credit-purchase
├─ Tickets de Suporte              #/support-tickets
├─ Perfil                          #/account-settings
├─ Integrações                     #/integrations
├─ Segurança da Conta              #/account-security
├─ Sessões Ativas (badge 2)        #/active-sessions
└─ Sair                            #/sign-out

Clientes
├─ Clientes                        #/customers
├─ Assistente de Renovação [Beta]  #/customers/renewal-assistant
├─ Conexões Ao Vivo                #/customers/live-connections
├─ Estatísticas de Clientes        #/customers/statistics
├─ Excluído                        #/customers/deleted
├─ Cupons de Desconto              #/customers/coupons
├─ Migração de Cliente             #/customers/migration
├─ Agendadas no BotBot             #/customers/botbot-scheduled-messages
├─ Fila do BotBot                  #/customers/botbot-queued-messages
├─ Logs do BotBot                  #/customers/botbot-logs
└─ Auditoria Clientes              #/customers/audit

Revendas
├─ Revendas                        #/resellers
├─ Transações de Créditos          #/resellers/credit-transactions
├─ Link de Indicação               #/resellers/referral-link
├─ Agendadas no BotBot             #/resellers/botbot-scheduled-messages
├─ Estatísticas de Revendas        #/resellers/statistics
├─ Logs do BotBot                  #/resellers/botbot-logs
├─ Histórico de Logins             #/resellers/sign-in-logs
└─ Auditoria Revendas              #/resellers/audit

Mensalista
├─ Renovar Mensalistas             #/resellers/renew-membership
├─ Atualização de Mensalistas      #/resellers/bulk-membership
└─ Lembrete de Mensalista          #/botbot/membership-reminder

Financeiro
├─ Vendas de Créditos              #/billing/credit-orders
├─ Renovações de Clientes          #/billing/customers-orders
└─ Renovações de Mensalistas       #/billing/membership-transactions

Relatórios
├─ Novos Conteúdos                 #/content
└─ Estatísticas dos Servidores     #/server-statistics

BotBot
├─ Configurações BotBot            #/integrations/botbot
├─ Teste Automático                #/automation/botbot-automatic-test
├─ Clientes                        #/automation/botbot-customers
└─ Revendas                        #/automation/botbot-resellers

Utilitários
└─ ChatBot                         #/chatbot

Sistema
├─ Planos (Preço)                  #/system/packages-price
├─ Pacote de Créditos (Preço)      #/system/credit-packages-price
├─ Auditoria do Sistema            #/system/audit
└─ Novidades v3.92                 #/changelog
```

Há também uma **barra de navegação móvel** (`mobile-glass-nav`) com os itens: Teste Rápido, Clientes, Revendas, Ações e Menu.

Além do menu, a interface tem:
- **Pesquisa rápida global** (`Ctrl+K`) no topo.
- **Central de links oficiais** no Dashboard (gestor de cobrança via WhatsApp, painel CINEVISION ONE, painel CINEVISION XTREAM, portal VOD, ativação de apps pagos, bot Telegram, área revenda do app, Drive, Telegram oficial, Play Store dos apps próprios, manual do revendedor, dicas e tutoriais).
- **Bloco "Teste Rápido"** no Dashboard com botões de criação de teste por duração (1h/3h/6h), tipo (completo/sem adultos) e dispositivo (Smart TV LG/Samsung/Nextrange/Roku, Android, iOS, Windows, Xbox, apps parceiros e app próprio).
- Diálogo global **"Adicionar Créditos"** (referência, valor, casas decimais, criar pedido de cliente, registrar como pagamento manual/offline, observações).
- Modal **"Últimas alterações Sigma v3.92"** (changelog) com opção "Não mostrar novamente".

---

## 6. Conceitos de domínio e modelos de dados

### 6.1 Reseller (Revenda)

Retorno de `GET /api/resellers/list` e `GET /api/resellers`:

```json
{ "id": "...", "username": "...", "parent": "<revendedor-pai>" }
```

A hierarquia é uma árvore: um revendedor tem `parent_user_id`. Papéis: `ultra-reseller`, `master-reseller`, `reseller`. Campos de listagem incluem `username`, `parentUserId`, `status`, `membershipActive`, `role`, `onlyThisReseller`, `creditsReadonly`, `lastRechargeFrom/To`, `createdFrom/To`, `countServer`. Um revendedor tem **créditos**, **mensalidade** (membership), **templates de mensagem** próprios, **dns** editável e pode ter sub-revendas.

### 6.2 Customer (Cliente)

Retorno de `GET /api/customers`:

```json
{
  "id","user_id","server_id","package_id","app_server_id","app_package_id",
  "reseller","created_at","updated_at","expires_at","expires_at_tz",
  "username","password","mac_address","name","email","telegram","whatsapp",
  "status","connection_type","is_trial","is_mag","is_asnlock","is_isplock",
  "is_migrated","is_restreamer","connections","has_multiple_connections",
  "server","package","package_is_adult","note","currency","plan_price",
  "customer_renew_template","customer_renew_confirmation_template",
  "renew_url","playlist","bouquets","m3u_url","m3u_url_short",
  "parent_can_edit_personal_data","is_multi_server"
}
```

- **`connection_type`**: ex. `BILLING` (cobrança) e provavelmente `IPTV`/`M3U`.
- **Flags**: teste (`is_trial`), MAG, bloqueio por ASN/ISP, migrado, restreamer, múltiplas conexões.
- **`renew_url`** aponta para o checkout público: `#/checkout/{domainId}/{customerId}`.
- **`m3u_url` / `m3u_url_short` / `playlist` / `bouquets`** expõem a lista de reprodução.
- Estados de status observados: `ACTIVE` (e, por contexto, bloqueado/expirado/excluído via `deleted=true`).

### 6.3 Server (Servidor)

Retorno de `GET /api/servers`:

```json
{
  "id","name","type","dns_list","status","timezone","reseller_action",
  "connection_type","packages":[...],"allowed_bouquets","will_count_membership",
  "allowed_dns","is_isplock","subtract_one_connection_when_calculating_membership",
  "connections_to_subtract_when_calculating_membership","cost_per_customer",
  "can_create_restreamer_packages","can_mass_migrate","sort_order",
  "max_customers","max_connections","api_version","has_default_customer_password"
}
```

- **`type`**: ex. `ONESTREAM` (servidor CINEVISION ONE). O painel também referencia um servidor **CINEVISION XTREAM**.
- Cada servidor agrega **pacotes**, **bouquets** permitidos, DNS, limites (`max_customers`, `max_connections`), custo por cliente e regras de mensalidade.
- Endpoints auxiliares: `GET /api/servers/limit`, `GET /api/servers/licence` (403 para esta conta), `GET /api/servers/bouquets/{serverId}/{bool}`, `GET /api/servers/resync/latest`.
- Ações: adicionar, editar, **resincronizar**, **migrar clientes em massa**, gerenciar tokens, copiar servidor.

### 6.4 Package (Plano) e Package Price

`GET /api/packages/price` (visão de preços):

```json
{ "id","server_id","server","name","status","is_trial","plan_price","my_plan_price",
  "credits","duration","duration_in" }
```

O pacote completo (`/api/servers` → `packages[]`) tem ainda: `is_mag`, `is_asnlock`, `is_isplock`, `is_trial`, `is_adult`, `is_restreamer`, `template`, `connections`, `show_on_dashboard`, `access_output`, `bouquets`, `child_packages`, `sort_order`, `has_default_customer_password`.

`plan_price` é armazenado em **centavos** (ex.: `2500` = R$ 25,00). `duration_in` = `MONTHS`.

### 6.5 Credit Package (Pacote de Créditos) e Credit Price

```json
{ "id","currency","credits","price_per_unit","my_price_per_unit",
  "request_national_document_id_user","require_national_document_id",
  "required_payment_details","has_default_national_document_data","status" }
```

`price_per_unit` em centavos. Exemplos coletados: 1 crédito a R$ 10,00; 5 a R$ 8,00; 10 a R$ 7,00; 25 a R$ 7,00; 50 a R$ 6,50; 75 a R$ 6,50; 100 a R$ 6,00; 150 a R$ 6,00 (preço unitário cai com o volume).

### 6.6 Membership (Mensalista)

Revendas pagam **mensalidade**. Recursos: `#/resellers/renew-membership` (`GET /api/resellers/membership-report`), `#/resellers/bulk-membership` (`GET /api/resellers/bulk-membership/preview`), `#/botbot/membership-reminder` (`GET /api/resellers/membership-list`), `#/membership/renew`, e transações em `GET /api/membershiptransactions`. Há `membershipActive`, `membershipExpiryFrom/To`, `membershipType` e planos de mensalista (`/api/membershipplans`).

### 6.7 Trial Blocker (Bloqueio de Teste)

`GET /api/trialblockers` retorna registros com `reason`, `block_from`, `block_to` (janelas em que a criação de testes é bloqueada, ex.: "Testes bloqueados para priorizar qualidade dos clientes pagantes").

### 6.8 Coupon (Cupom de desconto)

`GET /api/customer-coupons` (paginado; vazio na coleta). Rotas `#/customers/coupons` e `#/customers/coupons/add`; permissão `create customer coupon`.

### 6.9 Customer Migration (Migração de cliente)

`GET /api/customermigrations` (paginado). Rotas `#/customers/migration`, `#/customers/migration/add`, `#/customers/migration/status/:id`. Permissão `migrate customers using m3u`. Há também **migração de servidor em massa** (`#/system/servers/mass-migrate`).

### 6.10 Notice (Aviso)

`GET /api/notices/list` (visível ao revendedor) e `GET /api/notices` (administração). Campos: `id`, `user_id`, `title`, `description` (HTML com cores), e controles de exibição. O Dashboard também exibe uma central de avisos fixa.

### 6.11 Orders e Transactions

| Conceito | Endpoint | Rota |
|---|---|---|
| Vendas de créditos | `GET /api/creditorders` | `#/billing/credit-orders` |
| Renovações de clientes | `GET /api/customerorders` | `#/billing/customers-orders` |
| Renovações de mensalistas | `GET /api/membershiptransactions` | `#/billing/membership-transactions` |
| Créditos de registro de domínio | `GET /api/domain-registration-credits` | `#/billing/domain-registration-credits` |
| Transações de créditos entre revendas | `GET /api/reports/credit-transactions` | `#/resellers/credit-transactions` |

### 6.12 BotBot

Automação de WhatsApp. Superfícies: configurações (`#/integrations/botbot`), teste automático (`#/automation/botbot-automatic-test`), automação de clientes/revendas (`#/automation/botbot-customers`, `#/automation/botbot-resellers`), mensagens agendadas e em fila, logs (por cliente e por revenda), lembrete de mensalista. Endpoints: `GET /api/botbot/logs?type=customer|reseller`, `GET /api/customers/botbot-queued-messages`, `GET /api/customers/botbot-scheduled-messages`, `GET /api/resellers/botbot-scheduled-messages`.

### 6.13 Dashboard

`GET /api/dashboard/preferences` define `layout_columns` (1 ou 2) e `widget_visibility` / `widget_order` dos widgets:

`server-status`, `customers-revenue`, `customers-new-customers-chart`, `customers-revenue-forecast-chart`, `customers-lost-revenue-chart`, `customers-chart-subresellers`, `customers-chart-own`, `customers-chart-total`, `customers-expiring`, `quick-test`, `resellers-new-resellers-chart`, `resellers-membership-expiring-chart`, `resellers-membership-chart`, `credits-consumed-chart`, `resellers-chart-subresellers`, `resellers-chart-own`, `resellers-chart-total`, `resellers-low-credits`, `resellers-new-resellers`, `reseller-contact`.

Chamadas de dados do Dashboard: `GET /api/dashboard/charts/new-customers?period=last-30-days`, `GET /api/dashboard/charts/customer-retention`, `GET /api/dashboard/charts/revenue-forecast`, `GET /api/dashboard/charts/lost-revenue`, `GET /api/dashboard/metrics/recovery`, `GET /api/dashboard/ai-analysis`, `GET /api/customers/expiring`, `GET /api/users/online-count`.

Métricas exibidas: Clientes (próprios/subrevendas/total), Novos clientes, Expirando em 7 dias, Retenção/churn, **MRR** (receita recorrente), Ticket médio, Valor do cliente (LTV), Conversão de teste, Previsão de receita (30 dias), Receita perdida/renovada (30 dias) e Taxa de renovação.

### 6.14 Análise de IA (Sigma)

`GET /api/dashboard/ai-analysis` — recurso "Análise de IA Sigma" com cota "1 grátis/dia", que gera resumo sobre crescimento, expirações iminentes e receita em risco com ações recomendadas.

---

## 7. Integrações e gateways de pagamento

`GET /api/integrations` retorna o catálogo de integrações da conta:

| ID | Nome |
|---|---|
| `botbot` | BotBot (WhatsApp) |
| `meta-pixel` | Meta Pixel |
| `rlKWO3Wzo7` | Asaas |
| `BV4D3rLaqZ` | Mercado Pago (primário) |
| `EMeWepDnN9` | Mercado Pago (secundário) |
| `BKADdn1lrn` | paggpay |
| `kRXDgwDexV` | paggpay |
| `RYAWRk1jlx` | PayPal |
| `rdqLkQWAE9` | Stripe |

Gateways exigem configuração própria do revendedor (`user_config`, `user_config_setup`). Exemplos de campos por gateway:

- **Asaas**: `api_key` (Chave de API), `pix_key` (Chave Aleatória). Instruções oficiais embutidas na tela.
- **Mercado Pago**: `public_key`, `access_token`, `accept_pix_only` (checkbox, padrão "Aceitar Somente Pix").
- **Stripe / PayPal / paggpay**: presentes no catálogo, com configuração equivalente por credenciais.

O painel também expõe **API de Revenda** (`#/integrations/reseller-api`) e **Documentação da API** (`#/settings/developers/api-reference`), mas ambos dependem de complemento pago:
- `GET /api/reseller-api/v1/openapi.json` → `402 integration_inactive`.
- `GET /api/integration/openapi.json` → `403 Proibido`.
- `GET /api/content-request/*` → `402 addon_inactive` (`addon_key: content_requests`).

### 7.1 Templates de mensagem (por conta)

O perfil (`/api/auth/me`) carrega os templates de cobrança usados pelo BotBot/WhatsApp, com variáveis como `{name}`, `{username}`, `{last_recharge_at}`, `{plan_price}`, `{expires_at}`, `{pay_url}`, `{amount}`, `{dateFormatted}`, `{panelUrl}`, `{payment_method}`, `{order_number}`, `{transaction_id}`:

- `reseller_renew_template` (créditos acabando)
- `customer_renew_template` (conta expirando, com link de pagamento)
- `customer_renew_confirmation_template`
- `reseller_membership_renew_template_variable_amount_3_days` / `_expiry_day`
- `reseller_membership_renew_template_fixed_amount_3_days` / `_expiry_day`
- `reseller_membership_renew_confirmation` / `_manual`

---

## 8. Configurações públicas do painel (feature flags)

`GET /api/settings/public` retorna 58 variáveis (todas `public=YES`). As mais relevantes:

| Variável | Valor |
|---|---|
| `site_name` | CINEVISION ONE |
| `version` | 3.92 |
| `panel_url` | cinevision.sigma.vin |
| `panel_expiration_date` | 2026-10-07T12:00:00 (`panel_expiration_date_in_days` = 18) |
| `server_timezone` | America/Sao_Paulo |
| `currency` | BRL |
| `locale` | pt-BR |
| `minimum_credits_to_create_reseller` | 5 |
| `minimum_credits_to_transfer` | 5 |
| `username_format` | numeric |
| `minimum_number_of_characters_username_password` | 9 |
| `maximum_number_of_characters_username_password` | 9 |
| `enable_support_ticket` | 1 |
| `show_active_trial_count_resellers` | 1 |
| `enable_customer_username_field` | 1 |
| `number_of_minutes_of_inactivity_to_logout` | 1440 |
| `allow_reseller_login_if_zero_credits` | 2 |
| `reseller_toggle_tree_status` | 1 |
| `allow_set_number_of_connections` | 1 |
| `allow_customer_migration` | 1 |
| `allow_edit_customers_bouquets` | 1 |
| `allow_server_migration` | 1 |
| `allow_reduce_customer_connections` | 1 |
| `courtesy_days_behaviour` | 3 |
| `update_customer_password_when_importing_migration` | 0 |
| `domains_enabled` | NO |
| `domains_payment_mode` | CREDIT |
| `domains_credit_costs` | JSON com custos `create`/`renew` por TLD (`xyz`, `icu`, `cfd`, …) |
| `enable_referral_link` | 1 |
| `allow_multi_servers_customer` | NO |
| `allow_custom_theme` | NO |
| `login_notice_enabled` | 1 |
| `login_notice_text` | HTML com a central de links oficiais |
| `telegram` | https://telegram.me/cinevisiontv |
| `whatsapp` | link `api.whatsapp.com` com telefone da revenda |
| `logo_dark` / `logo_light` | `/api/settings/logo/...` |
| `auth_layout_*` | estilo/tema da tela de login (cores, imagem/vídeo, branding, gradiente) |
| `favicon_dark` / `favicon_light` | (vazios) |
| `light_theme_aside_style` | dark |
| `reseller_password_must_include_symbol` | 0 |

---



## 9. Catálogo completo de rotas (155 rotas)

Todas as rotas registradas no roteador Vue (`router.getRoutes()`), com nome, título de página, breadcrumbs e a permissão/papel exigido. Rotas com `:param` são dinâmicas.

| Rota | Nome | Título da página | Breadcrumbs | Permissão / Papel | Observação |
|---|---|---|---|---|---|
| `/customers/coupons/edit/:id` | customer-coupons-edit | Edit Coupon | Edit Coupon | create customer coupon |  |
| `/system/servers/edit/:id` | apps-servers-edit | Edit Server | Edit Server | create server |  |
| `/system/servers/resync/:id` | apps-servers-resync-progress | Resync Progress | Resync Progress | create server |  |
| `/system/servers/mass-migrate/:id` | apps-servers-mass-migrate-progress | Mass Migration Progress | Mass Migration Progress | mass migrate customers between servers |  |
| `/system/notices/edit/:id` | apps-notices-edit | Edit Notice | Edit Notice | create notice |  |
| `/customers/migration/status/:id` | apps-utilities-customer-migration-status | Client Migration Status | Client Migration Status | migrate customers using m3u |  |
| `/system/default-playlist-template/edit/:id` | apps-default-playlist-template-edit | Edit Default Playlist Template | Edit Default Playlist Template | edit default playlist template |  |
| `/system/credit-bonus-campaigns/edit/:id` | apps-credit-bonus-campaign-edit | Edit Credit Bonus Campaign | Edit Credit Bonus Campaign | create credit-bonus-campaign |  |
| `/system/packages/edit/:id` | apps-packages-edit | Edit Package | Edit Package | create package |  |
| `/system/packages-price/edit/:id` | apps-packages-edit-price | Edit Package Price | Edit Package Price | access reseller pages |  |
| `/system/credit-packages/edit/:id` | apps-credit-packages-edit | Edit Credit Package | Edit Credit Package | create credit-package |  |
| `/system/credit-packages-price/edit/:id` | apps-credit-packages-edit-price | Edit Credit Package Price | Edit Credit Package Price | access reseller pages |  |
| `/system/trialblocker/edit/:id` | apps-trialblocker-edit | Edit Trial Blocker | Edit Trial Blocker | create trialblocker |  |
| `/system/membership-plans/edit/:id` | apps-membership-plans-edit | Edit Membership Plan | Edit Membership Plan | create membership plans |  |
| `/system/subpanels/edit/:id` | apps-subpanels-edit | Edit Subpanel | Edit Subpanel |  |  |
| `/system/subpanels/impersonate/:id` | apps-subpanels-impersonate |  |  |  |  |
| `/integrations/reseller-api/deliveries` | integrations-reseller-api-deliveries | Webhook Deliveries | Integrations > Reseller API > Webhook Deliveries |  |  |
| `/integrations/reseller-api/success` | integrations-reseller-api-success | Reseller API Subscription | Integrations > Reseller API > Success | super-admin |  |
| `/integrations/reseller-api/cancel` | integrations-reseller-api-cancel | Reseller API Subscription | Integrations > Reseller API > Canceled | super-admin |  |
| `/customers/coupons/add` | customer-coupons-add | Add Coupon | Add Coupon | create customer coupon |  |
| `/utilities/domains/all` | utilities-admin-domains | All Domains | Utilities > Domains > All | papel: super-admin |  |
| `/system/servers/add` | apps-servers-add | Add Server | Add Server | create server |  |
| `/system/servers/resync` | apps-servers-resync | Resync Server | Resync Server | create server |  |
| `/system/servers/mass-migrate` | apps-servers-mass-migrate | Mass Migrate Customers | Mass Migrate Customers | mass migrate customers between servers |  |
| `/system/servers/token-manager` | apps-servers-token-manager | Token Manager | Token Manager | create server |  |
| `/system/notices/add` | apps-notices-add | Add Notice | Add Notice | create notice |  |
| `/customers/migration/add` | apps-utilities-customer-migration-add | Client Migration Add | Client Migration Add | migrate customers using m3u |  |
| `/system/credit-bonus-campaigns/add` | apps-credit-bonus-campaign-add | Add Credit Bonus Campaign | Add Credit Bonus Campaign | create credit-bonus-campaign |  |
| `/system/packages/add` | apps-packages-add | Add Package | Add Package | create package |  |
| `/system/credit-packages/add` | apps-credit-packages-add | Add Credit Package | Add Credit Package | create credit-package |  |
| `/system/trialblocker/add` | apps-trialblocker-add | Add Trial Blocker | Add Trial Blocker | create trialblocker |  |
| `/system/membership-plans/add` | apps-membership-plans-add | Add Membership Plan | Add Membership Plan | create membership plans |  |
| `/system/subpanels/add` | apps-subpanels-add | Add Subpanel | Add Subpanel |  |  |
| `/settings/developers/api-reference` | settings-developers-api-reference | API Documentation |  | update developers settings | middleware: auth |
| `/integrations/reseller-api/api-reference` | integrations-reseller-api-reference | Reseller API Documentation |  |  | middleware: auth |
| `/system/subpanels/:subpanelId/servers/resync/:id` | apps-subpanels-resync-progress | Resync Progress | Subpanels > Resync Progress | create subpanels |  |
| `/system/subpanels/:subpanelId/servers/resync` | apps-subpanels-resync | Resync Server | Subpanels > Resync Server | create subpanels |  |
| `/customers/edit/:id` | apps-customers-edit | Edit Client | Edit Client | create customer |  |
| `/resellers/edit/:id` | apps-resellers-edit | Edit Reseller | Edit Reseller | access reseller pages |  |
| `/membership/confirmation/:status` | membership-confirmation | Payment Confirmation |  |  |  |
| `/membership/payment-check/:orderId` | membership-payment-check | Payment Confirmation | Payment Confirmation |  |  |
| `/credit-purchase/payment-confirmation/:status` | credit-purchase-payment-confirmation | Payment Confirmation | Payment Confirmation | create customer |  |
| `/credit-purchase/payment-check/:orderId` | credit-purchase-payment-check | Payment Confirmation | Payment Confirmation | create customer |  |
| `/domain-purchase/payment-confirmation/:paymentStatus` | domain-purchase-payment-confirmation | Domain Payment Confirmation | Domain Payment Confirmation | can purchase domain |  |
| `/domain-purchase/payment-check/:orderId` | domain-purchase-payment-check | Domain Payment Confirmation | Domain Payment Confirmation | can purchase domain |  |
| `/credit-purchase/details/:packageId` | credit-purchase-details | Payment Details | Payment Details | create customer |  |
| `/referral/reseller/:resellerId` | referral-reseller | Create an Account |  |  |  |
| `/integrations/botbot` | integrations-botbot | Integrations | Integrations |  | redireciona para {path:/integrations,query:{integration:botbot}} |
| `/integrations/reseller-api` | integrations-reseller-api | Reseller API | Integrations > Reseller API |  |  |
| `/customers/renewal-assistant` | apps-customers-renewal-assistant | Renewal Assistant | Customers > Renewal Assistant | create customer |  |
| `/customers/live-connections` | live-connections | Live Connections | Live Connections | create customer |  |
| `/customers/statistics` | apps-customers-statistics | Customers Statistics | Customers Statistics | create customer |  |
| `/customers/deleted` | apps-customers-deleted | Customers Deleted | Customers Deleted | view deleted customers |  |
| `/customers/coupons` | customer-coupons | Customer Coupons | Customer Coupons | create customer coupon |  |
| `/customers/migration` | apps-utilities-customer-migration-listing | Client Migration | Client Migration | migrate customers using m3u |  |
| `/customers/mass-delete` | customers-mass-delete-customers | Mass Delete Customers | Mass Delete Customers | mass delete customers |  |
| `/customers/move` | apps-customers-move | Move Customers | Move Customers | move customers from one reseller to another |  |
| `/customers/botbot-logs` | reports-botbot-logs-customer | BotBot Logs | BotBot Logs | create customer |  |
| `/customers/botbot-queued-messages` | apps-customers-botbot-queued-messages | BotBot Queued Messages | BotBot Queued Messages | create customer |  |
| `/customers/botbot-scheduled-messages` | apps-customers-botbot-scheduled-messages | BotBot Scheduled Messages | BotBot Scheduled Messages | create customer |  |
| `/customers/audit` | apps-audit-customers | Audit Customers | Audit Customers |  |  |
| `/customers/add` | apps-customers-add | Add Customer | Add Customer | create customer |  |
| `/resellers/content-requests` | apps-content-requests | Requests | Resellers > Requests | qualquer: create content request, manage content request, view own content request, view all content request, vote content request |  |
| `/resellers/credit-transactions` | apps-reports-credit-transactions | Credit Transactions | Reports > Credit Transactions | create customer |  |
| `/resellers/renew-membership` | apps-membership-report | Renew Membership | Renew Membership | can setup membership |  |
| `/resellers/bulk-membership` | apps-bulk-membership-management | Mass Update Membership | Membership > Mass Update Membership | can setup membership |  |
| `/utilities/domains` | apps-domains | Domains | Domains | can purchase domain |  |
| `/resellers/referral-link` | apps-utilities-referral-link | Referral Link | Referral Link | use reseller referral link |  |
| `/resellers/restore-reseller` | apps-utilities-restore-reseller | Restore Resellers | Restore Resellers | create subpanels |  |
| `/resellers/deleted` | apps-resellers-deleted | Deleted Resellers | Deleted Resellers | edit all customers and resellers |  |
| `/resellers/move` | apps-utilities-move-resellers | Move Resellers | Move Resellers | move resellers from one reseller to another |  |
| `/resellers/import` | apps-utilities-import-reseller | Import Resellers | Import Resellers | create subpanels |  |
| `/resellers/panel-migration` | apps-servers-migration | Migrate Reseller | Migrate Reseller | create subpanels |  |
| `/resellers/botbot-logs` | reports-botbot-logs-reseller | BotBot Logs | BotBot Logs | access reseller pages |  |
| `/resellers/botbot-scheduled-messages` | apps-resellers-botbot-scheduled-messages | BotBot Scheduled Messages | BotBot Scheduled Messages | access reseller pages |  |
| `/resellers/statistics` | apps-resellers-statistics | Resellers Statistics | Resellers Statistics | access reseller pages |  |
| `/resellers/sign-in-logs` | apps-audit-sign-in-logs | Sign-in Logs | Sign-in Logs | view sign-in logs |  |
| `/resellers/audit` | apps-audit-resellers | Audit Resellers | Audit Resellers |  |  |
| `/resellers/add` | apps-resellers-add | Add Reseller | Add Reseller | access reseller pages |  |
| `/billing/credit-orders` | billing-credit-orders | Credit Orders | Credit Orders | access reseller pages |  |
| `/billing/domain-registration-credits` | billing-domain-registration-credits | Registration Credits | Registration Credits | access reseller pages |  |
| `/billing/domain-orders` | billing-domain-orders | Domain Orders | Domain Orders | papel: super-admin |  |
| `/billing/customers-orders` | billing-customers-orders | Customers Orders | Customers Orders | create customer |  |
| `/billing/membership-transactions` | billing-membership-transactions | Membership Transactions | Membership Transactions | can setup membership |  |
| `/botbot/membership-reminder` | botbot-membership-reminder | BotBot Membership Reminder | BotBot Membership Reminder | can setup membership |  |
| `/automation/botbot-settings` | automation-botbot-settings | BotBot Settings | BotBot Settings | create customer | redireciona para {path:/integrations/botbot} |
| `/automation/botbot-automatic-test` | automation-botbot-automatic-test | BotBot Automatic Test | BotBot Automatic Test | create customer |  |
| `/automation/botbot-customers` | automation-botbot-customers | BotBot Automation Customers | BotBot Automation Customers | create customer |  |
| `/automation/botbot-resellers` | automation-botbot-resellers | BotBot Automation Resellers | BotBot Automation Resellers | access reseller pages |  |
| `/membership/renew` | membership-renew | Renew My Membership |  |  |  |
| `/system/servers` | apps-servers-listing | Servers | Servers | create server |  |
| `/settings/servers-copy` | apps-servers-copy | Copy Server | Copy Server | create subpanels |  |
| `/system/notices` | apps-notices-listing | Notices | Notices | create notice |  |
| `/customers/subscribe` | apps-utilities-customer-subscribe | Customer Subscribe | Customer Subscribe | use customer subscribe |  |
| `/resellers/remove` | apps-utilities-remove-reseller | Remove Reseller | Remove Reseller | create subpanels |  |
| `/system/default-playlist-template` | apps-utilities-default-playlist-template | Default Playlist Template | Default Playlist Template | edit default playlist template |  |
| `/system/credit-bonus-campaigns` | apps-credit-bonus-campaign-listing | Bonus Campaigns | Bonus Campaigns | create credit-bonus-campaign |  |
| `/system/packages` | apps-packages-listing | Packages | Packages | create package |  |
| `/system/packages-price` | apps-packages-price | Packages | Packages | access reseller pages |  |
| `/system/permissions` | apps-permissions | Permissions | Permissions | papel: super-admin |  |
| `/system/audit` | apps-audit-system | System Audit | System Audit | papel: super-admin |  |
| `/system/server-request-logs` | system-server-request-logs | Server Request Logs | Server Request Logs | papel: super-admin |  |
| `/settings/general` | settings-general | General Settings | General Settings | update general settings |  |
| `/settings/content-requests` | settings-content-requests | Requests | Settings > Requests | update content-request settings |  |
| `/settings/panel-subscription` | settings-panel-subscription | Panel Subscription | Settings > Panel Subscription | qualquer: manage panel addons | middleware: auth |
| `/settings/domains` | settings-domains | Domains Settings | Domains Settings | update domains settings |  |
| `/settings/notifications` | settings-notifications | Notifications Settings | Notifications Settings | update notifications settings |  |
| `/settings/maintenance` | settings-maintenance | Maintenance Settings | Maintenance Settings | update maintenance settings |  |
| `/settings/domain` | settings-domain | Panel Domain Settings | Panel Domain Settings | update domain settings |  |
| `/settings/backup` | settings-backup | Backup Restoration | Backup Restoration | update backup settings |  |
| `/settings/customers` | settings-customers | Customers Settings | Customers Settings | update customers settings |  |
| `/settings/resellers` | settings-resellers | Resellers Settings | Resellers Settings | update resellers settings |  |
| `/settings/style` | settings-style | Style Settings | Style Settings | update style settings |  |
| `/settings/integrations` |  |  |  |  | redireciona para /settings/developers |
| `/settings/developers` | settings-developers | Developers Settings | Developers Settings | update developers settings |  |
| `/settings/settings-copy` | apps-settings-copy | Copy Settings | Copy Settings | create subpanels |  |
| `/system/credit-packages` | apps-credit-packages-listing | Credit Packages | Credit Packages | create credit-package |  |
| `/system/credit-packages-price` | apps-credit-packages-price | Credit Packages | Credit Packages | access reseller pages |  |
| `/system/trialblocker` | apps-trialblocker-listing | Trial Blocker | Trial Blocker | create trialblocker |  |
| `/system/membership-plans` | apps-membership-plans-listing | Membership Plans | Membership Plans | create membership plans |  |
| `/system/subpanels` | apps-subpanels-listing | Subpanels | Subpanels |  |  |
| `/checkout/:domainId/:customerId/confirmation/:status` | checkout-payment-confirmation | Renew |  |  |  |
| `/checkout/:domainId/:customerId` | checkout-payment | Renew |  |  |  |
| `/rs/:domainId/:resellerId` | referral-reseller-2 | Create an Account |  |  |  |
| `/cs/:domainId/:resellerId` | customer-subscribe | Create an Account |  |  |  |
| `/integrations/:integrationId` | integration-page | Integration | Integrations |  |  |
| `/log/:uuid` | log | Log | Log |  |  |
| `/reset-password-with-token/:token` | reset-password-with-token | Reset Password |  |  |  |
| `/dashboard` | dashboard | Dashboard | Statistics | create customer |  |
| `/notices` | notices | Notices | Notices | view notice |  |
| `/notifications` | notifications | Notifications | Notifications |  |  |
| `/credit-purchase` | credit-purchase | Purchase Credit | Purchase Credit | create customer |  |
| `/support-tickets` | apps-support-tickets | Support Tickets | Support Tickets | create customer |  |
| `/account-settings` | account-settings | Profile | Profile |  |  |
| `/integrations` | integrations | Integrations | Integrations |  |  |
| `/account-security` | account-security | Account Security | Account Security |  |  |
| `/active-sessions` | active-sessions | Active Sessions | Active Sessions |  |  |
| `/customers` | apps-customers-listing | Customers | Customers | create customer |  |
| `/resellers` | apps-resellers-listing | Resellers | Resellers | access reseller pages |  |
| `/content` | content | New Content | New Content | create customer |  |
| `/server-statistics` | server-statistics | Server Statistics | Server Statistics | create customer |  |
| `/chatbot` | apps-utilities-chatbot | ChatBot | ChatBot | use chatbot |  |
| `/unban-ip-address` | apps-utilities-unban-ip-address | Unban IP Address | Unban IP Address | unban ip address |  |
| `/feature-request` | feature-request | Feature Requests | Feature Requests | create subpanels |  |
| `/changelog` | changelog | Changelog | Changelog | create customer |  |
| `/` |  |  |  |  | redireciona para /dashboard; middleware: auth |
| `/sign-in` | sign-in | Sign In |  |  |  |
| `/sign-out` | sign-out | Sign Out |  |  |  |
| `/forgot-password` | forgot-password | Forgot Password |  |  |  |
| `/reset-password` | reset-password | Reset Password |  |  |  |
| `/` |  |  |  |  |  |
| `/404` | 404 | Error 404 |  |  |  |
| `/500` | 500 | Error 500 |  |  |  |
| `/` |  |  |  |  |  |
| `/:pathMatch(.*)*` |  |  |  |  | redireciona para /404 |


## 10. Endpoints da API observados

Endpoints `/api/...` efetivamente chamados pelo painel durante a coleta, com o método HTTP e as rotas que os disparam. A coluna de observação traz o status HTTP obtido por chamada direta autenticada (quando testado).

| Método | Endpoint | Usado em (rotas) | Observação |
|---|---|---|---|
| `GET` | `/api/audit/customers` | /customers/audit | status na coleta: 200 |
| `GET` | `/api/audit/my-sign-in-logs` | /active-sessions |  |
| `GET` | `/api/audit/resellers` | /resellers/audit | status na coleta: 200 |
| `GET` | `/api/audit/sign-in-logs` | /resellers/sign-in-logs | status na coleta: 200 |
| `GET` | `/api/auth/active-sessions` | /active-sessions | status na coleta: 200 |
| `GET` | `/api/auth/me` | /dashboard, /notices, /notifications, /credit-purchase, /support-tickets, /account-settings, /integrations, /account-security, /active-sessions, /customers, /customers/add, /customers/renewal-assistant, /customers/live-connections, /customers/statistics, /customers/deleted, /customers/coupons, /customers/coupons/add, /customers/migration, /customers/migration/add, /customers/mass-delete, /customers/move, /customers/botbot-logs, /customers/botbot-queued-messages, /customers/botbot-scheduled-messages, /customers/audit, /customers/subscribe, /resellers, /resellers/add, /resellers/credit-transactions, /resellers/renew-membership, /resellers/bulk-membership, /resellers/referral-link, /resellers/restore-reseller, /resellers/deleted, /resellers/move, /resellers/import, /resellers/panel-migration, /resellers/botbot-logs, /resellers/botbot-scheduled-messages, /resellers/statistics, /resellers/sign-in-logs, /resellers/audit, /resellers/remove, /billing/credit-orders, /billing/domain-registration-credits, /billing/customers-orders, /billing/membership-transactions, /botbot/membership-reminder, /automation/botbot-automatic-test, /automation/botbot-customers, /automation/botbot-resellers, /system/servers, /system/servers/add, /system/servers/resync, /system/servers/mass-migrate, /system/servers/token-manager, /system/notices, /system/notices/add, /system/default-playlist-template, /system/credit-bonus-campaigns, /system/credit-bonus-campaigns/add, /system/packages, /system/packages/add, /system/packages-price, /system/credit-packages, /system/credit-packages/add, /system/credit-packages-price, /system/trialblocker, /system/trialblocker/add, /system/membership-plans, /system/membership-plans/add, /system/subpanels, /system/subpanels/add, /settings/general, /settings/content-requests, /settings/domains, /settings/notifications, /settings/maintenance, /settings/domain, /settings/backup, /settings/customers, /settings/resellers, /settings/style, /settings/developers, /settings/developers/api-reference, /settings/servers-copy, /settings/settings-copy, /utilities/domains, /content, /server-statistics, /chatbot, /unban-ip-address, /feature-request, /changelog, /integrations/reseller-api, /integrations/reseller-api/api-reference, /integrations/reseller-api/deliveries, /integrations/botbot, /membership/renew | status na coleta: 200 |
| `GET` | `/api/botbot/logs` | /customers/botbot-logs, /resellers/botbot-logs |  |
| `GET` | `/api/content-request/notification-preference` | /settings/content-requests | status na coleta: 402 |
| `GET` | `/api/content-request/questions` | /settings/content-requests | status na coleta: 402 |
| `GET` | `/api/content-request/settings` | /settings/content-requests | status na coleta: 402 |
| `GET` | `/api/content-request/webhooks` | /settings/content-requests | status na coleta: 402 |
| `GET` | `/api/content/BV4D3rLaqZ` | /content |  |
| `GET` | `/api/creditbonuscampaigns` | /system/credit-bonus-campaigns | status na coleta: 403 |
| `GET` | `/api/creditbonuscampaigns/list` | /credit-purchase |  |
| `GET` | `/api/creditorders` | /billing/credit-orders | status na coleta: 200 |
| `GET` | `/api/creditpackages` | /system/credit-packages | status na coleta: 200 |
| `GET` | `/api/creditpackages/list` | /credit-purchase |  |
| `GET` | `/api/creditpackages/price` | /system/credit-packages-price | status na coleta: 200 |
| `GET` | `/api/customer-coupons` | /customers/coupons | status na coleta: 200 |
| `GET` | `/api/customermigrations` | /customers/migration | status na coleta: 200 |
| `GET` | `/api/customerorders` | /billing/customers-orders | status na coleta: 200 |
| `GET` | `/api/customers` | /customers, /customers/deleted, /customers/mass-delete | status na coleta: 200 |
| `GET` | `/api/customers/botbot-queued-messages` | /customers/botbot-queued-messages |  |
| `GET` | `/api/customers/botbot-scheduled-messages` | /customers/botbot-scheduled-messages |  |
| `POST` | `/api/customers/calculate-customer-credits` | /customers/add |  |
| `POST` | `/api/customers/calculate-plan-price` | /customers/add |  |
| `GET` | `/api/customers/expiring` | /dashboard | status na coleta: 200 |
| `GET` | `/api/customers/recovery/dispatch-history` | /customers/renewal-assistant |  |
| `GET` | `/api/customers/recovery/lapsed` | /customers/renewal-assistant |  |
| `GET` | `/api/customers/statistics` | /customers/statistics | status na coleta: 200 |
| `GET` | `/api/customers/statistics/top10` | /customers/statistics |  |
| `GET` | `/api/dashboard/ai-analysis` | /dashboard, /customers/renewal-assistant | status na coleta: 200 |
| `GET` | `/api/dashboard/charts/customer-retention` | /dashboard |  |
| `GET` | `/api/dashboard/charts/lost-revenue` | /dashboard, /customers/renewal-assistant |  |
| `GET` | `/api/dashboard/charts/new-customers` | /dashboard |  |
| `GET` | `/api/dashboard/charts/revenue-forecast` | /dashboard |  |
| `GET` | `/api/dashboard/metrics/recovery` | /dashboard, /customers/renewal-assistant | status na coleta: 200 |
| `GET` | `/api/dashboard/preferences` | /dashboard | status na coleta: 200 |
| `GET` | `/api/default-playlist-templates` | /system/default-playlist-template | status na coleta: 403 |
| `GET` | `/api/domain-registration-credits` | /billing/domain-registration-credits | status na coleta: 403 |
| `GET` | `/api/domains/available-servers` | /utilities/domains | status na coleta: 403 |
| `GET` | `/api/feature-request` | /feature-request | status na coleta: 403 |
| `GET` | `/api/integration/openapi.json` | /settings/developers/api-reference | status na coleta: 403 |
| `GET` | `/api/integrations` | /integrations, /integrations/botbot | status na coleta: 200 |
| `GET` | `/api/membershipplans` | /system/membership-plans | status na coleta: 403 |
| `GET` | `/api/membershiptransactions` | /billing/membership-transactions | status na coleta: 200 |
| `GET` | `/api/notices` | /system/notices |  |
| `GET` | `/api/notices/list` | /dashboard, /notices, /chatbot | status na coleta: 200 |
| `GET` | `/api/notifications` | /notifications | status na coleta: 200 |
| `GET` | `/api/packages` | /system/packages | status na coleta: 403 |
| `GET` | `/api/packages/price` | /system/packages-price | status na coleta: 200 |
| `GET` | `/api/reports/credit-transactions` | /resellers/credit-transactions | status na coleta: 200 |
| `GET` | `/api/reseller-api/v1/me/webhooks` | /integrations/reseller-api/deliveries | status na coleta: 402 |
| `GET` | `/api/reseller-api/v1/openapi.json` | /integrations/reseller-api/api-reference | status na coleta: 402 |
| `GET` | `/api/resellers` | /resellers, /resellers/deleted, /resellers/remove | status na coleta: 200 |
| `GET` | `/api/resellers/botbot-scheduled-messages` | /resellers/botbot-scheduled-messages |  |
| `GET` | `/api/resellers/bulk-membership/preview` | /resellers/bulk-membership |  |
| `GET` | `/api/resellers/deleted` | /resellers/restore-reseller |  |
| `GET` | `/api/resellers/list` | /customers, /customers/add, /customers/statistics, /customers/deleted, /customers/mass-delete, /customers/move, /customers/audit, /resellers, /resellers/add, /resellers/credit-transactions, /resellers/move, /resellers/statistics, /resellers/audit, /resellers/remove, /billing/credit-orders, /billing/customers-orders, /billing/membership-transactions, /system/servers/resync | status na coleta: 200 |
| `GET` | `/api/resellers/membership-list` | /botbot/membership-reminder |  |
| `GET` | `/api/resellers/membership-report` | /resellers/renew-membership |  |
| `GET` | `/api/resellers/roles` | /resellers, /resellers/add, /resellers/renew-membership, /resellers/bulk-membership, /resellers/referral-link, /settings/resellers | status na coleta: 200 |
| `GET` | `/api/resellers/statistics` | /resellers/statistics |  |
| `GET` | `/api/resellers/statistics/top10` | /resellers/statistics |  |
| `GET` | `/api/servers` | /dashboard, /resellers/add, /automation/botbot-automatic-test, /system/servers, /system/servers/resync, /settings/servers-copy | status na coleta: 200 |
| `GET` | `/api/servers/bouquets/BV4D3rLaqZ/true` | /customers/add |  |
| `GET` | `/api/servers/licence` | /system/servers/add | status na coleta: 403 |
| `GET` | `/api/servers/limit` | /system/servers | status na coleta: 403 |
| `GET` | `/api/servers/resync/latest` | /system/servers/resync |  |
| `GET` | `/api/settings/backup/list` | /settings/backup | status na coleta: 403 |
| `GET` | `/api/settings/countries` | /settings/domains | status na coleta: 200 |
| `GET` | `/api/settings/currencies` | /settings/general | status na coleta: 200 |
| `GET` | `/api/settings/customers` | /settings/customers | status na coleta: 403 |
| `GET` | `/api/settings/developers` | /settings/developers | status na coleta: 403 |
| `GET` | `/api/settings/domain` | /settings/domain | status na coleta: 403 |
| `GET` | `/api/settings/domains` | /settings/domains | status na coleta: 403 |
| `GET` | `/api/settings/domains/payment-gateways` | /settings/domains | status na coleta: 403 |
| `GET` | `/api/settings/domains/servers` | /settings/domains | status na coleta: 403 |
| `GET` | `/api/settings/general` | /settings/general | status na coleta: 403 |
| `GET` | `/api/settings/locales` | /settings/general | status na coleta: 200 |
| `GET` | `/api/settings/logo/m1DK15aY` | /settings/style |  |
| `GET` | `/api/settings/maintenance` | /settings/maintenance | status na coleta: 403 |
| `GET` | `/api/settings/notifications` | /settings/notifications | status na coleta: 403 |
| `GET` | `/api/settings/public` | /dashboard, /notices, /notifications, /credit-purchase, /support-tickets, /account-settings, /integrations, /account-security, /active-sessions, /customers, /customers/add, /customers/renewal-assistant, /customers/live-connections, /customers/statistics, /customers/deleted, /customers/coupons, /customers/coupons/add, /customers/migration, /customers/migration/add, /customers/mass-delete, /customers/move, /customers/botbot-logs, /customers/botbot-queued-messages, /customers/botbot-scheduled-messages, /customers/audit, /customers/subscribe, /resellers, /resellers/add, /resellers/credit-transactions, /resellers/renew-membership, /resellers/bulk-membership, /resellers/referral-link, /resellers/restore-reseller, /resellers/deleted, /resellers/move, /resellers/import, /resellers/panel-migration, /resellers/botbot-logs, /resellers/botbot-scheduled-messages, /resellers/statistics, /resellers/sign-in-logs, /resellers/audit, /resellers/remove, /billing/credit-orders, /billing/domain-registration-credits, /billing/customers-orders, /billing/membership-transactions, /botbot/membership-reminder, /automation/botbot-automatic-test, /automation/botbot-customers, /automation/botbot-resellers, /system/servers, /system/servers/add, /system/servers/resync, /system/servers/mass-migrate, /system/servers/token-manager, /system/notices, /system/notices/add, /system/default-playlist-template, /system/credit-bonus-campaigns, /system/credit-bonus-campaigns/add, /system/packages, /system/packages/add, /system/packages-price, /system/credit-packages, /system/credit-packages/add, /system/credit-packages-price, /system/trialblocker, /system/trialblocker/add, /system/membership-plans, /system/membership-plans/add, /system/subpanels, /system/subpanels/add, /settings/general, /settings/content-requests, /settings/domains, /settings/notifications, /settings/maintenance, /settings/domain, /settings/backup, /settings/customers, /settings/resellers, /settings/style, /settings/developers, /settings/developers/api-reference, /settings/servers-copy, /settings/settings-copy, /utilities/domains, /content, /server-statistics, /chatbot, /unban-ip-address, /feature-request, /changelog, /integrations/reseller-api, /integrations/reseller-api/api-reference, /integrations/reseller-api/deliveries, /integrations/botbot, /membership/renew | status na coleta: 200 |
| `GET` | `/api/settings/resellers` | /settings/resellers | status na coleta: 403 |
| `GET` | `/api/settings/style` | /settings/style | status na coleta: 403 |
| `GET` | `/api/settings/theme` | /settings/style | status na coleta: 403 |
| `GET` | `/api/settings/timezones` | /system/servers/add, /settings/general | status na coleta: 200 |
| `GET` | `/api/subpanels` | /system/subpanels | status na coleta: 403 |
| `GET` | `/api/supporttickets/mine` | /support-tickets | status na coleta: 200 |
| `GET` | `/api/trialblockers` | /system/trialblocker | status na coleta: 200 |
| `GET` | `/api/users/online-count` | /settings/servers-copy | status na coleta: 200 |


## 11. Documentação detalhada por módulo

As seções a seguir detalham cada tela por módulo: rotas, propósito, o que a tela mostra, campos de formulário, tabelas de dados, ações e endpoints. Foram derivadas do DOM renderizado no momento da coleta.

### Módulo 1 — Visão Geral e Conta

#### Visão geral

O módulo "Visão Geral e Conta" reúne a página inicial operacional do revendedor (Dashboard com métricas, análise de IA, clientes expirando e Teste Rápido), os canais informativos (Avisos, Notificações, Novidades/changelog), a compra de créditos, o suporte, e a gestão da própria conta (Perfil, Integrações de pagamento/mensagens/análise, Segurança/2FA, Sessões Ativas, Desbloqueio de IP, Renovação de mensalidade e Solicitação de funcionalidades).

#### Rotas do módulo

| Rota | Título da página | Permissão exigida | Observação |
|---|---|---|---|
| /dashboard | Dashboard | create customer | acesso direto |
| /notices | Avisos | view notice | acesso direto |
| /notifications | Notificações | — (sem permissão declarada no meta) | acesso direto |
| /credit-purchase | Comprar Crédito | create customer | acesso direto |
| /support-tickets | Tickets de Suporte | create customer | acesso direto |
| /account-settings | Perfil | — (string vazia no meta) | acesso direto |
| /integrations | Integrações | — (string vazia no meta) | acesso direto; URL final com `?tab=browse` |
| /account-security | Segurança da Conta | — (string vazia no meta) | acesso direto |
| /active-sessions | Sessões Ativas | — (string vazia no meta) | acesso direto |
| /changelog | Novidades | create customer | acesso direto |
| /feature-request | Solicitar Funcionalidades | create subpanels | acesso direto |
| /unban-ip-address | Desbloquear Endereço IP | unban ip address | acesso direto |
| /membership/renew | Renovar Minha Mensalidade | — (sem permissão declarada no meta) | acesso direto |

Nenhuma rota deste lote redirecionou para `/dashboard`; não há caso de "acesso negado / redirecionado" observável no JSON.

#### Páginas

##### /dashboard — Dashboard

- **URL hash:** `#/dashboard`
- **Título:** Dashboard (`Dashboard | CINEVISION ONE`)
- **Propósito:** tela inicial do revendedor; concentra métricas, atalhos operacionais e comunicados.
- **O que a tela mostra:** cabeçalho da conta (saldo de créditos, usuários online, badge "2FA Desativada"); central de links oficiais (gestor de cobrança, painéis, portal VOD, ferramentas, apps próprios, canais); widgets com filtros de período (abas "Mês passado", "Últimos 30 dias", "Mês atual", "Personalizado" e "Clientes"/"Revendas"); "Análise de IA Sigma" (botão "Gerar análise"); "Clientes expirando e expirados" (com links de edição por cliente); "Teste Rápido" (longa lista de botões por duração/tipo/dispositivo/app parceiro); "Assistente de Renovação"; modal "Últimas alterações Sigma v3.92" (configurações da conta, painel, outras alterações; "Não mostrar novamente"/"Fechar").
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| (sem label) — pesquisa global | text (`Pesquisar`) | Não | campo de busca no topo |
| Referência | text | Não | parte do diálogo global "Adicionar Créditos" |
| Criar pedido de cliente para este pagamento | checkbox | Não | diálogo global |
| Use casas decimais | checkbox | Não | diálogo global |
| (sem label) — valor | number | Não | diálogo global |
| (sem label) — texto | text | Não | diálogo global |
| (sem label) — observações | textarea | Não | diálogo global |
| Registrar como pagamento manual/offline/em dinheiro | checkbox | Não | diálogo global |
| Eu concordo em transferir 0 créditos | checkbox | Não | diálogo global |
| Visibilidade de widgets (`modern-widget-modern:customer:*`: headline, financial, ai-analysis, growth-recovery, renewal-assistant-cta, expiring-customers, quick-test) | checkbox | Não | liga/desliga widgets do dashboard |
| Layout: Única Coluna / Duas Colunas | radio | Não | valores `1` / `2` |
| Ordem/exibição de widgets (`widget-order-a-*`, `widget-order-b-*`: receita, status de servidores, novos clientes, previsão de receita, receita perdida, subrevendas, próprios, total, expirando, quick-test, novas revendas, mensalistas expirando, mensalistas, créditos consumidos, revendas com poucos créditos) | checkbox | Não | ~20 toggles de ordenação/visibilidade |

- **Tabelas de dados:** nenhuma `<table>` capturada (`tables: []`).
- **Ações/botões principais:** "Gerar análise", "Teste Rápido" (+ ~27 botões de teste por duração/dispositivo/app), "Renovar", "Adicionar", "Adicionar Cliente", "Abrir assistente" (Assistente de Renovação), "Salvar"/"Redefinir"/"Mostrar Todos"/"Ocultar Todos" (personalização do painel), "Copiar"/"Excluir", "Voltar para o painel clássico".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/servers`, `GET /api/dashboard/charts/new-customers?period=last-30-days`, `GET /api/customers/expiring`, `GET /api/dashboard/charts/customer-retention`, `GET /api/dashboard/metrics/recovery`, `GET /api/dashboard/charts/revenue-forecast`, `GET /api/dashboard/charts/lost-revenue`, `GET /api/dashboard/ai-analysis`, `GET /api/dashboard/preferences`, `GET /api/notices/list`.

##### /notices — Avisos

- **URL hash:** `#/notices`
- **Título:** Avisos (`Avisos | CINEVISION ONE`)
- **Propósito:** exibir comunicados administrativos aos revendedores.
- **O que a tela mostra:** comunicado "📢 COMUNICADO IMPORTANTE AOS REVENDEDORES 📢" com regras (recarga obrigatória a cada 45 dias sob risco de exclusão automática; mínimo de créditos para gerar testes grátis; manter saldo para evitar bloqueio). Sem abas e sem tabelas.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Referência | text | Não | diálogo global "Adicionar Créditos" presente no DOM |
| Criar pedido de cliente para este pagamento | checkbox | Não | diálogo global |
| Use casas decimais | checkbox | Não | diálogo global |
| (sem label) — valor | number | Não | diálogo global |
| (sem label) — texto | text | Não | diálogo global |
| (sem label) — observações | textarea | Não | diálogo global |
| Registrar como pagamento manual/offline/em dinheiro | checkbox | Não | diálogo global |
| Eu concordo em transferir 0 créditos | checkbox | Não | diálogo global |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** navegação padrão do menu ("Visão geral", "Clientes", "Revendas", "Mensalista", "Financeiro", "Relatórios", "BotBot", "Utilitários", "Sistema"); ações genéricas de dialogs ("Renovar", "Adicionar", "Fechar", "Copiar e Fechar", "Teste Rápido").
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/notices/list`.

##### /notifications — Notificações

- **URL hash:** `#/notifications`
- **Título:** Notificações (`Notificações | CINEVISION ONE`)
- **Propósito:** caixa de notificações da conta.
- **O que a tela mostra:** estado vazio com o texto "Não há notificações para mostrar". Sem abas, cards ou tabelas.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Referência | text | Não | diálogo global presente no DOM |
| Criar pedido de cliente para este pagamento | checkbox | Não | diálogo global |
| Use casas decimais | checkbox | Não | diálogo global |
| (sem label) — valor | number | Não | diálogo global |
| (sem label) — texto | text | Não | diálogo global |
| (sem label) — observações | textarea | Não | diálogo global |
| Registrar como pagamento manual/offline/em dinheiro | checkbox | Não | diálogo global |
| Eu concordo em transferir 0 créditos | checkbox | Não | diálogo global |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** apenas navegação padrão e ações genéricas de dialogs ("Renovar", "Adicionar", "Fechar", "Copiar e Fechar", "Teste Rápido").
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/notifications?page=1&per_page=20`.

##### /credit-purchase — Comprar Crédito

- **URL hash:** `#/credit-purchase`
- **Título:** Comprar Crédito (`Comprar Crédito | CINEVISION ONE`)
- **Propósito:** venda de pacotes de créditos ao revendedor.
- **O que a tela mostra:** grade de 13 pacotes como cards: 1, 5, 10, 25, 50, 75, 100, 150, 200, 250, 500, 750 e 1000 créditos, cada um com total (R$ 10,00; R$ 40,00; R$ 70,00; R$ 175,00; R$ 325,00; R$ 487,50; R$ 600,00; R$ 900,00; R$ 1.100,00; R$ 1.375,00; R$ 2.500,00; R$ 3.750,00; R$ 4.500,00), valor unitário e botão "Comprar N créditos por R$ ...". Badges de total por pacote.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Referência | text | Não | diálogo global presente no DOM |
| Criar pedido de cliente para este pagamento | checkbox | Não | diálogo global |
| Use casas decimais | checkbox | Não | diálogo global |
| (sem label) — valor | number | Não | diálogo global |
| (sem label) — texto | text | Não | diálogo global |
| (sem label) — observações | textarea | Não | diálogo global |
| Registrar como pagamento manual/offline/em dinheiro | checkbox | Não | diálogo global |
| Eu concordo em transferir 0 créditos | checkbox | Não | diálogo global |

- **Tabelas de dados:** nenhuma (`tables: []`); pacotes renderizados como cards/links `javascript:`, não como `<table>`.
- **Ações/botões principais:** 13 botões "Comprar ..." (um por pacote); ações genéricas ("Renovar", "Adicionar", "Fechar", "Teste Rápido").
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/creditpackages/list`, `GET /api/creditbonuscampaigns/list`.

##### /support-tickets — Tickets de Suporte

- **URL hash:** `#/support-tickets`
- **Título:** Tickets de Suporte (`Tickets de Suporte | CINEVISION ONE`)
- **Propósito:** canal de suporte entre revendedor e administração.
- **O que a tela mostra:** card "Suporte" com uma thread (mensagem do usuário solicitando atualização de conteúdo VOD + resposta do administrador orientando ao portal de VOD citado nos avisos); badge "Lida"; rodapé "Sem mais mensagens".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| (sem label, placeholder "Enter para enviar") | text | Não | caixa de envio da thread |
| Referência | text | Não | diálogo global presente no DOM |
| Criar pedido de cliente para este pagamento | checkbox | Não | diálogo global |
| Use casas decimais | checkbox | Não | diálogo global |
| (sem label) — valor | number | Não | diálogo global |
| (sem label) — texto | text | Não | diálogo global |
| (sem label) — observações | textarea | Não | diálogo global |
| Registrar como pagamento manual/offline/em dinheiro | checkbox | Não | diálogo global |
| Eu concordo em transferir 0 créditos | checkbox | Não | diálogo global |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Enviar" (thread), "Teste Rápido", ações genéricas ("Renovar", "Adicionar", "Fechar", "Copiar e Fechar").
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/supporttickets/mine`.

##### /account-settings — Perfil

- **URL hash:** `#/account-settings`
- **Título:** Perfil (`Perfil | CINEVISION ONE`)
- **Propósito:** editar dados de contato, visibilidade e preferências da conta.
- **O que a tela mostra:** card "Perfil" com seções E-mail, Telegram, WhatsApp, Idioma, permissões do master, exibição de ganhos, filtros, barra mobile e layout lateral; link "Abrir Integrações".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| E-mail (`email`, placeholder "Obrigatório") | email | Não (flag `required: false` no JSON; placeholder indica obrigatoriedade visual) | valor mascarado na doc |
| Telegram (`telegram`, placeholder "Opcional") | text | Não | — |
| Mostre meu Telegram para os meus revendas (`show_telegram_to_resellers`) | select-one | Não | "Não" / "Sim" |
| Mostrar meu Telegram na área do cliente (`show_telegram_in_customer_area`) | select-one | Não | "Não" / "Sim" |
| WhatsApp (`whatsapp`, placeholder "Opcional") | text | Não | formato com código do país; valor mascarado na doc |
| Mostre meu WhatsApp para os meus revendas (`show_whatsapp_to_resellers`) | select-one | Não | "Não" / "Sim" |
| Mostrar meu WhatsApp na área do cliente (`show_whatsapp_in_customer_area`) | select-one | Não | "Não" / "Sim" |
| Idioma (`locale`) | select-one | Não | English, Español, Deutsch, Français, Português, Română |
| Permitir que meu master renove meus mensalistas (`allow_reseller_to_renew_subresellers`) | select-one | Não | "Não" / "Sim" |
| Permitir que meu master veja os dados pessoais dos meus clientes e revendas (`allow_parent_to_view_personal_data`) | select-one | Não | "Não" / "Sim" |
| Mostrar ganhos na Dashboard (`show_earnings_dashboard`) | select-one | Não | "Não" / "Sim" |
| Lembrar filtro das páginas (`remember_page_filters`) | select-one | Não | "Não" / "Sim" |
| Mostrar barra de navegação para celular (`show_mobile_navbar`) | select-one | Não | "Sim" / "Não" |
| Layout da barra lateral (`aside_layout`) | select-one | Não | "Clássico" / "Recolhível - sem ícones" / "Recolhível - com ícones" |
| Referência + demais campos do diálogo global | text/checkbox/number/textarea | Não | mesmo conjunto global das demais páginas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Salvar", "Descartar", "Perfil", "Teste Rápido".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me` (nenhum endpoint de salvamento observado nas chamadas capturadas).

##### /integrations — Integrações

- **URL hash:** `#/integrations?tab=browse` (rota `#/integrations`)
- **Título:** Integrações (`Integrações | CINEVISION ONE`)
- **Propósito:** ativar integrações de pagamento, mensagens e análise.
- **O que a tela mostra:** abas "Ativo 0", "Disponível 9", "Configurações"; filtros "Todos", "Mensagens", "Análises", "Formas de pagamento"; destaque "Receba mais rápido com a paggpay"; 9 itens: Meta Pixel (Análises), Asaas, Mercado Pago Primário, Mercado Pago Secundário, paggpay Primário, paggpay Secundário, PayPal, Stripe (Formas de pagamento) e BotBot (Mensagens), cada um com link "Suporte" externo e botão "Ativar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Pesquisar (placeholder "Pesquisar") | search | Não | filtro da lista de integrações |
| Referência + demais campos do diálogo global | text/checkbox/number/textarea | Não | mesmo conjunto global |

- **Tabelas de dados:** nenhuma (`tables: []`); lista renderizada como cards.
- **Ações/botões principais:** "Ativar" (por integração), "Configurar a paggpay", filtros por categoria, "Teste Rápido".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/integrations`.

##### /account-security — Segurança da Conta

- **URL hash:** `#/account-security`
- **Título:** Segurança da Conta (`Segurança da Conta | CINEVISION ONE`)
- **Propósito:** gerenciar senha, código de validação de suporte e 2FA.
- **O que a tela mostra:** cards "Login" (senha mascarada), "Código de validação de suporte" (gerar código temporário para validações), aviso "Melhore a Segurança da Sua Conta" (nenhum 2FA ativado; recomendação de ≥2 métodos) e 4 cards de 2FA: Aplicativo Autenticador, E-mail, Telegram e WhatsApp (este último exige BotBot configurado).
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Senha Atual (`currentpassword`) | password | Não (flag `required: false` no JSON) | troca de senha |
| Nova Senha (`newpassword`) | password | Não | troca de senha |
| Confirmar Nova Senha (`confirmpassword`) | password | Não | troca de senha |
| Referência + demais campos do diálogo global | text/checkbox/number/textarea | Não | mesmo conjunto global |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Alterar Senha" / "Atualizar Senha", "Gerar código", 4× "Configurar verificação em duas etapas", "Teste Rápido".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me` (nenhum endpoint de troca de senha, código de suporte ou 2FA observado nas chamadas capturadas).

##### /active-sessions — Sessões Ativas

- **URL hash:** `#/active-sessions`
- **Título:** Sessões Ativas (`Sessões Ativas | CINEVISION ONE`)
- **Propósito:** visualizar/encerrar sessões e auditar logins.
- **O que a tela mostra:** 2 sessões (navegador desktop atual + navegador mobile; cada uma com SO, localização, navegador/versão, data de login, última atividade e IP — valores mascarados nesta doc) e card "Histórico de Logins" com entradas sucessivas (data, SO, navegador, localização, IP) mais aviso para ativar 2FA.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Referência + demais campos do diálogo global | text/checkbox/number/textarea | Não | mesmo conjunto global; sem filtros de formulário próprios capturados em `inputs` |

- **Tabelas de dados:** nenhuma `<table>` capturada (`tables: []`); sessões e histórico renderizados como cards/lista.
- **Ações/botões principais:** "Deslogar" (por sessão não atual), "Sessão Atual" (indicador), "Teste Rápido".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/auth/active-sessions`, `GET /api/audit/my-sign-in-logs?page=1&resellerUsername=&resellerActionId=&action=&ipAddress=&createdFrom=&createdTo=`.

##### /changelog — Novidades

- **URL hash:** `#/changelog`
- **Título:** Novidades (`Novidades | CINEVISION ONE`)
- **Propósito:** histórico de versões da plataforma Sigma.
- **O que a tela mostra:** lista de versões de Sigma v3.92 (detalhada: Configurações da Conta, Painel, Outras alterações, cada uma com "Ir para a página") até v3.54 (só títulos visíveis no texto capturado); aviso de permissões ("alguns itens só aparecem com a permissão necessária; não compartilhar prints; falar com o master"); botão "Atualizar cache do app".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Pesquisar (placeholder "Pesquisar") | text | Não | busca da página |
| Referência + demais campos do diálogo global | text/checkbox/number/textarea | Não | mesmo conjunto global |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Atualizar cache do app", múltiplos "Ir para a página" (atalhos para Configurações, Dashboard, Migração, mensalistas, clientes, renewal-assistant, integrações, conteúdo, transações, billing, automação, suporte, excluídos, estatísticas, BotBot), "Teste Rápido".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me` (nenhum endpoint próprio de changelog observado).

##### /feature-request — Solicitar Funcionalidades

- **URL hash:** `#/feature-request`
- **Título:** Solicitar Funcionalidades (`Solicitar Funcionalidades | CINEVISION ONE`)
- **Propósito:** sugerir/votar em funcionalidades e oferecer cofinanciamento.
- **O que a tela mostra:** card "Enviar Solicitação" com texto explicativo (votar para priorizar; opção de contribuir com o custo para acelerar); headings contêm "Erro" (2×), sem lista de solicitações visível no texto capturado.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Pesquisar (placeholder "Pesquisar") | text | Não | busca da página |
| Descrição (`featureDescription`, placeholder "Descreva a funcionalidade que você gostaria") | textarea | Não (flag `required: false` no JSON) | corpo da solicitação |
| Quero contribuir para o custo de desenvolvimento desta funcionalidade | checkbox | Não | cofinanciamento |
| Referência + demais campos do diálogo global | text/checkbox/number/textarea | Não | mesmo conjunto global |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Enviar Solicitação" / "Enviar", "Teste Rápido".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/feature-request`.

##### /unban-ip-address — Desbloquear Endereço IP

- **URL hash:** `#/unban-ip-address`
- **Título:** Desbloquear Endereço IP (`Desbloquear Endereço IP | CINEVISION ONE`)
- **Propósito:** desbloquear IP de revenda bloqueado pelo próprio painel.
- **O que a tela mostra:** instrução "Endereço IPv4 ou IPv6"; esclarecimento de que desbloqueia IPs de revendas bloqueadas por este painel, não de clientes; orientação para descobrir o IP via site externo (whatismyipaddress); headings contêm "Erro" (2×), sem resultado visível.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| (sem label, placeholder "Obrigatório") — endereço IP | text | Sim (`required: true`) | IPv4 ou IPv6 |
| Referência + demais campos do diálogo global | text/checkbox/number/textarea | Não | mesmo conjunto global |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Continuar", "Teste Rápido".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me` (nenhum endpoint de desbloqueio observado nas chamadas capturadas).

##### /membership/renew — Renovar Minha Mensalidade

- **URL hash:** `#/membership/renew`
- **Título:** Renovar Minha Mensalidade (`Renovar Minha Mensalidade | CINEVISION ONE`)
- **Propósito:** renovação da mensalidade do próprio revendedor (conteúdo não detalhado no JSON).
- **O que a tela mostra:** apenas o título; texto visível capturado contém somente o shell (menu, créditos, 2FA, título) sem cards, tabelas ou instruções. Headings contêm "Erro" (2×).
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Referência + demais campos do diálogo global | text/checkbox/number/textarea | Não | único conjunto em `inputs`; sem campo próprio de renovação capturado |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** apenas ações genéricas ("Renovar", "Adicionar", "Fechar", "Copiar e Fechar", "Teste Rápido").
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me` (nenhum endpoint de renovação de mensalidade observado).

#### Endpoints de API do módulo

Lista consolidada e única (método + caminho observados em `apiCalls`; telemetria externa de logs excluída):

- `GET /api/settings/public`
- `GET /api/auth/me`
- `GET /api/servers`
- `GET /api/dashboard/charts/new-customers?period=last-30-days`
- `GET /api/customers/expiring`
- `GET /api/dashboard/charts/customer-retention`
- `GET /api/dashboard/metrics/recovery`
- `GET /api/dashboard/charts/revenue-forecast`
- `GET /api/dashboard/charts/lost-revenue`
- `GET /api/dashboard/ai-analysis`
- `GET /api/dashboard/preferences`
- `GET /api/notices/list`
- `GET /api/notifications?page=1&per_page=20`
- `GET /api/creditpackages/list`
- `GET /api/creditbonuscampaigns/list`
- `GET /api/supporttickets/mine`
- `GET /api/integrations`
- `GET /api/auth/active-sessions`
- `GET /api/audit/my-sign-in-logs?page=1&resellerUsername=&resellerActionId=&action=&ipAddress=&createdFrom=&createdTo=`
- `GET /api/feature-request`

#### Observações e limites

- **Sem tabelas capturadas:** todas as 13 rotas retornam `tables: []`. Listas visíveis (sessões, histórico de logins, pacotes de crédito, integrações, threads de suporte) são renderizadas como cards/listas, não como `<table>`.
- **Páginas vazias/estados vazios:** `/notifications` exibe "Não há notificações para mostrar"; `/membership/renew` exibe só o título, sem conteúdo operacional; `/feature-request` não exibe lista/votos, apenas o formulário.
- **Erros sinalizados nos headings:** `/feature-request`, `/unban-ip-address` e `/membership/renew` contêm headings "Erro" (2× cada). Detalhe do erro não está no texto capturado.
- **Ações sem endpoint observado:** "Salvar" (Perfil), "Alterar Senha"/"Gerar código"/2FA (Segurança), "Continuar" (Desbloquear IP), compra de pacotes (`javascript:`) e renovação de mensalidade não têm POST/PUT correspondente nas `apiCalls` capturadas — apenas GETs de leitura e os dois GETs base.
- **Chamadas base onipresentes:** `GET /api/settings/public` e `GET /api/auth/me` aparecem em todas as 13 rotas; são o shell (config pública + sessão), não lógica do módulo.
- **Telemetria excluída da lista:** todas as rotas registram `POST https://logs.smart-ti.com/api/2/envelope/...` (Sentry); tratado como observabilidade, não API do módulo.
- **Texto truncado na fonte:** campos `text` estão truncados a ~2000 caracteres; Dashboard e Sessões Ativas perdem parte do conteúdo visível.
- **Dados pessoais generalizados:** e-mail, telefone/WhatsApp, IPs, IDs de cliente, contadores e chaves foram omitidos ou generalizados nesta seção conforme a regra; consultar o JSON apenas via ferramenta local se necessário.
- **Inputs repetidos:** o conjunto do diálogo "Renovar/Adicionar Créditos" (Referência, pedido de cliente, casas decimais, valor, texto, observações, pagamento manual, concordância de transferência) aparece no DOM de todas as páginas; foi documentado como global em cada página para não inflar a leitura como campo próprio.

### Módulo 2 — Clientes

#### Visão geral

O módulo Clientes concentra o ciclo de vida do cliente IPTV da revenda: listagem e filtro de ativos, criação, renovação/recuperação de expirados, monitoramento de conexões ao vivo, estatísticas, lixeira de excluídos, cupons de desconto, migração via M3U, operações em massa (excluir/mover), mensagens BotBot (agendadas, em fila e logs), auditoria e link público de auto-cadastro.

#### Rotas do módulo

| Rota | Título da página | Permissão exigida | Observação |
|---|---|---|---|
| `/customers` | Clientes | `create customer` | Lista principal com filtros; 1 registro visível na captura |
| `/customers/add` | Adicionar Cliente | `create customer` | Formulário em aba única "Detalhes" |
| `/customers/renewal-assistant` | Assistente de Renovação | `create customer` | Selo Beta; funil de recuperação via BotBot/WhatsApp |
| `/customers/live-connections` | Conexões Ao Vivo | `create customer` | Tabela vazia na captura; aviso de carregamento lento |
| `/customers/statistics` | Estatísticas de Clientes | `create customer` | Cards Top 10, desempenho, criados/excluídos |
| `/customers/deleted` | Clientes Excluídos | `view deleted customers` | Lixeira; 31 registros (20 por página) |
| `/customers/coupons` | Cupons de Cliente | `create customer coupon` | Tabela vazia; link para `/coupons/add` |
| `/customers/coupons/add` | Adicionar Cupom | `create customer coupon` | Formulário de cupom; sem restrição por plano/cliente |
| `/customers/migration` | Migração de Cliente | `migrate customers using m3u` | Tabela vazia; link para `/migration/add` |
| `/customers/migration/add` | Adicionar Migração de Cliente | `migrate customers using m3u` | Cola URLs M3U (até 100/lote) |
| `/customers/mass-delete` | Excluir Clientes em Massa | `mass delete customers` | Ação irreversível com confirmação |
| `/customers/move` | Mover Clientes | `move customers from one reseller to another` | Move todos os clientes entre revendas |
| `/customers/botbot-logs` | Logs do BotBot | `create customer` | Tabela vazia |
| `/customers/botbot-queued-messages` | Mensagens em Fila do BotBot | `create customer` | Tabela vazia |
| `/customers/botbot-scheduled-messages` | Mensagens Agendadas no BotBot | `create customer` | Tabela vazia |
| `/customers/audit` | Auditoria Clientes | (meta sem `permission`; contém `userId`) | 40 registros; filtros por cliente, IP e data |
| `/customers/subscribe` | Cadastro de Cliente | `use customer subscribe` | Exibe URL pública de auto-cadastro da revenda |

> Nenhuma rota redirecionou para `/dashboard`. Todas carregaram na URL final correspondente ao `route`.

#### Páginas

> Nota geral sobre formulários: todas as rotas repetem os mesmos inputs genéricos dos modais globais ("Renovar", "Adicionar Créditos", "Detalhes do Cliente", "Nova Mensagem": campo Referência, checkboxes de pedido/pagamento manual/casas decimais/transferência de créditos, campos numéricos/texto sem rótulo). Esses inputs foram omitidos abaixo; só campos específicos de cada tela estão tabelados. Tabelas de calendário (Sun–Sat) são componentes de datepicker e foram ignoradas.

##### `/customers` — Clientes

- **URL hash:** `#/customers`
- **Título:** Clientes
- **Propósito:** listar, filtrar e operar clientes ativos (renovar, editar, testar, excluir).
- **O que a tela mostra:** filtros (situação, plano, teste, servidor, conexões, vencimento, criação), alternância lista/cards, paginação (5–100 itens), tabela de clientes com 1 registro na captura (usuário + plano + datas de vencimento/criação + situação "Ativo IPTV" + detalhes de plano/conexões + coluna de ações).
- **Campos de formulário (específicos):**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Pesquisar (`placeholder: Pesquisar`) | text | Não | Busca por nome de usuário (captura filtrada por um termo) |
| Vencimento de / Vencimento até | text (datepicker) | Não | Atalhos: Hoje, Ontem, Amanhã, 3/7 Dias Antes/Depois |
| Criado de / Criado até | text (datepicker) | Não | Mesmo componente de data |
| Itens por página | select | Não | 5, 10, 20 (padrão), 40, 60, 80, 100 |

- **Tabelas de dados:** `USUÁRIO | DATAS | SITUAÇÃO | DETALHES | AÇÕES`.
- **Ações/botões principais:** Adicionar (→ `#/customers/add`), Limpar Filtro, Mudar para Cards, Ações, Teste Rápido, Editar (→ `#/customers/edit/[id]` por linha).
- **Endpoints de API chamados:** `GET /api/customers?page=1&username=...&serverId=&packageId=&expiryFrom=&expiryTo=&createdFrom=&createdTo=&status=&isTrial=&connections=&perPage=20`, `GET /api/resellers/list` (+ base `GET /api/settings/public`, `GET /api/auth/me`).

##### `/customers/add` — Adicionar Cliente

- **URL hash:** `#/customers/add`
- **Título:** Adicionar Cliente
- **Propósito:** criar um cliente IPTV consumindo créditos da revenda.
- **O que a tela mostra:** aba única "Detalhes" com Servidor, Plano, regras de Usuário/Senha em texto, Vencimento opcional, Conexões, demonstrativo de custo em créditos e valor cobrado do cliente, Bouquets opcional, campos opcionais e observação. Botões Cancelar/Salvar.
- **Campos de formulário (específicos; rótulos ausentes no JSON, descritos por placeholder + texto visível):**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Usuário (`placeholder: Obrigatório`) | text | Sim (indicado pelo placeholder e pelo texto de regras) | Regras em tela: só letras/números/traços, 9–20 caracteres etc. |
| Senha (`placeholder: Obrigatório`) | text | Sim (placeholder) | Regras em tela: letras/números/traço/underline, mínimo de caracteres |
| Vencimento (`placeholder: Escolha uma data (Opcional)`) | text (datepicker) | Não | Em branco = calcula pela duração do plano |
| Conexões (valor inicial 1) | number | Não | Texto: criado com N conexões do plano; alterável depois na lista |
| Valor do plano (`placeholder: Opcional, usar o valor do plano`) | text | Não | Valor cobrado do cliente |
| Campos complementares (`placeholder: Opcional`, vários) | text | Não | Atributos opcionais sem rótulo no JSON |
| Observação (`placeholder: Opcional`) | textarea | Não | — |
| Continuar nesta tela após salvar | checkbox | Não | Marcado por padrão |
| Data/hora de vencimento (`Select date` / `Select time`) | text | Não | Componente de data/hora |

- **Tabelas de dados:** nenhuma (só datepicker).
- **Ações/botões principais:** Salvar, Cancelar (→ `#/customers`).
- **Endpoints de API chamados:** `GET /api/servers/bouquets/[id]/true`, `POST /api/customers/calculate-plan-price`, `POST /api/customers/calculate-customer-credits`, `GET /api/resellers/list` (+ base).

##### `/customers/renewal-assistant` — Assistente de Renovação (Beta)

- **URL hash:** `#/customers/renewal-assistant`
- **Título:** Assistente de Renovação
- **Propósito:** recuperar clientes expirados com campanha de mensagens via BotBot/WhatsApp, com métricas e análise de IA.
- **O que a tela mostra:** abas de coorte (Expirado · 3/7/30/90 dias), painel de funil (base do período, renovados, em aberto, taxa de renovação com meta de 30%), bloco "Análise de IA Sigma" (1 grátis/dia), receita renovada vs. perdida, renovações por dia, seletor de clientes ("Não renovou"), editor de mensagem com prévia e agendamento de envio. Captura com coorte de 3 dias: base de 1, 0 renovados.
- **Campos de formulário (específicos):**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Desconto | select | Não | 5%, 10%, 15%, 20% (selecionado), 25%, 30%, 40%, 50% OFF; gera cupom único ao iniciar envio |
| Mensagem (WhatsApp) | textarea | Não | Template com variáveis `{name}`, `{plan_price}`, `{expires_at}`, `{package}`, `{username}`, `{pay_url}` |
| Intervalo entre envios | select | Não | 5s a 2min (passos de 5s); valor capturado 60000 (1 min) |
| Incluir cupom de desconto / Incluir nota de remoção | toggles (texto) | Não | Opções do assistente |

- **Tabelas de dados:** nenhuma.
- **Ações/botões principais:** Expirado · 3/7/30/90 dias (abas), Gerar análise, Gerar mensagem (IA), Iniciar envio · 0, Ativar renovação automática, modelos de mensagem (Reativação 30 dias+, Última chance 20% OFF, Lembrete Telegram, Expirado padrão), canais (WhatsApp, Telegram, E-mail/SMS "EM BREVE").
- **Endpoints de API chamados:** `GET /api/customers/recovery/lapsed?cohort=3`, `GET /api/customers/recovery/dispatch-history`, `GET /api/dashboard/metrics/recovery`, `GET /api/dashboard/charts/lost-revenue`, `GET /api/dashboard/ai-analysis` (+ base).

##### `/customers/live-connections` — Conexões Ao Vivo

- **URL hash:** `#/customers/live-connections`
- **Título:** Conexões Ao Vivo
- **Propósito:** monitorar quem está assistindo agora.
- **O que a tela mostra:** aviso de que pode levar até 1 minuto para carregar; filtro de pesquisa; tabela vazia ("Nenhum dado para mostrar" / "Carregando…").
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Pesquisar (`placeholder: Pesquisar`) | text | Não | Filtro da grade |

- **Tabelas de dados:** `USUÁRIO | CONEXÕES / MÁX | REVENDA | ASSISTINDO | TEMPO | DISPOSITIVO` (vazia na captura).
- **Ações/botões principais:** Limpar Filtro.
- **Endpoints de API chamados:** nenhum endpoint de dados capturado (só base `GET /api/settings/public`, `GET /api/auth/me`).

##### `/customers/statistics` — Estatísticas de Clientes

- **URL hash:** `#/customers/statistics`
- **Título:** Estatísticas de Clientes
- **Propósito:** visão agregada de criação/exclusão e desempenho por revenda.
- **O que a tela mostra:** cards "Top 10 Revenda Últimos 30 dias", "Desempenho", "Clientes Criados", "Clientes Excluídos", "Estatísticas Revenda", "Estatísticas" (totais ativo/inativo/total, testes, conexões, recortes 7/15/30/60/90 dias).
- **Campos de formulário:** nenhum específico além dos modais globais.
- **Tabelas de dados:** `Revenda | Criado | Excluído | Total`; `Revenda | Criado`; `Revenda | Excluído`; grade-resumo por revenda (clientes, testes, conexões, excluídos por período).
- **Ações/botões principais:** Limpar Filtro.
- **Endpoints de API chamados:** `GET /api/customers/statistics`, `GET /api/customers/statistics/top10?from_date=...&to_date=...`, `GET /api/resellers/list` (+ base).

##### `/customers/deleted` — Clientes Excluídos

- **URL hash:** `#/customers/deleted`
- **Título:** Clientes Excluídos
- **Propósito:** consultar a lixeira de clientes (somente leitura aparente).
- **O que a tela mostra:** mesmos filtros da lista principal adaptados (pesquisa, período de exclusão), alternância lista/cards, 31 registros paginados (20 por página; 5 linhas visíveis na captura: usuário + datas de criação/exclusão).
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Pesquisar (`placeholder: Pesquisar`) | text | Não | — |
| Excluído de / Excluído até | text (datepicker) | Não | Filtro por data de exclusão |
| Itens por página | select | Não | 5, 10, 20 (padrão), 40, 60, 80, 100 |

- **Tabelas de dados:** `USUÁRIO | DATAS` (`rowCount` 21 no JSON; texto indica 31 no total).
- **Ações/botões principais:** Limpar Filtro, Mudar para Cards.
- **Endpoints de API chamados:** `GET /api/customers?page=1&username=&deletedFrom=&deletedTo=&deleted=true&isTrial=&perPage=20`, `GET /api/resellers/list` (+ base).

##### `/customers/coupons` — Cupons de Cliente

- **URL hash:** `#/customers/coupons`
- **Título:** Cupons de Cliente
- **Propósito:** listar cupons de desconto para clientes.
- **O que a tela mostra:** card "Adicionar" e grade vazia.
- **Campos de formulário:** nenhum específico.
- **Tabelas de dados:** `CÓDIGO | SITUAÇÃO | DESCONTO | USO MÁXIMO | NÚMERO DE USOS | VÁLIDO DE | VÁLIDO ATÉ | AÇÕES` (vazia).
- **Ações/botões principais:** Adicionar (→ `#/customers/coupons/add`).
- **Endpoints de API chamados:** `GET /api/customer-coupons?page=1&perPage=50` (+ base).

##### `/customers/coupons/add` — Adicionar Cupom

- **URL hash:** `#/customers/coupons/add`
- **Título:** Adicionar Cupom
- **Propósito:** criar um cupom de desconto.
- **O que a tela mostra:** aviso de que ainda não é possível restringir cupom a plano/cliente específico; formulário com descrição, código, situação, tipo, valor, vigência e limites de uso. Botões Cancelar/Salvar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Descrição (`placeholder: Uma breve descrição - não visível para o cliente`) | text | Não | Interna |
| Código (`placeholder: O código será gerado automaticamente`) | text | Não | Gerado se vazio |
| Situação | radio | Não | `ACTIVE` / `INACTIVE` / `HIDDEN` (rótulo exibido "Ativo" nas 3 opções no JSON) |
| Tipo | radio | Não | `FIXED` (Valor Fixo) / `PERCENTAGE` (Percentual de Bônus) |
| Valor (`placeholder: Insira um valor maior que 0`) | text | Não | Se maior que o plano, cliente recebe 100% de desconto |
| Válido de / Válido até (`placeholder: Escolha uma data`) | text (datepicker) | Não | Em branco = imediato / indefinido |
| Usos máximos / Máximo por cliente (`placeholder: 0`) | number | Não | Em branco = ilimitado (não recomendado) |

- **Tabelas de dados:** nenhuma (só datepicker).
- **Ações/botões principais:** Salvar, Cancelar (→ `#/customers/coupons`).
- **Endpoints de API chamados:** nenhum endpoint de dados capturado (só base).

##### `/customers/migration` — Migração de Cliente

- **URL hash:** `#/customers/migration`
- **Título:** Migração de Cliente
- **Propósito:** listar processos de migração de clientes via M3U.
- **O que a tela mostra:** instrução ("clique em Adicionar para nova migração; clique em Ver ao lado para visualizar/aprovar") e grade vazia.
- **Campos de formulário:** nenhum específico.
- **Tabelas de dados:** `CRIADO EM | ATUALIZADO EM | SITUAÇÃO | AÇÕES` (vazia).
- **Ações/botões principais:** Adicionar (→ `#/customers/migration/add`).
- **Endpoints de API chamados:** `GET /api/customermigrations?page=1` (+ base).

##### `/customers/migration/add` — Adicionar Migração de Cliente

- **URL hash:** `#/customers/migration/add`
- **Título:** Adicionar Migração de Cliente
- **Propósito:** iniciar uma migração colando URLs M3U de origem.
- **O que a tela mostra:** instruções (até 100 clientes por vez, uma URL M3U com usuário e senha por linha, exemplo de formato; só usuários com ≤30 dias do vencimento podem ser aprovados/importados) e área de URLs. Botão Continuar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| URLs (`placeholder: Obrigatório`) | textarea | Sim (placeholder) | Uma URL M3U por linha |

- **Tabelas de dados:** nenhuma.
- **Ações/botões principais:** Continuar.
- **Endpoints de API chamados:** nenhum endpoint de dados capturado (só base).

##### `/customers/mass-delete` — Excluir Clientes em Massa

- **URL hash:** `#/customers/mass-delete`
- **Título:** Excluir Clientes em Massa
- **Propósito:** excluir em lote testes e/ou clientes por revenda/servidor.
- **O que a tela mostra:** atalhos de configuração (Todos testes, Testes vencidos, Clientes inativos), seletores de Revenda e Servidor (opcional), escopo, filtros de testes/clientes, aviso de irreversibilidade e checkbox de concordância. Botão Continuar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Revenda / Servidor (textos: "Selecione", "Opcional") | inputs sem rótulo no JSON | Não | Captura não detalha options |
| Quais clientes para excluir | radio | Não | `ALL` (revenda + subrevendas) / `ONLY_DIRECT` / `ONLY_SUBRESELLERS` |
| Testes para excluir | radio | Não | `NO` (Não excluir) / `BOTH` / `ACTIVE` / `INACTIVE` |
| Clientes para excluir | radio | Não | `NO` (Não excluir) / `ACTIVE` / `INACTIVE` / `BOTH` |
| Eu concordo | checkbox | Não | Confirmação da ação irreversível |

- **Tabelas de dados:** nenhuma.
- **Ações/botões principais:** Todos testes, Testes vencidos, Clientes inativos (presets), Continuar.
- **Endpoints de API chamados:** `GET /api/customers?page=1&username=&deletedFrom=&deletedTo=&deleted=true&isTrial=&perPage=20`, `GET /api/resellers/list` (+ base).

##### `/customers/move` — Mover Clientes

- **URL hash:** `#/customers/move`
- **Título:** Mover Clientes
- **Propósito:** transferir todos os clientes de uma revenda para outra.
- **O que a tela mostra:** dois seletores ("Revenda de onde tirar os clientes", "Revenda para onde os clientes irão"), resumo ("Todos os clientes de - serão movidos para -"), concordância e Continuar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Revenda de origem / Revenda de destino (sem rótulo no JSON; texto "Selecione") | text (seletores) | Não (incerto — sem `required` no JSON) | Options vindas de `GET /api/resellers/list` |
| Eu concordo | checkbox | Não | Confirmação |

- **Tabelas de dados:** nenhuma.
- **Ações/botões principais:** Continuar.
- **Endpoints de API chamados:** `GET /api/resellers/list` (+ base).

##### `/customers/botbot-logs` — Logs do BotBot

- **URL hash:** `#/customers/botbot-logs`
- **Título:** Logs do BotBot
- **Propósito:** consultar histórico de interações do BotBot com clientes.
- **O que a tela mostra:** filtro de pesquisa e grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Pesquisar (`placeholder: Pesquisar`) | text | Não | `keyword` na query |

- **Tabelas de dados:** `DATA/HORA | WHATSAPP | MENSAGEM | RESPOSTA` (vazia).
- **Ações/botões principais:** Limpar Filtro.
- **Endpoints de API chamados:** `GET /api/botbot/logs?page=1&keyword=&type=customer` (+ base).

##### `/customers/botbot-queued-messages` — Mensagens em Fila do BotBot

- **URL hash:** `#/customers/botbot-queued-messages`
- **Título:** Mensagens em Fila do BotBot
- **Propósito:** ver mensagens agendadas aguardando envio.
- **O que a tela mostra:** texto explicativo (hora de envio pode mudar; envio depende da configuração; link "Clique aqui para configurar o BotBot") e grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Pesquisar (`placeholder: Pesquisar`) | text | Não | `keyword` na query |

- **Tabelas de dados:** `DATA/HORA AGENDADA | CLIENTE | MENSAGEM | CONTAGEM REGRESSIVA` (vazia).
- **Ações/botões principais:** Limpar Filtro.
- **Endpoints de API chamados:** `GET /api/customers/botbot-queued-messages?perPage=20&page=1&keyword=` (+ base).

##### `/customers/botbot-scheduled-messages` — Mensagens Agendadas no BotBot

- **URL hash:** `#/customers/botbot-scheduled-messages`
- **Título:** Mensagens Agendadas no BotBot
- **Propósito:** ver mensagens enfileiradas ainda não enviadas.
- **O que a tela mostra:** texto similar ao da fila (podem ou não ser enviadas conforme configuração, status, tempos; link de configuração) e grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Pesquisar (`placeholder: Pesquisar`) | text | Não | `keyword` na query |

- **Tabelas de dados:** `DATA/HORA PREVISTA | CLIENTE | MENSAGEM | CONTAGEM REGRESSIVA` (vazia).
- **Ações/botões principais:** Limpar Filtro.
- **Endpoints de API chamados:** `GET /api/customers/botbot-scheduled-messages?perPage=20&page=1&keyword=` (+ base).

##### `/customers/audit` — Auditoria Clientes

- **URL hash:** `#/customers/audit`
- **Título:** Auditoria Clientes
- **Propósito:** rastrear quem fez o quê em clientes (criação, atualização), com IP e user-agent.
- **O que a tela mostra:** filtros (revenda executora, ação, cliente, IP, período), nota sobre "Ação do Sistema", paginação (40 registros, 20 por página; 5 linhas visíveis: data/hora, revenda com nível, cliente, ação/alterações, IP e user-agent).
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Usuário do Cliente (`placeholder: Usuário do Cliente`) | text | Não | `customerUsername` |
| Revenda que executou a ação (seletor) | input sem rótulo no JSON | Não | `resellerActionId` |
| Ação (seletor; texto "Ação -") | input sem rótulo no JSON | Não | `action` |
| Endereço IP (`placeholder: Endereço IP`) | text | Não | `ipAddress` |
| Data de / Data até | text (datepicker) | Não | `createdFrom`/`createdTo`; atalhos Hoje, Ontem, Últimos 7/30 dias, Este mês, Mês passado |

- **Tabelas de dados:** `DATA/HORA | REVENDA | CLIENTE | AÇÃO ALTERAÇÕES | ENDEREÇO IP USER AGENT`.
- **Ações/botões principais:** Limpar Filtro.
- **Endpoints de API chamados:** `GET /api/audit/customers?page=1&customerUsername=&resellerActionId=&action=&ipAddress=&createdFrom=&createdTo=`, `GET /api/resellers/list` (+ base).

##### `/customers/subscribe` — Cadastro de Cliente

- **URL hash:** `#/customers/subscribe`
- **Título:** Cadastro de Cliente
- **Propósito:** permitir auto-cadastro de novos clientes na rede da revenda via link exclusivo.
- **O que a tela mostra:** texto explicativo + URL pública de cadastro + botão de cópia.
- **Campos de formulário:** nenhum.
- **Tabelas de dados:** nenhuma.
- **Ações/botões principais:** Clique para Copiar a URL.
- **Endpoints de API chamados:** nenhum endpoint de dados capturado (só base).

#### Endpoints de API do módulo

- `GET /api/auth/me`
- `GET /api/settings/public`
- `GET /api/customers?page=1&username=...&serverId=&packageId=&expiryFrom=&expiryTo=&createdFrom=&createdTo=&status=&isTrial=&connections=&perPage=20` (lista/filtro de clientes)
- `GET /api/customers?page=1&username=&deletedFrom=&deletedTo=&deleted=true&isTrial=&perPage=20` (lixeira; também observado em `mass-delete`)
- `POST /api/customers/calculate-plan-price`
- `POST /api/customers/calculate-customer-credits`
- `GET /api/servers/bouquets/[id]/true`
- `GET /api/resellers/list`
- `GET /api/customers/recovery/lapsed?cohort=3`
- `GET /api/customers/recovery/dispatch-history`
- `GET /api/dashboard/metrics/recovery`
- `GET /api/dashboard/charts/lost-revenue`
- `GET /api/dashboard/ai-analysis`
- `GET /api/customers/statistics`
- `GET /api/customers/statistics/top10?from_date=...&to_date=...`
- `GET /api/customer-coupons?page=1&perPage=50`
- `GET /api/customermigrations?page=1`
- `GET /api/customers/botbot-queued-messages?perPage=20&page=1&keyword=`
- `GET /api/customers/botbot-scheduled-messages?perPage=20&page=1&keyword=`
- `GET /api/botbot/logs?page=1&keyword=&type=customer`
- `GET /api/audit/customers?page=1&customerUsername=&resellerActionId=&action=&ipAddress=&createdFrom=&createdTo=`

#### Observações e limites

- **Sem redirecionamentos:** nenhuma rota do JSON terminou em `/dashboard`; não há caso de "acesso negado / redirecionado" nesta captura.
- **Páginas/estados vazios:** `live-connections`, `coupons`, `migration`, `botbot-logs`, `botbot-queued-messages` e `botbot-scheduled-messages` retornaram "Nenhum dado para mostrar" na captura. `live-connections` ainda exibia "Carregando…" e avisa que pode levar até 1 minuto.
- **Dados sensíveis generalizados:** valores reais de usuários, e-mails, IDs, tokens, IPs e user-agents presentes no JSON foram omitidos ou descritos genericamente neste documento.
- **Incertezas do JSON:** (1) a maioria dos `inputs` não traz `label`/`name` — campos foram descritos por `placeholder` e texto visível; (2) `required` é `false` em todos os inputs, inclusive nos com placeholder "Obrigatório" — a obrigatoriedade acima segue o placeholder/texto, não o flag; (3) `rowCount` diverge do texto em `deleted` (21 vs. "31") e `customers` informa `rowCount: 2` para 1 registro visível; (4) `mass-delete` chama o endpoint de `deleted=true`, o que parece chamada residual/observada, não necessariamente a ação de exclusão; (5) telemetria `POST https://logs.smart-ti.com/api/2/envelope/` (Sentry) aparece em quase todas as rotas e foi excluída da lista de endpoints do módulo; (6) `audit` é a única rota sem `meta.permission` (traz `userId`).
- **Navegação interna observada (links):** `#/customers/add`, `#/customers/edit/[id]`, `#/customers/coupons/add`, `#/customers/migration/add` e o menu lateral do módulo (`renewal-assistant`, `live-connections`, `statistics`, `deleted`, `coupons`, `migration`, `botbot-scheduled-messages`, `botbot-queued-messages`, `botbot-logs`, `audit`).

### Módulo 3 — Revendas e Mensalistas

#### Visão geral

O módulo gerencia revendas (sub-painéis), créditos, mensalistas (assinatura recorrente de revendas), convites por indicação, movimentações na hierarquia (mover, remover, restaurar, importar, migrar), auditoria e mensagens BotBot, com listagens filtradas, rotinas em massa e relatórios de transações, estatísticas, logins e auditoria.

#### Rotas do módulo

| Rota | Título da página | Permissão exigida | Observação |
|------|------------------|-------------------|------------|
| /resellers | Revendas | access reseller pages | Lista principal de revendas; link `Adicionar` para `/resellers/add` |
| /resellers/add | Adicionar Revenda | access reseller pages | Formulário de criação; aba `Detalhes` |
| /resellers/credit-transactions | Transações de Créditos | create customer | Relatório de movimentações de crédito |
| /resellers/renew-membership | Renovar Mensalistas | can setup membership | Lista de mensalistas ativos para renovação |
| /resellers/bulk-membership | Atualização de Mensalistas | can setup membership | Filtro + alteração em massa com pré-visualização e confirmação |
| /resellers/referral-link | Link de Indicação | use reseller referral link | Mensagem de boas-vindas, tipo de mensalista padrão e URL de convite |
| /resellers/restore-reseller | Restaurar Revenda | create subpanels | Fluxo em 2 passos: selecionar revenda + visualizar e confirmar |
| /resellers/deleted | Revendas excluídos | edit all customers and resellers | Lista de revendas excluídas por período |
| /resellers/move | Mover Revendas | move resellers from one reseller to another | Move subrevendas de uma revenda de origem para outra de destino |
| /resellers/import | Importar Revendas | create subpanels | Importa revenda, subrevendas, créditos e clientes de outro servidor; desativa servidor temporariamente |
| /resellers/panel-migration | Migrar Revenda | create subpanels | Migração via URL do painel Sigma de origem; exige ser dono dos dois painéis |
| /resellers/botbot-logs | Logs do BotBot | access reseller pages | Log de mensagens BotBot enviadas a revendas |
| /resellers/botbot-scheduled-messages | Mensagens Agendadas no BotBot | access reseller pages | Mensagens pendentes/não enviadas; link para configuração do BotBot |
| /resellers/statistics | Estatísticas de Revendas | access reseller pages | Top 10, desempenho, criados/excluídos e árvore de revendas |
| /resellers/sign-in-logs | Histórico de Logins | view sign-in logs | Logins com IP, sessão e localização |
| /resellers/audit | Auditoria Revendas | (não declarada no meta) | Trilha de ações entre revendas, com IP e user-agent |
| /resellers/remove | Remover Revenda | create subpanels | Remoção em cascata só do nível informado para baixo, sem excluir do servidor |
| /botbot/membership-reminder | BotBot Lembrete de Mensalista | can setup membership | Disparo em segundo plano de lembretes de vencimento a mensalistas |

#### Páginas

##### /resellers — Revendas

- **URL hash:** `#/resellers`
- **Título:** Revendas
- **Propósito:** Listar, filtrar e operar revendas (renovar, adicionar créditos, ver detalhes, mensagem, alternar Cards/Tabela).
- **O que a tela mostra:** Filtros (situação, revenda, mensalista, permissão, créditos, última recarga, criação), grade de resultados com paginação e seletor de itens por página, atalho `Adicionar` para `/resellers/add`.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar | text | Não | Busca livre da grade |
| Última recarga (de/até) | text (datepicker) | Não | Intervalo; atalhos Hoje, Ontem, Últimos 7/30 dias, Este mês, Mês passado |
| Criado de / Criado até | text (datepicker) | Não | Intervalo de criação |
| Itens por página | select | Não | 5, 10, 20, 40, 60, 80, 100 (padrão 20) |
| Campos de modais globais (Renovar, Adicionar Créditos, Detalhes do Cliente, Nova Mensagem): Referência; Criar pedido de cliente; Use casas decimais; valor; observação; pagamento manual/offline; confirmação de transferência | text/number/textarea/checkbox | Não | Presentes em todas as rotas; pertencem aos modais, não à grade |

- **Tabelas de dados:**
  - Principal: `USUÁRIO | CRÉDITOS | DATAS | SITUAÇÃO | REVENDA | DETALHES | AÇÕES` — estado capturado vazio (`Nenhum dado para mostrar`).
  - Demais tabelas do JSON são calendários dos datepickers (`Sun..Sat`), sem dados de negócio.
- **Ações/botões principais:** Limpar Filtro, Adicionar, Mudar para Cards, Enviar Mensagem, Ações, Teste Rápido, paginação.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/list`, `GET /api/resellers?page=1&...&countServer=true&perPage=20`, `GET /api/resellers/roles`.

##### /resellers/add — Adicionar Revenda

- **URL hash:** `#/resellers/add`
- **Título:** Adicionar Revenda
- **Propósito:** Criar uma revenda com credenciais, permissão, créditos, servidores/DNS e dados opcionais de mensalista/contato.
- **O que a tela mostra:** Formulário em aba única `Detalhes`, tabela de DNS por servidor, botões Salvar/Cancelar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Usuário | text | Sim (placeholder `Obrigatório`) | Só letras, números e traços; mín. 6 caracteres |
| Senha | text | Sim (placeholder `Obrigatório`) | Mín. 8 caracteres; orientação de força no texto visível |
| Forçar revenda a mudar a senha no próximo login | checkbox | Não | — |
| Permissão | select (texto: `Selecione`) | Não informado no JSON | Papéis vindos de `/api/resellers/roles` |
| Créditos | number | Não | Mínimo de 5 créditos (texto visível) |
| Servidores (Opcional) | select | Não | Em branco = todos os servidores; afeta revenda e subrevendas |
| DNS do Servidor (Opcional) | text | Não | Define DNS das novas playlists |
| Atualize o DNS para todos os revendas abaixo desse revenda | checkbox | Não | — |
| Revenda Master | texto | — | Exibe a conta proprietária |
| Desativar login se não recarregar (dias) | number | Não | `0` desativa a opção |
| Configuração de Revenda Mensalista | checkbox | Não | Habilita bloco mensalista |
| Nome / E-mail / contato de mensagem | text | Não | Placeholder `Opcional`; detalhes pessoais visíveis só ao dono |
| Observações | textarea | Não | Placeholder `Opcional` |
| Salvar / Cancelar | botão | — | Cancelar volta para `#/resellers` |

- **Tabelas de dados:**
  - `Servidor | DNS` — ex.: servidor padrão do painel.
- **Ações/botões principais:** Salvar, Cancelar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/roles`, `GET /api/resellers/list`, `GET /api/servers`.

##### /resellers/credit-transactions — Transações de Créditos

- **URL hash:** `#/resellers/credit-transactions`
- **Título:** Transações de Créditos
- **Propósito:** Auditar movimentações de crédito (vendas/débitos e renovações) entre dono, revendas e clientes.
- **O que a tela mostra:** Filtros por origem/destino/observação/referência, grade paginada de transações.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Revenda que Enviou/Usou | text | Não | Filtro `fromUserId` |
| Revenda que Recebeu | text | Não | Filtro `toUserId` |
| Observação | text (placeholder `Observação`) | Não | Filtro `note` |
| Referência | text (placeholder `Referência`) | Não | Filtro `reference` |
| Limpar Filtro | botão | — | — |

- **Tabelas de dados:**
  - `CRIADO EM | CRÉDITOS | DONO | CRÉDITOS ANTES | CRÉDITOS DEPOIS | REVENDA | CRÉDITOS ANTES | CRÉDITOS DEPOIS | CLIENTE | AÇÃO | TIPO | OBSERVAÇÃO` — linhas de exemplo generalizadas: vendas com débito e renovação com custo do plano base e datas de vencimento antiga/nova.
- **Ações/botões principais:** Limpar Filtro, paginação.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/list`, `GET /api/reports/credit-transactions?page=1&fromUserId=&toUserId=&toCustomerId=&note=&reference=`.

##### /resellers/renew-membership — Renovar Mensalistas

- **URL hash:** `#/resellers/renew-membership`
- **Título:** Renovar Mensalistas
- **Propósito:** Listar mensalistas ativos e renovar assinaturas.
- **O que a tela mostra:** Filtros (status, tipo de mensalista, permissão, vencimento, criação), grade vazia, paginação 5–100.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar | text | Não | Busca livre |
| Vencimento de / Vencimento até | text (datepicker) | Não | Atalhos incluem Amanhã, Próximos 7/30 dias |
| Criado de / Criado até | text (datepicker) | Não | — |
| Filtros de texto visível: Ativo, Tipo de Mensalista, Permissão | selects/inputs | Não | Valores exatos das opções não capturados no JSON |
| Itens por página | select | Não | 5–100 (padrão 10) |

- **Tabelas de dados:**
  - `USUÁRIO | CRÉDITOS | SITUAÇÃO | REVENDA | DETALHES | DETALHES DO PLANO MENSALISTA | AÇÕES` — vazia (`Nenhum dado para mostrar`); demais tabelas são calendários.
- **Ações/botões principais:** Limpar Filtro, Renovar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/membership-report?page=1&username=&status=ACTIVE&...&perPage=10`, `GET /api/resellers/roles`.

##### /resellers/bulk-membership — Atualização de Mensalistas

- **URL hash:** `#/resellers/bulk-membership`
- **Título:** Atualização de Mensalistas
- **Propósito:** Aplicar alterações de plano mensalista em massa após filtrar, visualizar, selecionar e confirmar.
- **O que a tela mostra:** Cards `Filtros`, `Alterações a aplicar`, `Visualizar` (contadores de encontrados/selecionados), grade de pré-visualização, modal de confirmação.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Filtros: Situação, Mensalista ativo, Tipo de mensalista, Permissão, Vencimento, Criação, faixas de custo base/extra, recorrência, conexões, máx. clientes, créditos | text/number | Não | Texto visível indica `Sim` para mensalista ativo; seletores sem opções capturadas |
| Alterações a aplicar: Mensalista, Tipo de Mensalista (Valor Fixo), Tipo de Plano Mensalista (Valor Fixo), Redefinir créditos no vencimento, Custo base, Valor Adicional, Dias de Recorrência, Mínimo de Conexões, Número Máximo de Clientes, Vencimento, Hora de Vencimento, Créditos para Recarregar | checkbox + text/number | Não | Cada alteração tem checkbox habilitador + valor |
| Eu concordo | checkbox | Não | Confirmação no modal |
| Limpar filtros / Visualizar / Selecionar todos os filtrados / Desmarcar todos / Revisar e confirmar / Aplicar alterações | botões | — | Fluxo de confirmação em massa |

- **Tabelas de dados:**
  - `| Usuário | Situação | Custo | Data de Vencimento | Detalhes do Plano Mensalista` — vazia (`Nenhuma associação direta corresponde a esses filtros`); demais tabelas são calendários.
- **Ações/botões principais:** Visualizar, Selecionar todos os filtrados, Revisar e confirmar, Aplicar alterações.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/roles`, `GET /api/resellers/bulk-membership/preview?membership_active=YES&perPage=20&page=1`.

##### /resellers/referral-link — Link de Indicação

- **URL hash:** `#/resellers/referral-link`
- **Título:** Link de Indicação
- **Propósito:** Configurar mensagem de boas-vindas, mensalista padrão e divulgar URL de convite para novos revendas.
- **O que a tela mostra:** Bloco de template com tags clicáveis, bloco de mensalista padrão, bloco da URL de convite com botão de cópia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Template de boas-vindas (`referral_link_welcome_message_template`) | textarea | Não | Tags: `{name}`, `{username}`, `{email}`, `{whatsapp}`, `{password}`, `{panel_url}` |
| Tipo de Mensalista | radio | Não | Valores: `NONE`, `PER_ACTIVE_CUSTOMER`, `FIXED`, `PLAN` (rótulo visível `Nenhum` / Valor por Conexão / Valor Fixo) |
| Salvar | botão | — | Há dois blocos com Salvar (mensagem e mensalista) |
| Clique para Copiar a URL | botão | — | Copia o link de indicação |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Salvar, Clique para Copiar a URL.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/roles`.

##### /resellers/restore-reseller — Restaurar Revenda

- **URL hash:** `#/resellers/restore-reseller`
- **Título:** Restaurar Revenda
- **Propósito:** Restaurar revenda excluída em fluxo de 2 etapas.
- **O que a tela mostra:** Passo 1 (selecionar revenda por nome de usuário), passo 2 (visualizar e confirmar); mensagem de vazio quando nada é encontrado.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar por nome de usuário | checkbox + busca | Não | Texto de vazio: nenhum revenda excluído encontrado com o nome informado |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Visualizar Restore.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/deleted`.

##### /resellers/deleted — Revendas excluídos

- **URL hash:** `#/resellers/deleted`
- **Título:** Revendas excluídos
- **Propósito:** Consultar revendas excluídas por período.
- **O que a tela mostra:** Filtros de pesquisa e data de exclusão, grade vazia, alternância Tabela/Cards.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar | text | Não | Busca livre |
| Excluído de / Excluído até | text (datepicker) | Não | Atalhos incluem 3/7 dias antes/depois |
| Itens por página | select | Não | 5–100 (padrão 20) |

- **Tabelas de dados:**
  - `USUÁRIO | DATAS | DETALHES` — vazia; demais tabelas são calendários.
- **Ações/botões principais:** Limpar Filtro, Mudar para Cards.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers?page=1&username=&deletedFrom=&deletedTo=&deleted=true&perPage=20`.

##### /resellers/move — Mover Revendas

- **URL hash:** `#/resellers/move`
- **Título:** Mover Revendas
- **Propósito:** Transferir todos os subrevendas de uma revenda de origem para uma revenda de destino.
- **O que a tela mostra:** Dois seletores de revenda, resumo (`Todos os revendas de X serão movidos para Y`), confirmação e continuação.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Revenda de onde tirar os subrevendas (origem) | select/input de texto visível `Selecione` | Não informado | Lista vinda de `/api/resellers/list` |
| Revendas para os subrevendas irão (destino) | select/input de texto visível `Selecione` | Não informado | Idem |
| Eu concordo | checkbox | Não | Confirmação |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Continuar.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/list`.

##### /resellers/import — Importar Revendas

- **URL hash:** `#/resellers/import`
- **Título:** Importar Revendas
- **Propósito:** Importar revenda, subrevendas, créditos e clientes de outro servidor.
- **O que a tela mostra:** Aviso de desativação temporária do servidor, campos de identificação, servidor, plano e token, botão Continuar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Nome de Usuário Exato do Revenda | text (placeholder `Obrigatório`) | Sim | Importa revenda, subrevendas, créditos e clientes |
| Servidor | select/input (texto `Selecione`) | Não informado | Servidor de origem |
| Plano | select/input (texto `Selecione`) | Não informado | Recomendado plano mensal sem conteúdo adulto; vencimento do cliente não é afetado |
| Chave de API/Token do Servidor | text (placeholder `Obrigatório`) | Sim (pelo texto) | Mesmo token do Sigma; só o dono do servidor possui |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Continuar.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /resellers/panel-migration — Migrar Revenda

- **URL hash:** `#/resellers/panel-migration`
- **Título:** Migrar Revenda
- **Propósito:** Migrar revenda entre painéis Sigma informando a URL do painel de origem.
- **O que a tela mostra:** Orientação de horário de atendimento, campo único de URL, sem grade.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| URL do Sigma onde o revenda está cadastrado | text (placeholder com exemplo de URL) | Sim | Painel de origem, não o atual; exige ser dono dos dois painéis |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Nenhum botão específico além da navegação padrão.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /resellers/botbot-logs — Logs do BotBot

- **URL hash:** `#/resellers/botbot-logs`
- **Título:** Logs do BotBot
- **Propósito:** Consultar histórico de interações do BotBot com revendas.
- **O que a tela mostra:** Filtro de pesquisa e grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar | text | Não | Filtro `keyword` |
| Limpar Filtro | botão | — | — |

- **Tabelas de dados:**
  - `DATA/HORA | WHATSAPP | MENSAGEM | RESPOSTA` — vazia.
- **Ações/botões principais:** Limpar Filtro.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/botbot/logs?page=1&keyword=&type=reseller`.

##### /resellers/botbot-scheduled-messages — Mensagens Agendadas no BotBot

- **URL hash:** `#/resellers/botbot-scheduled-messages`
- **Título:** Mensagens Agendadas no BotBot
- **Propósito:** Ver mensagens do BotBot ainda não agendadas/enviadas para revendas.
- **O que a tela mostra:** Aviso de que o envio depende de status e tempo, link para configuração do BotBot, grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar | text | Não | Filtro `keyword` |

- **Tabelas de dados:**
  - `DATA/HORA PREVISTA | REVENDA | MENSAGEM | CONTAGEM REGRESSIVA` — vazia.
- **Ações/botões principais:** Limpar Filtro; link `Clique aqui para configurar o BotBot`.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/botbot-scheduled-messages?perPage=20&page=1&keyword=`.

##### /resellers/statistics — Estatísticas de Revendas

- **URL hash:** `#/resellers/statistics`
- **Título:** Estatísticas de Revendas
- **Propósito:** Visão agregada de desempenho, criação/exclusão e hierarquia de revendas.
- **O que a tela mostra:** Cards `Top 10 Revenda (Últimos 30 dias)`, `Desempenho`, `Revendas Criados`, `Revendas Excluídos`, `Estatistícas`, `Árvore de Revendas`; estados `Nenhum dado disponível` e grade com 1 registro vazio.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Filtros de período do Top 10 | text/inputs de data | Não | Texto visível indica últimos 30 dias; campos sem rótulo capturado |
| Limpar Filtro | botão | — | — |

- **Tabelas de dados:**
  - Grade genérica com cabeçalho `Nenhum dado para mostrar` — texto indica ausência de revendas.
- **Ações/botões principais:** Limpar Filtro.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/statistics?page=1&per_page=20`, `GET /api/resellers/statistics/top10?from_date=...&to_date=...`, `GET /api/resellers/list`.

##### /resellers/sign-in-logs — Histórico de Logins

- **URL hash:** `#/resellers/sign-in-logs`
- **Título:** Histórico de Logins
- **Propósito:** Auditar acessos (quando, quem, situação, IP e sessão).
- **O que a tela mostra:** Filtro de pesquisa e grade paginada de logins.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar | text | Não | Filtro `keyword` |
| Limpar Filtro | botão | — | — |

- **Tabelas de dados:**
  - `DATA/HORA | USUÁRIO | SITUAÇÃO | ENDEREÇO IP | DETALHES DA SESSÃO` — linhas generalizadas: logins com SO/navegador e localização; IPs e links externos de IP omitidos aqui.
- **Ações/botões principais:** Limpar Filtro, paginação.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/audit/sign-in-logs?page=1&keyword=`.

##### /resellers/audit — Auditoria Revendas

- **URL hash:** `#/resellers/audit`
- **Título:** Auditoria Revendas
- **Propósito:** Trilha de quem fez o quê entre revendas, com ação, alterações, IP e user-agent.
- **O que a tela mostra:** Filtros (revenda autora, ação, IP, período), explicação de `Ação do Sistema`, grade paginada, badges de nível.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Usuário do Revenda | text (placeholder `Usuário do Revenda`) | Não | Filtro `resellerUsername` |
| Ação | text/select | Não | Filtro `action` / `resellerActionId` |
| Endereço IP | text (placeholder `Endereço IP`) | Não | Filtro `ipAddress` |
| Data de / Data até | text (datepicker) | Não | Filtros `createdFrom`/`createdTo`; atalhos Hoje, Ontem, Últimos 7/30 dias, Este mês, Mês passado |

- **Tabelas de dados:**
  - `DATA/HORA | REVENDA | REVENDA AFETADO | AÇÃO ALTERAÇÕES | ENDEREÇO IP USER AGENT` — linhas generalizadas: créditos adicionados, observação/situação atualizadas, BotBot/perfil alterados, logins; demais tabelas são calendários.
- **Ações/botões principais:** Limpar Filtro, paginação.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/audit/resellers?page=1&resellerUsername=&resellerActionId=&action=&ipAddress=&createdFrom=&createdTo=`, `GET /api/resellers/list`.

##### /resellers/remove — Remover Revenda

- **URL hash:** `#/resellers/remove`
- **Título:** Remover Revenda
- **Propósito:** Remover revenda e toda a sua descendência (subrevendas e clientes desses níveis), sem excluir nada do servidor.
- **O que a tela mostra:** Aviso de escopo (`só desse revenda pra baixo`), seletor de revenda e continuação.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Revenda | select/input (texto `Selecione`) | Não informado | Lista vinda de `/api/resellers/list` (inclui variação `deleted=true`) |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Continuar.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers?page=1&username=&deletedFrom=&deletedTo=&deleted=true&perPage=20`, `GET /api/resellers/list`.

##### /botbot/membership-reminder — BotBot Lembrete de Mensalista

- **URL hash:** `#/botbot/membership-reminder`
- **Título:** BotBot Lembrete de Mensalista
- **Propósito:** Enviar em segundo plano lembretes de vencimento a mensalistas via BotBot.
- **O que a tela mostra:** Campo de data de vencimento, seletor opcional de mensalistas, aviso de processamento em segundo plano e link para automação de revendas.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Mensalistas com data de vencimento em | text (placeholder `Opcional`) | Não | Em branco usa configuração de Automação BotBot – Revendas |
| Seleção de mensalista(s) | text/input | Não | Opcional; vazio = todos sem mensagem hoje |
| Continuar | botão | — | Enfileira o pedido em segundo plano |

- **Tabelas de dados:** Apenas calendário do datepicker (`Sun..Sat`).
- **Ações/botões principais:** Continuar; link `Automação BotBot - Revendas`.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/membership-list`.

#### Endpoints de API do módulo

- `GET /api/settings/public`
- `GET /api/auth/me`
- `GET /api/resellers/list`
- `GET /api/resellers` (lista paginada/filtrada; inclui variação com `deleted=true`)
- `GET /api/resellers/roles`
- `GET /api/servers`
- `GET /api/reports/credit-transactions`
- `GET /api/resellers/membership-report`
- `GET /api/resellers/bulk-membership/preview`
- `GET /api/resellers/deleted`
- `GET /api/resellers/statistics`
- `GET /api/resellers/statistics/top10`
- `GET /api/resellers/membership-list`
- `GET /api/resellers/botbot-scheduled-messages`
- `GET /api/botbot/logs`
- `GET /api/audit/sign-in-logs`
- `GET /api/audit/resellers`

#### Observações e limites

- Nenhuma rota redirecionou para `/dashboard`; todos os `finalUrl` permaneceram no hash da rota solicitada.
- Estados vazios predominam: `/resellers`, `/resellers/renew-membership`, `/resellers/deleted`, `/resellers/botbot-logs`, `/resellers/botbot-scheduled-messages` e estatísticas retornam `Nenhum dado para mostrar/disponível`; `/resellers/bulk-membership` retorna `Nenhuma associação direta corresponde a esses filtros`; `/resellers/restore-reseller` informa que nenhum revenda excluído foi encontrado.
- Rotas com dados reais: `/resellers/credit-transactions` (transações), `/resellers/sign-in-logs` (logins) e `/resellers/audit` (ações); dados pessoais (contas, IPs, agentes) foram generalizados neste documento.
- Tabelas de calendário (`Sun..Sat`) são componentes de datepicker, não dados do módulo.
- Campos repetidos de `Renovar`, `Adicionar Créditos`, `Detalhes do Cliente` e `Nova Mensagem` aparecem nos `inputs` de todas as rotas por serem modais globais; os quadros acima destacam apenas os campos próprios de cada página.
- Lacunas do JSON: rótulos/IDs de vários filtros e selects não foram capturados (campos sem `label`/`name`); opções de `Permissão`, `Tipo de Mensalista` (filtros), `Servidor`, `Plano` e seletores de origem/destino não vieram em `options`; `/resellers/audit` não traz `permission` no `meta` (traz apenas identificador interno); nenhum `modals` foi populado apesar dos modais visíveis no texto.

### Módulo 4 — Financeiro, Relatórios e Sistema

#### Visão geral

O módulo cobre o financeiro da revenda (vendas de créditos, renovações de clientes e mensalistas, créditos de registro de domínio), relatórios operacionais (novos conteúdos, estatísticas dos servidores), utilitários de domínio e a administração do sistema (servidores, avisos, templates de playlist, campanhas de bônus, planos, pacotes de créditos, bloqueio de testes, planos de mensalista, subpainéis), com listagens filtradas, formulários `add` dedicados e telas de preço somente-leitura para a revenda.

#### Rotas do módulo

| Rota | Título da página | Permissão exigida | Observação |
|------|------------------|-------------------|------------|
| /billing/credit-orders | Vendas de Créditos | access reseller pages | Lista + gráficos diário/mensal; filtros por situação/revenda/data |
| /billing/domain-registration-credits | Créditos de Registro | access reseller pages | Auditoria somente-leitura de créditos de registro de domínio; estado vazio |
| /billing/customers-orders | Renovações de Clientes | create customer | Lista + gráficos + previsão de recebimento 30 dias |
| /billing/membership-transactions | Renovações de Mensalistas | can setup membership | Lista + gráficos mensal/diário |
| /content | Novos Conteúdos | create customer | Relatório com cache de 10 min; filtros de período e modo de exibição |
| /server-statistics | Estatísticas dos Servidores | create customer | Contadores próprios/subrevendas; sem grade |
| /utilities/domains | Domínios | can purchase domain | Grade vazia + `Comprar Domínio` |
| /system/servers | Servidores | create server | Tela administrativa de servidores (sem grade capturada) |
| /system/servers/add | Adicionar Servidor | create server | Formulário mínimo capturado (`Incluso na sua Licença`, Cancelar/Salvar) |
| /system/servers/resync | Sincronizar Servidor | create server | Rotina de sincronização entre servidores/tecnologias |
| /system/servers/mass-migrate | Migrar Clientes em Massa | mass migrate customers between servers | Origem → destino, um a um; selo `Migração indisponível` |
| /system/servers/token-manager | Gerenciador de Token | create server | Troca coordenada de token + grade vazia de painéis |
| /system/notices | Avisos | create notice | Grade com 2 avisos + `Adicionar` |
| /system/notices/add | Adicionar Aviso | create notice | Título, descrição, ordem, local de exibição, cor, vigência |
| /system/default-playlist-template | Template de Playlist Padrão | edit default playlist template | Grade vazia `NOME \| TIPO DE CONEXÃO \| TEMPLATE \| AÇÕES` |
| /system/credit-bonus-campaigns | Campanhas de Bônus | create credit-bonus-campaign | Grade vazia + `Adicionar` |
| /system/credit-bonus-campaigns/add | Adicionar Campanha de Bônus de Crédito | create credit-bonus-campaign | Percentual, recargas mín/máx, vigência |
| /system/packages | Planos | create package | Grade vazia + filtros (servidor, teste, situação, créditos, conexões, duração, adulto) |
| /system/packages/add | Adicionar Plano | create package | Nome, servidor, ordem, situação, teste, valor, créditos, duração, multi-servidor, template |
| /system/packages-price | Planos (Preço) | access reseller pages | Somente-leitura: 16 planos com valor, créditos, duração + `Editar` |
| /system/credit-packages | Pacote de Créditos | create credit-package | 13 faixas ativas (1–1000 créditos) + `Adicionar` |
| /system/credit-packages/add | Adicionar Pacote de Crédito | create credit-package | Créditos, valor por unidade, situação |
| /system/credit-packages-price | Pacote de Créditos (Preço) | access reseller pages | Somente-leitura das mesmas 13 faixas + `Editar` |
| /system/trialblocker | Bloqueio de Teste | create trialblocker | 1 bloqueio vigente + `Adicionar` + busca |
| /system/trialblocker/add | Adicionar Bloqueio de Teste | create trialblocker | Motivo + intervalo de bloqueio |
| /system/membership-plans | Planos Mensalista | create membership plans | Grade vazia + `Adicionar` + busca |
| /system/membership-plans/add | Adicionar Plano Mensalista | create membership plans | Nome, situação, tipo (por conexão/fixo), valor, faixa de conexões |
| /system/subpanels | Subpainéis | (não declarada no meta; meta traz só userId) | Grade vazia `SUBPAINEL \| CONTADOR \| AÇÕES` + `Adicionar` |
| /system/subpanels/add | Adicionar Subpainel | (não declarada no meta; meta traz só userId) | Nome, domínio, senha super-admin + sincronizações (maioria `Em breve`) |
| /system/permissions | Permissions (meta) / Dashboard (render) | super-admin (role) | Acesso negado / redirecionado para o dashboard |
| /system/audit | System Audit (meta) / Dashboard (render) | super-admin (role) | Acesso negado / redirecionado para o dashboard |
| /system/server-request-logs | Server Request Logs (meta) / Dashboard (render) | super-admin (role) | Acesso negado / redirecionado para o dashboard |
| /utilities/domains/all | All Domains (meta) / Dashboard (render) | super-admin (role) | Acesso negado / redirecionado para o dashboard |

#### Páginas

Nota válida para todas as rotas abaixo: os inputs `Referência`, `Criar pedido de cliente para este pagamento`, `Use casas decimais`, valor numérico, observação (textarea), `Registrar como pagamento manual/offline/em dinheiro` e `Eu concordo em transferir … créditos` pertencem aos modais globais (Renovar, Adicionar Créditos, Detalhes do Cliente, Nova Mensagem) e se repetem em quase todas as rotas; não são campos da tela principal. Não repetidos por extenso em cada tabela.

##### /billing/credit-orders — Vendas de Créditos

- **URL hash:** `#/billing/credit-orders`
- **Título:** Vendas de Créditos
- **Propósito:** Acompanhar vendas de créditos às revendas, com totalizadores e filtros.
- **O que a tela mostra:** Gráficos de total do período (dia, últimos 30 dias) e por mês (09/2025–09/2026); filtros Situação/Revendas/período; grade paginada; `Exportar (;)`.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Data de / Data até | text (datepicker) | Não | Atalhos: Hoje, Ontem, Últimos 3/7/30 dias, Últimos 12 meses |
| Situação, Revendas | filtro (texto visível) | Não | Valores exatos não capturados |
| Itens por página | select | Não | 5, 10, 20, 40, 60, 80, 100 (padrão 20) |
| Modais globais | text/number/textarea/checkbox | Não | Ver nota acima |

- **Tabelas de dados:**
  - `REVENDA | NÚMERO DO PEDIDO | DATA DA COMPRA | SITUAÇÃO | DATA DE PAGAMENTO | FORMA DE PAGAMENTO | ID DA TRANSAÇÃO | CRÉDITOS | PREÇO | TOTAL | AÇÕES` — estado vazio (`Nenhum dado para mostrar`).
  - Demais tabelas são calendários dos datepickers (`Sun..Sat`).
- **Ações/botões principais:** Exportar (;), Limpar Filtro, Teste Rápido, Ações, paginação.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/list`, `GET /api/creditorders?page=1&credits=&status=&createdAtFrom=&createdAtTo=&perPage=20`.

##### /billing/domain-registration-credits — Créditos de Registro

- **URL hash:** `#/billing/domain-registration-credits`
- **Título:** Créditos de Registro
- **Propósito:** Auditoria somente-leitura de créditos de registro de domínio com falha.
- **O que a tela mostra:** Texto explicativo de auditoria + `Atualizar` + grade paginada vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Itens por página | select | Não | 5–100 (padrão 20) |
| Modais globais | text/number/textarea/checkbox | Não | Ver nota acima |

- **Tabelas de dados:**
  - `REVENDA | TLD | AÇÃO | DOMÍNIO | PEDIDO DE ORIGEM | VENCIMENTO | CONSUMIDO EM | SITUAÇÃO` — vazio.
- **Ações/botões principais:** Atualizar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/domain-registration-credits?page=1&perPage=20`.

##### /billing/customers-orders — Renovações de Clientes

- **URL hash:** `#/billing/customers-orders`
- **Título:** Renovações de Clientes
- **Propósito:** Acompanhar renovações de clientes e previsão de recebimento.
- **O que a tela mostra:** Gráficos diário/mensal + `Previsão de Recebimento nos próximos 30 Dias`; filtros Situação/Plano/cliente/data; grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar Cliente (placeholder) | text | Não | Busca livre |
| Data de / Data até | text (datepicker) | Não | Mesmos atalhos das telas billing |
| Situação, Plano | filtro | Não | `Exportar (;)`, `Limpar Filtro` ao lado |
| Itens por página | select | Não | 5–100 (padrão 20) |

- **Tabelas de dados:**
  - `REVENDA | NÚMERO DO PEDIDO | DATA DA COMPRA | SITUAÇÃO | DATA DE PAGAMENTO | PLANO | FORMA DE PAGAMENTO | ID DA TRANSAÇÃO | TOTAL | AÇÕES` — vazio; calendários à parte.
- **Ações/botões principais:** Exportar (;), Limpar Filtro, Teste Rápido, Ações.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/list`, `GET /api/customerorders?page=1&username=&status=&createdAtFrom=&createdAtTo=&packageId=&perPage=20`.

##### /billing/membership-transactions — Renovações de Mensalistas

- **URL hash:** `#/billing/membership-transactions`
- **Título:** Renovações de Mensalistas
- **Propósito:** Acompanhar pagamentos/renovações de mensalistas.
- **O que a tela mostra:** Gráficos mensal + últimos 30 dias; filtros Situação/Revendas/pagamento; grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pagamento de / Pagamento para (placeholders) | text (datepicker) | Não | Intervalo de pagamento |
| Situação, Revendas | filtro | Não | Com `Exportar (;)` / `Limpar Filtro` |
| Itens por página | select | Não | 5–100 (padrão 20) |

- **Tabelas de dados:**
  - `REVENDA | NÚMERO DO PEDIDO | DATA DE PAGAMENTO | SITUAÇÃO | FORMA DE PAGAMENTO | ID DA TRANSAÇÃO | TOTAL | AÇÕES` — vazio; calendários à parte.
- **Ações/botões principais:** Exportar (;), Limpar Filtro, Teste Rápido, Ações.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/list`, `GET /api/membershiptransactions?page=1&credits=&status=&createdAtFrom=&createdAtTo=&perPage=20`.

##### /content — Novos Conteúdos

- **URL hash:** `#/content`
- **Título:** Novos Conteúdos
- **Propósito:** Exibir conteúdos recém-adicionados (cache de 10 minutos).
- **O que a tela mostra:** Aviso de cache (`lista em cache por 10 minutos`); seletores de período; modo de exibição; estado `Nenhum conteúdo disponível para a data selecionada`.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Últimos 3 Dias / Últimos 7 Dias / Dia a Dia | botão/filtro | — | Período do relatório |
| Mostrar Capa / Mostrar Texto / Mostrar Capa e Texto | radio (`content-display-mode`) | Não | Valores `cover`, `text`, `coverText` |
| Modais globais | text/number/textarea/checkbox | Não | Ver nota acima |

- **Tabelas de dados:** Nenhuma (sem grade; só texto de estado vazio).
- **Ações/botões principais:** Teste Rápido, Ações.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/content/BV4D3rLaqZ` (identificador do servidor generalizado).

##### /server-statistics — Estatísticas dos Servidores

- **URL hash:** `#/server-statistics`
- **Título:** Estatísticas dos Servidores
- **Propósito:** Resumo de clientes/conexões próprios e de subrevendas por servidor.
- **O que a tela mostra:** Blocos por servidor com `Ativo / Inativo / Total / Conexões` para `Clientes - Próprios` e `Clientes - Subrevendas`; links `Clique aqui para saber mais sobre os números acima`; seção `DICAS E TUTORIAIS`. Sem filtros nem grade.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| (nenhum campo próprio) | — | — | Só modais globais |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Teste Rápido; links para `#/customers`.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /utilities/domains — Domínios

- **URL hash:** `#/utilities/domains`
- **Título:** Domínios
- **Propósito:** Listar domínios comprados e oferecer compra de novo domínio.
- **O que a tela mostra:** Botão `Comprar Domínio`; grade vazia paginada (padrão 100 por página).
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Itens por página | select | Não | 5–100 (padrão 100) |
| Modais globais | text/number/textarea/checkbox | Não | Ver nota acima |

- **Tabelas de dados:**
  - `NOME DE DOMÍNIO | SERVIDOR | PAGAMENTO | SITUAÇÃO | DATA DA COMPRA | AÇÕES` — vazio.
- **Ações/botões principais:** Comprar Domínio, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/domains/available-servers`.

##### /system/servers — Servidores

- **URL hash:** `#/system/servers`
- **Título:** Servidores
- **Propósito:** Administração dos servidores do painel.
- **O que a tela mostra:** Só o título capturado; nenhuma grade ou formulário específico no JSON.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| (nenhum campo próprio) | — | — | Só modais globais |

- **Tabelas de dados:** Nenhuma capturada.
- **Ações/botões principais:** Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/servers/limit`, `GET /api/servers`.

##### /system/servers/add — Adicionar Servidor

- **URL hash:** `#/system/servers/add`
- **Título:** Adicionar Servidor
- **Propósito:** Cadastrar um servidor incluído na licença.
- **O que a tela mostra:** Texto `Incluso na sua Licença` + seção `GESTOR FINANCEIRO`; botões Cancelar/Salvar. Nenhum campo específico capturado no JSON além dos modais globais — lacuna de captura.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| (não capturados) | — | — | Lacuna: texto visível indica formulário, mas `inputs` traz só modais globais |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Cancelar, Salvar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/settings/timezones`, `GET /api/servers/licence`.

##### /system/servers/resync — Sincronizar Servidor

- **URL hash:** `#/system/servers/resync`
- **Título:** Sincronizar Servidor
- **Propósito:** Sincronizar revendas/clientes de todos os servidores ou de um único (útil ao trocar tecnologia, ex. XUI → XtreamUI); 1 sincronização por vez.
- **O que a tela mostra:** Explicações e opções (migrando para novo servidor, servidor, plano, revendas, comportamento de salvamento); tabela de servidores; confirmação `Entendido`; `Continuar`.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Migrando para um novo servidor? | radio | Não | `NO` / `YES` (cria cada cliente como se não existisse no novo) |
| Servidor / Plano / Revendas | text/radio | Não | `Sincronizar todos os servidores`; `Não altere o plano do cliente`; em branco = todos os revendas |
| Salvar clientes dentro de uma única revenda; demais flags Não/Sim | radio | Não | Vários grupos `NO`/`YES`; escopo de clientes `ACTIVE`/`BOTH` |
| Número de ressincronizações simultâneas (placeholder) | number | Não | Valor capturado `10` |
| Entendido | checkbox | Não | Confirmação antes de continuar |
| Modais globais | text/number/textarea/checkbox | Não | Ver nota acima |

- **Tabelas de dados:**
  - `Servidor | Configuração atual | Configuração de sincronização` — 1 linha (servidor próprio, `Não / Não Sim`).
- **Ações/botões principais:** Continuar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/servers`, `GET /api/resellers/list`, `GET /api/servers/resync/latest`.

##### /system/servers/mass-migrate — Migrar Clientes em Massa

- **URL hash:** `#/system/servers/mass-migrate`
- **Título:** Migrar Clientes em Massa
- **Propósito:** Migrar clientes de um servidor a outro, um por um (ativos primeiro; testes não migrados).
- **O que a tela mostra:** Regras (selo `Migração indisponível` até habilitar `Permitir migração em massa` em cada servidor; link `Abrir página de servidores`); origem e destino (ambos indisponíveis, 0 ativos/inativos); 2 confirmações; Cancelar/Continuar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Servidor de Origem / Servidor de Destino | radio | Não | Ambos com selo `Migração indisponível` |
| Entendo que o cliente será excluído da origem e criado no destino | checkbox | Não | Confirmação |
| Concordo que selecionei origem e destino corretos | checkbox | Não | Confirmação |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Abrir página de servidores, Cancelar, Continuar.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /system/servers/token-manager — Gerenciador de Token

- **URL hash:** `#/system/servers/token-manager`
- **Título:** Gerenciador de Token
- **Propósito:** Coordenar a troca do token/API de um servidor entre todos os painéis antes de aplicar neste painel.
- **O que a tela mostra:** Instruções de ordem (atualizar todos os outros painéis primeiro); seletor de servidor; campo de chave/token; `Continuar`; grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Servidor | text | Não | Servidor próprio exibido |
| Chave de API/Token do Servidor | text (placeholder `Obrigatório`) | Não (placeholder indica obrigatoriedade, `required` não marcado no JSON) | Token sensível — não reproduzir valor |
| Modais globais | text/number/textarea/checkbox | Não | Ver nota acima |

- **Tabelas de dados:**
  - `PAINEL | SERVIDOR | TIPO | DNS | URL/IP | CHAVE DE API/TOKEN | AÇÕES` — vazio.
- **Ações/botões principais:** Continuar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /system/notices — Avisos

- **URL hash:** `#/system/notices`
- **Título:** Avisos
- **Propósito:** Listar avisos exibidos no painel/dashboard.
- **O que a tela mostra:** Botão/cartão `Adicionar`; busca; grade com 2 avisos (títulos generalizados: central de links oficiais; comunicado a revendedores).
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar (placeholder) | text | Não | Busca da grade |
| Modais globais | text/number/textarea/checkbox | Não | Ver nota acima |

- **Tabelas de dados:**
  - `TÍTULO | ORDEM | VISÍVEL DE | VISÍVEL ATÉ | LOCAL DE EXIBIÇÃO | AÇÕES` — 2 linhas; ordens `-1` e `1`; vigência `-`; local traz JSON/HTML interno (IDs e descrição não reproduzidos).
- **Ações/botões principais:** Adicionar, Teste Rápido, Ações por linha.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/notices`.

##### /system/notices/add — Adicionar Aviso

- **URL hash:** `#/system/notices/add`
- **Título:** Adicionar Aviso
- **Propósito:** Criar um aviso (título, descrição rica, ordem, local, cor, vigência).
- **O que a tela mostra:** Formulário com editor (ordered/bullet); ordem com ajuda (menor = topo, negativos permitidos); local de exibição; cor; `Visível de/até`; Cancelar/Salvar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Título (placeholder `Obrigatório`) | text | Não (placeholder indica obrigatoriedade) | — |
| Descrição | editor rico | Não | Botões `ordered`, `bullet` |
| Ordem | number | Não | Valor capturado `0`; ajuda sobre negativos |
| Local de Exibição | radio | Não | `NOTICE_LIST` (só lista), `DASHBOARD` (só painel), `NOTICE_LIST_AND_DASHBOARD` (ambos) |
| Cor | select | Não | Opções vazias no JSON (lacuna) |
| Visível de / Visível até (placeholders `Escolha uma data`, `Select date/time`) | text (datepicker) | Não | Date+time; botões `Now`, `OK`; calendários à parte |
| Modais globais | text/number/textarea/checkbox | Não | Ver nota acima |

- **Tabelas de dados:** Só calendários dos datepickers.
- **Ações/botões principais:** Cancelar, Salvar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /system/default-playlist-template — Template de Playlist Padrão

- **URL hash:** `#/system/default-playlist-template`
- **Título:** Template de Playlist Padrão
- **Propósito:** Listar templates padrão de playlist.
- **O que a tela mostra:** Grade vazia, sem filtros capturados.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| (nenhum campo próprio) | — | — | Só modais globais |

- **Tabelas de dados:**
  - `NOME | TIPO DE CONEXÃO | TEMPLATE | AÇÕES` — vazio.
- **Ações/botões principais:** Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/default-playlist-templates`.

##### /system/credit-bonus-campaigns — Campanhas de Bônus

- **URL hash:** `#/system/credit-bonus-campaigns`
- **Título:** Campanhas de Bônus
- **Propósito:** Listar campanhas de bônus sobre recarga.
- **O que a tela mostra:** Cartão/botão `Adicionar`; busca `Pesquisar`; grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar (placeholder) | text | Não | Busca da grade |

- **Tabelas de dados:**
  - `VÁLIDO DE | VÁLIDO ATÉ | PERCENTUAL DE BÔNUS | RECARGA MÍNIMA | RECARGA MÁXIMA | AÇÕES` — vazio.
- **Ações/botões principais:** Adicionar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/creditbonuscampaigns`.

##### /system/credit-bonus-campaigns/add — Adicionar Campanha de Bônus de Crédito

- **URL hash:** `#/system/credit-bonus-campaigns/add`
- **Título:** Adicionar Campanha de Bônus de Crédito
- **Propósito:** Criar campanha (percentual + faixa de recarga + vigência).
- **O que a tela mostra:** Formulário + Cancelar/Salvar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Percentual de Bônus | number | Não | Valor capturado `1` |
| Recarga Mínima | number | Não | Valor capturado `1` |
| Recarga Máxima | number | Não | Valor capturado `1000` |
| Válido de / Válido até (placeholders `Escolha uma data`, `Select date/time`) | text (datepicker) | Não | Date+time; `Now`, `OK` |
| Modais globais | text/number/textarea/checkbox | Não | Ver nota acima |

- **Tabelas de dados:** Só calendários.
- **Ações/botões principais:** Cancelar, Salvar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /system/packages — Planos

- **URL hash:** `#/system/packages`
- **Título:** Planos
- **Propósito:** Gerenciar planos (catálogo administrativo).
- **O que a tela mostra:** Filtros (texto visível: Servidor, Teste, Situação, Créditos, Conexões, Duração, Conteúdo Adulto) + `Limpar Filtro` + `Adicionar`; grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar (placeholder) | text | Não | Busca livre |
| Servidor / Situação / Créditos / Conexões / Duração / Teste / Conteúdo Adulto | inputs/filtros | Não | Vários text sem label no JSON (lacuna de rótulos) |
| Limpar Filtro | botão | — | — |

- **Tabelas de dados:**
  - `SERVIDOR | PLANO | SITUAÇÃO | TESTE | VALOR DO PLANO | CRÉDITOS | CONEXÕES | DURAÇÃO | ORDEM | AÇÕES` — vazio.
- **Ações/botões principais:** Adicionar, Limpar Filtro, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/packages?page=1&name=&serverId=&isTrial=&status=&credits=&connections=&durationIn=&isAdult=`.

##### /system/packages/add — Adicionar Plano

- **URL hash:** `#/system/packages/add`
- **Título:** Adicionar Plano
- **Propósito:** Criar plano com servidor (imutável após salvar), preço/créditos, duração, teste e multi-servidor.
- **O que a tela mostra:** Formulário completo + alertas (plano pago sem preço/créditos exige confirmação); Cancelar/Salvar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Nome (placeholder `Obrigatório`) | text | Não (placeholder indica obrigatoriedade) | Visível a clientes e revendas |
| Servidor | radio | Não | Servidor próprio (2 opções capturadas); não alterável após salvar |
| Ordem | number (placeholder `Somente números`) | Não | Valor `0`; menor = topo, negativos permitidos |
| Situação | radio | Não | `ACTIVE` (Ativo) / `INACTIVE` (Inativo) |
| Teste | radio | Não | `NO` (Não) / `YES` (Sim) |
| Valor do Plano (placeholder `Obrigatório, 0 é permitido`) | text | Não | — |
| Créditos (placeholder `Obrigatório, 0 é permitido`) | text | Não | Valor capturado `1` |
| Duração | number | Não | Valor `1` |
| Duração Em | radio | Não | `MINUTES` / `HOURS` / `DAYS` / `MONTHS` / `YEARS` (ex.: `1 Mês`) |
| Ativar Multi-Servidor (Beta) | checkbox | Não | Exige servidor principal antes |
| Template (Opcional) (placeholder `Deixe em branco para usar o padrão no cadastro do servidor`) | textarea | Não | — |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Cancelar, Salvar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /system/packages-price — Planos (Preço)

- **URL hash:** `#/system/packages-price`
- **Título:** Planos
- **Propósito:** Visão somente-leitura do catálogo com preço de revenda (`Editar` por linha).
- **O que a tela mostra:** Busca `Pesquisar`; grade com 16 planos (texto indica `1 até 16 de 16`).
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar (placeholder) | text | Não | Filtro `name` |

- **Tabelas de dados:**
  - `SERVIDOR | PLANO | VALOR DO PLANO | MEU PREÇO | CRÉDITOS | DURAÇÃO | AÇÕES` — 16 linhas; todas do servidor próprio; `MEU PREÇO` vazio (`-`); exemplos: 1 mês 1 crédito; 3 meses 3–6 créditos; 6 meses 6–12 créditos; 12 meses 12–24 créditos; variantes 1/2 telas e com/sem conteúdo adulto; ação `Editar`.
- **Ações/botões principais:** Editar (por linha), Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/packages/price?page=1&name=`.

##### /system/credit-packages — Pacote de Créditos

- **URL hash:** `#/system/credit-packages`
- **Título:** Pacote de Créditos
- **Propósito:** Gerenciar faixas de venda de créditos (administrativo).
- **O que a tela mostra:** Botão/cartão `Adicionar`; grade com 13 faixas (`1 até 13 de 13`), todas `Ativo`.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| (nenhum campo próprio) | — | — | Só modais globais |

- **Tabelas de dados:**
  - `CRÉDITOS | SITUAÇÃO | VALOR POR UNIDADE | TOTAL | AÇÕES` — faixas de 1 a 1000 créditos; valor unitário decrescente por volume (ex.: 1, 5, 10, 25, 50 … 1000); ação `Ações`.
- **Ações/botões principais:** Adicionar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/creditpackages?page=1`.

##### /system/credit-packages/add — Adicionar Pacote de Crédito

- **URL hash:** `#/system/credit-packages/add`
- **Título:** Adicionar Pacote de Crédito
- **Propósito:** Criar uma faixa de créditos.
- **O que a tela mostra:** Formulário mínimo + Cancelar/Salvar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Créditos (placeholder `Obrigatório`) | text | Não (placeholder indica obrigatoriedade) | — |
| Valor por Unidade (placeholder `Obrigatório`) | text | Não (placeholder indica obrigatoriedade) | — |
| Situação | radio | Não | `ACTIVE` (Ativo) / `INACTIVE` (Inativo) |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Cancelar, Salvar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /system/credit-packages-price — Pacote de Créditos (Preço)

- **URL hash:** `#/system/credit-packages-price`
- **Título:** Pacote de Créditos
- **Propósito:** Visão somente-leitura das faixas para a revenda (`Editar` por linha).
- **O que a tela mostra:** Grade com as mesmas 13 faixas (`1 até 13 de 13`).
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| (nenhum campo próprio) | — | — | Só modais globais |

- **Tabelas de dados:**
  - `CRÉDITOS | VALOR POR UNIDADE | TOTAL | MEU VALOR MÍNIMO POR UNIDADE | MEU TOTAL | AÇÕES` — mesmos 13 pacotes; colunas `MEU …` vazias; ação `Editar`.
- **Ações/botões principais:** Editar (por linha), Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/creditpackages/price?page=1`.

##### /system/trialblocker — Bloqueio de Teste

- **URL hash:** `#/system/trialblocker`
- **Título:** Bloqueio de Teste
- **Propósito:** Listar janelas em que testes são bloqueados para priorizar pagantes.
- **O que a tela mostra:** Cartão/botão `Adicionar`; busca; grade com 1 bloqueio (`1 até 1 de 1`).
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar (placeholder) | text | Não | Busca da grade |

- **Tabelas de dados:**
  - `MOTIVO | BLOQUEAR DE | BLOQUEAR ATÉ | AÇÕES` — 1 linha generalizada: motivo sobre priorizar pagantes + intervalo em 23/07/2025 (20:00–23:30).
- **Ações/botões principais:** Adicionar, Ações, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/trialblockers`.

##### /system/trialblocker/add — Adicionar Bloqueio de Teste

- **URL hash:** `#/system/trialblocker/add`
- **Título:** Adicionar Bloqueio de Teste
- **Propósito:** Criar uma janela de bloqueio de testes.
- **O que a tela mostra:** Formulário + Cancelar/Salvar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Motivo (placeholder `Opcional`) | text | Não | Visível às revendas |
| Bloquear de / Bloquear até (placeholders `Escolha uma data`, `Select date/time`) | text (datepicker) | Não | Date+time; `Now`, `OK`; calendários à parte |

- **Tabelas de dados:** Só calendários.
- **Ações/botões principais:** Cancelar, Salvar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /system/membership-plans — Planos Mensalista

- **URL hash:** `#/system/membership-plans`
- **Título:** Planos Mensalista
- **Propósito:** Listar planos de cobrança de mensalistas.
- **O que a tela mostra:** Cartão/botão `Adicionar`; busca; grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar (placeholder) | text | Não | Busca da grade |

- **Tabelas de dados:**
  - `PLANO | TIPO | SITUAÇÃO | VALOR DO PLANO | CONTAGEM MÍNIMA DE CONEXÕES | CONTAGEM MÁXIMA DE CONEXÕES | AÇÕES` — vazio.
- **Ações/botões principais:** Adicionar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/membershipplans`.

##### /system/membership-plans/add — Adicionar Plano Mensalista

- **URL hash:** `#/system/membership-plans/add`
- **Título:** Adicionar Plano Mensalista
- **Propósito:** Criar plano mensalista por conexão ou valor fixo com faixa de conexões.
- **O que a tela mostra:** Formulário + Cancelar/Salvar; ajuda: `Valor por Conexão` multiplica conexões com vencimento futuro; senão valor fixo dentro da faixa.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Nome (placeholder `Obrigatório`) | text | Não (placeholder indica obrigatoriedade) | — |
| Situação | radio | Não | `ACTIVE` / `INACTIVE` |
| Tipo do Plano | radio | Não | `PER_ACTIVE_CUSTOMER` (Valor por Conexão) / `FIXED` (Valor Fixo) |
| Valor por Conexão (placeholder `Obrigatório`) | text | Não | — |
| Contagem Mínima/Máxima de Conexões | number | Não | Faixa de aplicação do valor fixo |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Cancelar, Salvar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /system/subpanels — Subpainéis

- **URL hash:** `#/system/subpanels`
- **Título:** Subpainéis
- **Propósito:** Listar subpainéis vinculados.
- **O que a tela mostra:** Cartão/botão `Adicionar`; busca; grade vazia.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Pesquisar (placeholder) | text | Não | Filtro `name` |

- **Tabelas de dados:**
  - `SUBPAINEL | CONTADOR | AÇÕES` — vazio.
- **Ações/botões principais:** Adicionar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/subpanels?page=1&name=`.

##### /system/subpanels/add — Adicionar Subpainel

- **URL hash:** `#/system/subpanels/add`
- **Título:** Adicionar Subpainel
- **Propósito:** Cadastrar subpainel (não permitido se o alvo já possui subpainéis) com sincronização opcional a partir deste painel.
- **O que a tela mostra:** Regras (comprar o painel antes via faturamento; sincronizar sobrescreve o subpainel e propaga exclusões); 3 campos obrigatórios; flags de sincronização (maioria `Em breve`); Cancelar/Salvar.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|-------------|------|-------------|--------------|
| Nome na barra lateral (placeholder `Obrigatório`) | text | Sim | — |
| Domínio do Painel (placeholder `Obrigatório`) | text | Sim | Exige painel comprado |
| Senha do Super Administrador (placeholder `Obrigatório`) | password | Sim | — |
| Bloqueio de Teste | checkbox | Não | Sincronizar deste painel |
| Permissões / Campanhas de Bônus / Planos / Pacote de Créditos / Servidores / Configurações Cliente/Revenda | checkbox | Não | Todas marcadas `Em breve` no texto visível |

- **Tabelas de dados:** Nenhuma.
- **Ações/botões principais:** Cancelar, Salvar, Teste Rápido.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /system/permissions — Permissions

- **URL hash:** `#/dashboard` (redirecionado; rota pedida `#/system/permissions`)
- **Título:** Dashboard (tela entregue); meta pedia `Permissions`
- **Propósito:** Não observável — acesso negado / redirecionado para o dashboard.
- **O que a tela mostra:** Dashboard padrão (modais globais + widgets do dashboard, sem conteúdo de permissões).
- **Campos de formulário:** Não aplicável (tela de dashboard).
- **Tabelas de dados:** Nenhuma da rota pedida.
- **Ações/botões principais:** Nenhum da rota pedida.
- **Endpoints de API chamados:** Nenhum específico da rota (só base do dashboard; `apiCalls` vazio no JSON).

##### /system/audit — System Audit

- **URL hash:** `#/dashboard` (redirecionado; rota pedida `#/system/audit`)
- **Título:** Dashboard (tela entregue); meta pedia `System Audit`
- **Propósito:** Não observável — acesso negado / redirecionado para o dashboard.
- **O que a tela mostra:** Dashboard padrão, sem trilha de auditoria.
- **Campos de formulário:** Não aplicável.
- **Tabelas de dados:** Nenhuma da rota pedida.
- **Ações/botões principais:** Nenhum da rota pedida.
- **Endpoints de API chamados:** Nenhum específico da rota (`apiCalls` vazio).

##### /system/server-request-logs — Server Request Logs

- **URL hash:** `#/dashboard` (redirecionado; rota pedida `#/system/server-request-logs`)
- **Título:** Dashboard (tela entregue); meta pedia `Server Request Logs`
- **Propósito:** Não observável — acesso negado / redirecionado para o dashboard.
- **O que a tela mostra:** Dashboard padrão, sem logs de requisições.
- **Campos de formulário:** Não aplicável.
- **Tabelas de dados:** Nenhuma da rota pedida.
- **Ações/botões principais:** Nenhum da rota pedida.
- **Endpoints de API chamados:** Nenhum específico da rota (`apiCalls` vazio).

##### /utilities/domains/all — All Domains

- **URL hash:** `#/dashboard` (redirecionado; rota pedida `#/utilities/domains/all`)
- **Título:** Dashboard (tela entregue); meta pedia `All Domains`
- **Propósito:** Não observável — acesso negado / redirecionado para o dashboard.
- **O que a tela mostra:** Dashboard padrão, sem lista de domínios.
- **Campos de formulário:** Não aplicável.
- **Tabelas de dados:** Nenhuma da rota pedida.
- **Ações/botões principais:** Nenhum da rota pedida.
- **Endpoints de API chamados:** Nenhum específico da rota (`apiCalls` vazio).

#### Endpoints de API do módulo

- `GET /api/auth/me`
- `GET /api/content/BV4D3rLaqZ` (identificador do servidor generalizado)
- `GET /api/creditbonuscampaigns`
- `GET /api/creditorders?page=1&credits=&status=&createdAtFrom=&createdAtTo=&perPage=20`
- `GET /api/creditpackages?page=1`
- `GET /api/creditpackages/price?page=1`
- `GET /api/customerorders?page=1&username=&status=&createdAtFrom=&createdAtTo=&packageId=&perPage=20`
- `GET /api/default-playlist-templates`
- `GET /api/domain-registration-credits?page=1&perPage=20`
- `GET /api/domains/available-servers`
- `GET /api/membershipplans`
- `GET /api/membershiptransactions?page=1&credits=&status=&createdAtFrom=&createdAtTo=&perPage=20`
- `GET /api/notices`
- `GET /api/packages?page=1&name=&serverId=&isTrial=&status=&credits=&connections=&durationIn=&isAdult=`
- `GET /api/packages/price?page=1&name=`
- `GET /api/resellers/list`
- `GET /api/servers`
- `GET /api/servers/licence`
- `GET /api/servers/limit`
- `GET /api/servers/resync/latest`
- `GET /api/settings/public`
- `GET /api/settings/timezones`
- `GET /api/subpanels?page=1&name=`
- `GET /api/trialblockers`

#### Observações e limites

- Páginas vazias (estado `Nenhum dado para mostrar` / `Nenhum conteúdo disponível`): `/billing/credit-orders`, `/billing/domain-registration-credits`, `/billing/customers-orders`, `/billing/membership-transactions`, `/content`, `/utilities/domains`, `/system/servers/token-manager`, `/system/default-playlist-template`, `/system/credit-bonus-campaigns`, `/system/packages`, `/system/membership-plans`, `/system/subpanels`. Com dados: `/system/notices` (2), `/system/packages-price` (16), `/system/credit-packages` e `/system/credit-packages-price` (13 cada), `/system/trialblocker` (1).
- Acessos negados/redirecionados para `#/dashboard` (role `super-admin` exigida, conta atual sem acesso): `/system/permissions`, `/system/audit`, `/system/server-request-logs`, `/utilities/domains/all`. Nesses 4, `finalUrl`, `docTitle`/`pageTitle` (`Dashboard`) e `apiCalls` vazio confirmam o redirecionamento; nada da tela pedida foi capturado.
- Tabelas `Sun..Sat` no JSON são calendários de datepickers, sem valor de negócio.
- Lacunas de captura: `/system/servers/add` exibe formulário mas o JSON só traz modais globais; `/system/notices/add` traz selects de cor com opções vazias; `/system/packages` traz filtros sem rótulos; valores exatos de Situação/Revenda/Plano nos filtros billing não foram capturados; `required` é quase sempre `false` no JSON mesmo com placeholder `Obrigatório` (exceção: 3 campos de `/system/subpanels/add` com `required: true`).
- Nenhum `modal` dedicado capturado em nenhuma rota do módulo (`modals: []` em todas); diálogos aparecem só como headings/inputs globais.
- Dados pessoais/identificadores do JSON (conta, IDs de servidor/usuário/avisos, chaves, telefones, links externos) foram generalizados ou omitidos conforme regra.

### Módulo 5 — Configurações, Automação BotBot e Integrações

#### Visão geral

O módulo reúne as telas de parametrização do painel (gerais, clientes, revendas, notificações, manutenção, domínio, domínios para revenda, backup, estilo, desenvolvedores), as operações de cópia entre painéis (servidor e configurações), a automação de mensagens via BotBot/ChatBot (teste automático, clientes, revendas, credenciais) e as integrações (galeria de pagamentos/análises/mensagens, API de revenda e webhooks). O padrão visual das telas de configuração é repetitivo: formulário com botões "Reverter alterações"/"Salvar" (ou "Copiar"/"Ativar") e, em todas as rotas, os mesmos diálogos globais ("Renovar", "Adicionar Créditos", "Detalhes do Cliente", "Nova Mensagem", "Teste Rápido"), cujos campos se repetem no JSON e são consolidados uma única vez em "Observações e limites".

#### Rotas do módulo

| Rota | Título da página | Permissão exigida | Observação |
|---|---|---|---|
| /settings/general | Configurações Gerais | update general settings | acesso direto |
| /settings/content-requests | Solicitações | update content-request settings | acesso direto; add-ons pagos inativos |
| /settings/panel-subscription | Panel Subscription | manage panel addons (`permissionsAny`) | acesso negado / redirecionado para o dashboard |
| /settings/domains | Configurações de Domínios | update domains settings | acesso direto; complemento pago |
| /settings/notifications | Configurações de Notificações | update notifications settings | acesso direto |
| /settings/maintenance | Configurações de Manutenção | update maintenance settings | acesso direto |
| /settings/domain | Configurações de Domínio do Painel | update domain settings | acesso direto |
| /settings/backup | Restaurar Backup | update backup settings | acesso direto; nenhum backup disponível |
| /settings/customers | Configurações dos Clientes | update customers settings | acesso direto |
| /settings/resellers | Configurações de Revendas | update resellers settings | acesso direto |
| /settings/style | Configurações de Estilo | update style settings | acesso direto; personalização de tema é add-on pago |
| /settings/developers | Configurações de Desenvolvedores | update developers settings | acesso direto; token = acesso SUPER ADMIN |
| /settings/developers/api-reference | Documentação da API | update developers settings | acesso direto; falha 403 ao carregar o OpenAPI |
| /settings/servers-copy | Copiar Servidor | create subpanels | acesso direto |
| /settings/settings-copy | Copiar Configurações | create subpanels | acesso direto; operação irreversível |
| /chatbot | ChatBot | use chatbot | acesso direto; URLs de chatbot por plano |
| /automation/botbot-automatic-test | BotBot Teste Automático | create customer | acesso direto; tutorial + URLs por plano |
| /automation/botbot-customers | BotBot Automação de Clientes | create customer | acesso direto; templates com variáveis |
| /automation/botbot-resellers | BotBot Automação de Revendas | access reseller pages | acesso direto; templates com variáveis |
| /automation/botbot-settings | Integrações (BotBot Settings) | create customer | renderiza a galeria `#/integrations?integration=botbot` |
| /integrations/reseller-api | API de Revenda | — (string vazia no meta) | acesso direto; "Integração não encontrada." |
| /integrations/reseller-api/api-reference | Documentação da API de Revenda | — (string vazia no meta) | acesso direto; falha 402 ao carregar o OpenAPI |
| /integrations/reseller-api/deliveries | Entregas de Webhook | — (string vazia no meta) | acesso direto; integração inativa |
| /integrations/botbot | Integrações | — (string vazia no meta) | renderiza a galeria `#/integrations?integration=botbot&tab=browse` |
| /resellers/content-requests | Requests | `permissionsAny` (create/manage/view/vote content request) | acesso negado / redirecionado para o dashboard |

#### Páginas

##### /settings/general — Configurações Gerais

- **URL hash:** `#/settings/general`
- **Título:** Configurações Gerais (`Configurações Gerais | CINEVISION ONE`)
- **Propósito:** identidade do painel, canais de contato e padrões de locale/moeda/fuso.
- **O que a tela mostra:** data de vencimento do painel; nome do site; URLs de Telegram e WhatsApp (com texto de ajuda sobre o formato e exibição como ícone na barra superior); ativar tickets de suporte; moeda; idioma (locale); fuso horário do servidor; aviso de login. Botões "Reverter alterações"/"Salvar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `site_name` ("Nome do Site") | text | Não | nome exibido do painel |
| `telegram` ("Opcional") | text | Não | URL do Telegram |
| `whatsapp` ("Opcional") | text | Não | URL do WhatsApp |
| `enable_support_ticket` | select | Não | Sim / Não |
| `currency` | select | Não | lista ampla de moedas (valor registrado: BRL) |
| `locale` | select | Não | lista de locales (valor registrado: pt-BR) |
| `server_timezone` | select | Não | lista de fusos (valor registrado: America/Sao_Paulo) |
| `login_notice_enabled` | select | Não | Sim / Não |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Reverter alterações", "Salvar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/settings/currencies`, `GET /api/settings/locales`, `GET /api/settings/timezones`, `GET /api/settings/general`.

##### /settings/content-requests — Solicitações

- **URL hash:** `#/settings/content-requests`
- **Título:** Solicitações (`Solicitações | CINEVISION ONE`)
- **Propósito:** cotas/política de solicitação de conteúdo, webhooks do ciclo de vida e resumos de notificação.
- **O que a tela mostra:** três cartões — "Política de Solicitação de Conteúdo", "Webhooks" (eventos assinados para integração própria) e "Resumos de Notificações". Todos exibem "Este complemento pago não está ativo para este painel"; link "Ver Assinatura do Painel" (`#/settings/panel-subscription`); estado "Nenhum webhook configurado".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| URL do endpoint (`https://`) | url | Sim | destino dos eventos assinados |
| Eventos (`content_request.created`, `.voted`, `.subscribed`, `.status_changed`, `.available`, `.rejected`) | checkbox | Não | um toggle por evento |
| Ativo | checkbox | Não | ativa o webhook |
| Modo de entrega (`delivery-mode`) | radio | Não | `immediate` / `daily` / `weekly` |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Salvar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/content-request/settings`, `GET /api/content-request/questions`, `GET /api/content-request/webhooks`, `GET /api/content-request/notification-preference`.

##### /settings/panel-subscription — Assinatura do Painel

- **URL hash:** pretendido `#/settings/panel-subscription`; **URL final:** `#/dashboard`.
- **Título:** meta `Panel Subscription`; página entregue é o Dashboard.
- **Propósito:** gestão de add-ons/assinatura do painel (permissão `manage panel addons` em `permissionsAny`).
- **O que a tela mostra:** nada da assinatura — acesso negado / redirecionado para o dashboard.
- **Campos de formulário:** não aplicável (conteúdo do dashboard pertence ao Módulo 1).
- **Tabelas de dados:** não aplicável.
- **Ações/botões principais:** não aplicável.
- **Endpoints de API chamados:** nenhum registrado no JSON (`apiCalls: []`).

##### /settings/domains — Configurações de Domínios

- **URL hash:** `#/settings/domains`
- **Título:** Configurações de Domínios (`Configurações de Domínios | CINEVISION ONE`)
- **Propósito:** venda de domínios para revendas (complemento pago via Namecheap/Cloudflare).
- **O que a tela mostra:** aviso de que o Domain Purchase é complemento pago; seção "Servidores para Compra de Domínio" com estado "Nenhum servidor elegível foi encontrado"; ativar compra de domínio (Sim/Não); modo de pagamento (cobrar créditos/dinheiro); TLDs permitidas; custo de crédito por TLD. Botão "Copiar IP".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `domains_enabled` | select | Não | Sim / Não |
| `domains_max_domains_per_reseller` | number | Não | teto por revenda |
| `domains_allowed_tlds` | text | Não | TLDs separadas por vírgula |
| `namecheap_api_user` / `namecheap_api_key` | text | Não | credenciais (valores omitidos) |
| `domains_contact_first_name` / `last_name` / `email` | text | Não | contato do registrante |
| `domains_contact_address_line_1/2/3`, `city`, `state`, `postcode`, `phone` | text | Não | endereço/telefone do registrante |
| `domains_contact_country` | select | Não | lista de países |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Copiar IP".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/settings/countries`, `GET /api/settings/domains`, `GET /api/settings/domains/servers`, `GET /api/settings/domains/payment-gateways`.

##### /settings/notifications — Configurações de Notificações

- **URL hash:** `#/settings/notifications`
- **Título:** Configurações de Notificações (`Configurações de Notificações | CINEVISION ONE`)
- **Propósito:** definir quando eventos geram itens na página de Notificações e os contatos de cobrança do painel.
- **O que a tela mostra:** cartão "Notificações de Revenda" (limite de exclusão de clientes que dispara notificação; 0 desativa sem bloquear; opção de notificar o master; super admins sempre recebem) e cartão "Notificações do Painel" (lembretes de cobrança ativos quando há ao menos um contato; envio diário às 14h no fuso do painel enquanto o vencimento for hoje, atrasado ou em até 5 dias). Botões "Reverter alterações"/"Salvar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `notification_reseller_deletion_customers_threshold` | number | Não | 0 desativa |
| `notification_reseller_deletion_send_to_reseller` | select | Não | Sim / Não |
| `notification_email` ("Opcional") | text | Não | múltiplos endereços separados |
| `telegram` / `whatsapp` ("Opcional") | text | Não | contatos de cobrança |
| `notification_botbot_appkey` / `notification_botbot_authkey` ("Opcional") | text | Não | credenciais (valores omitidos) |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Reverter alterações", "Salvar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/settings/notifications`.

##### /settings/maintenance — Configurações de Manutenção

- **URL hash:** `#/settings/maintenance`
- **Título:** Configurações de Manutenção (`Configurações de Manutenção | CINEVISION ONE`)
- **Propósito:** colocar o painel em modo manutenção e definir a mensagem de login.
- **O que a tela mostra:** seletor de modo + mensagem exibida na tentativa de login. Botões "Reverter alterações"/"Salvar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `maintenance_mode` | select | Não | Desligado (todos logam) / Ligado (só superusuário) |
| `custom_domain` | text | Não | campo de texto da tela |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Reverter alterações", "Salvar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/settings/maintenance`.

##### /settings/domain — Configurações de Domínio do Painel

- **URL hash:** `#/settings/domain`
- **Título:** Configurações de Domínio do Painel (`Configurações de Domínio do Painel | CINEVISION ONE`)
- **Propósito:** domínio/subdomínio pelo qual as revendas acessam o painel.
- **O que a tela mostra:** alerta para comprar o domínio e configurar o Cloudflare antes de usar, não digitar o DNS do servidor (alteração de DNS é em Servidores) e exemplo de formato (domínio ou subdomínio). Botões "Reverter alterações"/"Salvar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `custom_domain` | text | Não | somente domínio/subdomínio |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Reverter alterações", "Salvar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/settings/domain`.

##### /settings/backup — Restaurar Backup

- **URL hash:** `#/settings/backup`
- **Título:** Restaurar Backup (`Restaurar Backup | CINEVISION ONE`)
- **Propósito:** restauração de backup do painel.
- **O que a tela mostra:** estado vazio — "Nenhum backup disponível". Sem campos próprios além dos diálogos globais.
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| (nenhum campo próprio) | — | — | somente campos globais do diálogo |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** nenhum específico capturado.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/settings/backup/list`.

##### /settings/customers — Configurações dos Clientes

- **URL hash:** `#/settings/customers`
- **Título:** Configurações dos Clientes (`Configurações dos Clientes | CINEVISION ONE`)
- **Propósito:** regras de criação, credenciais, expiração e migração de clientes.
- **O que a tela mostra:** formulário longo de regras (formato de usuário/senha, tamanhos, exclusão de expirados/testes, comportamento de dias de cortesia, migração entre servidores/planos, caracteres proibidos, testes ilimitados via chatbot). Botões "Reverter alterações"/"Salvar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `username_format` | select | Não | numérico, numérico com traços, letras, alfanumérico (8 formatos) |
| `minimum_number_of_characters_username_password` | select | Não | 6–20 caracteres; controla geração aleatória |
| `maximum_number_of_characters_username_password` | select | Não | 6–20 caracteres |
| `delete_expired_customers_after_days` | select | Não | Não excluir / 1 dia a 24 meses |
| `delete_expired_trial_customers_after_days` | select | Não | Não excluir / 1 a 30 dias |
| `courtesy_days_behaviour` | select | Não | desabilitar confiança / somar / deduzir / deduzir se mesmo mês |
| `allow_server_migration`, `allow_migration_to_package_with_more_connections`, `set_expiry_hour_to_end_of_day`, `overflow_month`, `ignore_customer_plan_price` | select | Não | Sim / Não |
| `update_customer_password_when_importing_migration` | select | Não | Sim / Não |
| `prohibited_characters_customer_username_password` | text | Não | caracteres vetados |
| `allow_unlimited_trial_accounts_using_chatbot` | select | Não | Sim / Não |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Reverter alterações", "Salvar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/settings/customers`.

##### /settings/resellers — Configurações de Revendas

- **URL hash:** `#/settings/resellers`
- **Título:** Configurações de Revendas (`Configurações de Revendas | CINEVISION ONE`)
- **Propósito:** regras de criação, crédito, conexões, migração, sessão e mensalidade de revendas.
- **O que a tela mostra:** formulário longo (mensagem de login inativo; mínimos de crédito — sem efeito quando criado por link de indicação; conexões; migração de clientes com 4 modos de cobrança; inatividade/logout; bloqueio por falta de recarga; verificação de vencimento de mensalidade; limite de exclusões/24h; link de indicação). Botões "Reverter alterações"/"Salvar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `inactive_reseller_message` ("Opcional") | text | Não | mensagem de login inativo |
| `minimum_credits_to_create_reseller` / `minimum_credits_to_transfer` / `minimum_credits_to_create_trial` ("ex. 10") | text | Não | mínimos de crédito |
| `allow_set_number_of_connections`, `allow_reduce_customer_connections`, `reseller_password_must_include_symbol`, `allow_reseller_create_trial_if_zero_credits`, `show_active_trial_count_resellers`, `reseller_toggle_tree_status`, `allow_edit_customers_bouquets`, `enforce_membership_expiry_date_check`, `allow_reseller_login_if_membership_active`, `enable_referral_link` | select | Não | Sim / Não |
| `customer_max_connections` ("ex. 10") | text | Não | teto configurável pelo revenda; super admin sem limite |
| `allow_customer_migration` | select | Não | Sim / só <30 dias sem cobrar / 0,033 créd/dia / qualquer vencimento sem cobrar |
| `allow_reseller_login_if_zero_credits` | select | Não | Sim / Sim só p/ comprar créditos / Não |
| `number_of_minutes_of_inactivity_to_logout` | select | Não | Nunca / 10–30 min / 1h / 24h |
| `disable_after_days_without_recharge` ("ex. 10") | text | Não | bloqueio por falta de recarga |
| `resellers_max_customers_delete_per_24h` ("ex. 10") | text | Não | limite de exclusões/24h |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Reverter alterações", "Salvar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/resellers/roles`, `GET /api/settings/resellers`.

##### /settings/style — Configurações de Estilo

- **URL hash:** `#/settings/style`
- **Título:** Configurações de Estilo (`Configurações de Estilo | CINEVISION ONE`)
- **Propósito:** identidade visual (favicons, login, tema claro/escuro).
- **O que a tela mostra:** cartões "Ícones de favoritos" (PNG quadrado 512×512, máx. 128 KiB, separados claro/escuro), "Plano de fundo de login" (badge "Add-on necessário"; cor/imagem/vídeo; imagem e vídeo exigem o add-on Personalização de Tema), "Layout de login" (centralizado, tela dividida, cartão de vidro, editorial; logo 380×120px, PNG/SVG transparente recomendado), "Logos e fundos" por modo, "Estilo do painel" e "Personalização do Tema" (filtro de variáveis de cor). Links "Ver Assinatura do Painel"/"Adquirir add-on" e pré-visualizações do sign-in (modo claro/escuro × 4 layouts). Botões "Salvar", "Salvar Tema", "Redefinir tema para os padrões", "Limpar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Ícone de favoritos tema escuro/claro | file | Não | PNG 512×512, máx. 128 KiB |
| `auth_layout_background_type` | radio | Não | `colour` / `image` / `video` (imagem e vídeo exigem add-on) |
| `logo_dark` / `logo_light` | file | Não | png, jpg, jpeg, svg, gif |
| `auth_layout_background_dark` / `auth_layout_background_light` ("Cor de fundo de login") | text | Não | cor hexadecimal |
| `light_theme_aside_style` | radio | Não | `light` / `dark` (menu claro no tema claro) |
| Filtrar Cores ("Digite para filtrar variáveis de cor...") | text | Não | filtro de variáveis do tema |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Salvar", "Salvar Tema", "Redefinir tema para os padrões", "Limpar", "Adquirir add-on".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/settings/logo/m1DK15aY?v=96171a0d`, `GET /api/auth/me`, `GET /api/settings/style`, `GET /api/settings/theme`.

##### /settings/developers — Configurações de Desenvolvedores

- **URL hash:** `#/settings/developers`
- **Título:** Configurações de Desenvolvedores (`Configurações de Desenvolvedores | CINEVISION ONE`)
- **Propósito:** token da API do painel (nível SUPER ADMIN, sem controle de permissões) e webhook de sincronização.
- **O que a tela mostra:** aviso severo (token dá acesso irrestrito: criar/ler/atualizar/excluir qualquer cliente; não é API de revenda; não compartilhar); checkbox de confirmação que libera a visualização do token; botões "Copiar"/"Gerar Novo Token"; cartão "Documentação da API" (link `#/settings/developers/api-reference`); cartão "Webhook ao Sincronizar" (chamado nas sincronizações de clientes). Botão "Salvar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Confirmo que li e entendi a mensagem acima | checkbox | Não | libera a visualização do token |
| `agreement` ("Você deve concordar...") | text | Não | aceite formal |
| `resync_webhook_enabled` | select | Não | Sim / Não |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Copiar", "Gerar Novo Token", "Salvar", "Ver documentação da API".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/settings/developers`.

##### /settings/developers/api-reference — Documentação da API

- **URL hash:** `#/settings/developers/api-reference`
- **Título:** Documentação da API (`Documentação da API | CINEVISION ONE`)
- **Propósito:** referência interativa (OpenAPI) da API do painel.
- **O que a tela mostra:** link "← Voltar para Configurações de Desenvolvedores"; aviso de que o formulário "Testar" atinge PRODUÇÃO (cuidado com PUT/POST/DELETE); erro "Falha ao carregar a documentação da API: Request failed with status code 403". Sem inputs nem tabelas.
- **Campos de formulário:** nenhum (`inputs: []`).
- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** nenhum específico (só navegação global e "Teste Rápido").
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/integration/openapi.json`.

##### /settings/servers-copy — Copiar Servidor

- **URL hash:** `#/settings/servers-copy`
- **Título:** Copiar Servidor (`Copiar Servidor | CINEVISION ONE`)
- **Propósito:** copiar configurações e planos de um servidor para um painel de destino.
- **O que a tela mostra:** URL do painel de destino; token do painel (obtido como superusuário em Configurações > Integrações); seleção de servidor por radio (ex.: dois servidores listados); aviso de que o token do servidor não é copiado e deve ser inserido manualmente no novo painel. Botão "Copiar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `domain` ("Obrigatório") | text | Não (flag `required: false` no JSON) | URL do painel de destino |
| `token` ("Obrigatório") | text | Não (flag `required: false` no JSON) | token do painel (valor omitido) |
| `server` | radio | Não | um radio por servidor disponível |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Copiar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/users/online-count`, `GET /api/servers`.

##### /settings/settings-copy — Copiar Configurações

- **URL hash:** `#/settings/settings-copy`
- **Título:** Copiar Configurações (`Copiar Configurações | CINEVISION ONE`)
- **Propósito:** copiar todas as configurações deste painel para um painel novo.
- **O que a tela mostra:** URL do painel de destino; token (obtido como superusuário em Configurações > Integrações); avisos de que a operação não é reversível e não deve ser usada em painéis existentes. Botão "Copiar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `domain` ("Obrigatório") | text | Não (flag `required: false` no JSON) | URL do painel de destino |
| `telegram` ("Obrigatório") | text | Não (flag `required: false` no JSON) | campo da tela (conforme JSON) |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Copiar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /chatbot — ChatBot

- **URL hash:** `#/chatbot`
- **Título:** ChatBot (`ChatBot | CINEVISION ONE`)
- **Propósito:** orientar a configuração de respostas automáticas de WhatsApp para entrega de testes.
- **O que a tela mostra:** cartão "Chatbot usando BotBot (Android e iPhone)" — informa que as configurações foram movidas para Automação do BotBot > Configurações BotBot, com link "Ir para as Configurações do BotBot" (`#/automation/botbot-settings`); cartão "Chatbot usando App Android" — aviso de que o Auto Reply é de terceiros (sem suporte Sigma), APK próprio (só Android, não iPhone), link da Play Store do Auto Reply; lista de URLs de chatbot por plano/dispositivo (padrão `/api/chatbot/{chave}/{código}`), cada uma com "Clique para Copiar a URL". Ressalva: sem coleta do número de quem chama, a mesma pessoa pode pedir vários testes.
- **Campos de formulário:** nenhum próprio (`inputs` só com os globais do diálogo).
- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Clique para Copiar a URL" (por plano), "Ir para as Configurações do BotBot".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/notices/list`.

##### /automation/botbot-automatic-test — BotBot Teste Automático

- **URL hash:** `#/automation/botbot-automatic-test`
- **Título:** BotBot Teste Automático (`BotBot Teste Automático | CINEVISION ONE`)
- **Propósito:** passo a passo para entregar testes automáticos via BotBot (iPhone e Android).
- **O que a tela mostra:** cartão "Teste Automático usando BotBot (iPhone e Android)": tutorial em vídeo, acesso ao Chatbot (`botbot.chat/user/chatbot`), "Criar Resposta" com palavra-chave (ex.: teste iptv), tipo de resposta URL, colar um dos links por plano; lista de URLs por plano/dispositivo com "Clique para Copiar a URL".
- **Campos de formulário:** nenhum próprio (`inputs` só com os globais do diálogo).
- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Clique para Copiar a URL" (por plano).
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/servers`.

##### /automation/botbot-customers — BotBot Automação de Clientes

- **URL hash:** `#/automation/botbot-customers`
- **Título:** BotBot Automação de Clientes (`BotBot Automação de Clientes | CINEVISION ONE`)
- **Propósito:** mensagens automáticas do ciclo de vida do cliente (teste, renovação, confirmação, playlist).
- **O que a tela mostra:** cartão "Configurações de automação do BotBot para clientes": atenção de que só funciona com WhatsApp válido no cadastro; regra de SMS (links contam 26 caracteres; >160 caracteres = múltiplos segmentos/créditos extras); toggles de envio (aviso de renovação geral, no dia do vencimento, 3 e 7 dias antes, 1 dia após; mensagem pré-vencimento de teste com opção "Não enviar"; playlist para novos clientes); templates com tags clicáveis (`{name}`, `{plan_price}`, `{expires_at}`, `{package}`, `{username}`, `{password}`, `{pay_url}`, `{email}`, `{note}`, `{telegram}`, `{amount}`, `{currency}`, `{plan}`, `{url}`). Botão "Salvar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `customer_expiry_test_template` | textarea | Não | aviso de vencimento do teste |
| `customer_renew_sms_template` | textarea | Não | SMS de renovação |
| `customer_expiry_test_template_after` | textarea | Não | mensagem pós-teste |
| `customer_renew_confirmation_sms_template` | textarea | Não | SMS de confirmação |
| `customer_renew_template` | textarea | Não | aviso de renovação (WhatsApp) |
| `customer_renew_confirmation_template` | textarea | Não | confirmação de renovação |
| Enviar aviso de renovação (geral / no dia / 3 dias antes / 7 dias antes / 1 dia após); playlist p/ novos clientes | checkbox | Não | toggles de envio |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Salvar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /automation/botbot-resellers — BotBot Automação de Revendas

- **URL hash:** `#/automation/botbot-resellers`
- **Título:** BotBot Automação de Revendas (`BotBot Automação de Revendas | CINEVISION ONE`)
- **Propósito:** mensagens automáticas do ciclo da revenda (recarga, mensalidade, confirmações).
- **O que a tela mostra:** cartão "Configurações de automação do BotBot para revendas": mesma ressalva de WhatsApp válido e regra de SMS; sugestão de 5h de diferença entre horários de clientes e revendas; fuso America/Sao_Paulo e hora de envio (12:00); toggles (lembrete de recarga 3 dias antes do bloqueio; renovação de mensalista no dia e 3 dias antes); templates WhatsApp + SMS com tags (`{name}`, `{last_recharge_at}`, `{credits}`, `{username}`, `{pay_url}`, `{expires_at}`, `{amount}`, `{currency}`, `{url}`, `{payment_method}`, `{order_number}`, `{transaction_id}`). Botão "Salvar".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| `reseller_recharge_message_3_days` / `reseller_recharge_sms_template` | textarea | Não | recarga 3 dias antes do bloqueio |
| `reseller_membership_renew_template_variable_amount_3_days` / `..._sms_variable_3_days` | textarea | Não | mensalidade valor variável, 3 dias antes |
| `reseller_membership_renew_template_variable_amount_expiry_day` / `..._sms_variable_expiry_day` | textarea | Não | mensalidade valor variável, no dia |
| `reseller_membership_renew_template_fixed_amount_3_days` / `reseller_membership_renew_sms_fixed_3_days` | textarea | Não | mensalidade valor fixo, 3 dias antes |
| `reseller_membership_renew_template_fixed_amount_expiry_day` / `reseller_membership_renew_sms_fixed_expiry_day` | textarea | Não | mensalidade valor fixo, no dia |
| `reseller_membership_renew_confirmation` / `..._confirmation_sms_template` / `..._confirmation_manual` / `..._confirmation_manual_sms_template` | textarea | Não | confirmações automática e manual |
| Toggles de envio (recarga 3 dias antes; renovação no dia / 3 dias antes) | checkbox | Não | conforme labels da tela |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Salvar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /automation/botbot-settings — Configurações BotBot

- **URL hash:** pretendido `#/automation/botbot-settings`; **URL final:** `#/integrations?integration=botbot`.
- **Título:** meta `BotBot Settings`; página entregue é Integrações (`Integrações | CINEVISION ONE`).
- **Propósito:** credenciais da integração BotBot dentro da galeria de integrações.
- **O que a tela mostra:** galeria com abas "Ativo 0", "Disponível 9", "Configurações" e filtros Todos/Mensagens/Análises/Formas de pagamento; destaque "Receba mais rápido com a paggpay"; Análises (Meta Pixel); Formas de pagamento (Asaas, Mercado Pago Primário/Secundário, paggpay Primário/Secundário, PayPal, Stripe); Mensagens (BotBot); cada item com "Suporte" e "Ativar"/"Ativar integração".
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Busca ("Pesquisar") | search | Não | filtro da galeria |
| `botbotappkey` ("App Key") | text | Não | credencial (valor omitido) |
| `botbotauthkey` ("Auth Key") | text | Não | credencial (valor omitido) |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Ativar", "Ativar integração", "Configurar a paggpay".
- **Endpoints de API chamados:** nenhum `/api/*` próprio registrado além dos globais (`apiCalls: []` no JSON).

##### /integrations/reseller-api — API de Revenda

- **URL hash:** `#/integrations/reseller-api`
- **Título:** API de Revenda (`API de Revenda | CINEVISION ONE`)
- **Propósito:** credenciais e acesso da API de revenda.
- **O que a tela mostra:** estado vazio — "Integração não encontrada.". Sem inputs próprios.
- **Campos de formulário:** nenhum próprio (`inputs` só com os globais do diálogo).
- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** nenhum específico capturado.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`.

##### /integrations/reseller-api/api-reference — Documentação da API de Revenda

- **URL hash:** `#/integrations/reseller-api/api-reference`
- **Título:** Documentação da API de Revenda (`Documentação da API de Revenda | CINEVISION ONE`)
- **Propósito:** referência interativa (OpenAPI) da API de revenda.
- **O que a tela mostra:** link "← Voltar para a API de Revenda"; aviso de que o "Testar" atinge PRODUÇÃO; erro "Falha ao carregar a documentação da API: Request failed with status code 402" (pagamento/add-on exigido). Sem inputs nem tabelas.
- **Campos de formulário:** nenhum (`inputs: []`).
- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** voltar para a API de Revenda.
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/reseller-api/v1/openapi.json`.

##### /integrations/reseller-api/deliveries — Entregas de Webhook

- **URL hash:** `#/integrations/reseller-api/deliveries`
- **Título:** Entregas de Webhook (`Entregas de Webhook | CINEVISION ONE`)
- **Propósito:** histórico de entregas dos webhooks da API de revenda.
- **O que a tela mostra:** filtro "Todos os status" e botão "Atualizar"; erro "Não foi possível carregar as entregas. Esta integração não está ativa para sua conta.". Sem inputs próprios além dos globais.
- **Campos de formulário:** nenhum próprio (`inputs` só com os globais do diálogo).
- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Atualizar".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/reseller-api/v1/me/webhooks`.

##### /integrations/botbot — Integrações (BotBot)

- **URL hash:** `#/integrations?integration=botbot&tab=browse`
- **Título:** Integrações (`Integrações | CINEVISION ONE`)
- **Propósito:** galeria de integrações com foco na BotBot.
- **O que a tela mostra:** idêntico a `/automation/botbot-settings`: abas "Ativo 0"/"Disponível 9"/"Configurações", destaque paggpay, Análises (Meta Pixel), pagamentos (Asaas, Mercado Pago ×2, paggpay ×2, PayPal, Stripe), Mensagens (BotBot).
- **Campos de formulário:**

| Campo/Label | Tipo | Obrigatório | Opções/Notas |
|---|---|---|---|
| Busca ("Pesquisar") | search | Não | filtro da galeria |
| `botbotappkey` ("App Key") | text | Não | credencial (valor omitido) |
| `botbotauthkey` ("Auth Key") | text | Não | credencial (valor omitido) |
| + campos globais do diálogo (ver Observações) | diversos | Não | repetidos em todas as rotas |

- **Tabelas de dados:** nenhuma (`tables: []`).
- **Ações/botões principais:** "Ativar", "Ativar integração", "Configurar a paggpay".
- **Endpoints de API chamados:** `GET /api/settings/public`, `GET /api/auth/me`, `GET /api/integrations`.

##### /resellers/content-requests — Solicitações (revendas)

- **URL hash:** pretendido `#/resellers/content-requests`; **URL final:** `#/dashboard`.
- **Título:** meta `Requests`; página entregue é o Dashboard.
- **Propósito:** solicitações de conteúdo no contexto de revendas (`permissionsAny`: create/manage/view own/view all/vote content request).
- **O que a tela mostra:** nada da funcionalidade — acesso negado / redirecionado para o dashboard.
- **Campos de formulário:** não aplicável (conteúdo do dashboard pertence ao Módulo 1).
- **Tabelas de dados:** não aplicável.
- **Ações/botões principais:** não aplicável.
- **Endpoints de API chamados:** nenhum registrado no JSON (`apiCalls: []`).

#### Endpoints de API do módulo

Lista única (método + caminho, sem telemetria de erro/Sentry):

- `GET /api/settings/public`
- `GET /api/auth/me`
- `GET /api/settings/currencies`
- `GET /api/settings/locales`
- `GET /api/settings/timezones`
- `GET /api/settings/general`
- `GET /api/content-request/settings`
- `GET /api/content-request/questions`
- `GET /api/content-request/webhooks`
- `GET /api/content-request/notification-preference`
- `GET /api/settings/countries`
- `GET /api/settings/domains`
- `GET /api/settings/domains/servers`
- `GET /api/settings/domains/payment-gateways`
- `GET /api/settings/notifications`
- `GET /api/settings/maintenance`
- `GET /api/settings/domain`
- `GET /api/settings/backup/list`
- `GET /api/settings/customers`
- `GET /api/resellers/roles`
- `GET /api/settings/resellers`
- `GET /api/settings/logo/m1DK15aY?v=96171a0d`
- `GET /api/settings/style`
- `GET /api/settings/theme`
- `GET /api/settings/developers`
- `GET /api/integration/openapi.json`
- `GET /api/users/online-count`
- `GET /api/servers`
- `GET /api/notices/list`
- `GET /api/reseller-api/v1/openapi.json`
- `GET /api/reseller-api/v1/me/webhooks`
- `GET /api/integrations`

#### Observações e limites

- **Campos globais do diálogo (repetidos em todas as rotas com formulário, omitidos das tabelas acima por concisão):** Referência (text); "Criar pedido de cliente para este pagamento" (checkbox); "Use casas decimais" (checkbox); valor (number); texto (text); observações (textarea); "Registrar como pagamento manual/offline/em dinheiro" (checkbox); "Eu concordo em transferir 0 créditos" (checkbox); "Pesquisar" (text/search). Pertencem aos modais globais "Renovar", "Adicionar Créditos", "Detalhes do Cliente", "Nova Mensagem" e à busca do topo, não às telas do módulo.
- **Acessos negados / redirecionados para o dashboard (2):** `/settings/panel-subscription` (exige `manage panel addons`) e `/resellers/content-requests` (exige permissões de content-request) — ambos com `finalUrl` em `#/dashboard` e conteúdo do Dashboard.
- **Páginas vazias / estados vazios (5):** `/settings/backup` ("Nenhum backup disponível"); `/integrations/reseller-api` ("Integração não encontrada."); `/settings/developers/api-reference` (erro 403 ao carregar OpenAPI); `/integrations/reseller-api/api-reference` (erro 402 ao carregar OpenAPI); `/integrations/reseller-api/deliveries` (integração inativa, entregas não carregam).
- **Complementos pagos inativos (3 telas):** solicitação de conteúdo (`/settings/content-requests`), compra de domínios (`/settings/domains`, sem servidores elegíveis) e personalização de tema/`/settings/style` (fundo com imagem/vídeo exige add-on) — todas remetem a "Ver Assinatura do Painel".
- **Tabelas e modais:** nenhuma rota do módulo capturou `<table>` (`tables: []` em todas) nem modais (`modals: []` em todas); telas de automação usam cartões/templates, não grades de dados.
- **Gravação:** o JSON registra apenas chamadas `GET /api/*` (mais a telemetria `POST https://logs.smart-ti.com/api/2/envelope/...`, excluída da lista consolidada); nenhum endpoint de salvamento (PUT/POST) foi capturado, de modo que os verbos de "Salvar"/"Copiar"/"Ativar" são incertos.
- **Dados pessoais:** valores reais de e-mail, telefones, URLs com identificadores, tokens e chaves foram generalizados ou omitidos; exemplos de formato (ex.: URLs de Telegram/WhatsApp, `meupainel.xyz`) são descrições de ajuda da própria tela, não dados da conta.
- **Incertezas:** o campo `custom_domain` em `/settings/maintenance` aparece sem label no JSON (a tela menciona a mensagem de login, mas a associação exata não é confirmada); em `/settings/settings-copy` o segundo campo capturado chama-se `telegram` com placeholder "Obrigatório" (transcrito como está, sem interpretação); `finalUrl` de `/automation/botbot-settings` e `/integrations/botbot` indica que ambas renderizam a galeria de integrações, não um formulário dedicado.

## 12. Histórico de versões (changelog)

O painel expõe `GET /api/changelog` com **93 versões** (de `v3.0` a `v3.92`). Cada versão tem uma lista de `features` com `text`, `section`, `permission` e `link`. Resumo das versões recentes (contexto do produto atual):

**v3.92**
- Menu lateral configurável: Clássico, Retrátil sem ícones, Retrátil com ícones (`/account-settings`).
- Nova Dashboard permite escolher quais widgets exibir (`/dashboard`).

**v3.91**
- Página de migração de cliente aprimorada (`migrate customers using m3u`, `/customers/migration`).
- QR codes renderizados corretamente quando a integração retorna SVG.

**v3.90**
- Página única para gerenciar mensalistas de vários revendas diretos, com filtros, prévia da mensalidade e confirmação antes de aplicar (`can setup membership`, `/resellers/bulk-membership`).

**v3.89 / v3.88**
- Retorno da opção de gerar usuário e senha aleatórios ao editar/criar cliente (`/customers`).
- Melhora de desempenho no carregamento.

**v3.86**
- Filtros por data de criação em clientes, revendas e mensalistas.

**v3.85**
- `paggpay` disponível como gateway Pix.
- Nova dashboard (moderna).
- Lembretes de pagamento de mensalidade visíveis nas duas dashboards, com botão "Pagar agora".
- Configurações para solicitar CPF/CNPJ separadamente do endereço.
- Nova página de Assistente de Renovação (`/customers/renewal-assistant`).
- Pixel de conversão da Meta.

Versões anteriores (v3.0–v3.84) cobrem evolução de: subpainéis, migração de servidor, campanhas de bônus de crédito, bloqueio de teste, planos de mensalista, domínios, temas/estilo, PWA, Sentry, Pusher, chatbot, auditoria, entre outros. O conteúdo integral está em `GET /api/changelog` (47 KB) e em `#/changelog`.

---

## 13. Limitações e lacunas da coleta

Esta documentação foi produzida por **observação de um browser autenticado**, não por acesso ao código-fonte. Considere:

1. **Sem operações de escrita.** Nenhum `POST`/`PUT`/`DELETE` foi executado. Portanto **não** estão documentados: corpos de requisição, payloads de criação/edição, validações de servidor e efeitos colaterais. Onde a seção detalhada lista apenas endpoints `GET`, isso é uma limitação da coleta, não ausência de funcionalidade.
2. **Rotas com parâmetros não visitadas.** As rotas `*/edit/:id`, `*/add` com dependências, `*/status/:id`, `*/resync/:id`, `*/impersonate/:id`, `payment-check/:orderId`, `checkout/:domainId/:customerId`, `log/:uuid`, `reset-password-with-token/:token` existem no roteador mas não foram abertas. Consulte o catálogo de rotas (seção 9) para a lista completa.
3. **Rotas públicas de autenticação/checkout não visitadas**: `#/sign-in`, `#/forgot-password`, `#/reset-password`, `#/membership/*`, `#/credit-purchase/payment-*`, `#/domain-purchase/*`, `#/cs/:domainId/:resellerId`, `#/rs/:domainId/:resellerId`, `#/referral/reseller/:resellerId`, `#/404`, `#/500`.
4. **Acesso negado por papel/permissão.** A conta usada é `ultra-reseller`. Rotas com `meta.role = super-admin` redirecionam para o dashboard (`/system/permissions`, `/system/audit`, `/system/server-request-logs`, `/billing/domain-orders`, `/utilities/domains/all`, além de `/resellers/content-requests` e `/settings/panel-subscription`). Endpoints administrativos retornaram `403` para esta conta (`/api/settings/*` de configuração, `/api/packages`, `/api/membershipplans`, `/api/creditbonuscampaigns`, `/api/subpanels`, `/api/default-playlist-templates`, `/api/servers/limit`, `/api/servers/licence`, `/api/domains/available-servers`, `/api/feature-request`).
5. **Complementos pagos inativos.** `reseller-api` (`402 integration_inactive`) e `content_requests` (`402 addon_inactive`) não puderam ser documentados; as especificações OpenAPI (`/api/reseller-api/v1/openapi.json`, `/api/integration/openapi.json`) estão indisponíveis para esta conta. Se a documentação de API for necessária, ela deve ser obtida com uma conta que tenha esses complementos ativos.
6. **Conteúdo assíncrono e estados vazios.** Cada rota foi capturada ~3 s após a navegação. Páginas com carregamento lento ou com poucos registros apareceram em estado vazio. Várias tabelas existem mas vieram sem linhas.
7. **Rótulos de formulário incompletos.** Alguns campos não têm `label`/`name` no DOM; foram descritos por `placeholder`/contexto. Campos `required` são raramente marcados no HTML (o painel valida via JS), então a coluna "Obrigatório" das tabelas detalhadas é indicativa.
8. **Dados são de um instante.** Saldos, preços, contagens de usuários, IPs e datas refletem a coleta em 19/09/2026. Não há dados pessoais de terceiros neste documento.
9. **UI móvel parcial.** Existe uma barra de navegação móvel (`mobile-glass-nav`) e componentes responsivos que não foram percorridos em viewport móvel.
10. **Internacionalização.** O painel é multilíngue (vue-i18n; `Locale: pt`, `locale = pt-BR`); os textos documentados são da tradução pt-BR.
11. **Segurança/robôs.** O domínio está atrás de Cloudflare; automação exige browser real com sessão autenticada (um headless limpo não passa pelo desafio).

---

### Apêndice — Arquivos-fonte da coleta

| Artefato | Caminho |
|---|---|
| Dump por rota (DOM, formulários, tabelas, API) | `<diretório-local-de-coleta>/crawl-out.json` |
| Chamadas de API por rota | `<diretório-local-de-coleta>/api-calls.json` |
| Definições completas do roteador Vue | `<diretório-local-de-coleta>/routes-meta.json` |
| Respostas cruas de ~64 endpoints | `<diretório-local-de-coleta>/api-dump/` |
| Dados por módulo | `<diretório-local-de-coleta>/modules/` |
