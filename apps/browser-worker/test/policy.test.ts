import { describe, expect, it } from "vitest";
import { decideRequest, decideRoutedRequest, isSignInRoute, normalizeLoginPath } from "../src/policy.js";

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
