# Runbook — Central de Integrações (hub por tenant)

> Status: Baseline (S5C, #89)
> Scope: `GET /v1/integrations`, `POST /v1/integrations/:provider/configure|test|disable|webhook`, WhatsApp session/QR/reconnect, CINEVISION import-preview/execute
> Review: factual contra `apps/api/src/integrations/*` e `apps/api/README.md`; sem conector live habilitado por este documento.

Este runbook é o procedimento do **operador da plataforma** para habilitar,
rotacionar, desabilitar e diagnosticar as integrações self-service do hub
(`Configurações > Integrações`, rota `/settings/integrations`). A UI do tenant
executa exatamente os endpoints citados abaixo; o operador repete os mesmos
passos via API quando a UI não basta (automação, incidente, validação).

Autoridade: SPEC S1 (`s1-spec.md` na área de trabalho do Planner), estados
canônicos `platform.capabilities`, ADRs vigentes e
`docs/10-operations/integrations-capability-status.md` (nenhuma capability
promovida sem evidência de operador).

## 1. Pré-requisitos (plataforma)

| Item | Variável / local | Observação |
|---|---|---|
| Base pública do webhook | `INTEGRATIONS_PUBLIC_BASE_URL` (ex.: `https://app.exemplo.com.br`) | Origem `scheme://host[:port]`; sem ela o `webhook_ensure` falha fechado com `WEBHOOK_BASE_URL_NOT_CONFIGURED` (503) e instrui modo manual |
| Cofre (API) | `INFISICAL_*` (`packages/secrets`) | Writer server-side; refs `infisical://<env>/integrations/<tenantId>/<provider>/<KEY>` derivadas de contexto validado, nunca do corpo do cliente |
| Cofre (Browser Worker) | `BROWSER_INFISICAL_*` | Identidade própria do worker; nunca herda as vars da API |
| WAHA (plataforma) | `WAHA_BASE_URL` + `WAHA_API_KEY` | Credencial de administração; nunca vai ao navegador. Ausentes → `WAHA_NOT_CONFIGURED` (503) |
| CINEVISION (worker) | `CINEVISION_ALLOWED_ORIGIN`, `CINEVISION_WORKER_TIMEOUT_MS`, `BROWSER_WORKER_*` | Origem allowlisted fixa; a API nunca passa URL (sem SSRF) |
| Permissões (tenant) | `integration.read` (status), `integration.test` (testar), `integration.manage` (configure/disable/webhook/sessão) | Somente admin do tenant gerencia credenciais |
| Chaves Asaas (allowlist) | `https://api-sandbox.asaas.com/v3` / `https://api.asaas.com/v3` | Probe somente contra a allowlist fixa por environment; `baseUrl` no corpo é 400 |

Verificação rápida (somente leitura):

```bash
curl -H "Authorization: Bearer <token>" \
  https://<api>/v1/integrations
# → { integrations: [{ provider, environment, connection_status, capability_status, last_checked_at, last_error_code, configured }] }
```

## 2. Habilitar por tenant (fluxo canônico)

Ordem obrigatória: **configure → test → (webhook/sessão/import) → gate de capability**.
Conectar nunca habilita efeito comercial: `configure` grava `DRAFT`; só o
`test` read-only promove a `CONNECTED_READ_ONLY`. `capability_status` é
DERIVADO do registry (`AVAILABLE | DEGRADED | UNAVAILABLE | UNCERTIFIED | UNKNOWN`)
e nunca é persistido.

```bash
# 1. configurar (Asaas precisa de secret.apiKey; CINEVISION de secret.username+password)
curl -X POST https://<api>/v1/integrations/asaas/configure \
  -H "Authorization: Bearer <token>" -H "Idempotency-Key: <uuid>" \
  -H "Content-Type: application/json" \
  -d '{"environment":"SANDBOX","secret":{"apiKey":"$aact_..."}}'
# → { id, provider, environment, connection_status:"DRAFT", version:1, ... } (sem segredo)

# 2. testar (read-only, timeout bounded 8000ms no Asaas)
curl -X POST https://<api>/v1/integrations/asaas/test \
  -H "Authorization: Bearer <token>" -H "Idempotency-Key: <uuid>" \
  -H "Content-Type: application/json" \
  -d '{"environment":"SANDBOX"}'
# sucesso → CONNECTED_READ_ONLY; falha → TESTING + last_error_code sanitizado
```

Regras de concorrência (todas as escritas):

- `Idempotency-Key` no header (escopo = nome do comando; replay não duplica).
- `expectedVersion` obrigatório quando já existe binding vivo (ausente ou
  divergente → `precondition_failed`, 409). Releia o status e repita com a
  versão atual.
- WhatsApp **não** passa por configure/test/disable: o controller recusa com
  `CAPABILITY_UNCERTIFIED` (501, "disponível em S3"). O caminho do WhatsApp é
  a sessão dedicada (§4).

## 3. Rotação de segredo (Asaas e CINEVISION)

Rotação = `configure` com o novo segredo + `expectedVersion` atual
(não existe endpoint `rotate` dedicado). O novo segredo invalida o probe
anterior: a linha volta a `DRAFT`; repita o `test`.

```bash
# ler a versão atual
curl -H "Authorization: Bearer <token>" https://<api>/v1/integrations/asaas
# → ... "version": 3 ...

# rotacionar
curl -X POST https://<api>/v1/integrations/asaas/configure \
  -H "Authorization: Bearer <token>" -H "Idempotency-Key: <uuid-novo>" \
  -H "Content-Type: application/json" \
  -d '{"environment":"SANDBOX","expectedVersion":3,"secret":{"apiKey":"$aact_nova..."}}'
# → version:4, connection_status:"DRAFT" → rode /test em seguida
```

Ordem de escrita garantida pelo backend: `put` no vault PRIMEIRO, só então
insert/update da linha. Falha do vault → 503 `VAULT_UNAVAILABLE`, linha
intocada; falha do DB após o put → compensação (`deleteSecret`) + 503.
**Rollback:** se o `test` do novo segredo falhar, reconfigure com o segredo
anterior (novo `expectedVersion`) e reteste — a linha nunca alega conectada
sem probe.

## 4. Webhook Asaas (auto vs manual)

Provisionamento automático (sob `integration.manage`):

```bash
curl -X POST https://<api>/v1/integrations/asaas/webhook \
  -H "Authorization: Bearer <token>" -H "Idempotency-Key: <uuid>" \
  -H "Content-Type: application/json" \
  -d '{"environment":"SANDBOX"}'
# → { webhookUrl, providerWebhookId, hasAuthToken:true, status:"ACTIVE" } (nunca o token)
```

Comportamento real (para diagnosticar):

- URL canônica `<base>/v1/webhooks/asaas/:tenantKey` (tenant_key estável
  `asaas-<hex>`; reutilizada entre disable/enable).
- Dedupe pela URL: `POST` (novo) ou `PUT` (match). Conta Asaas com **10
  webhooks e nenhum match → 409** orientando update/delete manual no
  dashboard Asaas (limite oficial `ASAAS_WEBHOOK_LIMIT`, via `POST /v3/webhooks`).
- `authToken` (32–255 chars, sem espaço, base64url 64 chars gerado via
  `crypto`) é gravado no cofre ANTES de chamar o Asaas e **reutilizado no
  retry — nunca deletado após falha**. Distinto da API key; o ingress valida
  via `asaas-access-token` contra `sha256(token)` em `billing.tenant_channels`.
- Email operacional de notificação vem da sessão (override explícito
  permitido); sem email → `precondition_failed`.
- Base pública ausente → 503 `WEBHOOK_BASE_URL_NOT_CONFIGURED` com instrução
  de modo manual.

**Modo manual** (quando a base pública não existe ou o auto falha): no
dashboard Asaas, registre o webhook com URL `<base>/v1/webhooks/asaas/:tenantKey`,
eventos `PAYMENT_RECEIVED`/`PAYMENT_OVERDUE`/`PAYMENT_REFUNDED`, envio
sequencial, apiVersion 3 e um authToken próprio (32–255 chars, sem espaços,
diferente da API key). Valide com um evento sandbox e confirme que o ingress
responde 202 com o header `asaas-access-token`. Reexecute o `webhook_ensure`
quando a base estiver configurada para sincronizar o hash do canal.

## 5. WhatsApp / WAHA (sessão por tenant)

Superfície real: `POST /v1/integrations/whatsapp/session` (provisiona),
`GET …/session` (estado verbatim + `lastInbound`), `GET …/whatsapp/qr`
(proxy de bytes `image/png`, `no-store`, sem persistência),
`POST …/reconnect`, `POST …/disconnect`, `POST …/test-message`
(`{to: E.164, text: 1..500}`, limite 30 envios/5 min por origem),
todos sob `integration.manage` exceto os dois `GET` (`integration.read`).

```bash
# provisionar (idempotente: reuse; STOPPED→start; FAILED→restart)
curl -X POST https://<api>/v1/integrations/whatsapp/session \
  -H "Authorization: Bearer <token>" -H "Idempotency-Key: <uuid>" \
  -H "Content-Type: application/json" -d '{}'
# → 201 (nova) ou 200 (reutilizada): { sessionName:"tenant-<12hex>", status, ... }

# estado (verbatim do provider) + último inbound do tenant
curl -H "Authorization: Bearer <token>" https://<api>/v1/integrations/whatsapp/session
# → { sessionName, status, lastInbound:{ occurredAt, preview }|null }
```

Estados verbatim expostos (labels da UI entre parênteses):
`STOPPED` (Parada), `STARTING` (Iniciando), `SCAN_QR_CODE` (Aguardando
leitura do QR), `WORKING` (Conectada), `FAILED` (Falha). QR só faz sentido
em `SCAN_QR_CODE`/`STARTING`; fora disso o backend responde `QR_NOT_READY`
(404 — já pareada, parada ou expirada: atualize o estado e tente de novo).

Troubleshooting (códigos reais):

| Sintoma / código | Significado | Ação |
|---|---|---|
| `NO_SESSION` (404) | Tenant sem vínculo | Provisione via `POST …/session`; nunca use sessão de outro tenant (fail-closed) |
| `SESSION_NOT_FOUND_AT_PROVIDER` (404) | Vínculo sem sessão viva no WAHA | Reprovisione; se persistir, acione o operador WAHA |
| `SESSION_NOT_READY` (409) | Sessão viva mas ≠ `WORKING` | Aguarde/pareie o QR; `test-message` só com `WORKING` |
| `CAPPED` (429) | WAHA limitou (restriction/timelock) | **Não** trate como desconexão; aguarde, não reenvie em loop, atualize o QR/estado depois |
| `WAHA_UNAUTHORIZED` (503) | Admin key da plataforma rejeitada | Operador: conferir `WAHA_API_KEY` server-side |
| `WAHA_NOT_CONFIGURED` (503) | Plataforma sem WAHA | Operador: configurar `WAHA_BASE_URL` + `WAHA_API_KEY` |
| Timelock/restrição do número | Banimento temporário do provedor | Nunca provoque de propósito; pausar outbound e aguardar (ver `docs/10-operations/runbooks/whatsapp-down.md`) |

`reconnect` = restart; `disconnect` = parada — ambos **preservam histórico**.
Sessão persiste após restart (vínculo em `communication.tenant_channels`);
em vínculo ausente, falha fechado (nunca fallback para sessão `default`).

## 6. CINEVISION (conta, validação, importação)

Configure com `secret.username` + `secret.password` (ambos obrigatórios);
o backend grava `CINEVISION_USER`/`CINEVISION_PASS` no cofre e o `test`
spawna o browser-worker por tenant (`read-identity` + `list-servers`,
ambiente por invocação com profile isolado por tenant+conta, timeout bounded
default 120s). Ambos os reads confirmados → `CONNECTED_READ_ONLY`.

Códigos do `test` (`CINEVISION_MANUAL_GUIDANCE`, sem detalhe cru):

| `last_error_code` | Ação |
|---|---|
| `INVALID_CREDENTIALS` | Confira usuário/senha no painel e reconfigure; repita o teste |
| `CHALLENGE_DETECTED` | Challenge/CAPTCHA/2FA/Cloudflare: conclua manualmente no painel e repita — **sem bypass** |
| `TIMEOUT` | Tente de novo; se persistir, verifique o painel (inclusive bloqueios Cloudflare) |
| `PROVIDER_UNAVAILABLE` | Aguarde e tente de novo; se persistir, acione o operador |

Importação assistida (somente com binding vivo; sem ele → 404):

```bash
# 1. preview (integration.read; classifica sem escrever CRM)
curl -X POST https://<api>/v1/integrations/cinevision/import-preview \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}'
# → { total, novos, duplicados, conflitos, previewHash, items[]:{externalId, decision} }

# 2. execute (integration.manage; Idempotency-Key OBRIGATÓRIA — 400 sem ela)
curl -X POST https://<api>/v1/integrations/cinevision/import-execute \
  -H "Authorization: Bearer <token>" -H "Idempotency-Key: <uuid>" \
  -H "Content-Type: application/json" \
  -d '{"previewHash":"<hash-do-preview>","confirmed":true}'
# hash divergente → 409 (re-rode o preview); decisões: novo/duplicado(conflito no payload)/duplicado(pulado)
```

Falha do worker no execute → 409 `HUMAN_REQUIRED/<código>` orientando modo
manual. **Fallback manual permanece funcional**: ative/renove pelo painel
CINEVISION e reconcilie no hub depois. Writes automáticos seguem
`UNCERTIFIED` até a certificação S4 (Step 3/6–9 sem evidência live).

## 7. Disable / re-enable, saúde, auditoria

- `POST /v1/integrations/:provider/disable` (`integration.manage`,
  `expectedVersion` obrigatório): pausa novos efeitos; **preserva histórico**
  (faturas, eventos, mensagens, provas de importação). Re-enable = novo
  `configure` + `test` (a linha `DISABLED` vira histórico; o binding mais
  recente não-`DISABLED` manda no status).
- Saúde: `GET /v1/integrations[/:provider]` — `connection_status`,
  `last_checked_at`, `last_error_code`, `capability_status` derivado.
  Sem linha viva → `NOT_CONFIGURED` (fail-closed `SANDBOX`, nunca alega conectado).
- Auditoria: toda alteração grava tenant, user, provider, ação, revisão e
  resultado **sem valores de segredo** (o guard do repo proíbe segredos e
  hashes em metadata). O conteúdo de `test-message` nunca volta na resposta
  nem na auditoria.

## 8. O que NUNCA fazer

- Nunca contornar challenge/CAPTCHA/2FA/Cloudflare (bypass invalida a
  certificação e a conta do tenant).
- Nunca aceitar URL arbitrária de painel/probe do cliente (allowlist fixa;
  `baseUrl` no corpo é 400 — sem SSRF).
- Nunca devolver, logar ou expor segredo: respostas carregam só metadados;
  segredos viajam uma vez (no `configure`) e vivem no cofre.
- Nunca reutilizar a API key do Asaas como authToken do webhook.
- Nunca compartilhar sessão WAHA entre tenants nem reabilitar fallback para
  sessão `default`.
- Nunca prometer CINEVISION write automático antes da certificação S4.
- Nunca promover `platform.capabilities` sem rodar o gate de
  `docs/15-implementation-baseline/10-integrations-certification.md` e
  registrar operador, data, ambiente e observação (ver
  `integrations-capability-status.md`).

## Operador-follow-up (lacunas conhecidas, sem inventar)

- Pairing-code WhatsApp e update de webhook em reuse não implementados
  (engine não pinado; QR é o caminho) — ver `waha-admin.port.ts`.
- Sem live wiring de importação CINEVISION em produção até a certificação S4
  (fail-closed `NOT_WIRED`).
- Transcrição de áudio e outbound de mídia WAHA não implementados.
