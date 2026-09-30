import { describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import {
  buildIdentityUrl,
  isCrossOriginRedirect,
  performSubmitLogin,
  PlaywrightPage,
} from "../src/browser.js";
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
        calls.push({ url, authorization: null });
        const scope = globalThis as Record<string, unknown>;
        const prevFetch = scope.fetch;
        scope.localStorage = { getItem: (k: string) => (k === "token" ? "spa-token" : null) };
        scope.fetch = async (
          _u: string,
          init?: { headers?: Record<string, string> },
        ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
          const authorization = init?.headers?.Authorization ?? null;
          calls[calls.length - 1].authorization = authorization;
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
    expect(calls[0].url).toBe(`${ALLOWED}/api/auth/me`);
    expect(calls[0].authorization).toBe("Bearer spa-token");
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
        calls.push({ url, authorization: null });
        const scope = globalThis as Record<string, unknown>;
        const prevFetch = scope.fetch;
        scope.localStorage = { getItem: () => null };
        scope.fetch = async (
          _u: string,
          init?: { headers?: Record<string, string> },
        ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
          const authorization = init?.headers?.Authorization ?? null;
          calls[calls.length - 1].authorization = authorization;
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
    expect(calls[0].authorization).toBeNull();
  });
});