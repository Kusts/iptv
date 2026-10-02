# Database Seeds / Fixtures

> Status: Proposed — development/test data only  
> Version: 0.10

## Purpose

`001_pilot_baseline.sql` creates a deterministic, synthetic pilot dataset and
must be applied only after **all** migrations in `db/migrations/` (46 files)
have run. `db/migrations/README.md` is the canonical ordered list.

It exists for:

- local development;
- integration tests;
- API demos;
- agent eval fixtures;
- deterministic reproductions of Trial, Support and Referral flows.

## Safety rules

- Never replace synthetic identities with production customer data in this file.
- Never store live provider/API credentials; `secret_ref` values are placeholders only.
- High-risk outbound capabilities start disabled.
- Commercial values that were not finalized during discovery stay `TBD`/NULL rather than being invented.
- The currently confirmed monthly plan price is seeded at **BRL 30.00**.
- The additional connection is seeded as **RECURRING** with provider cost explicitly marked recurring; no sale price is invented.

## Apply

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seeds/001_pilot_baseline.sql
```

Apply only after all migrations in `db/migrations/` (46 files).

## Deterministic fixture cases

| Fixture | Purpose |
|---|---|
| `Lead Exemplo` | already has a primary ACTIVE Trial; useful for duplicate-Trial denial tests |
| `Cliente Exemplo` | active Customer with an open WhatsApp conversation and Support Ticket |
| `Referral Pilot` | active program linking the synthetic customer to the synthetic lead |
| CINEVISION supplier offers | known provider-credit packages captured during discovery |

The dataset is not a source of production policy. Domain documents remain authoritative.
