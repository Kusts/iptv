# Auditoria StreamMax — operações de provider, bots e idempotência (20/11/2026)

> Natureza: auditoria **somente leitura** de código/contratos + teste sintético em PostgreSQL **isolado, descartável e vazio**.
> Sem SQL direto de bots, sem staging/produção, sem cobrança Asaas, sem mensagens externas e sem segredos em log.
> Este documento não é homologação de produção; registra o que o código implementado e os testes comprovam.

## 1. Superfície auditada (API StreamMax)

Fontes: `apps/api/src/{provider,fulfillment,subscription,commerce,renewal,bot,order}/**`,
`docs/15-implementation-baseline/04-event-catalog.md`, `docs/05-contracts/streammax-bot-contract.md`.

### 1.1 Operações de provider e ativação de assinatura

| Rota | Método | Permissão / papel | Payload mínimo | Idempotência | Efeitos em subscription / entitlements / outbox |
|---|---|---|---|---|---|
| `POST /v1/fulfillment/subscriptions/:id/request` | POST | `subscription.write` (human) — `AuthGuard`+`PermissionsGuard` | `{subscriptionId}` no path; opcional `adapter: "manual"\|"echo"`, `echoOutcome` | chave de negócio interna `subscription-provision:<subscriptionId>:<attempt>` repassada ao `provider.request_operation` + pré-condição de estado (`PENDING_ACTIVATION`); controller não repassa header `Idempotency-Key` | cria `provider.provider_operations` (action `subscription.provision`, entity `subscription`) e emite `provider.operation_requested.v1` + outbox; assinatura permanece `PENDING_ACTIVATION` |
| `GET /v1/fulfillment/subscriptions/:id` | GET | `subscription.read` | path `:id`, tenant da credencial | leitura pura | última operação de fulfillment da assinatura (`operationId`, `action`, `status`, `effectCertainty`, `requestedAt`) |
| `POST /v1/provider/operations` | POST | `provider.operation.write` | `{action, entityType, entityId(uuid), idempotencyKey, payload?, adapter?}` | `idempotencyKey` obrigatório no corpo **e** header `Idempotency-Key`; `UniqueViolationError` → `precondition_failed` | cria operação `REQUESTED` + evento `provider.operation_requested.v1` + outbox |
| `POST /v1/provider/operations/:id/resolve` | POST | `provider.operation.write` | `{outcome:"SUCCEEDED"\|"FAILED"\|"UNKNOWN", note?, externalRef?}` (`externalRef` só em `SUCCEEDED` de `subscription.provision`) | header `Idempotency-Key` + **CAS por status observado**: terminal repetido → `precondition_failed`; concorrência perdedora → `precondition_failed` | `SUCCEEDED`+ref válida → status `SUCCEEDED`/`KNOWN_APPLIED`, binding, `provider.operation_succeeded.v1`, `resumeLinkedSubscription` → assinatura `ACTIVE` + ciclo + entitlements/grants + notificação de credenciais (tudo na mesma transação/outbox); `FAILED` → `provider.operation_failed.v1` + review humano, assinatura **continua** `PENDING_ACTIVATION`; `UNKNOWN` → `VERIFYING`, sem evento terminal |
| `POST /v1/provider/operations/:id/reconcile` | POST | `provider.operation.write` | `{operationId}` | header `Idempotency-Key` + CAS `status='VERIFYING'`; reconcile repetido sobre `HUMAN_REQUIRED` secret-required é no-op honesto | readback (porta backend) conclui `SUCCEEDED`/`FAILED` ou converge para `HUMAN_REQUIRED`; **nunca reexecuta** a operação; operações secret-required `subscription.provision` apenas **agendam** a recuperação durável (zero escrita no comando) |
| `GET /v1/provider/operations` | GET | `provider.operation.read` | query `limit`(1–50), `offset`, `status?` | leitura pura, tenant-scoped, colunas sanitizadas (nunca payload/segredo/evidência) | lista fila de operações + contagem de attempts |
| `GET /v1/provider/operations/:id` | GET | `provider.operation.read` | path `:id` | leitura pura | detalhe sanitizado + attempts |
| `POST /v1/admin/provider-dispatch/{drain,recover,reconcile}` | POST | `AuthGuard` + `PlatformAdminGuard` + rate limit | `{limit?}` | lease/claim com `claimed_by`, CAS por status; sem dupla execução | `drain` executa operações secret-required; `recover` libera leases expirados; `reconcile` resolve `VERIFYING` com readback + pós-condição + binding, fora de transação |
| `GET /v1/subscriptions/:id` · `GET /v1/subscriptions` | GET | `subscription.read` | path/query | leitura pura, RLS via `withTenantTransaction` | status + `projectedState`, ciclos e entitlements (somente leitura) |
| `GET /v1/orders/:id` · `GET /v1/orders` | GET | `billing.read` | path/query | leitura pura | pedido, cobrança e estado de liquidação; vínculo `originating_order_id` da assinatura |
| `GET /v1/renewals` · `POST /v1/renewals/{quote,renew,...}` | GET/POST | `subscription.read` / `subscription.write` | conforme contrato | chave de idempotência + estado | cotação/renovação com `already:true` em replay |

