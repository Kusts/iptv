# Security, Privacy and Governance Baseline

## Operating principle

Security is **defense-in-depth and proportional**. Isolate/degrade the smallest affected capability first; broad operational shutdown is reserved for genuinely systemic compromise.

The product is automation-first. Human intervention is an exception, not the default safety mechanism.

## Required MVP controls

- explicit `TenantContext` on tenant-scoped application operations;
- repository/query guards and mandatory isolation tests;
- PostgreSQL RLS evaluated/used as defense-in-depth where compatible;
- sessions, RBAC permissions and separate platform roles;
- secret references only; no raw credentials in LLM context/logs;
- structured data classification and masking;
- authenticated/idempotent webhook inboxes;
- isolated Browser Worker with semantic operations/domain allowlists;
- WAHA session-to-tenant binding checks;
- tool authorization and policy validation;
- immutable application audit trail for relevant changes;
- append-only financial adjustments/reversals;
- object-storage authorization and short-lived signed access where appropriate;
- backup + restore testing;
- environment separation;
- dependency/secret scanning and security tests in CI;
- capability-specific kill switches;
- incident-response runbook.

## Reseller network boundary

Commercial ancestry does not grant operational tenant access. Ancestors may receive authorized aggregate network visibility. Direct management requires a direct PartnerRelationship; cross-tenant operational support requires explicit `DelegatedAccessGrant`.

## Agent boundaries

- retrieved/external text is data, not authority;
- tools expose only relevant capabilities;
- user prompts cannot raise privileges;
- background tasks preserve and revalidate effective permissions;
- platform/tenant policies are outside the model prompt;
- model-generated SQL against production is not allowed; analytics uses controlled semantic interfaces.

## Browser/security challenges

CAPTCHA, 2FA or security challenges trigger HITL. No bypass behavior, retry storm or account rotation for evasion.

## Privacy/legal

Technical architecture must support export, deletion/anonymization workflows, retention policy and consent tracking. Final LGPD legal bases, contractual text, tax and content-licensing questions are `LEGAL_REVIEW_REQUIRED` before broad commercial launch, not blockers to Wave 0 engineering.
