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
  },
});