Eventos envolvidos (registry): `provider.operation_requested.v1`, `provider.operation_succeeded.v1`,
`provider.operation_failed.v1` (domínio `provider_operation`), todos publicados via `emitAndEnqueue` na **mesma transação**
da mudança de estado (evento + outbox atômicos). Não existe evento público `verification_required`
(lacuna de catálogo conhecida; transições `VERIFYING` são audit-only).

### 1.2 Superfície de bots (`/v1/bot/streammax`)

12 rotas POST, todas protegidas por `BotServiceGuard`: `list-plans`, `resolve-lead`, `reply`, `quote`,
`create-order`, `get-charge`, `get-subscription`, `get-trial`, `open-ticket`, `get-ticket`,
`renewal-quote`, `renew`. Contrato canônico em `docs/05-contracts/streammax-bot-contract.md`.
**Nenhuma** dessas rotas cobre criação/consulta/resolução/reconciliação de operação de provider nem
`fulfillment.request_for_subscription`.

## 2. Autenticação dos bots e cobertura atual

- **Credencial**: `platform.bot_service_credentials` (migration 070, append-only — só revogação),
  uma linha por tenant com `token_hash = SHA-256(pepper:token)`, `token_prefix`, `scopes ⊂ {bot.streammax.execute}`,
  `expires_at`, `revoked_at`, RLS `tenant_id = app.tenant_id`. Resolução por `platform.resolve_bot_credential`
  (SECURITY DEFINER) exige tenant `ACTIVE`, token não revogado e não expirado. Emissão por `scripts/emit-bot-credential.mjs`.
  É isso que viabiliza um **bot de serviço legítimo com papel mínimo e token por tenant/canal**, sem sessão humana e sem SQL.
- **Guard**: 404 se `STREAMMAX_BOT_API_ENABLED != "true"`; 503 se DB/pepper ausentes; 401 sem Bearer ou hash desconhecido;
  403 se o escopo `bot.streammax.execute` estiver ausente. `tenantId` do corpo é rejeitado (400).
- **Ator sintético**: `botServiceActor` usa `actorType:"external"`, `isPlatformAdmin:false`, `roleKeys:[]` e a interseção fixa
  de permissões `{crm.lead.write, conversation.reply, commerce.order.write, billing.charge.write, support.ticket.write}`.
  O `botExecute` limita ainda mais por allowlist: `BOT_COMMANDS = {person.register, lead.capture, message.send_manual,
  offer.quote, order.submit, billing.customer_provision, charge.create, support.ticket.open, renewal.quote,
  subscription.renew, conversation.start_manual, conversation.release}`.
- **CLI**: `bots/streammax/cli/streammax.mjs` usa `STREAMMAX_API_BASE_URL` + `STREAMMAX_BOT_SERVICE_TOKEN` (Bearer)
  e expõe exatamente os 12 comandos acima; bloqueia `--tenantId/--amount/--price/...`, valida UUIDs e aplica
  `messageId`/`idempotencyKey` por requisição. `bots/financeiro/cli/asaas.mjs` é somente Asaas Sandbox (inbox/list/stats),
  sem acesso à API StreamMax.
