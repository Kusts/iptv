# CINEVISION Provider Runtime Hardening — SPEC + PLAN

> Status: Accepted as plan — implementação incremental em andamento (Fase 0 concluída; Fase 1 módulos read-only no worker)  
> Version: 1.0  
> Base: [CINEVISION API investigation 2026-09-30](../../11-research/cinevision-api-investigation-2026-09-30.md) — painel observado CINEVISION ONE v3.93  
> Companion: [CINEVISION Provider](cinevision.md) · [Operation Catalog](cinevision-operation-catalog.md) · [Live Integration Certification](../../15-implementation-baseline/10-integrations-certification.md) · [ADR-0013 Playwright Browser Worker](../../06-decisions/ADR-0013-playwright-browser-worker.md)  
> Review: Auto-reviewed v0.15 — SPEC e PLAN confrontados com a codebase em 2026-10-01 (evidências na seção "Revisão contra a codebase"); escopo: evolução da integração existente, sem substituir a arquitetura atual. Prioridade P0 para qualquer escrita real no provider.

## 1. Objetivo

Evolution of the CINEVISION integration into a provider runtime that is:

- crash-safe and rollback-safe;
- semantic-operation based;
- conclusively read back;
- less dependent on selectors/DOM;
- able to use `API_IN_BROWSER` as the preferred mechanism inside the Browser Adapter;
- prepared for a future official M2M / server-to-server API;
- with controlled fallback to DOM and Manual/HITL;
- certified per capability;
- without blind retries;
- without bypassing provider security mechanisms.

This SPEC does not create a parallel architecture. It hardens and completes the existing architecture built on `ProviderOpsPort`, `ProviderReadbackPort`, `ProviderOperation`, `provider_operation_attempts`, `provider_evidence`, `provider_bindings`, the outbox, HITL, capability gates, `effect_certainty`, audit and tenant isolation.

## 2. Contexto validado

The 2026-09-30 investigation established:

- the SPA is at observed version `3.93`;
- internal API calls inside an authenticated Chrome session work;
- real reads were observed (identity, customers, individual customer, servers, status, prices, live connections, integrations);
- `API_IN_BROWSER` reduces DOM dependence but still depends on the browser and its session;
- equivalent Node server-to-server calls are NOT demonstrated as usable;
- the Reseller API is inactive on the investigated account;
- write contracts were observed in JS bundles but are NOT runtime certified;
- no external write was executed during the investigation.

Therefore:

```text
API_IN_BROWSER != CinevisionApiAdapter M2M
```

and:

```text
contract found in frontend != certified operation
```

## 3. Problema arquitetural P0

Some paths today execute external effects inside the DB transaction:

```text
CommandBus
  ↓
withTransaction(...)      (apps/api/src/commands/command-bus.ts — handler awaited before commit)
  ↓
handler
  ↓
port.requestOperation(...) (inline call sites: provider.commands.ts, trial.commands.ts,
                            fulfillment.commands.ts, inventory/license.commands.ts)
  ↓
external provider
  ↓
commit
```

An external provider does not participate in the PostgreSQL transaction. It is possible to reach:

```text
provider applied effect
       ↓
process failure
       ↓
transaction rollback
       ↓
provider != internal database
```

No real CINEVISION write may be enabled while this gap exists. (Confirmed against the codebase on 2026-10-01 — see the review section.)

## 4. Arquitetura alvo

```text
                    Domain / Commands
                          │
                          ▼
                    DB Transaction
                          │
              ┌───────────┴───────────┐
              │                       │
      ProviderOperation            Outbox
              │                       │
              └────────── COMMIT ─────┘
                          │
                          ▼
                 Provider Dispatcher
                          │
                          ▼
                    ProviderOpsPort
                          │
            ┌─────────────┼─────────────┐
            │             │             │
            ▼             ▼             ▼
   CinevisionApi    CinevisionBrowser   ManualProvider
      Adapter           Adapter            Adapter
      FUTURO             ATUAL             HITL
                            │
                  ┌─────────┴─────────┐
                  │                   │
                  ▼                   ▼
            API_IN_BROWSER            DOM
              preferencial         fallback
                          │
                          ▼
                 ProviderReadbackPort
                          │
                          ▼
                 postcondition/effect
```

## 5. Regra fundamental do ProviderOpsPort

`ProviderOpsPort.requestOperation()` remains the single port for external operations. The Domain Core must never know: CINEVISION endpoints, selectors, URLs, cookies, Bearer tokens, localStorage, provider-specific headers, SPA version, the API-in-browser strategy, or Playwright details. Those belong exclusively to the adapters.

## 6. Execution channel

The database supports `API | BROWSER | MANUAL` as `execution_channel`. `API_IN_BROWSER` must NOT become a new `execution_channel` value. Because it depends on Chrome, a persistent profile, an authenticated session and browser context, it persists as `execution_channel = BROWSER`. The differentiation lives in `adapter_version`, strategy and evidence/result metadata:

```text
execution_channel = BROWSER
adapter_version   = cinevision-browser-v2
strategy          = API_IN_BROWSER
```

Do not create a migration only to add `API_IN_BROWSER` to the channel enum.

## 7. CinevisionBrowserAdapter V2

