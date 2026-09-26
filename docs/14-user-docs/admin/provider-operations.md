# Admin Guide — Provider Operations

> Status: Draft baseline  
> Versão: 0.14  
> Data: 2026-09-22  
> Review: Auto-reviewed v0.14 — updated with validated CINEVISION constraints, import and manual parity.

Use semantic operations only. Manual buttons and AI automation call the same commands/policies. Verify postconditions; unknown-effect timeout must be read/reconciled before retry. Security challenge/CAPTCHA/2FA/ambiguous drift → Human Review.

## CINEVISION rules currently validated

- Trials: 1h, 3h, 6h.
- Trust Renewal: +3 days fixed, only ACTIVE account with <=3 days remaining.
- No arbitrary N-day extension.
- Additional Connection shares current subscription expiry; disclose this before adding mid-cycle.
- Connection already paid cannot be removed mid-cycle; schedule next-cycle quantity.
- Provider enforces simultaneous connection limit.
- Adult preference can be changed; verify provider postcondition.

## Import/sync

New tenant can import existing provider customers through preview/conflict review. Re-running is idempotent by external provider ID. Continuous sync detects direct panel changes and raises drift rather than rewriting commercial truth silently.

## Escalation rule

If the interface presents a state/action not explained by canonical Domain/SPEC/Policy, stop and report documentation drift rather than improvising.