- **Skill do Gestor CINEVISION**: mantém o estado manual em memória própria (`SOLICITADA → EM EXECUÇÃO →
  CONCLUÍDA COM READBACK | FALHOU | EFEITO DESCONHECIDO`), com `referencia_externa`, `resultado_observado`,
  `readback_confirmado` e chave de idempotência — ou seja, o readback de fornecedor **hoje vive no bot**, não na API.
  A skill declara explicitamente ausência de escrita automática e exige operador humano supervisionado.
- Cobertura de teste do auth: `bot-service-api.integration.test.ts`, `bot-service.guard.{unit,integration}.test.ts`,
  `bot-service-credential.integration.test.ts` (token inválido, tenant isolado, replay de idempotência,
  rejeição de token de sessão humana).

## 3. Lacuna mínima

**Resposta curta: não falta operação indispensable no backend; falta exposição autorizada ao bot.**

O backend já implementa de ponta a ponta a cadeia pedida — operação pendente (`HUMAN_REQUIRED`/`VERIFYING`) →
resultado confirmado (`provider.resolve_operation` com `externalRef`, ou `provider.reconcile` com readback da porta
backend) → assinatura `ACTIVE` **somente** com binding+entrega vinculados ao pedido — com idempotência em duas camadas
(chave `Idempotency-Key` e CAS por estado). Os campos do resultado pedido mapeiam para: `operation_id` (`id`),
`subscription_id` (`entity_id`), `tipo_operacao` (`action`, ex.: `subscription.provision`),
`estado CONCLUIDA|FALHOU|EFEITO_DESCONHECIDO` (`SUCCEEDED|FAILED|UNKNOWN`/`VERIFYING`),
`referencia_externa` (`externalRef`), `resultado_observado` (`note` + códigos fixos em `result_summary_json`),
`readback_confirmado` (somente via `provider.reconcile`/dispatcher, com porta de readback **de backend**).

As lacunas reais, em ordem de materialidade:

1. **Exposição ao bot (principal).** A CLI/skill e o ator sintético não têm rota nem permissão para
   `fulfillment.request_for_subscription` ou `provider.{request,resolve,reconcile}_operation`; o bot só consegue
   **ler** a assinatura (`get-subscription`) e o pedido/cobrança (`get-charge`). Hoje o Gestor CINEVISION registra o
   readback na própria memória e o operador precisa agir no painel/API humana.
2. **Readback confirmado pelo chamador.** `provider.resolve_operation` trata `externalRef` como **ateste do operador**,
   não prova de readback independente; e operações secret-required só terminalizam com readback da porta de backend
   (`provider.reconcile` agenda a recuperação). Não existe campo `readback_confirmado`/`resultado_observado`
   preenchível pelo chamador — por desenho de segurança.
3. **Documentação obsoleta do skill.** A skill `cinevision-operacoes` ainda afirma "não há credencial de serviço para bots";
   a migration 070 já fornece uma. É uma correção documental de baixo risco, fora do código desta entrega.

**Decisão de implementação:** nenhuma ampliação de código foi implementada nesta entrega. A única operação que
realmente "fecharia" o laço para o bot — aceitar um readback confirmado enviado pelo chamador e terminalizar a operação /
ativar a assinatura — é uma **ampliação de autoridade sensível** (poderia ativar assinatura com prova falsificada),
não uma correção pequena e segura; exige decisão de produto/autorização e teste de segurança específico.
A alternativa segura já existe e está coberta pelo teste: manter o readback como responsabilidade do backend e do
operador, e expor ao bot apenas leitura do estado da operação (`GET /v1/fulfillment/subscriptions/:id` ou
`GET /v1/provider/operations/:id`) via um novo comando **somente leitura**, se/quando autorizado.

## 4. Evidência de idempotência (teste sintético, PostgreSQL isolado)

**Teste existente reaproveitado — nenhum teste novo criado.**
`apps/api/test/subscription-fulfillment.integration.test.ts` já cobre integralmente o caso de aceite.

- Ambiente: PostgreSQL 16.16 portátil, instância **nova**, em `C:\Users\walis\AppData\Local\Temp\opencode\pg-iso`
  (fora do worktree), porta própria `55432`, banco `iptv_bots_audit` **vazio**; migrations aplicadas pelo próprio
  `beforeAll` (`applyMigrations`). Nenhum cluster com staging/produção foi tocado; nada foi reiniciado ou limpo além
  do que esta auditoria criou.
