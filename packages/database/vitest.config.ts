import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration files run in parallel and each `beforeAll` calls
    // `applyMigrations` against the same disposable database. The runner's
    // advisory lock serializes them, so the losers legitimately WAIT while
    // the winner applies all ~48 migrations (~14s measured on Windows dev
    // hosts, close to CI runners). The 10s default hookTimeout turned that
    // wait into a flaky "Hook timed out" suite failure (observed
    // 2026-10-05 on a fresh disposable DB). The operation is bounded real
    // work, not a hang — give the hooks an explicit budget instead.
    hookTimeout: 120_000,
  },
});
