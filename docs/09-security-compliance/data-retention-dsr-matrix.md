# Data Retention & Data Subject Request Matrix

> Status: Canonical privacy baseline; legal/accounting periods require jurisdictional validation  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for minimization, audit/financial exceptions and tenant/customer identity scope.

## Principle

Retention is purpose-based, not “keep everything forever”. Exact legal/accounting periods must be validated before production policy is finalized.

| Data category | Default product intent | Deletion/anonymization considerations |
|---|---|---|
| Person/contact profile | while relationship/purpose exists | anonymize/delete when no valid purpose, subject to legal/audit exceptions |
| Conversation content | limited operational/support period | minimize; detach/anonymize where possible while preserving required operational evidence |
| Payment/financial ledger | required financial/audit period | authoritative ledger generally preserved under legal/accounting basis; restrict PII linkage where possible |
| Provider operation evidence | incident/audit window | purge screenshots/traces earlier than core operation metadata where possible |
| Agent traces/prompts | eval/debug window | redact/minimize PII; longer retention requires explicit purpose |
| Knowledge | while valid/useful | remove personal source content; retain derived verified procedure when lawful and de-identified |
| Analytics events | defined analytics window | prefer pseudonymous IDs; aggregate historical metrics where possible |
| Security/audit logs | security/audit window | access-restricted; do not erase evidence required for security/legal obligations without review |

## DSR workflow

```text
request received
→ identity verification
→ scope tenant/person identities
→ locate data by system/category
→ determine deletion/access/correction eligibility and exceptions
→ execute/export/redact/anonymize
→ validate downstream indexes/caches
→ audit completion
```

## Merge/unmerge

Identity merge history must support correct DSR scoping. A DSR must not expose another person’s data due to an incorrect historical merge.

## Auto-review result

Reviewed to provide implementable privacy operations while explicitly avoiding fabricated statutory retention periods.