- Pré-requisito: `pnpm install --frozen-lockfile --offline` e `pnpm build` (12/12 tasks) para disponibilizar
  `dist/` dos pacotes `@iptv/*`.
- Comando (executado em `apps/api`, com `TEST_DATABASE_URL` exportado no shell — Turbo não carrega `.env`):

  ```sh
  TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/iptv_bots_audit' \
    pnpm exec vitest run test/subscription-fulfillment.integration.test.ts --reporter=verbose
  ```

- Resultado: **Test Files 1 passed (1); Tests 9 passed (9); EXIT=0** (~12 s).

Casos que provam o aceite (nomes literais dos testes, todos ✓):

| Caso de aceite | Evidência no teste |
|---|---|
| Pedido pendente → operação de provisionamento | `full loop: SETTLED → PENDING + cycle → MANUAL resolve SUCCEEDED → ACTIVE + grants + notification` — `fulfillment.request_for_subscription` cria `provider_operation` em `HUMAN_REQUIRED`, assinatura `PENDING_ACTIVATION`, zero binding antes da resolução (linhas 351–389) |
| Resultado confirmado com `referencia_externa` → assinatura ACTIVE com entrega vinculada ao pedido | resolução `SUCCEEDED` com `externalRef`; valida `1` binding com `external_id` igual ao ref vencedor, `1` ciclo `ACTIVE` (`cycle_no=1`), `1` entitlement `plan:<planKey>`, `1` grant `INITIAL`, evidência `ACTIVATION_POSTCONDITION` e notificação de credenciais `INTERNAL`/`QUEUED` (linhas 420–535); `originating_order_id` vem do pedido liquidado via `subscription.activate_from_order` |
| Repetir a mesma resolução sem duplicar efeitos/eventos | replay `provider.resolve_operation` → `precondition_failed`, binding permanece `1`; duas resoluções concorrentes: exatamente **uma** vence, a outra `precondition_failed`; `subscription.activate` repetido devolve `already:true` sem Second cycle (linhas 421–441, 499–545) |
| `FALHOU` não ativa | `FAILED fulfillment opens a review and never grants access` — assinatura continua `PENDING_ACTIVATION`, review `MANUAL_EXECUTION`/`PROVIDER_EXCEPTION`, nenhum entitlement (linhas 804–833). Também `full loop` prova que `SUCCEEDED` sem `externalRef` ou com ref inseguro é rejeitado e não muda a operação (linhas 391–418) |
| `EFEITO_DESCONHECIDO` → readback, não ativa cegamente | `echo success auto-activates; echo unknown reconciles to ACTIVE` — `VERIFYING` + `UNKNOWN`, `provider.reconcile` com readback `APPLIED` só então ativa; e `F04: DOM drift degrades only the affected write` mantém `VERIFYING`/`UNKNOWN` sem terminalizar (linhas 553–607, 609–682) |
| Isolamento e recuperação | `tenant isolation: another tenant cannot see or touch the subscription` e `F02: provider outage queues fulfillment; recovery resumes without duplicate effect` — retry idempotente (`retried:0` na segunda chamada, 1 ciclo) |

Eventos observados no log da execução (outbox, mesmo tenant): `provider.operation_requested.v1`,
`provider.operation_succeeded.v1`, `order.settled.v1`, `charge.paid.v1`, `payment.confirmed.v1`.
Nenhuma cobrança real, mensagem externa ou escrita em produção ocorreu: pagamento é webhook Asaas **simulado** no
próprio teste e adapter `echo`/`manual`.

## 5. Pendências

- Decidir, com dono de produto/segurança, se o bot de serviço deve terminalizar operações de provider; se sim,
  desenhar o contrato de readback (quem assina a prova) e o menor papel possível, com teste de segurança dedicado.
- Opcional e de baixo risco: expor ao bot uma leitura do estado de fulfillment/provider operation
  (`get-fulfillment`) e atualizar a CLI, o contrato JSON e a skill `streammax-api` — somente após autorização.
- Atualizar a linha da skill `cinevision-operacoes` sobre "sem credencial de serviço" (migration 070 já existe).
- Sem deploy, sem cobrança, sem mensagem externa e sem escrita em staging/produção nesta entrega.
