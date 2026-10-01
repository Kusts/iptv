import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import {
  buildIdentityUrl,
  isCrossOriginRedirect,
  performSubmitLogin,
  PlaywrightBrowser,
  PlaywrightPage,
  SubmitAbortedError,
} from "../src/browser.js";
import type { WorkerConfig } from "../src/config.js";
import { BINDING_PROVIDER } from "../src/constants.js";
import { acquireProfileLock, ProfileLockError } from "../src/profileLock.js";
import { decideRequest, initialPolicyState } from "../src/policy.js";

const ALLOWED = "https://panel.example.test";
const LOGIN_PATH = "/api/auth/login";

describe("absolute identity url", () => {
  it("builds the absolute fixed endpoint url", () => {
    expect(buildIdentityUrl(ALLOWED)).toBe("https://panel.example.test/api/auth/me");
  });

  it("refuses any non-fixed path", () => {
    for (const bad of ["/api/auth/me?x=1", "/api/other", "https://evil.example.test/api/auth/me", ""]) {
      expect(() => buildIdentityUrl(ALLOWED, bad), bad).toThrowError();
    }
  });
});

describe("redirect host check", () => {
  it("treats same-origin locations as safe", () => {
    expect(
      isCrossOriginRedirect(ALLOWED, `${ALLOWED}/api/auth/me`, "/api/auth/me?x=1"),
    ).toBe(false);
    expect(
      isCrossOriginRedirect(ALLOWED, `${ALLOWED}/api/auth/me`, `${ALLOWED}/login`),
    ).toBe(false);
  });

  it("treats cross-origin and unparseable locations as hostile", () => {
    expect(
      isCrossOriginRedirect(ALLOWED, `${ALLOWED}/api/auth/me`, "https://evil.example.test/steal"),
    ).toBe(true);
    expect(
      isCrossOriginRedirect(ALLOWED, `${ALLOWED}/api/auth/me`, "https://panel.example.test.evil.test/"),
    ).toBe(true);
    expect(isCrossOriginRedirect(ALLOWED, `${ALLOWED}/api/auth/me`, "")).toBe(true);
  });
});

describe("submitLogin window timing", () => {
  function probePost(windowOpen: boolean): "allow" | "allow-login-post" | "block" {
    return decideRequest({
      method: "POST",
      url: `${ALLOWED}/api/auth/login`,
      allowedOrigin: ALLOWED,
      onSignInRoute: true,
      loginWindowOpen: windowOpen,
      loginPath: LOGIN_PATH,
      loginPostUsed: false,
    });
  }

  it("blocks a POST fired during fill(), allows only the click POST", async () => {
    const state = initialPolicyState();
    const seen: { step: string; decision: string }[] = [];
    // Mirror the route: record the decision each step would get.
    const record = (step: string): void => {
      seen.push({ step, decision: probePost(state.loginWindowOpen) });
    };
    await performSubmitLogin(state, {
      fillEmail: async () => {
        record("fillEmail");
      },
      fillPassword: async () => {
        record("fillPassword");
      },
      clickSubmit: async () => {
        record("click");
      },
      waitSettled: async () => undefined,
    });
    expect(seen).toEqual([
      { step: "fillEmail", decision: "block" },
      { step: "fillPassword", decision: "block" },
      { step: "click", decision: "allow-login-post" },
    ]);
    expect(state.loginWindowOpen).toBe(false);
  });

  it("closes the window even when the click throws", async () => {
    const state = initialPolicyState();
    await expect(
      performSubmitLogin(state, {
        fillEmail: async () => undefined,
        fillPassword: async () => undefined,
        clickSubmit: async () => {
          expect(state.loginWindowOpen).toBe(true);
          throw new Error("click failed");
        },
        waitSettled: async () => undefined,
      }),
    ).rejects.toThrowError("click failed");
    expect(state.loginWindowOpen).toBe(false);
  });

  it("runs no step when the budget already expired (N1)", async () => {
    const controller = new AbortController();
    controller.abort();
    const state = initialPolicyState();
    const ran: string[] = [];
    await expect(
      performSubmitLogin(
        state,
        {
          fillEmail: async () => {
            ran.push("fillEmail");
          },
          fillPassword: async () => {
            ran.push("fillPassword");
          },
          clickSubmit: async () => {
            ran.push("click");
          },
          waitSettled: async () => {
            ran.push("settled");
          },
        },
        controller.signal,
      ),
    ).rejects.toThrowError(SubmitAbortedError);
    expect(ran).toEqual([]);
    expect(state.loginWindowOpen).toBe(false);
  });

  it("late fill after abort performs no click and arms no window (N1)", async () => {
    const controller = new AbortController();
    const state = initialPolicyState();
    const ran: string[] = [];
    let releaseFill!: () => void;
    const fillGate = new Promise<void>((resolve) => {
      releaseFill = resolve;
    });
    const pending = performSubmitLogin(
      state,
      {
        fillEmail: async () => {
          ran.push("fillEmail");
        },
        fillPassword: async () => {
          ran.push("fillPassword");
          await fillGate;
        },
        clickSubmit: async () => {
          ran.push("click");
        },
        waitSettled: async () => {
          ran.push("settled");
        },
      },
      controller.signal,
    );
    const assertion = expect(pending).rejects.toThrowError(SubmitAbortedError);
    // Let the submit reach the pending password fill first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Budget expires while the password fill pends; the fill resolves late.
    controller.abort();
    releaseFill();
    await assertion;
    expect(ran).toEqual(["fillEmail", "fillPassword"]);
    expect(state.loginWindowOpen).toBe(false);
  });
});

