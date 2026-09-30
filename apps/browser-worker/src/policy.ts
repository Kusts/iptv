/**
 * Network policy (pure, Playwright-free).
 *
 * - Block every origin different from the allowlist (SSRF guard).
 * - Allow GET/HEAD/OPTIONS same-origin.
 * - Allow AT MOST one POST, and ONLY when ALL of these hold:
 *   1. the route state window is open (`loginWindowOpen`) — armed by
 *      `submitLogin` only around its single controlled click (fills run
 *      with the window closed) and closed right after (never left open
 *      across navigations);
 *   2. the request originates from the MAIN frame (`decideRoutedRequest`
 *      rejects every subframe/popup request, so a concurrent frame can
 *      never consume the single exception);
 *   3. the MAIN page is on the EXACT sign-in route (`hash === "#/sign-in"`,
 *      never a substring match and never a subframe URL);
 *   3. the request pathname EXACTLY equals the configured
 *      `CINEVISION_LOGIN_PATH` (relative `/api/...`, no query/fragment/
 *      traversal — validated by `normalizeLoginPath`);
 *   4. the single exception was not consumed yet (`loginPostUsed`).
 * - Block PUT/PATCH/DELETE and every other POST (popups, arbitrary
 *   forms, second POST, off-window, off-path, off-hash).
 *
 * Service workers are `block` at context launch so this route sees every
 * request (Playwright does not route service-worker-intercepted requests).
 * Every popup is closed on sight, so no popup/form can smuggle a POST
 * through the window either.
 */

import { SIGN_IN_HASH } from "./constants.js";

export type PolicyDecision = "allow" | "allow-login-post" | "block";

export interface PolicyInput {
  method: string;
  url: string;
  /** Exact origin allowlist value (e.g. `https://panel.example`). */
  allowedOrigin: string;
  /** True only while the page URL hash is EXACTLY `#/sign-in`. */
  onSignInRoute: boolean;
  /** True only during the controlled `submitLogin` click window. */
  loginWindowOpen: boolean;
  /** Exact validated login POST pathname from `CINEVISION_LOGIN_PATH`. */
  loginPath: string;
  /** True after the single login POST exception was consumed. */
  loginPostUsed: boolean;
}

export interface PolicyState {
  loginWindowOpen: boolean;
  loginPostUsed: boolean;
}

const LOGIN_PATH_RE = /^\/api\/[A-Za-z0-9._/-]{1,160}$/;

/**
 * Validate `CINEVISION_LOGIN_PATH`: a relative pathname only, starting
 * with `/api/`, without query, fragment, backslashes or `..` segments.
 * Returns the exact pathname to compare requests against. Throws a plain
 * `Error` with a fixed message (callers map it to `ConfigError` without
 * echoing the value).
 */
export function normalizeLoginPath(raw: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > 200) {
    throw new Error("browser-worker policy: login path is required");
  }
  if (!LOGIN_PATH_RE.test(value)) {
    throw new Error("browser-worker policy: login path must be a relative /api/... pathname");
  }
  if (value.includes("//") || value.includes("..") || value.includes("\\")) {
    throw new Error("browser-worker policy: login path must not contain traversal");
  }
  // Belt-and-braces: the value must round-trip as a pure pathname.
  let pathname: string;
  try {
    pathname = new URL(value, "https://placeholder.invalid").pathname;
  } catch {
    throw new Error("browser-worker policy: login path is not a valid pathname");
  }
  if (pathname !== value) {
    throw new Error("browser-worker policy: login path must not contain query or fragment");
  }
  return value;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Pure per-request decision. Never throws for malformed input — blocks. */
export function decideRequest(input: PolicyInput): PolicyDecision {
  const requestOrigin = originOf(input.url);
  if (requestOrigin === null || requestOrigin !== input.allowedOrigin) {
    return "block";
  }
  let path: string;
  try {
    path = new URL(input.url).pathname;
  } catch {
    return "block";
  }
  const method = input.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return "allow";
  }
  if (method === "POST") {
    if (
      input.loginWindowOpen &&
      !input.loginPostUsed &&
      input.onSignInRoute &&
      input.loginPath.length > 0 &&
      path === input.loginPath
    ) {
      return "allow-login-post";
    }
    return "block";
  }
  // PUT, PATCH, DELETE and anything else: blocked.
  return "block";
}

export interface RoutedRequestInput {
  method: string;
  url: string;
  /** Exact origin allowlist value (e.g. `https://panel.example`). */
  allowedOrigin: string;
  /** Current MAIN page URL — never a subframe/popup URL. */
  mainPageUrl: string;
  /** True only when the request originates from the main frame. */
  isMainFrame: boolean;
  /** True only during the controlled `submitLogin` click window. */
  loginWindowOpen: boolean;
  /** Exact validated login POST pathname from `CINEVISION_LOGIN_PATH`. */
  loginPath: string;
  /** True after the single login POST exception was consumed. */
  loginPostUsed: boolean;
}

/**
 * Route-level decision bound to the main frame by identity. Blocks every
 * subframe/popup request — even with an open window on the route — so a
 * concurrent frame can never consume the single login POST exception.
 * Never throws for malformed input — blocks.
 */
export function decideRoutedRequest(input: RoutedRequestInput): PolicyDecision {
  if (!input.isMainFrame) return "block";
  return decideRequest({
    method: input.method,
    url: input.url,
    allowedOrigin: input.allowedOrigin,
    onSignInRoute: isSignInRoute(input.mainPageUrl),
    loginWindowOpen: input.loginWindowOpen,
    loginPath: input.loginPath,
    loginPostUsed: input.loginPostUsed,
  });
}

/**
 * True only when the current page URL hash is EXACTLY the sign-in route.
 * Substring matches (`#/sign-in-evil`, `?x=#/sign-in`, …) are NOT routes.
 */
export function isSignInRoute(pageUrl: string): boolean {
  try {
    return new URL(pageUrl).hash === SIGN_IN_HASH;
  } catch {
    return false;
  }
}

/** @deprecated Use {@link isSignInRoute} (exact match). Kept for compat. */
export function isSignInHash(pageUrl: string): boolean {
  return isSignInRoute(pageUrl);
}

export function initialPolicyState(): PolicyState {
  return { loginWindowOpen: false, loginPostUsed: false };
}
