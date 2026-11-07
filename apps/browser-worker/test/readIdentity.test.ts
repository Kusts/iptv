import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BINDING_PROVIDER } from "../src/constants.js";
import { formatResult } from "../src/output.js";
import { acquireProfileLock } from "../src/profileLock.js";
import type { CinevisionCommandBrowser, CinevisionCommandPage } from "../src/operations/cinevisionCommand.js";
import {
  runReadIdentity,
  type ReadIdentityBrowser,
  type ReadIdentityPage,
} from "../src/operations/readIdentity.js";
import type { InPageResult } from "../src/providers/cinevision/api-client.js";
import { assertSecretUrlAllowed, type WorkerConfig } from "../src/config.js";


const ALLOWED = "https://panel.example.test";
process.env["CINEVISION_EMAIL"] = "operator@example.test";
process.env["CINEVISION_PASSWORD"] = "pw-123";
const EMAIL = "operator@example.test";
const LOGIN_PATH = "/api/auth/login";

function tmpProfile(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "bw-profile-"));
  return { root, dir: join(root, "p-test") };
}

function config(): WorkerConfig {
  const { root, dir } = tmpProfile();
  return {
    provider: BINDING_PROVIDER,
    tenantId: "tenant-a",
    providerAccountId: "acct-1",
    allowedOrigin: ALLOWED,
    loginPath: LOGIN_PATH,
    headless: true,
    challengeWaitSeconds: 0,
    commandTimeoutMs: 60_000,
    profileRoot: root,
    profileDir: dir,
  };
}

interface PageScript {
  form: { forms: number; emailInputs: number; passwordInputs: number; submitButtons: number } | null;
  challenge: boolean;
  loginResult: boolean;
  /** Projected Fase-1 identity payloads served to `evaluateCapability`. */
  reads: unknown[];
}

function fakeBrowser(
  script: PageScript,
  calls: { opened: string[]; submitted: number; reads: number; closed: number },
): CinevisionCommandBrowser {
  const page: CinevisionCommandPage = {
    currentUrl: () => `${ALLOWED}/#/dashboard`,
    goto: async () => undefined,
    probeLoginForm: async () => script.form,
    detectChallenge: async () => script.challenge,
    submitLogin: async () => {
      calls.submitted += 1;
      return script.loginResult;
    },
    // Legacy probe never reauthorizes: the reauth window stays unarmed.
    armReauthWindow: () => false,
    fetchIdentity: async () => {
      throw new Error("legacy fetchIdentity is not used by the V2 path");
    },
    evaluateCapability: async (): Promise<InPageResult> => {
      calls.reads += 1;
      const next = script.reads.shift();
      if (next === undefined) throw new Error("no more reads");
      return { kind: "ok", status: 200, contentType: "application/json", data: next };
    },
    close: async () => {
      calls.closed += 1;
    },
  };
  return {
    open: async (profileDir: string) => {
      calls.opened.push(profileDir);
      return page;
    },
  };
}

function identityPayload(username: string): unknown {
  return { id: "u-1", username, credits: 2 };
}

