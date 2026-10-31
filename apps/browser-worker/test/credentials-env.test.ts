import { describe, expect, it, vi } from "vitest";
import { FIXED_SECRET_REFS } from "../src/constants.js";
import { CredentialError, resolveCredentials } from "../src/secrets.js";
import type { SecretsPort } from "@iptv/secrets";

const PANEL_URL = "https://panel.example.test/";
const VAULT_EMAIL = "vault-user@example.test";
const VAULT_PASS = "vault-pass-never-emitted";
const ENV_EMAIL = "tenant-user@example.test";
const ENV_PASS = "tenant-pass-never-emitted";

function vault(port: Partial<Record<string, string>> = {}): SecretsPort & { calls: string[] } {
  const values: Record<string, string> = {
    [FIXED_SECRET_REFS[0]]: PANEL_URL,
    [FIXED_SECRET_REFS[1]]: VAULT_EMAIL,
    [FIXED_SECRET_REFS[2]]: VAULT_PASS,
    ...port,
  };
  const calls: string[] = [];
  return {
    name: "fake-vault",
    calls,
    getSecret: async (ref: string) => {
      calls.push(ref);
      const value = values[ref];
      if (value === undefined) throw new Error("not found");
      return value;
    },
  };
}

/**
 * S4A-CINE-VALIDATE (Issue #88, etapas 1-2) — RED:
 * o worker deve aceitar credencial por invocação via env
 * (`CINEVISION_EMAIL`/`CINEVISION_PASSWORD` vencem as refs fixas quando
 * presentes), sem nunca logar valores.
 */
describe("resolveCredentials env override (S4A)", () => {
  it("usa o env quando email+senha presentes (vault só para a URL)", async () => {
    const secrets = vault();
    const creds = await resolveCredentials(secrets, {
      CINEVISION_EMAIL: ENV_EMAIL,
      CINEVISION_PASSWORD: ENV_PASS,
    } as NodeJS.ProcessEnv);
    expect(creds.email).toBe(ENV_EMAIL);
    expect(creds.password).toBe(ENV_PASS);
    expect(creds.panelUrl).toBe(PANEL_URL);
    // Toca o vault UMA vez (só a URL) — email/senha nunca saem do env.
    expect(secrets.calls).toEqual([FIXED_SECRET_REFS[0]]);
  });

  it("mantém o legado (refs fixas) sem env", async () => {
    const secrets = vault();
    const creds = await resolveCredentials(secrets, {} as NodeJS.ProcessEnv);
    expect(creds.email).toBe(VAULT_EMAIL);
    expect(creds.password).toBe(VAULT_PASS);
    expect(secrets.calls).toEqual([...FIXED_SECRET_REFS]);
  });

  it("trata env vazio como ausente (loader: KEY= é AUSENTE)", async () => {
    const secrets = vault();
    const creds = await resolveCredentials(secrets, {
      CINEVISION_EMAIL: "",
      CINEVISION_PASSWORD: "   ",
    } as NodeJS.ProcessEnv);
    expect(creds.email).toBe(VAULT_EMAIL);
    expect(secrets.calls).toEqual([...FIXED_SECRET_REFS]);
  });

  it("falha fechado com override parcial (nunca mistura tenant×deployment)", async () => {
    const secrets = vault();
    await expect(
      resolveCredentials(secrets, { CINEVISION_EMAIL: ENV_EMAIL } as NodeJS.ProcessEnv),
    ).rejects.toBeInstanceOf(CredentialError);
    await expect(
      resolveCredentials(secrets, { CINEVISION_PASSWORD: ENV_PASS } as NodeJS.ProcessEnv),
    ).rejects.toBeInstanceOf(CredentialError);
  });

  it("nunca loga nem vaza valores (console + mensagens de erro)", async () => {
    const seen: string[] = [];
    for (const method of ["debug", "info", "log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        seen.push(args.map(String).join(" "));
      });
    }
    try {
      const secrets = vault();
      const creds = await resolveCredentials(secrets, {
        CINEVISION_EMAIL: ENV_EMAIL,
        CINEVISION_PASSWORD: ENV_PASS,
      } as NodeJS.ProcessEnv);
      expect(`${creds.email} ${creds.password}`).toContain(ENV_EMAIL);
      for (const line of seen) {
        expect(line).not.toContain(ENV_EMAIL);
        expect(line).not.toContain(ENV_PASS);
        expect(line).not.toContain(VAULT_EMAIL);
        expect(line).not.toContain(VAULT_PASS);
      }
      await expect(
        resolveCredentials(secrets, { CINEVISION_EMAIL: ENV_EMAIL } as NodeJS.ProcessEnv),
      ).rejects.toThrowError(/SECRET_UNAVAILABLE|CREDENTIAL/);
    } finally {
      vi.restoreAllMocks();
    }
    // Mensagens de erro carregam só códigos fixos — inspeção direta.
    try {
      await resolveCredentials(vault(), { CINEVISION_EMAIL: ENV_EMAIL } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(ENV_EMAIL);
      expect(message).not.toContain(ENV_PASS);
    }
  });
});
