import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { applyMigrations } from "@iptv/database";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { registerObservabilityHook } from "../src/observability-hook.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

/**
 * Readiness over a real PostgreSQL pool — the path the container healthcheck
 * and any load-balancer gate actually exercises. The probe is a bare
 * `SELECT 1`, so it must answer 200 as soon as the pool can connect, with or
 * without migrations applied (the schema is not part of the check).
 */
describe.skipIf(!hasDb)("GET /v1/health/ready (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    registerObservabilityHook(app);
    await app.init();
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 {status:ok, checks:{database:ok}} with the request id header", async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/v1/health/ready",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { database: "ok" } });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("stays public/unauthenticated (no auth header sent) and does not change liveness", async () => {
    const ready = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/health/ready" });
    const live = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/health" });
    expect(ready.statusCode).toBe(200);
    expect(live.statusCode).toBe(200);
    expect(live.json<{ status: string }>().status).toBe("ok");
  });
});