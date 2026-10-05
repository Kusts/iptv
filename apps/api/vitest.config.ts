import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration files share ONE TEST_DATABASE_URL and assert on global
    // outbox/inbox state (e.g. "no PENDING rows left"). Parallel workers
    // interleave commands across files and break those assertions, so test
    // files run sequentially. Tests within a file keep default concurrency.
    // DB-bound integration queries can exceed the 5s default under full-suite load.
    testTimeout: 15000,
    maxWorkers: 1,
    // The FIRST integration file to run applies all ~48 migrations in its
    // beforeAll (~14s measured on Windows dev hosts, close to CI runners).
    // The 10s default hookTimeout turns that legitimate, bounded bootstrap
    // into a flaky "Hook timed out" (observed 2026-10-05 on a fresh
    // disposable DB). Same rationale as packages/database/vitest.config.ts.
    hookTimeout: 120_000,
  },
});