A real `CinevisionBrowserAdapter implements ProviderOpsPort` plus a matching readback implementation. The adapter supports two internal strategies: `API_IN_BROWSER` (default) and `DOM`. DOM is used only when the capability cannot run through the internal API, lacks sufficient API contract, legitimately needs UI interaction, or has specific DOM certification.

## 8. API_IN_BROWSER

`API_IN_BROWSER` means executing a CINEVISION API call using the authenticated browser context:

```text
Browser session → page/context → same-origin /api/* → Bearer/session already owned by the browser
```

It does NOT mean copying the token to the backend and issuing external requests. Implementation requirements: allowed origin only; endpoints restricted per capability; no arbitrary URL, method or caller-supplied body; payload mapping inside the adapter; response content-type/schema validation; the token/session never exposed to the Domain Core.

## 9. Endpoint allowlist

No generic `request(method, url, body)` API may be exposed to Browser Worker consumers. Each action is declared semantically (`readIdentity()`, `readCustomer()`, `readCreditBalance()`, `readLiveConnections()`, `createTrial()`, `renewCustomer()`, `changeConnections()`, `blockCustomer()`, `unblockCustomer()`, `syncCustomer()`, `trustRenewal()`, `migrateServer()`). The adapter itself maps semantic operation → endpoint/method/payload.

## 10. ProviderReadbackPort

Real readers implement the port. First set: `READ_IDENTITY`, `READ_CREDIT_BALANCE`, `LIST_CUSTOMERS`, `READ_CUSTOMER`, `READ_CUSTOMER_STATUS`, `READ_CONNECTIONS`, `LIST_SERVERS`, `READ_SERVER_STATUS`, `LIST_PACKAGE_PRICES`, `READ_LIVE_CONNECTIONS`, `LIST_INTEGRATIONS`. `READ_PLAYLIST` stays blocked until live validation. Readers return sanitized typed models (e.g. `ReadCustomerResult { externalId, status, expiresAt, isTrial, connections, serverId, packageId }`) — never the raw provider payload.

## 11. Normalização defensiva

The internal API is not a stable public contract (observed example: `is_trial` is a string). Requirements: validate types; normalize explicitly; reject unexpected schemas; never perform dangerous silent coercion; produce `BAD_RESPONSE` when the observed contract stops holding.

## 12. Durable Provider Dispatcher

Mandatory post-commit durable flow:

```text
Command
   ↓
transaction (create/update ProviderOperation + domain event + outbox + audit)
   ↓
COMMIT
   ↓
ProviderDispatcher (durable claim)
   ↓
ProviderOperationAttempt persisted
   ↓
dispatch_started persisted
   ↓
ProviderOpsPort
   ↓
readback
   ↓
result persisted
```

No real provider call may occur before commit.

## 13. Attempt antes do send

Before any external effect there must be a durable attempt, distinguishing at least: `attempt_created`, `dispatch_started`, `adapter_result_received`, `readback_started`, `completed`. Exact naming may adapt to the existing schema. Do not create an unnecessary migration if current structure can represent the same invariants; create a minimal append-only migration only if the current structure cannot unambiguously answer "could the dispatch already have started?".

## 14. Lease e concorrência

Only one worker may execute the same attempt/operation at a time. The dispatcher needs a durable claim/lease/owner/expiration-recovery mechanism. An expired lease does NOT mean the request was not sent: if `dispatch_started` occurred, recovery must assume `effect_certainty = UNKNOWN` until a conclusive readback.

## 15. Crash semantics

| Caso | Situação | Tratamento |
|---|---|---|
| A | crash antes do dispatch (attempt persisted, not started) | resumível quando houver prova durável de que nenhum envio começou |
| B | crash durante transporte (`dispatch_started`, request possivelmente enviado) | `VERIFYING`, `effect_certainty = UNKNOWN`, readback obrigatório |
| C | provider aplicou, resposta perdida | `UNKNOWN` → readback |
| D | resposta chegou, banco falhou antes de persistir | `UNKNOWN` → readback |
| E | readback confirma aplicado | `SUCCEEDED`, `KNOWN_APPLIED` |
| F | readback confirma não aplicado | `KNOWN_NOT_APPLIED`; retry analisável conforme política da capability |

## 16. Proibição de retry cego

Never `timeout → repeat write`, and never `API_IN_BROWSER failed → automatically retry the same write via DOM` when the first action may have applied:

```text
write incerta → VERIFYING → readback
  ├─ applied → SUCCEEDED
  ├─ not applied → retry elegível
  └─ inconclusive → HUMAN_REQUIRED
```

## 17. Fallback API_IN_BROWSER → DOM

Reads: automatic DOM fallback allowed when both paths are certified, no mutable effect exists and the failure is safely classifiable. Writes: automatic fallback is forbidden once the send may have started. DOM may be selected before dispatch, via the capability matrix, or after a conclusive `KNOWN_NOT_APPLIED` readback if the capability policy allows. Never `POST API timeout → click DOM button`.

## 18. Taxonomia de falhas