describe("fetchIdentity (in-page bearer fetch, real code)", () => {
  interface CapturedRequest {
    url: string;
    authorization: string | null;
  }

  function fakePageWith(
    fetchBehavior: (
      url: string,
      authorization: string | null,
    ) => { ok: boolean; status: number; body?: unknown },
    calls: CapturedRequest[],
  ): PlaywrightPage {
    const page = {
      evaluate: async (
        fn: (url: string) => Promise<unknown>,
        url: string,
      ): Promise<unknown> => {
        const call: CapturedRequest = { url, authorization: null };
        calls.push(call);
        const scope = globalThis as Record<string, unknown>;
        const prevFetch = scope.fetch;
        scope.localStorage = { getItem: (k: string) => (k === "token" ? "spa-token" : null) };
        scope.fetch = async (
          _u: string,
          init?: { headers?: Record<string, string> },
        ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
          const authorization = init?.headers?.Authorization ?? null;
          call.authorization = authorization;
          const behavior = fetchBehavior(url, authorization);
          return {
            ok: behavior.ok,
            status: behavior.status,
            json: async () => behavior.body ?? null,
          };
        };
        try {
          return await fn(url);
        } finally {
          delete scope.localStorage;
          scope.fetch = prevFetch;
        }
      },
    } as unknown as Page;
    return new PlaywrightPage(
      page,
      {} as unknown as BrowserContext,
      ALLOWED,
      initialPolicyState(),
      LOGIN_PATH,
    );
  }

  it("reads the identity with the session bearer token on 200", async () => {
    const calls: CapturedRequest[] = [];
    const page = fakePageWith(
      () => ({ ok: true, status: 200, body: { email: "operator@example.test" } }),
      calls,
    );
    await expect(page.fetchIdentity()).resolves.toEqual({ email: "operator@example.test" });
    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first?.url).toBe(`${ALLOWED}/api/auth/me`);
    expect(first?.authorization).toBe("Bearer spa-token");
  });

  it("returns a status marker without throwing on non-ok (401)", async () => {
    const calls: CapturedRequest[] = [];
    const page = fakePageWith(() => ({ ok: false, status: 401 }), calls);
    await expect(page.fetchIdentity()).resolves.toEqual({ __identityReadStatus: 401 });
    expect(calls).toHaveLength(1);
  });

  it("returns a status marker without throwing on server error (500)", async () => {
    const calls: CapturedRequest[] = [];
    const page = fakePageWith(() => ({ ok: false, status: 500 }), calls);
    await expect(page.fetchIdentity()).resolves.toEqual({ __identityReadStatus: 500 });
  });

  it("never sends the bearer token when the session token is absent", async () => {
    const calls: CapturedRequest[] = [];
    const page = {
      evaluate: async (
        fn: (url: string) => Promise<unknown>,
        url: string,
      ): Promise<unknown> => {
        const call: CapturedRequest = { url, authorization: null };
        calls.push(call);
        const scope = globalThis as Record<string, unknown>;
        const prevFetch = scope.fetch;
        scope.localStorage = { getItem: () => null };
        scope.fetch = async (
          _u: string,
          init?: { headers?: Record<string, string> },
        ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
          const authorization = init?.headers?.Authorization ?? null;
          call.authorization = authorization;
          return { ok: false, status: 401, json: async () => null };
        };
        try {
          return await fn(url);
        } finally {
          delete scope.localStorage;
          scope.fetch = prevFetch;
        }
      },
    } as unknown as Page;
    const instance = new PlaywrightPage(
      page,
      {} as unknown as BrowserContext,
      ALLOWED,
      initialPolicyState(),
      LOGIN_PATH,
    );
    await expect(instance.fetchIdentity()).resolves.toEqual({ __identityReadStatus: 401 });
    expect(calls[0]?.authorization).toBeNull();
  });
});

