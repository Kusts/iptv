import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Test FILES run sequentially — never in parallel. The migration
    // runner's session-level advisory lock (`MIGRATION_ADVISORY_LOCK_KEY`)
    // only serializes runs against the SAME database: `pg_advisory_lock` is
    // a per-database lock, so two suites migrating two DIFFERENT databases in
    // one cluster are NOT serialized by it (proven: a session holding the lock
    // on `db_a` blocks a second session on `db_a`, while a session on `db_b`
    // acquires the same key immediately). Migration 050 therefore races its
    // cluster-global check-then-create of the `outbox_worker` /
    // `outbox_executor` roles: `pg_roles` is shared by every database in the
    // cluster, so two concurrent check-then-creates both see "absent" and the
    // loser dies on the unique index backing `pg_authid.rolname` — the #42 CI
    // failure. Concretely, `tenant-transaction.test.ts` (migrates
    // `TEST_DATABASE_URL`) raced
    // `outbox-worker-concurrency.integration.test.ts` (creates its own
    // database) inside this package, and this package raced `@iptv/api` /
    // `@iptv/outbox-worker` across turbo tasks. `fileParallelism: false` is
    // the same invariant `apps/api/vitest.config.ts` already enforces with
    // `maxWorkers: 1`; the cross-package half is the CI's
    // `pnpm test --concurrency=1`.
    fileParallelism: false,
    // Files are serialized, but the FIRST file to run still applies all ~48
    // migrations in its `beforeAll` (~14s measured on Windows dev hosts,
    // close to CI runners). The 10s default hookTimeout turns that
    // legitimate, bounded bootstrap into a flaky "Hook timed out" suite
    // failure (observed 2026-10-05 on a fresh disposable DB). The operation
    // is bounded real work, not a hang — give the hooks an explicit budget.
    hookTimeout: 120_000,
  },
});