Canonical classes: `CHALLENGE, AUTH_FAILED, SESSION_EXPIRED, PERMISSION_DENIED, INTEGRATION_INACTIVE, RATE_LIMITED, HTTP_FAILURE, BAD_RESPONSE, UI_DRIFT, POSTCONDITION_MISMATCH, UNKNOWN_EFFECT, TRANSPORT`. Cause and effect certainty are independent concepts: `error_class = TRANSPORT` with `effect_certainty = UNKNOWN` is not "TRANSPORT = not applied".

## 19. Cloudflare e challenges

The system must not attempt to bypass protection mechanisms. A real challenge → `CHALLENGE` → `HUMAN_REQUIRED` → recurring pattern marks the capability/provider account `DEGRADED` with cooldown. Never classify `403`/`404`/Cloudflare headers generically as challenge; challenge requires observable evidence (the worker already detects localized interstitial titles and challenge markers).

## 20. Session handling

The session belongs to the Browser Adapter. The domain never receives Bearer tokens, cookies, localStorage or login control. `SESSION_EXPIRED` on a read: authorized reauth → bounded retry. On a potential write: readback/reconciliation first.

## 21. Adapter versioning

Every execution records a version specific enough to reconstruct provider, adapter, adapter version, strategy and expected panel (e.g. `cinevision-browser-v2`). Panel `3.93` is a `provider compatibility pin`, never a permanent domain rule.

## 22. Capability matrix

| Capability | API_IN_BROWSER | DOM | M2M | Initial status |
|---|---|---|---|---|
| READ_IDENTITY | candidato principal | fallback | não provado | UNCERTIFIED |
| READ_CUSTOMER / READ_CUSTOMER_STATUS | candidato principal | fallback | não provado | UNCERTIFIED |
| READ_CREDIT_BALANCE | candidato principal | fallback | não provado | UNCERTIFIED |
| LIST_CUSTOMERS / READ_CONNECTIONS | candidato principal | fallback | não provado | UNCERTIFIED |
| LIST_SERVERS / READ_SERVER_STATUS | candidato principal | fallback | não provado | UNCERTIFIED |
| LIST_PACKAGE_PRICES / READ_LIVE_CONNECTIONS / LIST_INTEGRATIONS | candidato principal | fallback | não provado | UNCERTIFIED |
| CREATE_TRIAL | contrato frontend | candidato fallback | não provado | UNCERTIFIED |
| RENEW_CUSTOMER / BLOCK_CUSTOMER / CHANGE_CONNECTIONS | contrato frontend | candidato fallback | não provado | UNCERTIFIED |
| TRUST_RENEWAL | semântica inferida | candidato | não provado | UNCERTIFIED |
| MIGRATE_SERVER | contrato frontend | candidato | não provado | UNCERTIFIED |
| CHANGE_PACKAGE | perigoso | perigoso | não provado | DISABLED operacionalmente |

No row is promoted just because an endpoint appears in the JS.

## 23. Certification states

No new enums: `UNCERTIFIED → SANDBOX_CERTIFIED → CERTIFIED` (runtime CHECK constraints), with availability `AVAILABLE | DEGRADED | UNAVAILABLE` as a separate axis. `canary` is an operational process, not an enum. Relevant drift: `CERTIFIED → DEGRADED → recertification`.

## 24. Gate provider.cinevision

New environments must not run without an explicit `provider.cinevision` fixture: the system starts fail-closed with `certification = UNCERTIFIED`, `availability = UNAVAILABLE` (or equivalent runtime-supported behavior). Absence of a gate row never releases operation. Implemented 2026-10-01 via migration `202610010000_044_provider_cinevision_capability_gate.sql` (idempotent INSERT + capability event; SQL proof in `db/tests/010_provider_cinevision_capability_gate.sql`).

## 25. Primeira operação mutável

The first certified write is `CREATE_TRIAL`, only after: readers implemented; durable dispatch implemented; disposable account/entity designated; internal eligibility; capability enabled; specific readback available:

```text
Trial eligibility → ProviderOperation + Outbox → COMMIT → Dispatcher → CREATE_TRIAL
→ READ_CUSTOMER → validar is_trial / expires_at / customer exists / binding / credentials-access
→ SUCCEEDED
```

An isolated HTTP 200 never terminates the operation.

## 26. CREATE_TRIAL idempotency

The idempotency key belongs to the semantic intent: `trial-provision:{trialId}`, not `trial-provision:{trialId}:{attemptIndex}`. The attempt index belongs to the attempt, not to the business operation identity. Review compatibility impacts before changing current behavior.

## 27. Operações seguintes

After `CREATE_TRIAL`: `SYNC_CUSTOMER`/readback, `RENEW_CUSTOMER`, `CHANGE_CONNECTIONS`, `BLOCK_CUSTOMER`/`UNBLOCK_CUSTOMER`, `TRUST_RENEWAL`, `MIGRATE_SERVER` — final order by risk/evidence, never skipping dispatch/readback gates.

## 28. BLOCK / UNBLOCK

The observed endpoint has TOGGLE semantics — especially dangerous. Mandatory `READ_CUSTOMER_STATUS` before and after. Never repeat a toggle on timeout without knowing current state.

## 29. TRUST_RENEWAL

Preserve the domain rule `ACTIVE + remaining <= 3 days + 3 days` with the existing human approval. The adapter never decides commercial eligibility. After execution, readback expiry must match the expected postcondition exactly.

