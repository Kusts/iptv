import { describe, expect, it } from "vitest";
import {
  armReauthWindow,
  consumeLoginPost,
  decideRequest,
  decideRoutedRequest,
  initialPolicyState,
  isSignInRoute,
  normalizeLoginPath,
} from "../src/policy.js";

const ALLOWED = "https://panel.example.test";
const LOGIN_PATH = "/api/auth/login";

function post(url: string, extra: Partial<Parameters<typeof decideRequest>[0]> = {}) {
  return decideRequest({
    method: "POST",
    url,
    allowedOrigin: ALLOWED,
    onSignInRoute: true,
    loginWindowOpen: true,
    loginPath: LOGIN_PATH,
    loginPostUsed: false,
    ...extra,
  });
}

describe("login path validation", () => {
  it("accepts a relative /api/... pathname", () => {
    expect(normalizeLoginPath("/api/auth/login")).toBe("/api/auth/login");
  });

  it("rejects absolute urls, queries, fragments and traversal", () => {
    for (const bad of [
      "https://panel.example.test/api/auth/login",
      "/api/auth/login?x=1",
      "/api/auth/login#frag",
      "/api/../evil",
      "/api//double",
      "/other/path",
      "/api/",
      "",
      "   ",
    ]) {
      expect(() => normalizeLoginPath(bad), bad).toThrowError();
    }
  });
});

describe("exact sign-in route", () => {
  it("matches only the exact hash", () => {
    expect(isSignInRoute(`${ALLOWED}/#` + "/sign-in")).toBe(true);
    for (const url of [
      `${ALLOWED}/#/sign-in-evil`,
      `${ALLOWED}/#/x-sign-in`,
      `${ALLOWED}/?x=%23/sign-in`,
      `${ALLOWED}/#/sign-in/extra`,
      `${ALLOWED}/dashboard`,
      ":::not-a-url:::",
    ]) {
      expect(isSignInRoute(url), url).toBe(false);
    }
  });
});

