import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/index.js";

describe("loadConfig", () => {
  it("returns defaults for an empty env", () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({ NODE_ENV: "development", PORT: 3001, LOG_LEVEL: "info" });
    expect(cfg.DATABASE_URL).toBeUndefined();
  });

  it("accepts valid overrides", () => {
    const cfg = loadConfig({
      NODE_ENV: "production",
      PORT: "8080",
      DATABASE_URL: "postgresql://iptv:iptv@localhost:5432/iptv",
      LOG_LEVEL: "warn",
      BETTER_AUTH_SECRET: "real-production-secret-0123456789",
    });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.NODE_ENV).toBe("production");
  });

  it("rejects the dev auth secret in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", BETTER_AUTH_SECRET: "dev-only-better-auth-secret-0123456789" }),
    ).toThrow(/BETTER_AUTH_SECRET must be overridden in production/);
  });

  it("throws descriptive errors on invalid env", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(/invalid environment configuration/);
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(/invalid environment configuration/);
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(/invalid environment configuration/);
  });
});