## 30. Provider bindings

When the provider generates or reveals stable external identifiers, record them in `provider_bindings`; do not permanently depend on username/email/phone/textual search when a stable external ID is proven.

## 31. Evidence

Per-attempt sanitized evidence. Allowed: HTTP status, content type, adapter version, strategy, response shape, non-sensitive external IDs, timestamps, readback result, error class, correlation id. Prohibited: Bearer, passwords, cookies, Authorization headers, raw localStorage, real playlists, IPTV credentials, unnecessary PII.

## 32. Browser evidence

Screenshots/traces are not an indiscriminate requirement. When needed for DOM certification: test account, sanitized, no tokens/credentials captured, no storage state persisted as evidence. `API_IN_BROWSER` prefers sanitized structural evidence.

## 33. Secrets

Resolve the divergence between LAB Infisical usage and documentation that still treats the secret manager as proposed (ADR-0014); formalize before production. Independently of the chosen backend, `provider_accounts.secret_ref` remains a reference; the secret value never enters domain event, audit, `requested_payload_json`, `result_summary_json` or logs.

## 34. Observabilidade

Minimum metrics: `provider_operations_total`, `provider_operations_by_status`, `provider_attempts_total`, `provider_attempt_latency`, `provider_readback_latency`, `provider_unknown_effect_total`, `provider_human_required_total`, `provider_challenge_total`, `provider_bad_response_total`, `provider_postcondition_mismatch_total`. Controlled dimensions: provider, capability, adapter, strategy, result, error_class. Never tenant/customer/token as metric labels.

## 35. Timeouts

Every external operation has a finite budget, separating session acquisition, adapter execution, HTTP/browser action, readback and overall operation budget; configurable per adapter/capability. No indefinitely pending call. A timeout after a potential write means `UNKNOWN`, never `FAILED`/`KNOWN_NOT_APPLIED`.

## 36. Reads

Reads may use bounded retry when idempotent, effect-free and transitively-classified transient. No aggressive retry on challenge, permission denied, integration inactive, persistent bad schema or UI drift.

## 37. API M2M futura

`CinevisionApiAdapter` stays planned but must not be implemented as real based on the SPA API alone. Prefer a future authorized Reseller API (OpenAPI, dedicated auth, scopes, token lifecycle, webhook signing, rate limits, permitted contract) before considering `execution_channel = API`.

## 38. Reseller API

Do not block the MVP waiting for the Reseller API. Current state `DISABLED`/integration inactive (402). Keep investigation as a separate track; do not bypass the 402.

## 39. ManualProviderOpsAdapter

Preserved as the safe fallback: challenge, ambiguity, contract drift, uncertified capability, inconclusive readback or degraded provider converge to `HUMAN_REQUIRED` instead of guessing or repeating actions.

## 40. Compatibilidade

Do not break: `EchoProviderOpsAdapter`, `ManualProviderOpsAdapter`, existing tests, command/event vocabulary, tenant isolation, the DB idempotency constraint, the recovery queue, trust-renewal HITL or existing fulfillment. Changes are incremental.

## 41. Acceptance Criteria — P0

No real write until ALL: external effect removed from the DB transaction; post-commit outbox working; durable dispatcher; attempt persisted before send; crash recovery; `UNKNOWN_EFFECT` working; real readback; no blind retries; crash-window tests green.

## 42. Acceptance Criteria — Browser Adapter V2

Real `CinevisionBrowserAdapter`; `API_IN_BROWSER` preferred; DOM encapsulated as fallback; endpoint/method allowlist; no generic browser navigation/request API; internal payload mapping; normalized schemas; no secret leakage; session-expiry and challenge handled; bounded timeouts; `execution_channel = BROWSER` persisted; strategy distinguishable in evidence.

## 43. Acceptance Criteria — Readers

Demonstrate in a controlled environment: READ_IDENTITY, READ_CREDIT_BALANCE, LIST_CUSTOMERS, READ_CUSTOMER, READ_CUSTOMER_STATUS, READ_CONNECTIONS, LIST_SERVERS, READ_SERVER_STATUS, LIST_PACKAGE_PRICES, READ_LIVE_CONNECTIONS. Per capability: schema test, error classification, no-secret logging, timeout, retry policy, evidence, certification record.

## 44. Acceptance Criteria — CREATE_TRIAL

Disposable entity; eligibility before dispatch; stable operation idempotency; outbox; attempt; `API_IN_BROWSER` contract validated; readback; postcondition; crash-after-send test; duplicate prevention; `UNKNOWN_EFFECT` test; `HUMAN_REQUIRED` fallback; promotion only after evidence.

## 45. Testes obrigatórios

Unit: mappings, schemas, normalization, error classification, effect certainty, fallback decisions, idempotency. Integration: transaction+outbox, dispatcher claim, duplicate workers, lease expiry, crash recovery, readback, operation state transitions. Contract (fake responses): 200 JSON; 401; 402; 403 JSON; 403 HTML challenge; 404 HTML; 429; malformed JSON/schema; timeout; connection reset. Browser controlled: session valid/expired, API_IN_BROWSER, DOM fallback, challenge, provider version drift.

