import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export const MIGRATION_HISTORY_TABLE = "platform.migration_history";

/**
 * Fixed session-level advisory-lock key serializing migration-runner runs.
 * One arbitrary 64-bit key for the whole runner; concurrent runs on separate
 * connections block on `pg_advisory_lock` until the holder unlocks.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 7271645001;

function advisoryLockSql(): string {
  return `SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
}

function advisoryUnlockSql(): string {
  return `SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`;
}

export interface ApplyMigrationsOptions {
  migrationsDir: string;
}

export interface MigrationRecord {
  filename: string;
  sha256: string;
}

/** Minimal query surface the runner needs; real `pg` clients satisfy it. */
export interface MigrationClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** List `*.sql` migration files in a directory, sorted by filename. */
export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** SHA-256 hex of file content (utf-8). */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function readMigration(migrationsDir: string, filename: string): MigrationRecord & { sql: string } {
  const sql = readFileSync(join(migrationsDir, filename), "utf8");
  return { filename, sha256: sha256Hex(sql), sql };
}

/**
 * Strip exactly one outer `BEGIN;` … `COMMIT;` envelope so the file body can
 * run inside the runner's own transaction (which also covers the bookkeeping
 * INSERT atomically). Leading comments/whitespace before the first `BEGIN;`
 * and trailing comments/whitespace after the final `COMMIT;` are allowed.
 * Canonical files on disk are never modified.
 *
 * After stripping, the body must not contain any other transaction-control
 * statement (checked line-by-line); violations throw naming the file.
 *
 * Limitation: the residual scan is line-based and only skips `--` line
 * comments, block comments, single-quoted literals and dollar-quoted
 * (`$tag$…$tag$`) string bodies. Exotic quoting (e.g. a dollar-quote tag
 * inside a comment, or a `BEGIN` keyword split across lines) is not handled.
 */
export function migrationBody(sql: string, filename = "migration"): string {
  const body = stripEnvelope(sql);
  assertNoTxControlStatements(body, filename);
  return body;
}

/** Match one trivia chunk: whitespace, `--` line comment, or block comment. */
const TRIVIA_CHUNK = String.raw`(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)`;

/** Strip one leading `BEGIN;` (after trivia) and one trailing `COMMIT;` (before trivia). */
function stripEnvelope(sql: string): string {
  const leadingMatch = new RegExp(`^${TRIVIA_CHUNK}*(BEGIN\\s*;)`, "i").exec(sql);
  if (!leadingMatch || leadingMatch[1] === undefined) {
    return sql.trim();
  }
  const afterBegin = sql.slice(leadingMatch[0].length);
  const trailingMatch = new RegExp(`(COMMIT\\s*;)${TRIVIA_CHUNK}*$`, "i").exec(afterBegin);
  if (!trailingMatch || trailingMatch[1] === undefined) {
    return afterBegin.trim();
  }
  return afterBegin.slice(0, trailingMatch.index).trim();
}

const TX_CONTROL_RE = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;
const DOLLAR_TAG_RE = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/;

/**
 * Reject bodies containing residual transaction-control statements.
 * Line-based: skips lines inside dollar-quoted blocks and, on code lines,
 * strips `--` comments and `'...'` literals before matching.
 */
function assertNoTxControlStatements(body: string, filename: string): void {
  let dollarTag: string | null = null;
  for (const rawLine of body.split("\n")) {
    let line = rawLine;
    if (dollarTag !== null) {
      const close = line.indexOf(dollarTag);
      if (close === -1) continue;
      line = line.slice(close + dollarTag.length);
      dollarTag = null;
    }
    let code = "";
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === "-" && line[i + 1] === "-") break; // line comment: rest is trivia
      if (ch === "'") {
        // Skip single-quoted literal ('' = escaped quote); unterminated → rest of line.
        let j = i + 1;
        let done = false;
        while (j < line.length) {
          if (line[j] === "'") {
            if (line[j + 1] === "'") {
              j += 2;
              continue;
            }
            j += 1;
            done = true;
            break;
          }
          j += 1;
        }
        i = j;
        if (!done) break;
        continue;
      }
      if (ch === "$") {
        const tagMatch = DOLLAR_TAG_RE.exec(line.slice(i));
        if (tagMatch && tagMatch.index === 0) {
          const tag = tagMatch[0];
          const closeIdx = line.indexOf(tag, i + tag.length);
          if (closeIdx === -1) {
            dollarTag = tag; // multi-line dollar-quoted body starts here
            break;
          }
          i = closeIdx + tag.length;
          continue;
        }
      }
      code += ch;
      i += 1;
    }
    if (dollarTag !== null) continue;
    // Strip block comments that survived on this code line before matching.
    const uncommented = code.replace(/\/\*[\s\S]*?\*\//g, "");
    if (TX_CONTROL_RE.test(uncommented)) {
      throw new Error(
        `migration ${filename} contains a transaction-control statement outside the single outer BEGIN;/COMMIT; envelope: ` +
          `${JSON.stringify(rawLine.trim())} (only one outer BEGIN; … COMMIT; pair is allowed)`,
      );
    }
  }
}

