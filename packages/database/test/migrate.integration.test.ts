import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, listMigrationFiles } from "../src/migrate.js";

const here = dirname(fileURLToPath(import.meta.url));
// Canonical migrations live at <repo>/db/migrations (read-only for us).
const REAL_MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasDb)("real migrations (requires TEST_DATABASE_URL)", () => {
  // Fresh apply of the canonical migrations can exceed the 5s default on a
  // cold Postgres (first run after container start) — observed flake.
  it(
    "applies all canonical migrations and is idempotent on re-run",
    async () => {
      const files = listMigrationFiles(REAL_MIGRATIONS_DIR);
      const onDisk = readdirSync(REAL_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
      expect(files).toHaveLength(onDisk.length);
      expect(files.length).toBeGreaterThanOrEqual(11);

      const first = await applyMigrations(process.env.TEST_DATABASE_URL as string, {
        migrationsDir: REAL_MIGRATIONS_DIR,
      });
      const second = await applyMigrations(process.env.TEST_DATABASE_URL as string, {
        migrationsDir: REAL_MIGRATIONS_DIR,
      });
      // Either first run applied them or a previous run did; second is a no-op.
      expect(first.applied.length + first.skipped.length).toBe(files.length);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(files);
    },
    60_000,
  );
});