## 46. Definition of Done

```text
commands → DB-only transaction → durable dispatch → CinevisionBrowserAdapter
→ API_IN_BROWSER → readback → conclusive effect
```

working end-to-end for `CREATE_TRIAL` in a controlled environment, without blind retry, without persisted secrets and with proven crash recovery. Other writes stay disabled until individually certified.

---

# PLAN — execução incremental

> Estratégia: implementação por fases, CI verde entre elas, fail-closed, readers antes de writes. Nenhuma fase posterior contorna os gates da anterior. `NO REAL WRITE` no provider permanece até a validação live controlada (Fase 6, com acesso do operador); a Fase 5 entrega o caminho real atrás dos gates, sem executá-lo.

## Fase 0 — Baseline e saneamento (CONCLUÍDA 2026-10-01)

- Ler documentação canônica e investigação; confirmar baseline (`panel 3.93`, `M2M UNCONFIRMED`, `Reseller API INACTIVE`, `API_IN_BROWSER reads observed`, `real writes not certified`). ✅
- Rodar suíte completa e investigar falhas preexistentes antes de atribuí-las às mudanças. ✅ — achado e corrigido: 5× TS2532 preexistentes em `apps/browser-worker/test/browser.test.ts` (indexação sob `noUncheckedIndexedAccess`) tornavam o `pnpm typecheck` do HEAD vermelho.
- Encoding: BOM removido de 4 arquivos do browser-worker (`src/browser.ts`, `src/config.ts`, `test/browser.test.ts`, `test/readIdentity.test.ts`); verificação byte-level sem mojibake.
- Gate inicial fail-closed: migration 044 (`provider.cinevision` `UNAVAILABLE`/`UNCERTIFIED`/risk `HIGH`, idempotente, com capability event) + `db/tests/010` (row, idempotência, evento). Gate de runtime (`applyCapabilityGate`) já força MANUAL quando `UNAVAILABLE`.
- Saída: baseline verde (lint, typecheck, testes worker 108, docs/contracts/seeds), gate conhecido, nenhuma mudança funcional externa.

## Fase 1 — ProviderReadbackPort real (MÓDULOS IMPLEMENTADOS 2026-10-01; certificação live pendente)

- Módulos `apps/browser-worker/src/providers/cinevision/` (`errors`, `api-client`, `schemas`, `readers`, `index`): taxonomia canônica, client bounded GET-only com mapa fechado capability→path, timeout configurável (AbortController in-page + race externo), validação de content-type, normalização `is_trial`, evidência sanitizada, 11 readers evidenciados pela investigação (incl. `readCreditBalance` via `credits` de `auth/me`); `READ_PLAYLIST` e writes não implementados (bloqueados).
- Garantias de segurança (duas rodadas de revisão independente): nenhuma função de transporte genérica exportada; a função in-page é totalmente autocontida (harness de isolamento serialização-safety em teste) e valida origem permitida + path EXATO do mapa fechado ANTES de tocar o token; parse/projeção primitive-only por allowlist acontecem DENTRO da página (`token`, `meta.token` e valores aninhados nunca cruzam a fronteira browser→processo); sinais de challenge vêm do texto da RESPOSTA (não do documento da SPA); `CHALLENGE` exige evidência estrutural de interstitial com famílias script/marker disjuntas (script isolado — challenge-platform, turnstile, cf-challenge — não basta); schemas estritos (chave desconhecida/objeto vazio → `BAD_RESPONSE`); rejeição do `evaluate` → `TRANSPORT`; abort externo propaga ao `AbortController` in-page (registry por callId) com timeout como backstop.
- 75 testes novos (unit + contract matrix: 200 válido, `is_trial` variants, 401/402/403 JSON/403 HTML challenge/404/429, content-type errado, JSON malformado, schema drift, timeout, abort antes/depois do início com cancelamento in-page, reset, negativos de origem/path/segredos aninhados, isolamento de serialização da função in-page).
- Pendente desta fase: wiring no `PlaywrightPage` real + rota CLI (Fase 2), validação live controlada para promover readers a `SANDBOX_CERTIFIED` (hoje bloqueada pelo interstitial Cloudflare/IP documentado em [Live Integration Certification](../../15-implementation-baseline/10-integrations-certification.md)).

## Fase 2 — Browser Adapter V2 (IMPLEMENTADA 2026-10-01; smoke live pendente)

CLI V2 semântico read-only: 11 subcomandos (um por capability certificada-leitura) ligados aos readers da Fase 1 reutilizando a mesma função in-page autocontida; envelope com `executionChannel=BROWSER`, `strategy=API_IN_BROWSER`, `adapterVersion=cinevision-browser-v2`; DOM apenas como slot fail-closed (`DOM_NOT_CERTIFIED`); identidade da sessão verificada ANTES de todo comando não-identidade e reverificada após reauth (mismatch → falha sem dados); reauth única com janela dedicada na política (1 POST inicial + 1 de reauth máximo, garantias preservadas); budget total com cancelamento efetivo (abort entre etapas, `open()` cancelável com contexto exposto ao owner, nenhum `close` sem bound, lock nunca liberado com launch pendente — bounded-hold + detecção de owner stale no profile lock); args apenas IDs/paginação, fail-closed. 178 testes no worker. Pendente desta fase: smoke E2E contra o painel real (mesmo unblock path da Fase 1).

