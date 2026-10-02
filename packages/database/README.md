# @iptv/database

Kysely bootstrap + SQL migration runner. No business services live here.

## Runtime surface

- `createDb({ connectionString, maxConnections? })` (`src/db.ts`): a Kysely
  instance over `pg`. There is no CamelCasePlugin, so columns stay
  snake_case and are mapped explicitly through the typed interfaces in
  `schema.ts`.
- Tenant helpers (`src/tenant-context.ts`): `assertTenantId`,
  `readTenantSetting`, `withTenantTransaction`.
- `applyMigrations(connectionString, { migrationsDir })` (`src/migrate.ts`):
  applies every pending `*.sql` file of the directory in filename order and
  reports `{ applied, skipped }`.

## Migration runner guarantees

- **Advisory lock**: `applyMigrations` holds a dedicated pooled connection
  with a session-level `pg_advisory_lock(MIGRATION_ADVISORY_LOCK_KEY)`
  (`7271645001`) for the whole run and releases it in `finally`, so
  concurrent runner processes serialize. Per-file work uses a second
  connection, which is why the lock survives each file's `BEGIN`/`COMMIT`.
- **Bookkeeping table**: applied files are recorded in
  `platform.migration_history` (`filename` PK, `sha256`, `applied_at`). The
  table is created idempotently (`CREATE SCHEMA/TABLE IF NOT EXISTS`) by the
  runner itself — it is operational bookkeeping, not domain state, so it is
  intentionally not a new file under `db/migrations/*.sql` (those 46 files
  are canonical, read-only, and listed in `db/migrations/README.md`). Each
  pending file runs inside one transaction together with its bookkeeping
  INSERT; re-running is a no-op; a content change to an already-applied file
  fails fast on sha256 mismatch.
- **One envelope per file**: a file may wrap its body in a single
  `BEGIN;` … `COMMIT;` pair; the runner strips that envelope and rejects
  residual transaction-control statements in the body (naming the file).

## Conventions

- Snake-case columns mapped explicitly via typed interfaces (`schema.ts`);
  CamelCasePlugin is OFF.
- Migrations are roll-forward only.