describe("launch quiescence F1 (PlaywrightBrowser.open, mocked launch)", () => {
  function workerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
    const root = mkdtempSync(join(tmpdir(), "bw-f1-"));
    return {
      provider: BINDING_PROVIDER,
      tenantId: "tenant-a",
      providerAccountId: "acct-1",
      allowedOrigin: ALLOWED,
      loginPath: LOGIN_PATH,
      infisicalSiteUrl: "https://infisical.example.test",
      infisicalProjectId: "proj-1",
      infisicalClientId: "id-1",
      infisicalClientSecret: "secret-1",
      headless: true,
      challengeWaitSeconds: 0,
      commandTimeoutMs: 60_000,
      launchSettleMs: 500,
      profileRoot: root,
      profileDir: join(root, "p-test"),
      ...overrides,
    };
  }

  it("abort before context creation waits for the late launch to close; profile cycles never overlap", async () => {
    const cfg = workerConfig();
    // Execution A holds the profile lock (as the runner does).
    const lockA = await acquireProfileLock(cfg.profileDir);
    let tardyClosed = 0;
    let releaseLaunch!: (ctx: BrowserContext) => void;
    const launchGate = new Promise<BrowserContext>((resolve) => {
      releaseLaunch = resolve;
    });
    const browser = new PlaywrightBrowser(cfg, () => launchGate);
    const controller = new AbortController();
    let quiescence: Promise<void> | null = null;
    const opened = browser.open(cfg.profileDir, ALLOWED, LOGIN_PATH, {
      signal: controller.signal,
      launchSettleMs: 2000,
      onPendingLaunch: (q) => {
        quiescence = q;
      },
    });
    let openSettled = false;
    let openError: unknown = null;
    void opened.then(
      () => {
        openSettled = true;
      },
      (err) => {
        openSettled = true;
        openError = err;
      },
    );
    // Quiescence is registered synchronously during open.
    expect(quiescence).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Budget expires while the launch still pends.
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The abort must NOT settle open while the launch is still pending:
    // the lock is never released with a launch pending.
    expect(openSettled).toBe(false);
    // Execution B tries to acquire before the late launch resolves: it
    // must collide fail-closed (no overlapping profile use).
    await expect(acquireProfileLock(cfg.profileDir)).rejects.toBeInstanceOf(ProfileLockError);
    // The late Chromium launch resolves AFTER the abort: it is tardy, so
    // it must be closed instead of handed out.
    const tardy = {
      close: async () => {
        tardyClosed += 1;
      },
    } as unknown as BrowserContext;
    releaseLaunch(tardy);
    await expect(opened).rejects.toBeInstanceOf(SubmitAbortedError);
    expect(openError).toBeInstanceOf(SubmitAbortedError);
    // Bounded quiescence settled: the tardy context was closed.
    await quiescence;
    expect(tardyClosed).toBe(1);
    // Only after settle/close may the profile be reused: A releases,
    // then B acquires cleanly (cycles never overlap).
    await lockA.release();
    const lockB = await acquireProfileLock(cfg.profileDir);
    await lockB.release();
  });

  it("a launch that never settles still rejects within the bound (no unbounded wait)", async () => {
    const cfg = workerConfig();
    const browser = new PlaywrightBrowser(cfg, () => new Promise<never>(() => undefined));
    const controller = new AbortController();
    const started = Date.now();
    const opened = browser.open(cfg.profileDir, ALLOWED, LOGIN_PATH, {
      signal: controller.signal,
      launchSettleMs: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(opened).rejects.toBeInstanceOf(SubmitAbortedError);
    // Bounded: rejects shortly after the 500ms quiescence bound, never hangs.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("setup failure after ownership uses a bounded close (browser.ts:411)", async () => {
    const cfg = workerConfig();
    let closes = 0;
    const wedged = {
      on: () => undefined,
      pages: () => [],
      newPage: async () => {
        throw new Error("setup failed");
      },
      route: async () => undefined,
      close: () => new Promise<void>(() => undefined),
    } as unknown as BrowserContext;
    const browser = new PlaywrightBrowser(cfg, async () => wedged);
    const started = Date.now();
    // Wrap the hanging close so the test can observe the bound without
    // waiting on the real (never-settling) close.
    const originalClose = wedged.close.bind(wedged);
    void originalClose;
    wedged.close = async () => {
      closes += 1;
      await new Promise<void>(() => undefined);
    };
    await expect(
      browser.open(cfg.profileDir, ALLOWED, LOGIN_PATH, { launchSettleMs: 500 }),
    ).rejects.toThrowError("setup failed");
    expect(closes).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});