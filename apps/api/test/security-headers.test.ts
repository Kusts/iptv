import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { registerObservabilityHook } from "../src/observability-hook.js";
import {
  API_HSTS_VALUE,
  API_NOSNIFF_VALUE,
  API_REFERRER_POLICY_VALUE,
  registerApiSecurityHeaders,
} from "../src/security-headers.js";

/**
 * Regressão SEC44 (api-only): `GET /v1/health` emite exatamente os 3 headers
 * de segurança da fatia, sem CSP geral. Mesmo registrador que `main.ts` usa.
 */
describe("API security headers (SEC44, api-only)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    registerObservabilityHook(app);
    registerApiSecurityHeaders(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("emits HSTS + nosniff + Referrer-Policy with exact values on GET /v1/health", async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/v1/health",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["strict-transport-security"]).toBe(API_HSTS_VALUE);
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
    expect(res.headers["x-content-type-options"]).toBe(API_NOSNIFF_VALUE);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe(API_REFERRER_POLICY_VALUE);
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("does not impose a general CSP on the API in this slice", async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/v1/health",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });
});
