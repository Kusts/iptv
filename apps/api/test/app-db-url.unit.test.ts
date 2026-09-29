import { describe, expect, it } from "vitest";
import { resolveAppConnectionString } from "../src/app.module.js";

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
