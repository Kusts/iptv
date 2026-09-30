import { describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import {
  buildIdentityUrl,
  CrossOriginRedirectError,
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

describe("fetchIdentity redirect flow (fake request layer, real code)", () => {
  interface FakeApiResponse {
    status(): number;
    headers(): Record<string, string>;
    ok(): boolean;
    json(): Promise<unknown>;
  }

  interface RequestCalls {
    urls: string[];
    noRedirect: boolean[];
  }

  function apiResponse(
    status: number,
    headers: Record<string, string>,
    body: unknown,
  ): FakeApiResponse {
    return {
      status: () => status,
      headers: () => headers,
      ok: () => status >= 200 && status < 300,
      json: async () => body,
    };
  }

  function fakePageWith(
    handler: (url: string) => FakeApiResponse,
    calls: RequestCalls,
  ): PlaywrightPage {
    const get = async (url: string, opts: { maxRedirects: number }): Promise<FakeApiResponse> => {
      calls.urls.push(url);
      calls.noRedirect.push(opts.maxRedirects === 0);
      return handler(url);
    };
    const context = { request: { get } } as unknown as BrowserContext;
    return new PlaywrightPage(
      {} as unknown as Page,
      context,
      ALLOWED,
      initialPolicyState(),
      LOGIN_PATH,
    );
  }

  function tracker(): RequestCalls {
    return { urls: [], noRedirect: [] };
  }

  it("returns json on 200 with redirects disabled", async () => {
    const calls = tracker();
    const page = fakePageWith(
      () => apiResponse(200, {}, { email: "operator@example.test" }),
      calls,
    );
    await expect(page.fetchIdentity()).resolves.toEqual({ email: "operator@example.test" });
    expect(calls.urls).toEqual([`${ALLOWED}/api/auth/me`]);
    expect(calls.noRedirect).toEqual([true]);
  });

  it("follows a same-origin redirect exactly once", async () => {
    const calls = tracker();
    let seen = 0;
    const page = fakePageWith((url) => {
      seen += 1;
      if (seen === 1) {
        expect(url).toBe(`${ALLOWED}/api/auth/me`);
        return apiResponse(302, { location: "/api/auth/me?fresh=1" }, null);
      }
      return apiResponse(200, {}, { email: "operator@example.test" });
    }, calls);
    await expect(page.fetchIdentity()).resolves.toEqual({ email: "operator@example.test" });
    expect(calls.urls).toEqual([`${ALLOWED}/api/auth/me`, `${ALLOWED}/api/auth/me?fresh=1`]);
    expect(calls.noRedirect).toEqual([true, true]);
  });

  it("fails closed without following a cross-origin redirect", async () => {
    const calls = tracker();
    const page = fakePageWith(
      () => apiResponse(302, { location: "https://evil.example.test/steal" }, null),
      calls,
    );
    const err = await page.fetchIdentity().then(
      () => {
        throw new Error("should have thrown");
      },
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(CrossOriginRedirectError);
    // Fixed message: no origin/secret material leaks into the error.
    expect(String((err as Error).message)).not.toContain("evil.example.test");
    expect(calls.urls).toEqual([`${ALLOWED}/api/auth/me`]);
  });

  it("fails closed on empty or hostile Location", async () => {
    for (const location of ["", "https://panel.example.test.evil.test/", "//evil.example.test/x"]) {
      const calls = tracker();
      const page = fakePageWith(() => apiResponse(302, { location }, null), calls);
      await expect(page.fetchIdentity(), `location=${location}`).rejects.toBeInstanceOf(
        CrossOriginRedirectError,
      );
      expect(calls.urls, `location=${location}`).toEqual([`${ALLOWED}/api/auth/me`]);
    }
  });

  it("fails closed on a redirect chain (second 3xx)", async () => {
    const calls = tracker();
    const page = fakePageWith(
      () => apiResponse(302, { location: "/api/auth/me?step=2" }, null),
      calls,
    );
    await expect(page.fetchIdentity()).rejects.toBeInstanceOf(CrossOriginRedirectError);
    expect(calls.urls).toHaveLength(2);
  });

  it("throws a fixed message on non-ok final status", async () => {
    const calls = tracker();
    const page = fakePageWith(() => apiResponse(500, {}, null), calls);
    await expect(page.fetchIdentity()).rejects.toThrowError(
      "identity read failed with status 500",
    );
  });
});