## Fase 3 — Durable Provider Dispatcher (NÚCLEO PROVIDER CONCLUÍDO 2026-10-01; fatias trial/fulfillment/license na próxima onda)

`NO REAL WRITE` permanece: o dispatcher ainda não tem adapter real de escrita (echo/manual são sintéticos; o path real chega na Fase 5).

- Migration `202610010001_045_provider_dispatch_lease.sql`: colunas de lease/claim/`dispatch_started_at` em `provider_operations` e `provider_operation_attempts` (NULL-safe, append-only) + índice parcial de recuperação.
- Flag `PROVIDER_DISPATCH_MODE=inline|durable` (default inline): no modo durable o branch secret do provider retorna `QUEUED` sem chamar o port — nenhuma chamada externa dentro da transaction; echo/manual permanecem inline (dev convenience, §3.5 do PLAN); nenhum teste existente alterado.
- `ProviderDispatcherService` em 3 fases: claim `SKIP LOCKED` com **claim token único por aquisição** (fencing) → promoção RUNNING + attempt `STARTED` + `dispatch_started_at` (fronteira de crash inequívoca) → **port call FORA de qualquer transaction** → fase de resultado com UPDATE condicional pelo token (claim perdido aborta sem escrever). Proveniência: só `secret-required-v1` é claimado; sintéticos/spoofs ignorados; op secret-required com porta não-compatível → `HUMAN_REQUIRED` (nunca Echo); capability revalidada no dispatch (ausente/UNAVAILABLE → `HUMAN_REQUIRED`).
- Recovery por statements únicos atômicos que revalidam na escrita: pré-send → `REQUESTED` reexecutável; pós-send → `VERIFYING`/`UNKNOWN` (nunca reexecução direta; reconcile segue pelo `provider.reconcile` existente); timeout do port → `VERIFYING`/`UNKNOWN` (SPEC §35).
- Acionamento: tasks opt-in no scheduler (`provider.dispatch_due`/`provider.dispatch_recovery`, gated em mode=durable) + `POST /v1/admin/provider-dispatch/drain|recover` platform-admin.
- Evidência: 32 unit tests + **17 integration tests executados contra Postgres descartável (17/17)** cobrindo double-claim, lease expiry pré/pós-send, falha de Phase-3 após resposta do port, fencing perdido, proveniência, capability flip e tenant isolation.
- **Fatias trial e fulfillment migradas (mesma onda)**: appliers extraídos como fonte única entre handler inline e dispatcher (registry fechado por `op.action`), cortes durable equivalentes, payload externo projetado por allowlist compartilhada (`buildDispatchPortPayload` — payload inline == payload durable, metadados de domínio ficam só na operação persistida), ramo FAILED do trial honesto (sem evento sem transição real), entrada `provider.request_operation action=trial.provision` delega ao applier do trial (regra `via: "provider.resolve"` parametrizada, não duplicada).
- **License deliberadamente inerte no dispatch**: `app_license.purchase` não possui branch secret (persiste `intent-v1`, nunca `secret-required-v1`) — o wrapper existe, é honesto (`{ok:false}` de finalização → `HUMAN_REQUIRED`, nunca mascara SUCCEEDED) e os locks de licença/supplier/reserva estão documentados como pré-condição para um futuro enable; nada o re-invoca hoje.
- **Isolamento de teste para a row global de capability**: chave de capability injetável no dispatcher (default de produção `'provider.cinevision'` inalterado); nenhum teste flipa mais a row global (D4 usa chave própria); cada suíte de integration que depende do gate é dona do próprio arrange AVAILABLE (5º arquivo adicionado: renewal-retention, que passava por sorte de agendamento no banco compartilhado).
- **Suíte completa de integração VERDE (58/58 arquivos) contra Postgres descartável**, e CI passou a rodar as integrações com serviço `postgres:17-alpine` + `TEST_DATABASE_URL` descartável. Fix de fixture latente: `newId().slice(0,8)` é prefixo de TIMESTAMP de UUIDv7 e colide no mesmo milissegundo — os arquivos novos usam a cauda aleatória (`slice(-8/-12)`, padrão já documentado em inventory-app-catalog).
- Pendente desta fase: revisão humana final do slice multidomínio; o gate de crash safety está demonstrado por testes.

## Fase 4 — Effect certainty + retry/reconciliation (pendente)

Transições `REQUESTED/QUEUED/RUNNING/VERIFYING/RETRY_WAIT/HUMAN_REQUIRED/SUCCEEDED/FAILED/CANCELLED` conforme vocabulário existente; certainty `KNOWN_APPLIED/KNOWN_NOT_APPLIED/UNKNOWN`; retry somente com política permitindo E `KNOWN_NOT_APPLIED` (ou leitura idempotente); `UNKNOWN → VERIFYING`; readback inconclusivo → `HUMAN_REQUIRED`; proibido trocar canal após write incerta. Gate: crash/retry tests verdes.

## Fase 5 — CREATE_TRIAL controlado (IMPLEMENTADA 2026-10-01; validação live pendente)

