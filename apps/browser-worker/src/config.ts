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
 *
 * Path policy is decided by the SEMANTICS OF THE PATH, not by the host OS
 * (`./pathSemantics.js`): a Windows deployment path (`D:/...`, UNC) is
 * validated with the win32 rules on every host, so the same config is
 * accepted in CI and in production. Host-fs comparisons (repo checkout,
 * home dir) apply only when the path semantics matches the host namespace.
 * Every fail-closed guarantee is preserved and errors never echo the value.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { BINDING_PROVIDER } from "./constants.js";
import {
  detectPathSemantics,
  hasWindowsPathMarker,
  pathApiFor,
  pathApiForPath,
  type PathApi,
  type PathSemantics,
} from "./pathSemantics.js";
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
  /** Total per-command budget (ms). Exceeded → INCONCLUSIVE/TRANSPORT. */
  commandTimeoutMs: number;
  /**
   * Bounded wait for a canceled launch to settle + its tardy context to
   * close before the profile lock may be released (ms, F1). Optional so
   * existing programmatic configs keep compiling; resolved configs
   * always carry the value.
   */
  launchSettleMs?: number;
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

/**
 * Total per-command budget from `BROWSER_WORKER_COMMAND_TIMEOUT_MS`.
 * Default 60s, clamped to 5s–300s; invalid values fall back to 60s.
 * Exceeding the budget fails closed (INCONCLUSIVE/TRANSPORT) — no
 * unbounded command execution, no infinite loops.
 */
export function parseCommandTimeoutMs(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value.length === 0) return 60_000;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 5_000 || n > 300_000) return 60_000;
  return n;
}

/**
 * Bounded launch-quiescence wait from
 * `BROWSER_WORKER_LAUNCH_SETTLE_MS` (F1): how long an abort/timeout path
 * waits for a pending `launchPersistentContext` to settle and its tardy
 * context to close before the profile lock may be released. Default
 * 3000ms, clamped to 500ms–15000ms; invalid values fall back to 3000ms.
 * Exceeding the bound fails closed by HOLDING the lock (stale-PID
 * recovery frees it once this process exits) — never by announcing the
 * profile as available while Chromium may still be starting on it.
 */
export function parseLaunchSettleMs(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value.length === 0) return 3000;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 500 || n > 15_000) return 3000;
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

/** Host namespace: win32 on Windows, posix elsewhere. */
function hostPathSemantics(): PathSemantics {
  return platform() === "win32" ? "windows" : "posix";
}

/**
 * Container semantics inferred from env alone (no host fallback for the
 * Windows variables): `LOCALAPPDATA` (or `XDG_STATE_HOME`) carrying an
 * unambiguous Windows marker selects windows; otherwise the host default.
 * This is what makes `defaultProfileRoot({ LOCALAPPDATA: "D:/..." })`
 * deterministic on Linux as well as on Windows.
 */
function containerSemanticsFromEnv(env: NodeJS.ProcessEnv): PathSemantics {
  for (const name of ["LOCALAPPDATA", "XDG_STATE_HOME"] as const) {
    const raw = env[name];
    if (raw !== undefined && hasWindowsPathMarker(raw.trim())) return "windows";
  }
  return hostPathSemantics();
}

/**
 * User container whose ACLs isolate the profile. Explicit `semantics` wins
 * (windows container = `%LOCALAPPDATA%` or `~/AppData/Local`; posix
 * container = `$XDG_STATE_HOME` or `~/.local/state`), joined and resolved
 * with that namespace's api. When omitted, semantics come from
 * `containerSemanticsFromEnv` so the Windows deployment layout stays
 * deterministic on a posix host.
 */
export function userContainerDir(
  env: NodeJS.ProcessEnv = process.env,
  semantics: PathSemantics = containerSemanticsFromEnv(env),
): string {
  if (semantics === "windows") {
    const api = pathApiFor("windows");
    const raw = env["LOCALAPPDATA"];
    const base = raw !== undefined && raw.trim().length > 0 ? raw.trim() : api.join(homedir(), "AppData", "Local");
    return api.resolve(base);
  }
  const api = pathApiFor("posix");
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg.trim().length > 0) {
    return api.resolve(xdg.trim());
  }
  return api.resolve(api.join(homedir(), ".local", "state"));
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

/** True when `candidate` is `base` or nested inside it (namespace-aware). */
function isInsideOrEqual(api: PathApi, base: string, candidate: string): boolean {
  const rel = api.relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel));
}

/**
 * Validate a profile root: absolute, not a dangerous ancestor (fs root,
 * home dir itself), never inside the repo checkout, and â€” in the Windows
 * namespace â€” strictly inside the `%LOCALAPPDATA%` user container. Returns
 * the resolved path (in the path's own semantics). Throws `ConfigError` with
 * fixed words (never echoes the value).
 *
 * `opts.semantics` pins the namespace; otherwise it is detected from the
 * path itself, so a Windows deployment path validates identically on a
 * posix host. Host-fs guards (repo checkout, home dir) only apply when the
 * host namespace matches the path namespace. This function is the PURE
 * policy engine: for a foreign-namespace path it reasons in that path's
 * own namespace, and the resolved result must never be handed to the HOST
 * filesystem (on posix a windows path is a relative filename there) —
 * runtime consumers go through `defaultProfileRoot`, which enforces the
 * host-namespace boundary. Throws `ConfigError` with fixed words (never
 * echoes the value).
 */
