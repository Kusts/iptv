import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, isValidRequestId, registerRequestIdHook } from "../src/request-id.js";
import { registerObservabilityHook } from "../src/observability-hook.js";

describe("GET /v1/health", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    registerObservabilityHook(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 {status, version, requestId} with x-request-id header equal to the body", async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/v1/health",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; version: string; requestId: string; scheduler: string; tickSeconds: number }>();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(isValidRequestId(body.requestId)).toBe(true);
    expect(res.headers["x-request-id"]).toBe(body.requestId);
    // W1-08/W1-12: scheduler surface (disabled without env) + trace header.
    expect(body.scheduler).toBe("disabled");
    expect(body.tickSeconds).toBe(60);
    expect(res.headers["x-trace-id"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("reuses a valid inbound x-request-id", async () => {
    const inbound = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const res = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/v1/health",
      headers: { "x-request-id": inbound },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; version: string; requestId: string }>();
    expect(body.requestId).toBe(inbound);
    expect(res.headers["x-request-id"]).toBe(inbound);
  });

  it("ignores an invalid inbound x-request-id and generates one", async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/v1/health",
      headers: { "x-request-id": "not-a-uuid" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; version: string; requestId: string }>();
    expect(body.requestId).not.toBe("not-a-uuid");
    expect(isValidRequestId(body.requestId)).toBe(true);
    expect(res.headers["x-request-id"]).toBe(body.requestId);
  });
});
