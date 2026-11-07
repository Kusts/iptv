import { describe, expect, it, vi } from "vitest";
import { CredentialError, resolveCredentials } from "../src/secrets.js";

const ORIGIN = "https://panel.example.test";

describe("resolveCredentials", () => {
  it("uses the validated origin as panel URL and requires both invocation credentials", async () => {
    await expect(resolveCredentials(ORIGIN, {
      CINEVISION_EMAIL: " operator@example.test ",
      CINEVISION_PASSWORD: " password ",
    })).resolves.toEqual({ panelUrl: ORIGIN, email: "operator@example.test", password: "password" });
  });

  it.each([
    { CINEVISION_EMAIL: "operator@example.test" },
    { CINEVISION_PASSWORD: "password" },
    { CINEVISION_EMAIL: " ", CINEVISION_PASSWORD: "password" },
    { CINEVISION_EMAIL: "operator@example.test", CINEVISION_PASSWORD: " " },
  ])("fails closed on a missing/partial pair", async (env) => {
    await expect(resolveCredentials(ORIGIN, env)).rejects.toThrow("SECRET_UNAVAILABLE");
  });

  it("rejects an empty origin without exposing credential values", async () => {
    await expect(resolveCredentials(" ", {
      CINEVISION_EMAIL: "private@example.test", CINEVISION_PASSWORD: "private-password",
    })).rejects.toBeInstanceOf(CredentialError);
  });

  it("never logs or echoes credentials in failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let message = "";
      try { await resolveCredentials(ORIGIN, { CINEVISION_EMAIL: "private@example.test" }); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).not.toContain("private@example.test");
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
