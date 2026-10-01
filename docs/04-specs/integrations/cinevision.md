# Integration SPEC — CINEVISION Provider Adapter

> Status: Draft based on collected panel documentation and project decisions  
> Version: 1.1  
> Known panel documentation baseline: CINEVISION ONE v3.92, collected 2026-09-19; v3.93 observed 2026-09-30 (provider compatibility pin, not a domain rule).  
> Review: Auto-reviewed v0.15 — added the Runtime Hardening cross-reference; capability semantics unchanged.

## Purpose

Use CINEVISION only as an external fulfillment/provider system while the platform remains authoritative for Person, Order, Subscription, Entitlements, finance, support and history.

## Known capabilities relevant to the project

The collected panel documentation and operational notes indicate capabilities around:

- quick/free trials;
- customer creation/editing;
- renewal;
- Trust Renewal: exactly +3 days, only ACTIVE accounts with <=3 days remaining;
- server sync/migration;
- connection/screen changes;
- block/unblock;
- playlists/credentials;
- live connections/client statistics;
- credit packages and credit consumption;
- support/tickets and operational notices.

The panel also exposes internal frontend/API behavior, but internal/private endpoints must not be treated as a stable public contract unless explicitly authorized and validated.

## Provider Port — semantic operations

```text
CREATE_TRIAL
CREATE_CUSTOMER
RENEW_CUSTOMER
TRUST_RENEWAL
BLOCK_CUSTOMER
UNBLOCK_CUSTOMER
SYNC_CUSTOMER
MIGRATE_SERVER
CHANGE_CONNECTIONS
FETCH_CREDENTIALS
FETCH_PLAYLIST
```

Future operations may be added only after ProviderOperation semantics, risk and postcondition are documented.

## Execution strategy

```text
official/authorized API available
→ API adapter

operation not available through stable authorized API
→ authorized persistent browser worker
```

The Domain Core never receives selectors, page routes or credentials.

## Browser security rule

Use an authorized normal Chrome/Chromium session under operator-owned credentials. CAPTCHA, 2FA, security challenge or ambiguous UI drift goes to `HUMAN_REQUIRED`. No anti-bot/access-control bypass is part of the design.

## Postcondition principle

An external action is `SUCCEEDED` only after a business-relevant postcondition is observed.

Examples:

| Action | Minimum postcondition concept |
|---|---|
| CREATE_TRIAL | external test exists and usable credentials/access window observed |
| RENEW_CUSTOMER | external expiration/service period reflects intended renewal |
| CHANGE_CONNECTIONS | observed connection allowance equals intended quantity |
| MIGRATE_SERVER | customer/provider binding shows target server and service remains valid |
| BLOCK/UNBLOCK | observed external state matches intent |
| TRUST_RENEWAL | observed expiry reflects provider-granted temporary extension |

Exact selectors/routes are implementation artifacts versioned per adapter revision; they are not domain rules.

## Trial specifics

Free tests are qualification instruments. Internal Trial Eligibility must succeed before ProviderPort is called. The provider's ability to create another test never overrides our one-primary-Trial policy.

Known durations/options such as 1h/3h/6h and adult-content setting are provider capabilities/configuration, not universal domain constants. Capabilities should be discovered/configured per provider account.

## Additional connection / screen

Additional connection is a recurring commercial add-on. No ciclo atual ela **herda a mesma expiration date da assinatura principal**; não possui período independente. O cliente deve ser avisado antes de adicionar no meio do ciclo. Remoção no meio do período já pago não é suportada: agenda-se a mudança para a próxima renovação.

Provider fulfillment pode consumir créditos recorrentes por ciclo. O provider aplica o limite de conexões simultâneas; nossa plataforma não precisa derrubar sessões excedentes.

## Renovação em Confiança — regra validada no piloto

A capability observada deve ser modelada semanticamente como `TRUST_RENEWAL`, não como extensão genérica:

```text
account must be ACTIVE
remaining time <= 3 days
effect = +3 days fixed
```

Conta já vencida não é elegível. Não há operação observada para adicionar N dias arbitrários. Fora dessa capability, acessos temporários conhecidos são Trials de 1h/3h/6h. Esta regra deve continuar capability-versioned para permitir outro provider no futuro.

## Evidence and adapter revision

Each attempt records:

```text
adapter_version
provider_account_id
semantic action
before observation
after observation
trace/screenshot refs (sanitized)
external ids
attempt number
error classification
```

## UI drift procedure

```text
expected contract mismatch
→ stop unsafe action
→ capture sanitized evidence
→ mark operation HUMAN_REQUIRED/FAILED
→ if systemic, provider adapter DEGRADED / kill switch
→ validate new adapter revision on safe account/test case
→ release revision
```

## Reconciliation

Compare our intended/authoritative state to provider observations. Provider observations may create drift cases such as:

- internal active entitlement but provider expired;
- internal connection quantity differs from provider;
- renewal Order settled but fulfillment absent;
- provider shows renewal with no matching internal command.

Ambiguous drift goes to HITL; it never causes silent history rewrite.

## Runtime hardening

Operational hardening of this integration (post-commit durable dispatch, `API_IN_BROWSER` strategy, conclusive readback, per-capability certification, crash semantics, no blind retries) is specified in [CINEVISION Provider Runtime Hardening](cinevision-runtime-hardening.md). No real write is enabled until that plan releases the corresponding phase.

## Outstanding implementation discovery

Before coding each browser operation, the agent must extract/confirm from the current panel version:

- route/page;
- stable semantic locator strategy;
- required inputs;
- confirmation/result UI;
- postcondition observation;
- recoverable error states;
- whether an authorized API alternative now exists.

This document intentionally does not invent those details where the collected source does not support them.

## Auto-review result

Reviewed to preserve the core boundary: CINEVISION is fulfillment only; Trial policy, recurring-screen economics and commercial truth stay inside our platform.
## Existing-base import and manual parity

Tenant onboarding must support importing the existing CINEVISION customer base through authorized read/browser operations, with preview, idempotent external IDs, incomplete-identity handling and reconciliation. Continuous sync detects manual changes made directly in provider panel.

Every low/medium-risk semantic action automated by Agent must have equivalent Control Center action; both use the same ProviderOperation/policy/postcondition path.

## Adult-content preference

Ask/confirm on first paid activation; tenant default may be ON. Customer can request change at any time. Change is successful only after observed provider postcondition.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — provider capabilities corrected against pilot tests.
## Partner apps from playlist metadata

Authorized playlist/test-account metadata may expose partner/recommended apps. Normalize these into the Technical App Catalog with source/provenance. They are recommendations/options, not automatically paid products or supplier licenses.
