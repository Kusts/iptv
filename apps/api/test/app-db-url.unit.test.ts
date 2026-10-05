import { describe, expect, it, vi } from "vitest";
import { ownerFallbackWarning, resolveAppConnectionString, warnOnOwnerFallback } from "../src/app.module.js";

const OWNER = "postgresql://iptv:iptv@localhost:5432/iptv";
const APP = "postgresql://iptv_app:secret@localhost:5432/iptv";
const TEST = "postgresql://iptv:iptv@localhost:5432/iptv_test";

describe("resolveAppConnectionString (RLS cutover)", () => {
  it("prefers APP_DATABASE_URL when set", () => {
    expect(
      resolveAppConnectionString({
        APP_DATABASE_URL: APP,
        DATABASE_URL: OWNER,
        TEST_DATABASE_URL: TEST,
      } as NodeJS.ProcessEnv),
    ).toBe(APP);
  });

  it("falls back to DATABASE_URL when APP_DATABASE_URL is unset", () => {
    expect(
      resolveAppConnectionString({
        DATABASE_URL: OWNER,
        TEST_DATABASE_URL: TEST,
      } as NodeJS.ProcessEnv),
    ).toBe(OWNER);
  });

  it("treats an empty APP_DATABASE_URL as unset", () => {
    expect(
      resolveAppConnectionString({
        APP_DATABASE_URL: "",
        DATABASE_URL: OWNER,
      } as NodeJS.ProcessEnv),
    ).toBe(OWNER);
  });

  it("falls back to TEST_DATABASE_URL when neither APP nor DATABASE is set", () => {
    expect(
      resolveAppConnectionString({ TEST_DATABASE_URL: TEST } as NodeJS.ProcessEnv),
    ).toBe(TEST);
  });

  it("returns null when no connection string is set", () => {
    expect(resolveAppConnectionString({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("owner fallback warning (RLS cutover not applied)", () => {
  it("warns in production when APP_DATABASE_URL is unset (RLS is bypassed)", () => {
    const message = ownerFallbackWarning({
      NODE_ENV: "production",
      DATABASE_URL: OWNER,
    } as NodeJS.ProcessEnv);
    expect(message).not.toBeNull();
    expect(message).toMatch(/RLS BYPASSED/);
    expect(message).toMatch(/APP_DATABASE_URL/);
    // Never a boot failure: the message is a warning, not a thrown error.
    expect(() => ownerFallbackWarning({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("treats an empty APP_DATABASE_URL as unset in production", () => {
    expect(
      ownerFallbackWarning({
        NODE_ENV: "production",
        APP_DATABASE_URL: "",
        DATABASE_URL: OWNER,
      } as NodeJS.ProcessEnv),
    ).toMatch(/RLS BYPASSED/);
  });

  it("stays silent in production once APP_DATABASE_URL is set", () => {
    expect(
      ownerFallbackWarning({
        NODE_ENV: "production",
        APP_DATABASE_URL: APP,
        DATABASE_URL: OWNER,
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("stays silent outside production (dev/test boot is owner by design)", () => {
    expect(ownerFallbackWarning({ NODE_ENV: "development", DATABASE_URL: OWNER } as NodeJS.ProcessEnv)).toBeNull();
    expect(ownerFallbackWarning({ NODE_ENV: "test", DATABASE_URL: TEST } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("emits exactly one warning through the boot logger, and never throws", () => {
    const warn = vi.fn();
    const logger = { warn };

    expect(
      warnOnOwnerFallback({ NODE_ENV: "production", DATABASE_URL: OWNER } as NodeJS.ProcessEnv, logger),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/RLS BYPASSED/);

    warn.mockClear();
    expect(
      warnOnOwnerFallback({ NODE_ENV: "production", APP_DATABASE_URL: APP } as NodeJS.ProcessEnv, logger),
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
