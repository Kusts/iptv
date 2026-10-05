import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MigrateConfigError,
  assertOwnerConnectionString,
  resolveMigrationsDir,
  runMigrationsCli,
} from "../src/bin/iptv-migrate.js";

const here = dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

/**
 * Configuration guard rails of the migration job. No database involved: the
 * cases here are exactly the ones that must fail BEFORE a connection opens.
 */
describe("iptv-migrate configuration (no database)", () => {
  it("defaults to the canonical repository migrations directory", () => {
    expect(resolveMigrationsDir({})).toBe(REAL_MIGRATIONS_DIR);
  });

  it("honours an explicit MIGRATIONS_DIR and rejects a missing one", () => {
    expect(resolveMigrationsDir({ MIGRATIONS_DIR: REAL_MIGRATIONS_DIR })).toBe(REAL_MIGRATIONS_DIR);
    expect(() => resolveMigrationsDir({ MIGRATIONS_DIR: join(REAL_MIGRATIONS_DIR, "nope") })).toThrow(
      MigrateConfigError,
    );
  });

  it("accepts owner connection strings and rejects the application role", () => {
    expect(() =>
      assertOwnerConnectionString("postgresql://iptv_owner:pw@postgres:5432/iptv"),
    ).not.toThrow();
    expect(() =>
      assertOwnerConnectionString("postgresql://iptv_app:pw@postgres:5432/iptv"),
    ).toThrow(MigrateConfigError);
    expect(() => assertOwnerConnectionString("not-a-url")).toThrow(MigrateConfigError);
  });

  it("never echoes the password in the rejection message", () => {
    try {
      assertOwnerConnectionString("postgresql://iptv_app:sup3r-s3cret@postgres:5432/iptv");
      expect.unreachable("expected MigrateConfigError");
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain("iptv_app");
      expect(message).not.toContain("sup3r-s3cret");
    }
  });

  it("requires DATABASE_URL before touching the database", async () => {
    await expect(runMigrationsCli({})).rejects.toBeInstanceOf(MigrateConfigError);
    await expect(runMigrationsCli({ DATABASE_URL: "  " })).rejects.toBeInstanceOf(MigrateConfigError);
    await expect(
      runMigrationsCli({ DATABASE_URL: "postgresql://iptv_app:pw@postgres:5432/iptv" }),
    ).rejects.toBeInstanceOf(MigrateConfigError);
  });

  it("fails closed when the resolved directory has no migrations", async () => {
    const empty = join(here, "..", "test", "fixtures");
    if (!existsSync(empty)) return; // fixture dir removed: nothing to assert
    await expect(
      runMigrationsCli({
        DATABASE_URL: "postgresql://iptv_owner:pw@postgres:5432/iptv",
        MIGRATIONS_DIR: empty,
      }),
    ).rejects.toBeInstanceOf(MigrateConfigError);
  });
});