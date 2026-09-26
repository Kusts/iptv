# CINEVISION Semantic Operation Catalog

> Status: Canonical semantic catalog; live selectors/routes pending safe observation  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked to avoid inventing undocumented endpoints, selectors or provider guarantees.

## Purpose

Define what our platform needs from the provider without pretending current UI/API implementation details are known or stable.

`LIVE OBSERVATION REQUIRED` means the Browser/API adapter implementation must be captured in a safe authenticated environment before production use.

## Core operations

| Semantic operation | Business purpose | Postcondition our system must verify | Implementation detail |
|---|---|---|---|
| `createTrial` | provision eligible Trial | credentials/access exist with expected duration/options | partial API support known; exact active contract must be pinned |
| `createCustomer` | create provider-side fulfillment identity | provider customer can be re-read | LIVE OBSERVATION REQUIRED |
| `renewCustomer` | extend paid service | provider expiry/entitlement reflects expected period | LIVE OBSERVATION REQUIRED |
| `grantTrustRenewal` | +3-day provider trust renewal | account was ACTIVE with <=3 days remaining and observed expiry advanced exactly 3 days | rule validated; locator/API still LIVE OBSERVATION REQUIRED |
| `blockCustomer` | suspend fulfillment | provider reports blocked/inactive | LIVE OBSERVATION REQUIRED |
| `unblockCustomer` | restore fulfillment | provider reports usable state | LIVE OBSERVATION REQUIRED |
| `syncCustomer` | reconcile provider representation | provider state refreshes and can be re-read | LIVE OBSERVATION REQUIRED |
| `migrateServer` | move ONE/XTREAM or equivalent server | target server is verified and service credentials/state valid | LIVE OBSERVATION REQUIRED |
| `changeConnections` | change recurring connection/screen quantity | provider connection quantity equals requested | LIVE OBSERVATION REQUIRED |
| `readCustomer` | reconciliation/support | provider state snapshot returned | LIVE OBSERVATION REQUIRED |
| `readCreditBalance` | inventory/recharge | provider balance snapshot returned | LIVE OBSERVATION REQUIRED |
| `readLiveConnections` | support/operations | current connection snapshot returned | LIVE OBSERVATION REQUIRED |
| `importExistingCustomers` | tenant onboarding/migration | provider customer snapshots discovered without mutation | LIVE OBSERVATION REQUIRED |
| `changeAdultContent` | update customer preference | observed adult-content setting equals requested | LIVE OBSERVATION REQUIRED |

## Adapter contract

Every mutating operation must record:

```text
provider_operation_id
tenant_id
semantic_action
input snapshot/reference
started_at/completed_at
attempts
result/error
postcondition result
evidence references
adapter version
browser session reference when applicable
```

## Ambiguous timeout

If the command may have reached the provider but no response is available:

```text
UNKNOWN_EFFECT
→ read/verify postcondition
→ if already applied: mark SUCCEEDED
→ if definitely not applied: safe retry according to policy
→ if still ambiguous: HUMAN_REQUIRED
```

## Drift

Unexpected route/UI/DOM/security challenge enters degraded mode. The adapter must not improvise destructive navigation.

## Live-capture checklist

For each operation capture later:

- authenticated route/page;
- required UI/API inputs;
- stable semantic locators where possible;
- confirmation/postcondition source;
- failure messages;
- timeout characteristics;
- screenshots/trace in safe test account;
- adapter version and date verified.

## Auto-review result

Reviewed to provide implementation-ready semantic authority while explicitly refusing to fabricate unstable provider implementation details.
## Validated business constraints v0.14

- Trial windows observed: 1h/3h/6h.
- Trust renewal: +3 days fixed; account ACTIVE; <=3 days to expiry; no arbitrary N-day extension.
- Additional connection expires with the main subscription period and cannot be removed mid-period for pro-rata adjustment.
- Provider enforces simultaneous-connection limit.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — validated business constraints and import semantics checked.

