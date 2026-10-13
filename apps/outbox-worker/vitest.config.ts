import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Bootstrap/teardown applies all ~48 migrations (~14s bounded work).
    // The 10s default hookTimeout turns that into a flaky "Hook timed out".
    // Same rationale as apps/api and packages/database vitest configs.
    hookTimeout: 120_000,
  },
});
