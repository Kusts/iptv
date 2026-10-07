# PostgreSQL Integration Tests

> Status: executable; runtime pending in this environment

These tests are intended for a **disposable PostgreSQL database** after applying every migration in `db/migrations/` (both runners below apply all `db/migrations/*.sql` in filename order — not a fixed numeric range).

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

1. applies all migrations;
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
- `008_rls_crm_communications_rollout.sql` — RLS step 3 proof against migration 042: preconditions on all 13 enforced tables, global-table allow-list assertion (0 globals in `crm`/`communication` scope), 6-table isolation sample (tenant A/B, fail-closed, cross-tenant writes blocked), owner bypass. 006/007 serve as regression (run all three). Certified also through PgBouncer transaction mode — see the runbook.
- `009_waha_channel_resolver.sql` — migration 043 proof: `communication.resolve_tenant_channel(text)` lets `iptv_app` resolve a webhook routing key with NO tenant context (the pre-context state `WahaWebhookService.resolveChannel` runs in), while the direct table read stays fail-closed; asserts SECURITY DEFINER + pinned `search_path` + EXECUTE `iptv_app`-only (revoked from PUBLIC), narrow body (only `communication.tenant_channels`), ACTIVE-only semantics, unknown/DISABLED keys → 0 rows, per-tenant containment.
- `010_provider_cinevision_capability_gate.sql` — migration 044 proof: the `provider.cinevision` capability row exists fail-closed (`UNAVAILABLE`/`UNCERTIFIED`, so `applyCapabilityGate` forces MANUAL); re-applying the migration 044 statements is a no-op (no duplicate row, no drift on either table); the append-only `platform.capability_events` log records the `NULL → UNAVAILABLE` transition with the W0 fail-closed reason. Re-apply probes run inside the test transaction and roll back.
- `011_provider_cinevision_trial_capability_gate.sql` — migration 046 proof: the per-action `provider.cinevision.trial` capability row exists fail-closed (`UNAVAILABLE`/`UNCERTIFIED`, so `decideTrialDispatchGate` blocks every real `trial.provision` even with the GLOBAL row AVAILABLE); re-applying the migration 046 statements is a no-op (no duplicate row, no drift on either table); the append-only `platform.capability_events` log records the `NULL → UNAVAILABLE` transition with the FASE5-S4S5 fail-closed reason; the GLOBAL `provider.cinevision` row is a read-only witness (never written here). Re-apply probes run inside the test transaction and roll back.
- `012_control_identity_rls_rollout.sql` — RLS control+identity rollout proof against migrations 047 (with the 048 policy-shape assertions) + 049 (membership enrollment): preconditions (`iptv_app` `NOBYPASSRLS`; RLS + `tenant_isolation` on `identity.persons`/`identity.identities`/`identity.identity_merge_reviews` AND `control.tenant_memberships`/`control.membership_roles`; hybrid global+own read / own-tenant write per-command policies on `control.feature_flags` — 048 split 047's single all-command policy because one USING admitting NULL tenant let the app role steal/delete global rows; full DML grants on the rollout surface; read-only grants on the global catalogs), global-table assertion (the 7 grant-without-RLS control tables carry no `tenant_id`), allow-list assertion (every `tenant_id`-bearing control/identity table must be RLS-enrolled — the 047 pre-context exception pair enrolled via 049, so the documented-exception list is now EMPTY and nothing may hide behind it), the former pre-context pair asserted ENROLLED (tripwire in reverse), isolation sample (tenant A/B, fail-closed without context with GLOBAL flags still readable, own-tenant writes visible, cross-tenant and GLOBAL writes blocked incl. the 048 global-row steal-via-UPDATE and DELETE regressions), owner bypass. Fixture rows roll back; role/policy/grants persist. 006/007/008/009/013 serve as regression (run all seven).
- `013_control_membership_resolvers.sql` — migration 049 proof: `control.list_memberships_for_session(text)` (session-hash-bound login/resolveSession read — exact `auth.listMemberships` columns, ACTIVE-only, unknown-or-expired token → 0 rows, per-session containment), `control.check_membership_active(uuid, uuid)` (ACTIVE-only boolean matrix incl. SUSPENDED → false, for the `setActiveTenant` switch check) and `control.resolve_membership_roles(uuid, uuid)` (single base-role + extras-array row, 0 rows without an ACTIVE membership, for `PermissionsGuard`) let `iptv_app` perform the pre-context reads with NO tenant context while the direct table reads stay fail-closed; asserts SECURITY DEFINER + pinned `search_path = control, pg_temp` + EXECUTE `iptv_app`-only (revoked from PUBLIC), narrow bodies (control membership graph only), enrolled-policy isolation sample on BOTH tables (own rows visible+writable with context, cross-tenant writes → `42501`, cross-tenant UPDATE touches 0 rows), owner bypass, and a login→switch→guarded-request rehearsal as `iptv_app`. Fixture rows roll back; functions/policies/grants persist. 006/007/008/009/012 serve as regression (run all seven).
- `014_crm_update_delete_proofs.sql` — RLS write-authorization proof on the 041 `crm.customers` surface (adapted from PR #3, renumbered): own-tenant UPDATE visible, cross-tenant UPDATE touches 0 rows, tenant_id row-migration rejected by WITH CHECK, cross-tenant DELETE touches 0 rows, no-context fail-closed, owner bypass. Fixture rows roll back. 006/007/008 serve as regression.
- `015_platform_outbox_worker.sql` — migration 050 proof: worker/executor role preconditions (`LOGIN`/`NOLOGIN NOINHERIT`, `NOBYPASSRLS`, executor-owned `SECURITY DEFINER` + pinned `search_path`, `PUBLIC` revoked, `EXECUTE` worker-only, zero worker table privileges, executor RLS policies, lease columns, recovery index, append-only trigger, 001 `outbox_pending_idx` preserved), basic claim (due PENDING/FAILED only, server tokens, payload returned), worker direct reads denied (incl. tenant tables), `iptv_app` denied on all four functions, disjoint claims, stale-token fencing (complete/fail/renew write 0 rows), live renew, crash reclaim (`claim → backdated lease → reclaim → stale fenced → current completes`, no manual repair), real clock expiry (`pg_sleep(2)` on a 1s lease), fail path with clamped retry floor, bounds fail-closed (asserted outside the handler), tenant-GUC untouched by function calls, owner close-out (no stuck `PUBLISHING`, audit chain, terminal row untouched). Single-session: real two-session `SKIP LOCKED` + cross-session CAS are covered by `apps/api/test/outbox-worker-concurrency.integration.test.ts`. Fixture rows roll back. 001–014 serve as regression (run all).

## Gate

Passing static validation is not enough. Before pilot release, these tests must run in CI against the PostgreSQL version selected for production, followed by the broader runtime test plan in `docs/03-architecture/migrations/runtime-test-plan-v0.8.md`.
