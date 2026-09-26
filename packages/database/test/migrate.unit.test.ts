import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrationsWithClient,
  applyMigrationsWithClients,
  listMigrationFiles,
  migrationBody,
  sha256Hex,
  MIGRATION_ADVISORY_LOCK_KEY,
  type MigrationClient,
} from "../src/migrate.js";

/** In-memory fake satisfying MigrationClient; simulates the history table. */
class FakeClient implements MigrationClient {
  history = new Map<string, string>();
  executed: string[] = [];
  queries: string[] = [];
  inTransaction = false;
  failBodies = false;

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push(text);
    const t = text.trim();
    const upper = t.toUpperCase();
    if (upper.startsWith("SELECT PG_ADVISORY_LOCK") || upper.startsWith("SELECT PG_ADVISORY_UNLOCK")) {
      return { rows: [] };
    }
    if (upper === "BEGIN") {
      this.inTransaction = true;
      return { rows: [] };
    }
    if (upper === "COMMIT" || upper === "ROLLBACK") {
      this.inTransaction = false;
      return { rows: [] };
    }
    if (upper.startsWith("CREATE SCHEMA") || upper.startsWith("CREATE TABLE")) {
      return { rows: [] };
    }
    if (upper.startsWith("SELECT FILENAME")) {
      const rows = [...this.history.entries()].map(([filename, sha256]) => ({ filename, sha256 }));
      return { rows: rows as T[] };
    }
    if (upper.startsWith("INSERT INTO")) {
      const [filename, sha256] = params as [string, string];
      this.history.set(filename, sha256);
      return { rows: [] };
    }
    // Migration body SQL.
    if (this.failBodies) {
      throw new Error("boom: migration body failed");
    }
    this.executed.push(t);
    return { rows: [] };
  }

  lockIndex(): number {
    return this.queries.findIndex((q) => q.toUpperCase().includes("PG_ADVISORY_LOCK("));
  }

  unlockIndex(): number {
    return this.queries.findIndex((q) => q.toUpperCase().includes("PG_ADVISORY_UNLOCK("));
  }

  historyReadIndex(): number {
    return this.queries.findIndex((q) => q.toUpperCase().startsWith("SELECT FILENAME"));
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migrations-"));
  writeFileSync(join(dir, "002_b.sql"), "SELECT 2;");
  writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
  writeFileSync(join(dir, "notes.txt"), "ignored");
});

function cleanup(): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("listMigrationFiles", () => {
  it("lists only .sql files sorted by filename", () => {
    try {
      expect(listMigrationFiles(dir)).toEqual(["001_a.sql", "002_b.sql"]);
    } finally {
      cleanup();
    }
  });
});

describe("sha256Hex", () => {
  it("is stable and content-sensitive", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });
});

describe("applyMigrationsWithClient", () => {
  it("applies pending files in filename order", async () => {
    const client = new FakeClient();
    try {
      const res = await applyMigrationsWithClient(client, dir);
      expect(res.applied).toEqual(["001_a.sql", "002_b.sql"]);
      expect(res.skipped).toEqual([]);
      expect(client.executed).toEqual(["SELECT 1;", "SELECT 2;"]);
    } finally {
      cleanup();
    }
  });

  it("is idempotent on re-run", async () => {
    const client = new FakeClient();
    try {
      await applyMigrationsWithClient(client, dir);
      const second = await applyMigrationsWithClient(client, dir);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(["001_a.sql", "002_b.sql"]);
      expect(client.executed).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("fails fast on content mismatch for already-applied files", async () => {
    const client = new FakeClient();
    try {
      await applyMigrationsWithClient(client, dir);
      writeFileSync(join(dir, "001_a.sql"), "SELECT 999;");
      await expect(applyMigrationsWithClient(client, dir)).rejects.toThrow(
        /content mismatch.*001_a\.sql/,
      );
    } finally {
      cleanup();
    }
  });
});

describe("migrationBody", () => {
  it("strips the outer envelope allowing leading/trailing comments", () => {
    const sql = [
      "-- copyright header",
      "/* block comment */",
      "BEGIN;",
      "SELECT 1;",
      "COMMIT;",
      "-- trailing note",
      "/* done */",
      "",
    ].join("\n");
    expect(migrationBody(sql, "001_a.sql")).toBe("SELECT 1;");
  });

  it("rejects a nested BEGIN naming the file", () => {
    const sql = "BEGIN;\nSELECT 1;\nBEGIN;\nSELECT 2;\nCOMMIT;";
    expect(() => migrationBody(sql, "007_nested.sql")).toThrow(
      /007_nested\.sql.*transaction-control/i,
    );
  });

  it("rejects a stray COMMIT naming the file", () => {
    const sql = "SELECT 1;\nCOMMIT;";
    expect(() => migrationBody(sql, "003_stray.sql")).toThrow(
      /003_stray\.sql.*transaction-control/i,
    );
  });

  it("ignores tx keywords inside dollar-quoted bodies, comments and string literals", () => {
    const sql = [
      "BEGIN;",
      "CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$",
      "BEGIN",
      "    RAISE EXCEPTION 'oops';",
      "END;",
      "$$;",
      "-- COMMIT; is just a comment",
      "SELECT 'BEGIN';",
      "COMMIT;",
    ].join("\n");
    expect(migrationBody(sql, "001_platform.sql")).toContain("RAISE EXCEPTION");
  });
});

describe("advisory lock", () => {
  it("acquires the lock with the fixed key before reading history and releases on success", async () => {
    const lockClient = new FakeClient();
    const workClient = new FakeClient();
    try {
      const res = await applyMigrationsWithClients(lockClient, workClient, dir);
      expect(res.applied).toEqual(["001_a.sql", "002_b.sql"]);
      // Lock is the first statement on the dedicated client (hence before any
      // history read on the worker) and unlock is the last, on success.
      expect(lockClient.lockIndex()).toBe(0);
      expect(lockClient.queries[0]).toContain(String(MIGRATION_ADVISORY_LOCK_KEY));
      expect(workClient.historyReadIndex()).toBeGreaterThanOrEqual(0);
      expect(lockClient.unlockIndex()).toBe(lockClient.queries.length - 1);
      expect(lockClient.queries[lockClient.unlockIndex()]).toContain(
        String(MIGRATION_ADVISORY_LOCK_KEY),
      );
      // Worker never sees lock traffic; work actually ran.
      expect(workClient.executed).toEqual(["SELECT 1;", "SELECT 2;"]);
      expect(lockClient.executed).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("releases the lock when the run fails", async () => {
    const lockClient = new FakeClient();
    const workClient = new FakeClient();
    workClient.failBodies = true;
    try {
      await expect(applyMigrationsWithClients(lockClient, workClient, dir)).rejects.toThrow(
        /boom: migration body failed/,
      );
      expect(lockClient.lockIndex()).toBeGreaterThanOrEqual(0);
      expect(lockClient.unlockIndex()).toBeGreaterThan(lockClient.lockIndex());
    } finally {
      cleanup();
    }
  });
});
