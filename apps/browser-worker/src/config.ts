/**
 * Worker config â€” fail-closed env resolution.
 *
 * SINGLE-BINDING operator smoke (see `constants.ts`): identity comes ONLY
 * from deployment env â€” `BROWSER_WORKER_PROVIDER` (must be exactly
 * `CINEVISION`), `BROWSER_WORKER_TENANT_ID` /
 * `BROWSER_WORKER_PROVIDER_ACCOUNT_ID`, the three `FIXED_SECRET_REFS` and
 * the mandatory `CINEVISION_LOGIN_PATH`. Tenant/account ids are NEVER
 * accepted from argv (the CLI has no such flags) and no HTTP server
 * exists in this package, so there is no request-supplied identity to
 * trust. `BROWSER_WORKER_ENABLED` must be exactly `"1"` or nothing
 * launches. Anything unconfigured or mismatched fails closed.
 *
 * Profile isolation: the persistent profile lives OUTSIDE the repo under
 * a per-OS user container (`%LOCALAPPDATA%` on Windows, `XDG_STATE_HOME`
 * or `~/.local/state` elsewhere). On Windows the root MUST stay inside
 * that container (whose ACLs isolate the OS user) â€” anything outside
 * fails closed. `BROWSER_WORKER_PROFILE_ROOT` is a restricted escape
 * hatch (tests, unusual layouts): it must be absolute and is validated
 * like the default (inside the user container on Windows, never inside
 * the repo checkout, never a dangerous ancestor).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { BINDING_PROVIDER } from "./constants.js";
import { normalizeLoginPath } from "./policy.js";

export interface WorkerConfig {
  /** Fixed single-binding provider tag. Always `CINEVISION`. */
  provider: typeof BINDING_PROVIDER;
  tenantId: string;
  providerAccountId: string;
  allowedOrigin: string;
  /**
   * Exact validated login POST pathname (from `CINEVISION_LOGIN_PATH`).
   * The network policy allows one POST only to this exact path, and
   * `submitLogin` refuses to click when it is absent.
   */
  loginPath: string;
  infisicalSiteUrl: string;
  infisicalProjectId: string;
  infisicalClientId: string;
  infisicalClientSecret: string;
  headless: boolean;
  profileRoot: string;
  profileDir: string;
  /** Bounded wait for a managed challenge to auto-clear (seconds). */
  challengeWaitSeconds: number;
}

export class ConfigError extends Error {
  constructor(detail: string) {
    super(`browser-worker config: ${detail}`);
    this.name = "ConfigError";
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Managed challenges auto-clear in seconds; a bounded wait is not a bypass. */
function parseChallengeWaitSeconds(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value.length === 0) return 45;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 300) return 45;
  return n;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  const value = raw === undefined ? "" : raw.trim();
  if (value.length === 0) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

/** Gate: worker starts only when explicitly enabled. */
export function isWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["BROWSER_WORKER_ENABLED"] === "1";
}

/** User container whose ACLs isolate the profile on this platform. */
export function userContainerDir(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === "win32") {
    const base = env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return resolve(base);
  }
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg.trim().length > 0) {
    return resolve(xdg.trim());
  }
  return resolve(join(homedir(), ".local", "state"));
}

/** Walk up from `startDir` looking for the repo checkout root. */
export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) || existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = resolve(join(dir, ".."));
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when `candidate` is `base` or nested inside it. */
function isInsideOrEqual(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validate a profile root: absolute, not a dangerous ancestor (fs root,
 * home dir itself), never inside the repo checkout, and â€” on Windows â€”
 * inside the `%LOCALAPPDATA%` user container. Returns the resolved path.
 * Throws `ConfigError` with fixed words (never echoes the value).
 */
export function validateProfileRoot(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = root.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw new ConfigError("PROFILE_ROOT must be an absolute path");
  }
  const resolved = resolve(trimmed);
  const fsRoot = parse(resolved).root;
  if (resolved === fsRoot || resolved === resolve(homedir())) {
    throw new ConfigError("PROFILE_ROOT must not be a filesystem or home root");
  }
  const repoRoot = findRepoRoot();
  if (repoRoot !== null && isInsideOrEqual(repoRoot, resolved)) {
    throw new ConfigError("PROFILE_ROOT must stay outside the repo checkout");
  }
  if (platform() === "win32") {
    const container = userContainerDir(env);
    if (!isInsideOrEqual(container, resolved) || resolved === container) {
      throw new ConfigError("PROFILE_ROOT_OUTSIDE_USER_CONTAINER");
    }
  }
  return resolved;
}

/**
 * Validate the non-secret allowlist origin: absolute `https://` URL whose
 * serialization is exactly an origin (no path/query/hash).
 */
export function normalizeAllowedOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("CINEVISION_ALLOWED_ORIGIN must be an absolute https:// origin");
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("CINEVISION_ALLOWED_ORIGIN must use https://");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ConfigError("CINEVISION_ALLOWED_ORIGIN must not contain a path");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError("CINEVISION_ALLOWED_ORIGIN must not contain query or hash");
  }
  return url.origin;
}