export function validateProfileRoot(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { semantics?: PathSemantics } = {},
): string {
  const trimmed = root.trim();
  const api = opts.semantics !== undefined ? pathApiFor(opts.semantics) : pathApiForPath(trimmed);
  if (trimmed.length === 0 || !api.isAbsolute(trimmed)) {
    throw new ConfigError("PROFILE_ROOT must be an absolute path");
  }
  const resolved = api.resolve(trimmed);
  if (resolved === api.parse(resolved).root) {
    throw new ConfigError("PROFILE_ROOT must not be a filesystem or home root");
  }
  if (api.semantics === hostPathSemantics() && resolved === pathApiFor(api.semantics).resolve(homedir())) {
    throw new ConfigError("PROFILE_ROOT must not be a filesystem or home root");
  }
  const repoRoot = findRepoRoot();
  if (repoRoot !== null && detectPathSemantics(repoRoot) === api.semantics) {
    if (isInsideOrEqual(api, repoRoot, resolved)) {
      throw new ConfigError("PROFILE_ROOT must stay outside the repo checkout");
    }
  }
  if (api.semantics === "windows") {
    const container = userContainerDir(env, "windows");
    // STRICTLY inside: `relative()` is the comparison (win32 is
    // case-insensitive), so a case-variant spelling of the container itself
    // is rejected too — raw string equality would let `d:\x` slip past a
    // `D:\X` container.
    const rel = api.relative(container, resolved);
    if (rel === "" || rel.startsWith("..") || api.isAbsolute(rel)) {
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
 * Runtime platform profile root OUTSIDE the repo. `BROWSER_WORKER_PROFILE_ROOT`
 * is a restricted override: when set it must still pass
 * `validateProfileRoot`. The namespace is inferred (override markers, else
 * env markers, else the host), and — RUNTIME BOUNDARY — the result must
 * carry the HOST namespace: this path is handed to the native filesystem
 * and Playwright, where a foreign-namespace path would be reinterpreted
 * (on posix, `D:\x` is a relative filename that could land inside the
 * checkout — fail-open vs the outside-repo guarantee). Cross-host policy
 * validation lives in the pure `validateProfileRoot`/tests; runtime
 * resolution fails closed on a namespace mismatch. `opts.hostSemantics`
 * overrides the host for tests (a Windows deployment resolution can then
 * be exercised deterministically on any host).
 */
export function defaultProfileRoot(
  env: NodeJS.ProcessEnv = process.env,
  opts: { hostSemantics?: PathSemantics } = {},
): string {
  const hostSemantics = opts.hostSemantics ?? hostPathSemantics();
  const override = env["BROWSER_WORKER_PROFILE_ROOT"];
  if (override !== undefined && override.trim().length > 0) {
    const semantics = detectPathSemantics(override.trim());
    if (semantics !== hostSemantics) {
      throw new ConfigError("PROFILE_ROOT semantics must match the host platform");
    }
    return validateProfileRoot(override, env, { semantics });
  }
  const semantics = containerSemanticsFromEnv(env);
  if (semantics !== hostSemantics) {
    throw new ConfigError("PROFILE_ROOT semantics must match the host platform");
  }
  const api = pathApiFor(semantics);
  const base = userContainerDir(env, semantics);
  const leaf =
    semantics === "windows"
      ? api.join(base, "iptv", "browser-worker", "profiles")
      : api.join(base, "iptv-browser-worker", "profiles");
  return validateProfileRoot(leaf, env, { semantics });
}

/**
 * Tenant/account-isolated profile dir: `sha256(tenantId + NUL +
 * providerAccountId)` hex. Raw ids never appear in the path. Joined with
 * the root's own semantics so a Windows root keeps win32 separators on any
 * host.
 */
export function profileDirFor(root: string, tenantId: string, providerAccountId: string): string {
  const digest = createHash("sha256")
    .update(tenantId, "utf8")
    .update("\0", "utf8")
    .update(providerAccountId, "utf8")
    .digest("hex");
  return pathApiForPath(root).join(root, `p-${digest.slice(0, 32)}`);
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

/**
 * Resolve and validate the full worker config. Throws `ConfigError`.
 * `opts.hostSemantics` overrides the host namespace for the profile-root
 * runtime boundary (test seam — see `defaultProfileRoot`).
 */
export function resolveWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { hostSemantics?: PathSemantics } = {},
): WorkerConfig {
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
  const profileRoot = defaultProfileRoot(env, opts);
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
    commandTimeoutMs: parseCommandTimeoutMs(env["BROWSER_WORKER_COMMAND_TIMEOUT_MS"]),
    launchSettleMs: parseLaunchSettleMs(env["BROWSER_WORKER_LAUNCH_SETTLE_MS"]),
    profileRoot,
    profileDir: profileDirFor(profileRoot, tenantId, providerAccountId),
  };
}