export async function ensureHistoryTable(client: MigrationClient): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS platform`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_HISTORY_TABLE} (` +
      `filename text PRIMARY KEY, ` +
      `sha256 text NOT NULL, ` +
      `applied_at timestamptz NOT NULL DEFAULT now())`,
  );
}

export async function loadApplied(client: MigrationClient): Promise<Map<string, string>> {
  const res = await client.query<{ filename: string; sha256: string }>(
    `SELECT filename, sha256 FROM ${MIGRATION_HISTORY_TABLE}`,
  );
  return new Map(res.rows.map((r) => [r.filename, r.sha256]));
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
}

/**
 * Core runner over an injected client (unit-testable without a database).
 * Idempotent: already-applied files are skipped; fails fast when an
 * already-applied file's content hash changed.
 */
export async function applyMigrationsWithClient(
  client: MigrationClient,
  migrationsDir: string,
): Promise<ApplyResult> {
  return applyMigrationsWithClients(client, client, migrationsDir);
}

/**
 * Runner with a dedicated lock connection: acquires a session-level
 * PostgreSQL advisory lock on `lockClient` before reading
 * migration_history and holds it until the whole run finishes (released in
 * `finally`, on success and on failure). Per-file migrations run inside
 * their own transactions on `workClient`. In production the two clients are
 * separate pooled connections, so the lock survives per-file
 * BEGIN/COMMIT boundaries and serializes concurrent runner processes.
 */
export async function applyMigrationsWithClients(
  lockClient: MigrationClient,
  workClient: MigrationClient,
  migrationsDir: string,
): Promise<ApplyResult> {
  await lockClient.query(advisoryLockSql());
  try {
    return await runMigrations(workClient, migrationsDir);
  } finally {
    await lockClient.query(advisoryUnlockSql());
  }
}

async function runMigrations(client: MigrationClient, migrationsDir: string): Promise<ApplyResult> {
  await ensureHistoryTable(client);
  const applied = await loadApplied(client);
  const result: ApplyResult = { applied: [], skipped: [] };

  for (const filename of listMigrationFiles(migrationsDir)) {
    const { sha256, sql } = readMigration(migrationsDir, filename);
    const known = applied.get(filename);
    if (known !== undefined) {
      if (known !== sha256) {
        throw new Error(
          `migration content mismatch for already-applied file ${filename}: ` +
            `expected sha256 ${known}, found ${sha256}`,
        );
      }
      result.skipped.push(filename);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(migrationBody(sql, filename));
      await client.query(
        `INSERT INTO ${MIGRATION_HISTORY_TABLE} (filename, sha256) VALUES ($1, $2)`,
        [filename, sha256],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    result.applied.push(filename);
  }
  return result;
}

/**
 * Apply all pending `*.sql` migrations from `migrationsDir`, sorted by
 * filename. Records each applied file (filename + sha256) in
 * `platform.migration_history`. Re-running is a no-op for applied files.
 *
 * Holds a dedicated pooled connection for the session-level advisory lock
 * for the whole run; per-file work uses a second pooled connection.
 */
export async function applyMigrations(
  connectionString: string,
  options: ApplyMigrationsOptions,
): Promise<ApplyResult> {
  const pool = new Pool({ connectionString });
  const lockPgClient = await pool.connect();
  try {
    const workPgClient = await pool.connect();
    try {
      const adapt = (c: typeof lockPgClient): MigrationClient => ({
        query: (text, params) =>
          c.query(text, params as never[]).then((res) => ({ rows: res.rows })),
      });
      return await applyMigrationsWithClients(
        adapt(lockPgClient),
        adapt(workPgClient),
        options.migrationsDir,
      );
    } finally {
      workPgClient.release();
    }
  } finally {
    lockPgClient.release();
    await pool.end();
  }
}