/**
 * SSRF guard: the secret URL must be `https://` with EXACTLY the allowlist
 * origin. Throws `ConfigError(ORIGIN_MISMATCHâ€¦)` otherwise. Never echoes
 * the URL â€” only the fixed code words.
 */
export function assertSecretUrlAllowed(secretUrl: string, allowedOrigin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(secretUrl);
  } catch {
    throw new ConfigError("ORIGIN_MISMATCH (secret url is not an absolute url)");
  }
  if (parsed.protocol !== "https:") {
    throw new ConfigError("ORIGIN_MISMATCH (secret url must use https://)");
  }
  if (parsed.origin !== allowedOrigin) {
    throw new ConfigError("ORIGIN_MISMATCH (secret origin differs from allowlist)");
  }
}

/**
 * Platform profile root OUTSIDE the repo. `BROWSER_WORKER_PROFILE_ROOT`
 * is a restricted override: when set it must still pass
 * `validateProfileRoot`.
 */
export function defaultProfileRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["BROWSER_WORKER_PROFILE_ROOT"];
  if (override !== undefined && override.trim().length > 0) {
    return validateProfileRoot(override, env);
  }
  if (platform() === "win32") {
    return validateProfileRoot(join(userContainerDir(env), "iptv", "browser-worker", "profiles"), env);
  }
  return validateProfileRoot(join(userContainerDir(env), "iptv-browser-worker", "profiles"), env);
}

/**
 * Tenant/account-isolated profile dir: `sha256(tenantId + NUL +
 * providerAccountId)` hex. Raw ids never appear in the path.
 */
export function profileDirFor(root: string, tenantId: string, providerAccountId: string): string {
  const digest = createHash("sha256")
    .update(tenantId, "utf8")
    .update("\0", "utf8")
    .update(providerAccountId, "utf8")
    .digest("hex");
  return join(root, `p-${digest.slice(0, 32)}`);
}

/** Resolve the fixed single-binding provider tag. Fail closed. */
export function resolveBindingProvider(env: NodeJS.ProcessEnv = process.env): typeof BINDING_PROVIDER {
  const raw = env["BROWSER_WORKER_PROVIDER"];
  const value = raw === undefined ? "" : raw.trim();
  if (value !== BINDING_PROVIDER) {
    throw new ConfigError("BROWSER_WORKER_PROVIDER must be CINEVISION");
  }
  return BINDING_PROVIDER;
}

/** Resolve and validate the full worker config. Throws `ConfigError`. */
export function resolveWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  if (!isWorkerEnabled(env)) {
    throw new ConfigError("DISABLED (BROWSER_WORKER_ENABLED must be 1)");
  }
  const provider = resolveBindingProvider(env);
  const tenantId = required(env, "BROWSER_WORKER_TENANT_ID");
  const providerAccountId = required(env, "BROWSER_WORKER_PROVIDER_ACCOUNT_ID");
  if (!ID_RE.test(tenantId)) {
    throw new ConfigError("BROWSER_WORKER_TENANT_ID has invalid characters");
  }
  if (!ID_RE.test(providerAccountId)) {
    throw new ConfigError("BROWSER_WORKER_PROVIDER_ACCOUNT_ID has invalid characters");
  }
  const allowedOrigin = normalizeAllowedOrigin(required(env, "CINEVISION_ALLOWED_ORIGIN"));
  let loginPath: string;
  try {
    loginPath = normalizeLoginPath(required(env, "CINEVISION_LOGIN_PATH"));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError("CINEVISION_LOGIN_PATH must be a relative /api/... pathname");
  }
  const infisicalSiteUrl = required(env, "BROWSER_INFISICAL_SITE_URL");
  const infisicalProjectId = required(env, "BROWSER_INFISICAL_PROJECT_ID");
  const infisicalClientId = required(env, "BROWSER_INFISICAL_CLIENT_ID");
  const infisicalClientSecret = required(env, "BROWSER_INFISICAL_CLIENT_SECRET");
  // Fail closed on the secret-manager identity too: absolute https URL.
  try {
    const site = new URL(infisicalSiteUrl);
    if (site.protocol !== "https:") {
      throw new ConfigError("BROWSER_INFISICAL_SITE_URL must use https://");
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError("BROWSER_INFISICAL_SITE_URL must be an absolute https:// url");
  }
  const profileRoot = defaultProfileRoot(env);
  return {
    provider,
    tenantId,
    providerAccountId,
    allowedOrigin,
    loginPath,
    infisicalSiteUrl,
    infisicalProjectId,
    infisicalClientId,
    infisicalClientSecret,
    headless: env["BROWSER_WORKER_HEADLESS"] !== "0",
    challengeWaitSeconds: parseChallengeWaitSeconds(env["BROWSER_WORKER_CHALLENGE_WAIT_SECONDS"]),
    profileRoot,
    profileDir: profileDirFor(profileRoot, tenantId, providerAccountId),
  };
}
