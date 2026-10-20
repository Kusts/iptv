import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { createAuth } from "../src/auth.js";
import { hashPassword } from "../src/passwords.js";

const SECRET = "test-only-session-ttl-secret-0123456789";

/**
 * Minimal chainable Kysely stub: every builder method returns the chain and
 * the terminal methods resolve preset values. Enough for the login (session
 * insert) and resolveSession (session read) paths — nothing else is touched.
 */
interface StubChain {
  selectFrom(...args: unknown[]): StubChain;
  innerJoin(...args: unknown[]): StubChain;
  leftJoin(...args: unknown[]): StubChain;
  select(...args: unknown[]): StubChain;
  where(...args: unknown[]): StubChain;
  set(...args: unknown[]): StubChain;
  values(...args: unknown[]): StubChain;
  returning(...args: unknown[]): StubChain;
  insertInto(...args: unknown[]): StubChain;
  updateTable(...args: unknown[]): StubChain;
  executeTakeFirst(): Promise<unknown>;
  executeTakeFirstOrThrow(): Promise<unknown>;
  execute(...args: unknown[]): Promise<unknown>;
}

function stubChain(opts: {
  takeFirst?: unknown;
  takeFirstOrThrow?: unknown;
  onValues?: (values: Record<string, unknown>) => void;
  executor?: unknown;
}): StubChain {
  const eat = (...args: unknown[]): StubChain => {
    void args;
    return c;
  };
  const c: StubChain = {
    selectFrom: eat,
    innerJoin: eat,
    leftJoin: eat,
    select: eat,
    where: eat,
    set: eat,
    values: (...args: unknown[]) => {
      // Only the session `insertInto(...).values(row)` call carries an
      // `onValues` hook, so this fires exactly once per login with the row
      // (including `expires_at`) the production code would persist.
      if (args[0] !== undefined && opts.onValues !== undefined) {
        opts.onValues(args[0] as Record<string, unknown>);
      }
      return c;
    },
    returning: eat,
    insertInto: eat,
    updateTable: eat,
    executeTakeFirst: async () => opts.takeFirst,
    executeTakeFirstOrThrow: async () => opts.takeFirstOrThrow,
    execute: async (...args: unknown[]) => {
      // `db.transaction().execute(cb)` runs the callback with the stub trx;
      // every other terminal `execute(...)` resolves `undefined` (update path).
      if (typeof args[0] === "function") {
        return (args[0] as (trx: unknown) => unknown)(opts.executor);
      }
      return undefined;
    },
  };
  return c;
}

/** Login-path db stub: valid ACTIVE credential + session insert capturing `expires_at`. */
function loginDb(captured: { expiresAt?: Date }, passwordHash: string): Kysely<Database> {
  const trx = {
    insertInto: (...args: unknown[]) => {
      void args;
      return stubChain({
        takeFirstOrThrow: { id: "session-id-1" },
        onValues: (values) => {
          captured.expiresAt = values["expires_at"] as Date;
        },
      });
    },
    updateTable: (...args: unknown[]) => {
      void args;
      return stubChain({});
    },
    // Kysely `sql` builders resolve the executor via `getExecutor()` and run
    // transform/compile/execute through it: return zero membership rows here.
    getExecutor: (...args: unknown[]) => {
      void args;
      return {
        transformQuery: (node: unknown) => node,
        compileQuery: (...inner: unknown[]) => {
          void inner;
          return {};
        },
        executeQuery: async (...inner: unknown[]) => {
          void inner;
          return { rows: [] };
        },
      };
    },
  };
  return {
    selectFrom: (...args: unknown[]) => {
      void args;
      return stubChain({
        takeFirst: {
          password_hash: passwordHash,
          user_id: "user-1",
          display_name: "User",
          status: "ACTIVE",
          is_platform_admin: false,
        },
      });
    },
    transaction: (...args: unknown[]) => {
      void args;
      return stubChain({ executor: trx });
    },
  } as unknown as Kysely<Database>;
}

/** resolveSession-path db stub: one preset session row, empty memberships. */
function sessionRowDb(row: Record<string, unknown>): Kysely<Database> {
  return {
    selectFrom: (...args: unknown[]) => {
      void args;
      return stubChain({ takeFirst: row });
    },
    // Kysely `sql` builders resolve the executor via `getExecutor()`.
    getExecutor: (...args: unknown[]) => {
      void args;
      return {
        transformQuery: (node: unknown) => node,
        compileQuery: (...inner: unknown[]) => {
          void inner;
          return {};
        },
        executeQuery: async (...inner: unknown[]) => {
          void inner;
          return { rows: [] };
        },
      };
    },
  } as unknown as Kysely<Database>;
}

describe("createAuth session TTL", () => {
  it("issues a short-lived session when sessionTtlHours is tiny (expiry honored)", async () => {
    const passwordHash = await hashPassword("correct-horse-8");
    const captured: { expiresAt?: Date } = {};
    const auth = createAuth(loginDb(captured, passwordHash), {
      secret: SECRET,
      sessionTtlHours: 2 / 3600,
    });
    const before = Date.now();
    const result = await auth.login({ email: "user@example.com", password: "correct-horse-8" });
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.expiresAt).toBeInstanceOf(Date);
    const ttlMs = (captured.expiresAt as Date).getTime() - before;
    // ~2 seconds: proves a short TTL actually shortens the session lifetime.
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThan(60_000);
  });

  it("keeps the 168h default when sessionTtlHours is unset", async () => {
    const passwordHash = await hashPassword("correct-horse-8");
    const captured: { expiresAt?: Date } = {};
    const auth = createAuth(loginDb(captured, passwordHash), { secret: SECRET });
    const before = Date.now();
    await auth.login({ email: "user@example.com", password: "correct-horse-8" });
    const ttlMs = (captured.expiresAt as Date).getTime() - before;
    expect(ttlMs).toBeGreaterThan(167 * 3600_000);
    expect(ttlMs).toBeLessThan(169 * 3600_000);
  });

  it("resolves an expired session to null", async () => {
    const auth = createAuth(
      sessionRowDb({
        session_id: "session-id-3",
        active_tenant_id: null,
        tenant_context_revision: "0",
        expires_at: new Date(Date.now() - 1000),
        user_id: "user-3",
        display_name: "User",
        status: "ACTIVE",
        is_platform_admin: false,
        email: "user@example.com",
      }),
      { secret: SECRET, sessionTtlHours: 1 },
    );
    await expect(auth.resolveSession({ token: "any-token" })).resolves.toBeNull();
  });

  it("resolves a fresh session with its expiry", async () => {
    const expiresAt = new Date(Date.now() + 3600_000);
    const auth = createAuth(
      sessionRowDb({
        session_id: "session-id-4",
        active_tenant_id: null,
        tenant_context_revision: "0",
        expires_at: expiresAt,
        user_id: "user-4",
        display_name: "User",
        status: "ACTIVE",
        is_platform_admin: false,
        email: "user@example.com",
      }),
      { secret: SECRET },
    );
    const session = await auth.resolveSession({ token: "any-token" });
    expect(session?.sessionId).toBe("session-id-4");
    expect(session?.expiresAt).toEqual(expiresAt);
    expect(session?.tenantContextRevision).toBe("0");
  });
});