- Idempotency business-key (§26): chave `trial-provision:{trialId}` nas duas entradas (domínio e `provider.request_operation`), com reabertura da MESMA operação em retry elegível (`insertOrReopenTrialProvisionOperation`, CAS) — o índice de tentativa vive nos attempts; duplicatas bloqueadas (409) e replay pós-SUCCEEDED recusado.
- Eligibility antes da porta (§25): `assertTrialProvisionPreconditions` (ALLOW via `evidence_json.trial_id`, fail-closed) nas duas entradas; bypass via `provider.request_operation` fechado; preparação canônica compartilhada (`prepareTrialProvisionIntent`: attempt + eventos + REQUESTED→PROVISIONING).
- Convergência de incerteza (§15/§16): VERIFYING inconclusivo → HUMAN_REQUIRED (applier compartilhado, CAS com perdedor silencioso); snapshot conclusivo sem customer converge (sem self-loop); RETRY_WAIT permanece sem writer (decisão consciente: retry é business-driven pelo reopen; auto-retry proibido).
- Gate por ação + conta descartável (§22/§24/§25): migration append-only 046 (`provider.cinevision.trial` UNAVAILABLE/UNCERTIFIED + evento, proof `db/tests/011`); dispatch real de trial exige gate da ação AVAILABLE + `PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID` apontando conta ACTIVE do tenant (fail-closed em ausência/divergência); a row global segue master para as demais ações — certificação de `subscription.provision` continua em fase própria.
- Readback + postcondition + binding (§10/§25/§30/§31): `TrialReadbackPort` (READ_CUSTOMER) com normalização defensiva e external id conservador; postconditions is_trial/expires_at/external_id → satisfeitas: SUCCEEDED/KNOWN_APPLIED + `provider_bindings` (+ `trial.provider_binding_id`) com expiração OBSERVADA vencendo a local; violadas: HUMAN_REQUIRED/POSTCONDITION_MISMATCH; inconclusivas: VERIFYING → convergência. HTTP 200 isolado nunca encerra a operação.
- Execução real somente pós-commit e fora de tx (§12/§41): o caminho inline-secret REAL de `trial.provision` é queue-only (nunca port/readback in-tx; paridade inline/durable por construção); o dispatcher é o único executor certificado — port e readbacks com budget finito (`racePortCall`/`raceTrialReadback`/`raceGenericReadback`), recovery/reconcile fora de tx com CAS (`recoverOnce`, `reconcileOnce`; scheduler `provider.dispatch_due|dispatch_recovery|dispatch_reconcile` + endpoints platform-admin `drain|recover|reconcile`).
- Retomada vinculada à intenção: `resumeLinkedTrial` exige a latest op de ação `trial.provision` (op arbitrária não ativa nem envenena a resolução).
- Evidência: 60/60 arquivos e 726/726 testes da api contra Postgres descartável; worker 178/178; docs/contracts/seeds OK; typecheck/lint limpos; reviewer + security-reviewer independentes APPROVED após 3 rodadas de findings corrigidos.
- Pendente desta fase (bloqueia certificação, não o código): revalidação do contrato `POST /api/customers` no build atual (Ficha W1 body ainda `unknown`) e canary live (Fase 6) — ambos exigem acesso live do operador (interstitial Cloudflare documentado; credenciais fora do runtime). O worker segue GET-only; o subcomando `createTrial` só entra após contrato revalidado. `NO REAL WRITE` permanece.

## Fases 6-18 (resumo)

6 canary CREATE_TRIAL (abort em padrão sistêmico de challenge/bad response/drift/unknown/postcondition mismatch → DEGRADED → manual); 7 SYNC/readback hardening + reconciliation jobs (provider observation é evidence, não domínio mestre); 8 RENEW_CUSTOMER (postcondition `expires_at`); 9 CHANGE_CONNECTIONS (não confundir `READ_CONNECTIONS` com `READ_LIVE_CONNECTIONS`); 10 BLOCK/UNBLOCK (pre/post-read obrigatórios por ser toggle); 11 TRUST_RENEWAL (fluxo HITL atual preservado, +3d exatos); 12 MIGRATE_SERVER (readers suficientes primeiro); 13 playlist/credentials (`READ_PLAYLIST` sem registrar conteúdo sensível; `GENERATE_CREDENTIAL` bloqueado); 14 calculations (POST não é side-effect-free por presunção; teste só com autorização explícita); 15 operações destrutivas (default DISABLED + HITL + preview + rollback); 16 Reseller API paralela (só se ativada comercialmente; migração capability a capability, sem big-bang); 17 decisão formal de secrets (ADR Infisical vs documentação; `secret_ref` only); 18 observabilidade operacional (dashboards/alerts para unknown effect, human required, challenge, session expiry, schema drift, bad response, postcondition mismatch, latência, dispatch abandonado, falha de readback — sem PII em labels); 19 documentação (atualizar docs existentes, eliminar afirmações desatualizadas — incl. reconciliar o ladder `UNVALIDATED→LAB_VALIDATED→CANARY_VALIDATED` do baseline com os enums de runtime).

## Ordem de PRs

