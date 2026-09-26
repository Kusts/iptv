# @iptv/database

Kysely bootstrap + SQL migration runner. No business services live here.

## Bookkeeping table

The runner records applied files in `platform.migration_history`
(`filename` PK, `sha256`, `applied_at`). The table is created idempotently
(`CREATE SCHEMA/TABLE IF NOT EXISTS`) by the runner itself — it is
operational bookkeeping, not domain state, so it is intentionally not a new
file under `db/migrations/*.sql` (those 11 files are canonical and
read-only). Each pending file runs inside one transaction together with its
bookkeeping INSERT; re-running is a no-op; a content change to an
already-applied file fails fast on sha256 mismatch.

## Conventions

- Snake-case columns mapped explicitly via typed interfaces (`schema.ts`);
  CamelCasePlugin is OFF.
- Migrations are roll-forward only.
