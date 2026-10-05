import { describe, expect, it } from "vitest";
import { HttpException } from "@nestjs/common";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Driver,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import type { Database } from "@iptv/database";
import { HealthController, READINESS_PROBE_TIMEOUT_MS } from "../src/health.controller.js";

/**
 * Readiness probe paths that must not touch a real database. A real `Kysely`
 * instance is built over a fake driver (the documented unit-test seam), so the
 * controller runs its genuine `sql\`select 1\`` compile + execute path — a
 * structural object double cannot: `compile` needs the dialect internals.
 */
function kyselyWithExecute(executeQuery: () => Promise<QueryResult<unknown>>): Kysely<Database> {
  const connection: DatabaseConnection = {
    executeQuery: async <R>() => executeQuery() as Promise<QueryResult<R>>,
    streamQuery: async function* () {
      // No streaming in the readiness probe.
    },
  };
  const driver: Driver = {
    init: async () => {},
    // `acquireConnection` hands back the DriverConnection itself (same shape
    // as Kysely's own DummyDriver), not a `{ connection }` wrapper.
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

describe("GET /v1/health/ready (unit)", () => {
  it("returns 200 {status:ok, checks:{database:ok}} when SELECT 1 answers", async () => {
    const controller = new HealthController(
      null,
      kyselyWithExecute(() => Promise.resolve({ rows: [{ "?column?": 1 }] })),
    );
    await expect(controller.ready()).resolves.toEqual({ status: "ok", checks: { database: "ok" } });
  });

  it("returns 503 with a fixed reason when the database rejects", async () => {
    const controller = new HealthController(
      null,
      kyselyWithExecute(() =>
        Promise.reject(new Error("connect ECONNREFUSED 10.0.0.9:5432 password=hunter2")),
      ),
    );
    const err = await controller.ready().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    const exception = err as HttpException;
    expect(exception.getStatus()).toBe(503);
    // Fixed vocabulary: no driver message, no connection detail, no password.
    expect(exception.getResponse()).toEqual({ status: "unavailable", checks: { database: "error" } });
  });

  it("gives up after the probe budget when the database never answers", async () => {
    const controller = new HealthController(null, kyselyWithExecute(() => new Promise(() => {})));
    const startedAt = Date.now();
    const err = await controller.ready().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getResponse()).toEqual({
      status: "unavailable",
      checks: { database: "error" },
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(READINESS_PROBE_TIMEOUT_MS - 50);
  }, READINESS_PROBE_TIMEOUT_MS + 5000);

  it("treats an unconfigured database (null DB) as not ready", async () => {
    for (const controller of [new HealthController(null, null), new HealthController(null, undefined)]) {
      const err = await controller.ready().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getResponse()).toEqual({
        status: "unavailable",
        checks: { database: "error" },
      });
    }
  });
});