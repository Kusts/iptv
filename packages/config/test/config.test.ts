import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_CORS_ORIGIN, loadConfig } from "../src/index.js";

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

  it("defaults CORS to the local web origin outside production", () => {
    expect(loadConfig({}).CORS_ALLOWED_ORIGINS).toEqual([DEFAULT_LOCAL_CORS_ORIGIN]);
    expect(DEFAULT_LOCAL_CORS_ORIGIN).toBe("http://localhost:3000");
    expect(loadConfig({ NODE_ENV: "development" }).CORS_ALLOWED_ORIGINS).toEqual([
      "http://localhost:3000",
    ]);
    expect(loadConfig({ NODE_ENV: "test" }).CORS_ALLOWED_ORIGINS).toEqual([
      "http://localhost:3000",
    ]);
  });

  it("denies all cross-origin requests in production with no configured origin", () => {
    const cfg = loadConfig({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "real-production-secret-0123456789",
    });
    expect(cfg.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it("parses comma-separated exact origins, trimming and deduping", () => {
    const cfg = loadConfig({
      CORS_ALLOWED_ORIGINS: " http://localhost:3000, https://app.example.com ,http://localhost:3000",
    });
    expect(cfg.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:3000", "https://app.example.com"]);
  });

  it("rejects wildcard and invalid CORS origins", () => {
    for (const bad of [
      "*",
      "https://*.example.com",
      "https://app.example.com/*",
      "app.example.com",
      "https://app.example.com/app",
      "https://app.example.com?x=1",
      "https://app.example.com#frag",
      "ftp://app.example.com",
      "not-a-url",
    ]) {
      expect(() => loadConfig({ CORS_ALLOWED_ORIGINS: bad })).toThrow(
        /CORS_ALLOWED_ORIGINS contains invalid origin/,
      );
    }
  });

  it("leaves the disposable trial account undesignated by default", () => {
    expect(loadConfig({}).PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID).toBeUndefined();
    expect(loadConfig({ PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: "" }).PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID).toBeUndefined();
  });

  it("accepts a uuid disposable trial account and rejects anything else", () => {
    const id = "a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9";
    expect(loadConfig({ PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: id }).PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID).toBe(id);
    expect(() => loadConfig({ PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: "not-a-uuid" })).toThrow(
      /invalid environment configuration/,
    );
  });
});
