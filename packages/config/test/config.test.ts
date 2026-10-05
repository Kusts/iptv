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
      PROVIDER_DISPATCH_MODE: "durable",
    });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.NODE_ENV).toBe("production");
  });

  it("rejects the dev auth secret in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "dev-only-better-auth-secret-0123456789",
        PROVIDER_DISPATCH_MODE: "durable",
      }),
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
      PROVIDER_DISPATCH_MODE: "durable",
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

/**
 * CV-DSP-01 production fail-fast: the leased durable dispatcher is the only
 * certified executor for real provider writes, so a production boot must set
 * `PROVIDER_DISPATCH_MODE=durable` explicitly instead of relying on the
 * historical inline fallback. Outside production nothing changes — the
 * resolver still falls back to inline for unset/empty/typo values.
 */
describe("loadConfig PROVIDER_DISPATCH_MODE", () => {
  const productionBase = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "real-production-secret-0123456789",
  } satisfies NodeJS.ProcessEnv;

  function withDispatchMode(raw: string | undefined): NodeJS.ProcessEnv {
    return raw === undefined ? { ...productionBase } : { ...productionBase, PROVIDER_DISPATCH_MODE: raw };
  }

  it("accepts an exact durable mode in production", () => {
    expect(() => loadConfig(withDispatchMode("durable"))).not.toThrow();
    expect(loadConfig(withDispatchMode("durable")).NODE_ENV).toBe("production");
  });

  it("rejects every non-durable value in production, naming the variable", () => {
    for (const bad of [
      undefined, // unset
      "", // empty is ABSENT per the repo rule, never a match
      "   ", // whitespace-only placeholder
      "inline",
      "DURABLE", // uppercase
      "Durable",
      " durable", // padded
      "durable ",
      "durable\n",
      "duarble", // typo
      "true",
    ]) {
      expect(() => loadConfig(withDispatchMode(bad)), `PROVIDER_DISPATCH_MODE=${JSON.stringify(bad)}`).toThrow(
        /invalid environment configuration: PROVIDER_DISPATCH_MODE must be exactly "durable"/,
      );
    }
  });

  it("reports an unset dispatch mode as unset in the production error", () => {
    expect(() => loadConfig(withDispatchMode(undefined))).toThrow(/received unset/);
    expect(() => loadConfig(withDispatchMode(""))).toThrow(/received unset/);
    expect(() => loadConfig(withDispatchMode("DURABLE"))).toThrow(/received "DURABLE"/);
  });

  it("keeps unset/empty/invalid dispatch modes accepted outside production", () => {
    for (const nodeEnv of ["development", "test"] as const) {
      for (const raw of [undefined, "", "   ", "inline", "DURABLE", " durable ", "duarble"]) {
        const env = raw === undefined ? { NODE_ENV: nodeEnv } : { NODE_ENV: nodeEnv, PROVIDER_DISPATCH_MODE: raw };
        expect(() => loadConfig(env), `${nodeEnv} with ${JSON.stringify(raw)}`).not.toThrow();
      }
    }
    expect(loadConfig({}).NODE_ENV).toBe("development");
  });
});