describe("runReadIdentity (fully mocked, V2 reader path)", () => {
  it("confirms identity on an existing session with two matching reads", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const cfg = config();
    const result = await runReadIdentity(cfg, {
      browser: fakeBrowser(
        {
          form: null,
          challenge: false,
          loginResult: false,
          reads: [identityPayload(EMAIL), identityPayload(EMAIL)],
        },
        calls,
      ),
    });
    expect(result.status).toBe("READ_CONFIRMED");
    expect(result.identityMatched).toBe(true);
    expect(result.readbackMatched).toBe(true);
    expect(result.errorCode).toBe("NONE");
    expect(result.needsHuman).toBe(false);
    expect(result.command).toBe("cinevision.readIdentity");
    expect(result.executionChannel).toBe("BROWSER");
    expect(result.strategy).toBe("API_IN_BROWSER");
    expect(result.adapterVersion).toBe("cinevision-browser-v2");
    expect(result.reauthenticated).toBe(false);
    expect(calls.opened).toEqual([cfg.profileDir]);
    expect(calls.reads).toBe(2);
  });

  it("logs in through a strict-unique form, then confirms", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const result = await runReadIdentity(config(), {
      browser: fakeBrowser(
        {
          form: { forms: 1, emailInputs: 1, passwordInputs: 1, submitButtons: 1 },
          challenge: false,
          loginResult: true,
          reads: [identityPayload(EMAIL), identityPayload(EMAIL)],
        },
        calls,
      ),
    });
    expect(result.status).toBe("READ_CONFIRMED");
    expect(calls.submitted).toBe(1);
  });

  it("returns HUMAN_REQUIRED on ambiguous login DOM without guessing", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const result = await runReadIdentity(config(), {
      browser: fakeBrowser(
        {
          form: { forms: 1, emailInputs: 2, passwordInputs: 1, submitButtons: 1 },
          challenge: false,
          loginResult: true,
          reads: [identityPayload(EMAIL)],
        },
        calls,
      ),
    });
    expect(result.status).toBe("HUMAN_REQUIRED");
    expect(result.errorCode).toBe("AMBIGUOUS_LOGIN_FORM");
    expect(calls.submitted).toBe(0);
    expect(calls.reads).toBe(0);
  });

  it("returns HUMAN_REQUIRED without submit when several forms exist (no click)", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const result = await runReadIdentity(config(), {
      browser: fakeBrowser(
        {
          form: { forms: 2, emailInputs: 1, passwordInputs: 1, submitButtons: 1 },
          challenge: false,
          loginResult: true,
          reads: [identityPayload(EMAIL)],
        },
        calls,
      ),
    });
    expect(result.status).toBe("HUMAN_REQUIRED");
    expect(result.errorCode).toBe("AMBIGUOUS_LOGIN_FORM");
    expect(calls.submitted).toBe(0);
  });

  it("returns HUMAN_REQUIRED without submit when submit buttons are not exactly one", async () => {
    for (const submitButtons of [0, 2]) {
      const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
      const result = await runReadIdentity(config(), {
        browser: fakeBrowser(
          {
            form: { forms: 1, emailInputs: 1, passwordInputs: 1, submitButtons },
            challenge: false,
            loginResult: true,
            reads: [identityPayload(EMAIL), identityPayload(EMAIL)],
          },
          calls,
        ),
      });
      expect(result.status, `submitButtons=${submitButtons}`).toBe("HUMAN_REQUIRED");
      expect(result.errorCode, `submitButtons=${submitButtons}`).toBe("AMBIGUOUS_LOGIN_FORM");
      expect(calls.submitted, `submitButtons=${submitButtons}`).toBe(0);
    }
  });

  it("returns HUMAN_REQUIRED/CONFIG when no login path is configured (no launch)", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const cfg = { ...config(), loginPath: "" };
    const result = await runReadIdentity(cfg, {
      browser: fakeBrowser(
        { form: null, challenge: false, loginResult: false, reads: [] },
        calls,
      ),
    });
    expect(result.status).toBe("HUMAN_REQUIRED");
    expect(result.errorCode).toBe("CONFIG");
    expect(calls.opened).toEqual([]);

  });

  it("fails closed with PROFILE_LOCKED on a concurrent binding session (no launch)", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const cfg = config();
    const { ensureProfileDir } = await import("../src/operations/readIdentity.js");
    await ensureProfileDir(cfg.profileRoot, cfg.profileDir);
    const held = await acquireProfileLock(cfg.profileDir);
    try {
      const result = await runReadIdentity(cfg, {
        browser: fakeBrowser(
          { form: null, challenge: false, loginResult: false, reads: [] },
          calls,
        ),
      });
      expect(result.status).toBe("HUMAN_REQUIRED");
      expect(result.errorCode).toBe("PROFILE_LOCKED");
      expect(calls.opened).toEqual([]);
    } finally {
      await held.release();
    }
  });

  it("returns HUMAN_REQUIRED on challenge instead of bypassing", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const result = await runReadIdentity(config(), {
      browser: fakeBrowser(
        { form: null, challenge: true, loginResult: false, reads: [] },
        calls,
      ),
    });
    expect(result.status).toBe("HUMAN_REQUIRED");
    expect(result.errorCode).toBe("CHALLENGE_DETECTED");
    expect(calls.reads).toBe(0);
  });

  it("waits a bounded window for a managed challenge that auto-clears", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const cfg = { ...config(), challengeWaitSeconds: 1 };
    let challengeCalls = 0;
    const browser = fakeBrowser(
      {
        form: { forms: 1, emailInputs: 1, passwordInputs: 1, submitButtons: 1 },
        challenge: false,
        loginResult: true,
        reads: [identityPayload(EMAIL), identityPayload(EMAIL)],
      },
      calls,
    );
    const originalDetect = browser.open;
    const patched: typeof browser = {
      ...browser,
      open: async (profileDir, allowedOrigin, loginPath) => {
        const page = await originalDetect(profileDir, allowedOrigin, loginPath);
        page.detectChallenge = async () => {
          challengeCalls += 1;
          return challengeCalls <= 1;
        };
        return page;
      },
    };
    const result = await runReadIdentity(cfg, {
      browser: patched,
    });
    expect(result.status).toBe("READ_CONFIRMED");
    expect(challengeCalls).toBeGreaterThanOrEqual(2);
  });

  it("performs no readback when login fails", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const result = await runReadIdentity(config(), {
      browser: fakeBrowser(
        {
          form: { forms: 1, emailInputs: 1, passwordInputs: 1, submitButtons: 1 },
          challenge: false,
          loginResult: false,
          reads: [identityPayload(EMAIL)],
        },
        calls,
      ),
    });
    expect(result.status).toBe("HUMAN_REQUIRED");
    expect(result.errorCode).toBe("IDENTITY_MISMATCH");
    expect(calls.reads).toBe(0);
  });

  it("returns HUMAN_REQUIRED on secret/profile identity mismatch", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const result = await runReadIdentity(config(), {
      browser: fakeBrowser(
        {
          form: null,
          challenge: false,
          loginResult: false,
          reads: [identityPayload("other@example.test"), identityPayload("other@example.test")],
        },
        calls,
      ),
    });
    expect(result.status).toBe("HUMAN_REQUIRED");
    expect(result.errorCode).toBe("IDENTITY_MISMATCH");
    expect(result.identityMatched).toBe(false);
  });

  it("returns INCONCLUSIVE when the repeat read disagrees", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const result = await runReadIdentity(config(), {
      browser: fakeBrowser(
        {
          form: null,
          challenge: false,
          loginResult: false,
          reads: [identityPayload(EMAIL), identityPayload("other@example.test")],
        },
        calls,
      ),
    });
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.errorCode).toBe("READ_MISMATCH");
  });

  it("origin guard rejects a mismatched panel URL", () => {
    expect(() => assertSecretUrlAllowed("https://evil.example.test", ALLOWED)).toThrow();
  });

  it("fails closed when invocation credentials are unavailable", async () => {
    const email = process.env["CINEVISION_EMAIL"];
    const password = process.env["CINEVISION_PASSWORD"];
    delete process.env["CINEVISION_EMAIL"];
    delete process.env["CINEVISION_PASSWORD"];
    try {
      const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
      const result = await runReadIdentity(config(), {
        browser: fakeBrowser({ form: null, challenge: false, loginResult: false, reads: [] }, calls),
      });
      expect(result.status).toBe("HUMAN_REQUIRED");
      expect(result.errorCode).toBe("SECRET_UNAVAILABLE");
      expect(calls.opened).toEqual([]);
    } finally {
      if (email !== undefined) process.env["CINEVISION_EMAIL"] = email;
      if (password !== undefined) process.env["CINEVISION_PASSWORD"] = password;
    }
  });

  it("emits only the safe result envelope and never credentials or panel URL", async () => {
    const calls = { opened: [] as string[], submitted: 0, reads: 0, closed: 0 };
    const result = await runReadIdentity(config(), {
      browser: fakeBrowser({
        form: null,
        challenge: false,
        loginResult: false,
        reads: [identityPayload(EMAIL), identityPayload(EMAIL)],
      }, calls),
    });
    const line = formatResult(result);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "correlationId", "errorCode", "identityMatched", "needsHuman", "providerAccountId",
      "readbackMatched", "status", "command", "executionChannel", "strategy", "adapterVersion",
      "reauthenticated", "evidence",
    ].sort());
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain("pw-123");
    expect(line).not.toContain(ALLOWED);
    expect(parsed["executionChannel"]).toBe("BROWSER");
    expect(parsed["strategy"]).toBe("API_IN_BROWSER");
    expect(parsed["adapterVersion"]).toBe("cinevision-browser-v2");
  });
});

describe("legacy surface compat", () => {
  it("keeps the legacy page/browser types structurally compatible", () => {
    const checkPage = (page: CinevisionCommandPage): ReadIdentityPage => page;
    void checkPage;
    const checkBrowser = (browser: CinevisionCommandBrowser): ReadIdentityBrowser => ({
      open: (...args) => browser.open(...args),
    });
    void checkBrowser;
  });
});
