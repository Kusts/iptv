import { describe, expect, it } from "vitest";
import { assertOutboxWorkerIdentity } from "../src/roleGuard.js";
import type { RoleQuery } from "../src/roleGuard.js";

interface GuardScenario {
  user?: string;
  sessionUser?: string;
  attrs?: Record<string, boolean>;
  memberships?: number;
  /** "table|PRIV" entry forced to true (every other check reads false). */
  tablePrivTrue?: string;
  /** Function signature forced to non-executable. */
  missingExec?: string;
}

function makeQuery(scenario: GuardScenario): RoleQuery {
  return async (sql: string, params?: unknown[]) => {
    if (sql.includes("current_user AS u")) {
      return {
        rows: [{ u: scenario.user ?? "outbox_worker", s: scenario.sessionUser ?? "outbox_worker" }],
      };
    }
    if (sql.includes("FROM pg_roles WHERE rolname = current_user")) {
      return {
        rows: [
          scenario.attrs ?? {
            rolcanlogin: true,
            rolsuper: false,
            rolbypassrls: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
          },
        ],
      };
    }
    if (sql.includes("pg_auth_members")) {
      return { rows: [{ n: scenario.memberships ?? 0 }] };
    }
    if (sql.includes("has_table_privilege")) {
      const match = sql.match(/has_table_privilege\('([^']+)', '([^']+)'\)/);
      const key = match !== null && match[1] !== undefined && match[2] !== undefined ? `${match[1]}|${match[2]}` : "";
      return { rows: [{ v: scenario.tablePrivTrue === key }] };
    }
    if (sql.includes("has_function_privilege")) {
      const fn = params !== undefined && params.length > 0 ? params[0] : null;
      return { rows: [{ v: fn !== scenario.missingExec }] };
    }
    throw new Error("unexpected role guard query");
  };
}

describe("role guard", () => {
  it("passes for the exact least-privilege posture", async () => {
    await expect(assertOutboxWorkerIdentity(makeQuery({}))).resolves.toEqual({ ok: true });
  });

  it("checks all fourteen table predicates and all four functions", async () => {
    let tables = 0;
    let functions = 0;
    const counting: RoleQuery = async (sql, params) => {
      if (sql.includes("has_table_privilege")) tables += 1;
      if (sql.includes("has_function_privilege")) functions += 1;
      return makeQuery({})(sql, params);
    };
    await assertOutboxWorkerIdentity(counting);
    expect(tables).toBe(14);
    expect(functions).toBe(4);
  });

  it("refuses a foreign session identity", async () => {
    await expect(assertOutboxWorkerIdentity(makeQuery({ user: "iptv_app" }))).rejects.toThrow(
      /session identity/,
    );
  });

  it("refuses a mismatched session_user", async () => {
    await expect(
      assertOutboxWorkerIdentity(makeQuery({ sessionUser: "postgres" })),
    ).rejects.toThrow(/session identity/);
  });

  it("refuses elevated role attributes", async () => {
    await expect(
      assertOutboxWorkerIdentity(
        makeQuery({
          attrs: {
            rolcanlogin: true,
            rolsuper: true,
            rolbypassrls: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
          },
        }),
      ),
    ).rejects.toThrow(/role attributes/);
  });

  it("refuses a non-login worker role", async () => {
    await expect(
      assertOutboxWorkerIdentity(
        makeQuery({
          attrs: {
            rolcanlogin: false,
            rolsuper: false,
            rolbypassrls: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
          },
        }),
      ),
    ).rejects.toThrow(/role attributes/);
  });

  it("refuses any role membership", async () => {
    await expect(assertOutboxWorkerIdentity(makeQuery({ memberships: 1 }))).rejects.toThrow(
      /memberships/,
    );
  });

  it("refuses any direct table privilege", async () => {
    await expect(
      assertOutboxWorkerIdentity(
        makeQuery({ tablePrivTrue: "platform.outbox_messages|SELECT" }),
      ),
    ).rejects.toThrow(/direct table privilege/);
    await expect(
      assertOutboxWorkerIdentity(
        makeQuery({ tablePrivTrue: "platform.outbox_transitions|INSERT" }),
      ),
    ).rejects.toThrow(/direct table privilege/);
    await expect(
      assertOutboxWorkerIdentity(
        makeQuery({ tablePrivTrue: "platform.outbox_transitions|TRUNCATE" }),
      ),
    ).rejects.toThrow(/direct table privilege/);
  });

  it("refuses a missing execute grant on any lifecycle function", async () => {
    await expect(
      assertOutboxWorkerIdentity(
        makeQuery({ missingExec: "platform.outbox_complete(uuid,uuid)" }),
      ),
    ).rejects.toThrow(/lifecycle function/);
  });
});