describe("network policy", () => {
  it("allows same-origin GET/HEAD/OPTIONS", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(
        decideRequest({
          method,
          url: `${ALLOWED}/api/auth/me`,
          allowedOrigin: ALLOWED,
          onSignInRoute: false,
          loginWindowOpen: false,
          loginPath: LOGIN_PATH,
          loginPostUsed: false,
        }),
      ).toBe("allow");
    }
  });

  it("blocks every cross-origin request", () => {
    for (const method of ["GET", "POST", "PUT"]) {
      expect(
        decideRequest({
          method,
          url: "https://evil.example.test/api/auth/me",
          allowedOrigin: ALLOWED,
          onSignInRoute: true,
          loginWindowOpen: true,
          loginPath: LOGIN_PATH,
          loginPostUsed: false,
        }),
      ).toBe("block");
    }
  });

  it("allows the single POST only inside the window, on the route, on the exact path", () => {
    expect(post(`${ALLOWED}/api/auth/login`)).toBe("allow-login-post");
  });

  it("blocks a second POST after the window was consumed", () => {
    expect(post(`${ALLOWED}/api/auth/login`, { loginPostUsed: true })).toBe("block");
  });

  it("authorizes exactly one bounded reauth POST with identical guarantees", () => {
    const state = initialPolicyState();
    // Initial slot consumed by the first login.
    expect(
      decideRoutedRequest({
        method: "POST",
        url: `${ALLOWED}/api/auth/login`,
        allowedOrigin: ALLOWED,
        mainPageUrl: `${ALLOWED}/#/sign-in`,
        isMainFrame: true,
        loginWindowOpen: true,
        loginPath: LOGIN_PATH,
        loginPostUsed: state.loginPostUsed,
        reauthArmed: state.reauthArmed,
        reauthLoginPostUsed: state.reauthLoginPostUsed,
      }),
    ).toBe("allow-login-post");
    consumeLoginPost(state);
    const blocked = {
      method: "POST",
      url: `${ALLOWED}/api/auth/login`,
      allowedOrigin: ALLOWED,
      mainPageUrl: `${ALLOWED}/#/sign-in`,
      isMainFrame: true,
      loginWindowOpen: true,
      loginPath: LOGIN_PATH,
      loginPostUsed: state.loginPostUsed,
      reauthArmed: state.reauthArmed,
      reauthLoginPostUsed: state.reauthLoginPostUsed,
    } as const;
    expect(decideRoutedRequest({ ...blocked })).toBe("block");
    // Arming authorizes exactly one more POST — same window/route/path rules.
    expect(armReauthWindow(state)).toBe(true);
    expect(
      decideRoutedRequest({
        ...blocked,
        loginPostUsed: state.loginPostUsed,
        reauthArmed: state.reauthArmed,
        reauthLoginPostUsed: state.reauthLoginPostUsed,
      }),
    ).toBe("allow-login-post");
    consumeLoginPost(state);
    // Third POST blocked; re-arming is refused — the limit is never lifted.
    expect(
      decideRoutedRequest({
        ...blocked,
        loginPostUsed: state.loginPostUsed,
        reauthArmed: state.reauthArmed,
        reauthLoginPostUsed: state.reauthLoginPostUsed,
      }),
    ).toBe("block");
    expect(armReauthWindow(state)).toBe(false);
    expect(
      decideRoutedRequest({
        ...blocked,
        loginPostUsed: state.loginPostUsed,
        reauthArmed: state.reauthArmed,
        reauthLoginPostUsed: state.reauthLoginPostUsed,
      }),
    ).toBe("block");
  });

  it("retires the initial slot when reauth is armed: at most one POST after arming (N3)", () => {
    const state = initialPolicyState();
    // Initial slot NOT consumed, then reauth armed on the single reauth path.
    expect(armReauthWindow(state)).toBe(true);
    const attempt = () =>
      decideRoutedRequest({
        method: "POST",
        url: `${ALLOWED}/api/auth/login`,
        allowedOrigin: ALLOWED,
        mainPageUrl: `${ALLOWED}/#/sign-in`,
        isMainFrame: true,
        loginWindowOpen: true,
        loginPath: LOGIN_PATH,
        loginPostUsed: state.loginPostUsed,
        reauthArmed: state.reauthArmed,
        reauthLoginPostUsed: state.reauthLoginPostUsed,
      });
    // First POST after arming: allowed (the single reauth-phase slot).
    expect(attempt()).toBe("allow-login-post");
    consumeLoginPost(state);
    // Second POST: blocked — the retired initial slot is not a second chance.
    expect(attempt()).toBe("block");
    expect(attempt()).toBe("block");
  });

  it("keeps every guarantee on the rearmed window", () => {
    const state = initialPolicyState();
    state.loginPostUsed = true;
    expect(armReauthWindow(state)).toBe(true);
    const base = {
      method: "POST",
      url: `${ALLOWED}/api/auth/login`,
      allowedOrigin: ALLOWED,
      mainPageUrl: `${ALLOWED}/#/sign-in`,
      isMainFrame: true,
      loginWindowOpen: true,
      loginPath: LOGIN_PATH,
      loginPostUsed: true,
      reauthArmed: true,
      reauthLoginPostUsed: false,
    } as const;
    expect(decideRoutedRequest({ ...base })).toBe("allow-login-post");
    // Same guarantees: off-route, off-path, closed window, subframe, or
    // cross-origin reauth POSTs are still blocked.
    expect(decideRoutedRequest({ ...base, mainPageUrl: `${ALLOWED}/#/dashboard` })).toBe("block");
    expect(decideRoutedRequest({ ...base, url: `${ALLOWED}/api/auth/refresh` })).toBe("block");
    expect(decideRoutedRequest({ ...base, loginWindowOpen: false })).toBe("block");
    expect(decideRoutedRequest({ ...base, isMainFrame: false })).toBe("block");
    expect(
      decideRoutedRequest({ ...base, url: "https://evil.example.test/api/auth/login" }),
    ).toBe("block");
    // The blocked attempts did not consume the single reauth slot.
    expect(decideRoutedRequest({ ...base })).toBe("allow-login-post");
  });

  it("blocks arbitrary POST targets even with an open window on the route", () => {
    for (const url of [
      `${ALLOWED}/api/auth/refresh`,
      `${ALLOWED}/api/customer/123`,
      `${ALLOWED}/api/renew`,
      `${ALLOWED}/account/save`,
    ]) {
      expect(post(url), url).toBe("block");
    }
  });

  it("blocks the login path outside the submit window (popup/form smuggling)", () => {
    expect(post(`${ALLOWED}/api/auth/login`, { loginWindowOpen: false })).toBe("block");
  });

  it("blocks the login path off the exact sign-in route", () => {
    expect(post(`${ALLOWED}/api/auth/login`, { onSignInRoute: false })).toBe("block");
  });

  it("blocks POST when no login path is configured", () => {
    expect(post(`${ALLOWED}/api/auth/login`, { loginPath: "" })).toBe("block");
  });

  it("blocks PUT/PATCH/DELETE and repeated write attempts", () => {
    for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
      expect(
        decideRequest({
          method,
          url: `${ALLOWED}/api/customer/123`,
          allowedOrigin: ALLOWED,
          onSignInRoute: false,
          loginWindowOpen: false,
          loginPath: LOGIN_PATH,
          loginPostUsed: true,
        }),
      ).toBe("block");
    }
    // Lowercase methods are normalized, not smuggled through.
    expect(
      decideRequest({
        method: "put",
        url: `${ALLOWED}/api/customer/123`,
        allowedOrigin: ALLOWED,
        onSignInRoute: true,
        loginWindowOpen: true,
        loginPath: LOGIN_PATH,
        loginPostUsed: false,
      }),
    ).toBe("block");
  });

  it("blocks malformed urls", () => {
    expect(
      decideRequest({
        method: "GET",
        url: ":::not-a-url:::",
        allowedOrigin: ALLOWED,
        onSignInRoute: false,
        loginWindowOpen: false,
        loginPath: LOGIN_PATH,
        loginPostUsed: false,
      }),
    ).toBe("block");
  });
});

