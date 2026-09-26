# Audit & Evidence Policy

> Status: Canonical baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for privacy minimization, tamper resistance, financial/provider accountability and HITL traceability.

## Audit goals

Provide enough evidence to answer:

- who/what initiated an action;
- under which tenant/policy/release;
- what authoritative state changed;
- what external side effect was requested/observed;
- whether a human intervened;
- which evidence supports success/failure.

## Audit-worthy actions

At minimum:

- authentication/admin/permission/config changes;
- price/offer/reward/policy changes;
- payments/refunds/ledger entries;
- subscription/entitlement changes;
- provider operations;
- HITL/human takeover;
- knowledge verification/deprecation;
- referral/reward issuance/redemption;
- secret/config/kill-switch changes;
- agent high-risk tool executions.

## Evidence types

- immutable audit event;
- domain event IDs;
- provider request/result metadata;
- sanitized screenshots/browser traces for selected operations;
- policy/risk decision references;
- human-review records.

## Privacy

Evidence must be the minimum needed, access-controlled and retained according to classification. Do not capture full secrets, unnecessary message bodies or payment credentials.

## Auto-review result

Reviewed to balance investigation/accountability with data minimization and avoid turning audit storage into a shadow PII database.
