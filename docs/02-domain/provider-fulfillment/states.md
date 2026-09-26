# Provider Operation — State Machine v1.0

> Status: FINAL supporting detail. Canonical catalog: `docs/15-implementation-baseline/03-state-machines.md`.

## States

`REQUESTED | QUEUED | RUNNING | VERIFYING | RETRY_WAIT | HUMAN_REQUIRED | SUCCEEDED | FAILED | CANCELLED`

Effect certainty is orthogonal:

`KNOWN_APPLIED | KNOWN_NOT_APPLIED | UNKNOWN`.

A timeout/transport failure after a possible external write sets certainty to UNKNOWN and enters VERIFYING/readback. Blind retry is forbidden until the effect is known or a safe idempotent contract proves repetition is harmless.

## Source-of-truth rule

Provider state is observed external implementation state. Subscription/Entitlements remain the business truth. Divergence creates `ReconciliationFinding`; it never silently rewrites the canonical business state.

## Human challenge

CAPTCHA/2FA/security challenge → `HUMAN_REQUIRED`; no bypass attempt.