describe("main-frame binding", () => {
  function routed(extra: Partial<Parameters<typeof decideRoutedRequest>[0]> = {}) {
    return decideRoutedRequest({
      method: "POST",
      url: `${ALLOWED}/api/auth/login`,
      allowedOrigin: ALLOWED,
      mainPageUrl: `${ALLOWED}/#/sign-in`,
      isMainFrame: true,
      loginWindowOpen: true,
      loginPath: LOGIN_PATH,
      loginPostUsed: false,
      ...extra,
    });
  }

  it("allows the login POST from the main frame on the route", () => {
    expect(routed()).toBe("allow-login-post");
  });

  it("blocks iframe/popup requests even with an open window, without consuming it", () => {
    // A concurrent subframe/popup POST — even one whose own frame URL
    // carries the sign-in hash — is bound by frame identity, not URL.
    expect(routed({ isMainFrame: false })).toBe("block");
    // The blocked frame did NOT consume the exception (pure decision, no
    // state change): the main-frame click POST is still allowed after it.
    expect(routed({ isMainFrame: true })).toBe("allow-login-post");
  });

  it("binds the route check to the main page url, never a frame url", () => {
    expect(routed({ mainPageUrl: `${ALLOWED}/#/dashboard` })).toBe("block");
    expect(routed({ mainPageUrl: `${ALLOWED}/#/sign-in-evil` })).toBe("block");
  });

  it("blocks non-main-frame GETs as well (only the main page may request)", () => {
    expect(
      routed({ method: "GET", url: `${ALLOWED}/api/auth/me`, isMainFrame: false }),
    ).toBe("block");
    expect(routed({ method: "GET", url: `${ALLOWED}/api/auth/me` })).toBe("allow");
  });
});
