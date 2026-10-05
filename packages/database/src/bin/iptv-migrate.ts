#!/usr/bin/env node
/**
 * CLI entry — `iptv-migrate` (dedicated migration job).
 *
 * The one sanctioned way to apply `db/migrations/*.sql`: a one-shot job that
 * runs BEFORE the API starts (the `migrate` service in
 * `deploy/staging/docker-compose.staging.yml`). The API NEVER migrates on
 * boot, so a broken migration blocks the rollout instead of racing it, and
 * the operator gets an explicit exit code to act on.
 *
 * Connection contract: `DATABASE_URL` ONLY, and it must be the schema OWNER.
 * The application role `iptv_app` (`NOBYPASSRLS`, no DDL grants) is rejected
 * before any connection is opened, and this CLI never reads
 * `APP_DATABASE_URL`. Owner traffic is always direct, never pooled — see
 * `docs/10-operations/runbooks/rls-role-split-cutover.md` and
 * `docs/10-operations/runbooks/migration-failure.md`.
 *
 * Env:
 *   `DATABASE_URL`   required — owner connection string (never logged)
 *   `MIGRATIONS_DIR` optional  — defaults to the repository `db/migrations`
 *
 * Exit codes: `0` applied/no-op, `1` invalid configuration or runner
 * failure (a `restart: "no"` job must therefore fail the deploy).
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, listMigrationFiles } from "../migrate.js";

/**
 * Roles that hold no DDL grants. Migrations run as the schema owner; naming
 * the app role explicitly keeps a copy/pasted `APP_DATABASE_URL` from
 * silently failing half-way through the run.
 */
const NON_OWNER_ROLES = new Set(["iptv_app"]);

/**
 * Invalid-configuration failure: no connection was opened, nothing applied.
 * Messages are unprefixed; the CLI owns the `iptv-migrate:` log prefix.
 */
export class MigrateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrateConfigError";
  }
}

/** `<pkg>/src/bin` in dev, `<pkg>/dist/bin` after build — same depth. */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the migrations directory: explicit `MIGRATIONS_DIR` first, then the
 * repository copy relative to this file, then the working directory. Fails
 * closed — a wrong path must never look like "0 migrations, all good".
 */
export function resolveMigrationsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["MIGRATIONS_DIR"];
  if (override !== undefined && override.trim().length > 0) {
    const dir = resolve(override.trim());
    if (!existsSync(dir)) {
      throw new MigrateConfigError(`MIGRATIONS_DIR does not exist: ${dir}`);
    }
    return dir;
  }
  const candidates = [
    join(here, "..", "..", "..", "..", "db", "migrations"),
    join(process.cwd(), "db", "migrations"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new MigrateConfigError(
    `migrations directory not found; set MIGRATIONS_DIR (looked in ${candidates.join(", ")})`,
  );
}

/**
 * Reject a non-owner connection string before connecting. Only the role name
 * is echoed — never the connection string (it carries the owner password).
 */
export function assertOwnerConnectionString(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new MigrateConfigError("DATABASE_URL is not a valid connection string");
  }
  let username: string;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    username = url.username;
  }
  if (NON_OWNER_ROLES.has(username.toLowerCase())) {
    throw new MigrateConfigError(
      `refusing to migrate as application role ${JSON.stringify(username)}: ` +
        "migrations require the schema owner in DATABASE_URL",
    );
  }
}

/**
 * Apply every pending migration from the resolved directory. Returns the
 * process exit code; throws only for invalid configuration (runner failures
 * propagate so `main` can report them).
 */
export async function runMigrationsCli(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const raw = env["DATABASE_URL"];
  if (raw === undefined || raw.trim().length === 0) {
    throw new MigrateConfigError("DATABASE_URL is required (schema owner connection string)");
  }
  const connectionString = raw.trim();
  assertOwnerConnectionString(connectionString);

  const migrationsDir = resolveMigrationsDir(env);
  const total = listMigrationFiles(migrationsDir).length;
  if (total === 0) {
    // Fail closed: an empty directory would otherwise report success having
    // applied nothing, leaving the API on an older schema than the code.
    throw new MigrateConfigError(`no *.sql migrations found in ${migrationsDir}`);
  }

  const result = await applyMigrations(connectionString, { migrationsDir });
  process.stdout.write(
    `iptv-migrate: applied=${result.applied.length} skipped=${result.skipped.length} ` +
      `total=${total} dir=${migrationsDir}\n`,
  );
  return 0;
}

async function main(): Promise<void> {
  try {
    await runMigrationsCli();
  } catch (err) {
    // Fixed prefix + the error message only. Connection strings, passwords
    // and resolved secret values are never printed.
    const reason = err instanceof Error ? err.message : "unknown error";
    process.stderr.write(`iptv-migrate: FAILED ${reason}\n`);
    process.exitCode = 1;
  }
}

// Only auto-run as a CLI entry point (importable without side effects).
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("iptv-migrate.js") || process.argv[1].endsWith("iptv-migrate.ts"));
if (invokedDirectly) {
  void main();
}