PR 1 baseline (CI/docs/encoding/gate — concluído nesta revisão) → PR 2 readback (readers/schemas/errors/tests — módulos prontos, wiring na 2) → PR 3 Browser Adapter V2 → PR 4 durable dispatcher → PR 5 effect certainty → PR 6 CREATE_TRIAL → PR 7+ capability incremental.

## Invariantes que reviewers devem bloquear

Rejeitar PR que: chama provider dentro de DB transaction; repete write após timeout sem readback; alterna canal após write incerta; persiste Bearer/cookie/password; cria endpoint genérico de browser; permite URL arbitrária; considera HTTP 200 suficiente para write; marca frontend contract como runtime certified; adiciona `API_IN_BROWSER` como novo execution channel; adiciona estado de certificação incompatível com o runtime; trata 403/404 genericamente como Cloudflare; permite ausência de capability gate = enabled.

## Condição de encerramento

1. `ProviderReadbackPort` CINEVISION operacional; 2. Browser Adapter com `API_IN_BROWSER` como caminho principal para capabilities certificadas; 3. toda chamada externa pós-commit; 4. crash windows cobertos; 5. `UNKNOWN_EFFECT` reconciliado antes de retry; 6. `CREATE_TRIAL` certificado; 7. fulfillment principal do MVP com fallback manual seguro; 8. CI verde; 9. documentação refletindo exatamente o runtime; 10. nenhum mecanismo dependendo de bypass de controles de segurança.

---

# Revisão contra a codebase (2026-10-01)

Evidência de inspeção (explorer + leitura direta), confrontando esta SPEC com o runtime real:

**Confirmado (gaps reais):**

- Dispatch inline na transaction: `CommandBus` aguarda o handler dentro de `db.withTransaction` (`apps/api/src/commands/command-bus.ts`); call sites inline em `provider.commands.ts`, `trial.commands.ts`, `fulfillment.commands.ts`, `inventory/license.commands.ts` — comentários no próprio código admitem ausência de crash/commit protection. Fase 3 é obrigatória antes de qualquer write.
- Gate fail-open por ausência de registro: `applyCapabilityGate` com `capability = null` devolvia `capability_not_catalogued` mantendo o adapter pedido; não existia linha `provider.cinevision` em `platform.capabilities` (seed criava apenas provider/account). **Corrigido na Fase 0** (migration 044 fail-closed; `UNAVAILABLE → MANUAL` já implementado no gate puro).
- Readback real inexistente: apenas `StubProviderReadback` env-gated com provenance gate (`echo-v1`/`manual-v1` sintéticos); `SECRET_REQUIRED_ADAPTER_VERSION` reserva `secret-required-v1`. Fase 1 entrega os módulos worker; a porta API real depende da Fase 3 (não há canal API↔worker hoje; o worker é CLI).
- Tabelas/estados já compatíveis: `provider_operations` (9 status; `execution_channel` CHECK `API|BROWSER|MANUAL`), `provider_operation_attempts`, `provider_evidence` (C0-C3), `provider_bindings`, `effect_certainty` (`UNKNOWN|KNOWN_APPLIED|KNOWN_NOT_APPLIED` com shape CHECK), outbox `platform.outbox_messages` com drainer `SKIP LOCKED`, HITL `human_review.*` + trust-renewal ledger — a SPEC não precisa de novos enums, conforme planejado.

**Divergências registradas:**

1. Ladder de certificação: `docs/15-implementation-baseline/10-integrations-certification.md` usa `UNVALIDATED → LAB_VALIDATED → CANARY_VALIDATED → CERTIFIED` (vocabulário de plano), enquanto o runtime e esta SPEC usam `UNCERTIFIED | SANDBOX_CERTIFIED | CERTIFIED`. Autoridade: enums de runtime. Reconciliação documental na Fase 19.
2. Painel: `cinevision.md` fixa baseline v3.92 (2026-09-19); investigação observou v3.93 (2026-09-30). Tratado como `provider compatibility pin`, não regra de domínio.
3. Schemas do worker: validadores internos dependency-free em vez de Zod (Zod não é dependência do `browser-worker`; adicionar seria edição de `package.json` fora da menor mudança compatível desta fase). Assinaturas compatíveis para troca futura; semântica estrita equivalente (strip, fail-closed, única normalização explícita).
4. Evidência do readback admite `schema: "NOT_EVALUATED"` além de `ok | BAD_RESPONSE` para falhas sem validação de schema (transporte e status não-2xx).
5. Leitura live hoje bloqueada: interstitial Cloudflare/IP documentado em [Live Integration Certification](../../15-implementation-baseline/10-integrations-certification.md) (W0-09). Promoção dos readers a `SANDBOX_CERTIFIED` exige um dos unblock paths (IP descansado + desafio interativo dentro da janela bounded, canal real-Chrome, ou rede diferente). O código está pronto para validação via contract tests.

**Executado nesta revisão (Fase 0 + módulos da Fase 1):** fix TS2532 preexistente; normalização de BOM; migration `202610010000_044_provider_cinevision_capability_gate.sql` + `db/tests/010`; módulos `apps/browser-worker/src/providers/cinevision/` + 44 testes; este documento e cross-references. Nenhuma mudança de comportamento de runtime da API; nenhum write real; nenhum segredo tocado.
