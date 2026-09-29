# PostgreSQL Integration Tests

> Status: executable; runtime pending in this environment

These tests are intended for a **disposable PostgreSQL database** after applying migrations 001–011.

## Core run

```bash
export DATABASE_URL='postgresql://.../disposable_db'
./scripts/run_pg_tests.sh
```

This applies migrations and the invariant tests that do not require fixtures.

## Fixture run

```bash
export DATABASE_URL='postgresql://.../disposable_db'
./scripts/run_pg_fixture_tests.sh
```

This runner:

1. applies migrations 001–011;
2. applies every synthetic seed twice to prove seed idempotency;
3. runs all SQL integration tests.

## Current coverage

- `001_trial_invariants.sql` — one primary Trial, no concurrent free-access window, valid Retrial after previous access ends.
- `002_tenant_isolation.sql` — composite tenant FKs reject cross-tenant identity references.
- `003_communications_support.sql` — Message append-only behavior and Support Ticket lifecycle persistence.
- `004_referral_reward_invariants.sql` — active referral attribution cannot be duplicated for the same Person/program.
- `005_pilot_seed.sql` — pilot fixture integrity, confirmed monthly price, recurring additional connection and non-self referral.
- `006_rls_spike.sql` — Wave 0 RLS spike (rolled back, no persistent change): app role without `BYPASSRLS` isolated per tenant on `crm.customers` + `communication.conversations`, cross-tenant read returns 0 rows, cross-tenant write blocked, owner bypasses. See `docs/spikes/rls-pooling-spike.md`.
- `007_rls_app_role_pilot.sql` — RLS steps 1–2 proof against the persistent migration 041 surface: preconditions (`iptv_app` `NOBYPASSRLS` + pilot DML grants, RLS + `tenant_isolation` on `crm.customers`), tenant A/B isolation, fail-closed without context, own-tenant write visible + cross-tenant write blocked, owner bypass. Fixture rows roll back; role/policy persist. Cutover path: `docs/10-operations/runbooks/rls-role-split-cutover.md`.

## Gate

Passing static validation is not enough. Before pilot release, these tests must run in CI against the PostgreSQL version selected for production, followed by the broader runtime test plan in `docs/03-architecture/migrations/runtime-test-plan-v0.8.md`.
