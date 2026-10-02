import { describe, expect, it } from "vitest";
import { join, win32 } from "node:path";
import {
  assertSecretUrlAllowed,
  defaultProfileRoot,
  findRepoRoot,
  isWorkerEnabled,
  normalizeAllowedOrigin,
  profileDirFor,
  resolveBindingProvider,
  resolveWorkerConfig,
  validateProfileRoot,
} from "../src/config.js";

const CONTAINER = "D:/tmp/bw-localappdata";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    BROWSER_WORKER_ENABLED: "1",
    BROWSER_WORKER_PROVIDER: "CINEVISION",
    BROWSER_WORKER_TENANT_ID: "tenant-a",
    BROWSER_WORKER_PROVIDER_ACCOUNT_ID: "acct-1",
    CINEVISION_ALLOWED_ORIGIN: "https://panel.example.test",
    CINEVISION_LOGIN_PATH: "/api/auth/login",
    BROWSER_INFISICAL_SITE_URL: "https://infisical.example.test",
    BROWSER_INFISICAL_PROJECT_ID: "proj-1",
    BROWSER_INFISICAL_CLIENT_ID: "id-1",
    BROWSER_INFISICAL_CLIENT_SECRET: "secret-1",
    LOCALAPPDATA: CONTAINER,
    BROWSER_WORKER_PROFILE_ROOT: `${CONTAINER}/iptv-test/profiles`,
  };
}

/** Windows `path.join` emits backslashes — compare separator-insensitively. */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/");
}

describe("worker enabled gate", () => {
  it("is disabled unless BROWSER_WORKER_ENABLED is exactly 1", () => {
    expect(isWorkerEnabled({})).toBe(false);
    expect(isWorkerEnabled({ BROWSER_WORKER_ENABLED: "0" })).toBe(false);
    expect(isWorkerEnabled({ BROWSER_WORKER_ENABLED: "true" })).toBe(false);
    expect(isWorkerEnabled({ BROWSER_WORKER_ENABLED: "1" })).toBe(true);
  });

  it("resolveWorkerConfig fails closed without the flag (no launch)", () => {
    expect(() => resolveWorkerConfig({})).toThrowError(/DISABLED/);
  });
});

describe("single-binding provider + login path", () => {
  it("requires provider CINEVISION (absent/wrong fails closed)", () => {
    expect(resolveBindingProvider({ BROWSER_WORKER_PROVIDER: "CINEVISION" })).toBe("CINEVISION");
    const absent = { ...baseEnv() };
    delete absent["BROWSER_WORKER_PROVIDER"];
    expect(() => resolveWorkerConfig(absent)).toThrowError(/BROWSER_WORKER_PROVIDER/);
    expect(() =>
      resolveWorkerConfig({ ...baseEnv(), BROWSER_WORKER_PROVIDER: "OTHER" }),
    ).toThrowError(/BROWSER_WORKER_PROVIDER/);
  });

  it("requires a valid relative login path (absent/invalid fails closed)", () => {
    const absent = { ...baseEnv() };
    delete absent["CINEVISION_LOGIN_PATH"];
    expect(() => resolveWorkerConfig(absent)).toThrowError(/CINEVISION_LOGIN_PATH/);
    for (const bad of [
      "https://panel.example.test/api/auth/login",
      "/api/auth/login?x=1",
      "/api/../evil",
      "/other/path",
    ]) {
      expect(() => resolveWorkerConfig({ ...baseEnv(), CINEVISION_LOGIN_PATH: bad }), bad).toThrowError(
        /CINEVISION_LOGIN_PATH/,
      );
    }
  });
});

describe("allowed origin + SSRF guard", () => {
  it("accepts a clean https origin", () => {
    expect(normalizeAllowedOrigin("https://panel.example.test")).toBe("https://panel.example.test");
  });

  it("rejects http, paths, queries and hashes", () => {
    expect(() => normalizeAllowedOrigin("http://panel.example.test")).toThrowError();
    expect(() => normalizeAllowedOrigin("https://panel.example.test/app")).toThrowError();
    expect(() => normalizeAllowedOrigin("https://panel.example.test/?x=1")).toThrowError();
    expect(() => normalizeAllowedOrigin("https://panel.example.test/#/sign-in")).toThrowError();
    expect(() => normalizeAllowedOrigin("not-a-url")).toThrowError();
  });

  it("rejects secret urls outside the allowlist or without https", () => {
    const allowed = "https://panel.example.test";
    expect(() => assertSecretUrlAllowed("https://panel.example.test/", allowed)).not.toThrow();
    expect(() => assertSecretUrlAllowed("http://panel.example.test/", allowed)).toThrowError(
      /ORIGIN_MISMATCH/,
    );
    expect(() => assertSecretUrlAllowed("https://evil.example.test/", allowed)).toThrowError(
      /ORIGIN_MISMATCH/,
    );
    expect(() => assertSecretUrlAllowed("https://panel.example.test.evil.test/", allowed)).toThrowError(
      /ORIGIN_MISMATCH/,
    );
  });
});

describe("profile isolation", () => {
  it("derives tenant/account-isolated dirs without raw ids in the path", () => {
    const root = `${CONTAINER}/iptv-test/profiles`;
    const a = profileDirFor(root, "tenant-a", "acct-1");
    const b = profileDirFor(root, "tenant-a", "acct-2");
    const c = profileDirFor(root, "tenant-b", "acct-1");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(profileDirFor(root, "tenant-a", "acct-1")).toBe(a);
    for (const dir of [a, b, c]) {
      expect(normalizeSep(dir).startsWith(normalizeSep(root))).toBe(true);
      expect(dir).not.toContain("tenant-a");
      expect(dir).not.toContain("acct-1");
    }
  });

  it("accepts an override inside the user container, derives the default there", () => {
    expect(defaultProfileRoot({ ...baseEnv(), BROWSER_WORKER_PROFILE_ROOT: `${CONTAINER}/custom` })).toBe(
      validateProfileRoot(`${CONTAINER}/custom`, { LOCALAPPDATA: CONTAINER }),
    );
    const root = defaultProfileRoot({ LOCALAPPDATA: CONTAINER } as NodeJS.ProcessEnv);
    expect(normalizeSep(root).startsWith(normalizeSep(CONTAINER))).toBe(true);
    expect(root).toContain("browser-worker");
  });

  it("rejects relative roots and dangerous ancestors", () => {
    expect(() => validateProfileRoot("relative/path", { LOCALAPPDATA: CONTAINER })).toThrowError();
    expect(() => validateProfileRoot("D:/", { LOCALAPPDATA: CONTAINER })).toThrowError();
  });

  it("rejects a root inside the repo checkout", () => {
    const repo = findRepoRoot();
    expect(repo).not.toBeNull();
    const inside = join(repo as string, "tmp-bw-profiles-test");
    expect(() => validateProfileRoot(inside, { LOCALAPPDATA: CONTAINER })).toThrowError(/repo/);
  });

  it("fails closed when the root leaves the Windows user container", () => {
    expect(() => validateProfileRoot("D:/tmp/outside-container", { LOCALAPPDATA: CONTAINER })).toThrowError(
      /PROFILE_ROOT_OUTSIDE_USER_CONTAINER/,
    );
  });
});

/**
 * Path policy follows the SEMANTICS OF THE PATH, not the host OS: these
 * cases pin the same result on Windows and on Linux CI (the Windows cases
 * used to pass only because the test host was win32).
 */
describe("path semantics", () => {
  it("accepts a Windows path inside the user container on any host", () => {
    const resolved = validateProfileRoot("D:/tmp/bw-localappdata/custom/profiles", { LOCALAPPDATA: CONTAINER });
    expect(normalizeSep(resolved)).toBe(normalizeSep(win32.resolve("D:/tmp/bw-localappdata/custom/profiles")));
    expect(normalizeSep(resolved).startsWith(normalizeSep(CONTAINER))).toBe(true);
  });

  it("fails closed for a Windows path outside the user container on any host", () => {
    expect(() => validateProfileRoot("D:/tmp/outside-container", { LOCALAPPDATA: CONTAINER })).toThrowError(
      /PROFILE_ROOT_OUTSIDE_USER_CONTAINER/,
    );
  });

  it("rejects a Windows drive root as a dangerous ancestor", () => {
    // Not the absolute-path error: a drive root IS absolute in the win32
    // namespace, so it must fail on the fs-root guard.
    expect(() => validateProfileRoot("D:/", { LOCALAPPDATA: CONTAINER })).toThrowError(
      /must not be a filesystem or home root/,
    );
    expect(() => validateProfileRoot("C:\\", { LOCALAPPDATA: CONTAINER })).toThrowError(
      /must not be a filesystem or home root/,
    );
    // Sanity: the UNC share root resolves to its own namespace root.
    expect(win32.parse(win32.resolve("\\\\server\\share")).root).toBe(win32.resolve("\\\\server\\share"));
  });

  it("rejects a Windows drive-relative path as non-absolute", () => {
    expect(() => validateProfileRoot("D:relative", { LOCALAPPDATA: CONTAINER })).toThrowError(
      /must be an absolute path/,
    );
  });

  it("accepts a POSIX path with explicit posix semantics on any host", () => {
    expect(validateProfileRoot("/tmp/bw-profiles-check", {}, { semantics: "posix" })).toBe(
      "/tmp/bw-profiles-check",
    );
  });

  it("rejects a POSIX relative path", () => {
    expect(() => validateProfileRoot("tmp/profiles", {}, { semantics: "posix" })).toThrowError(/absolute/);
  });

  it("rejects a root inside the repo checkout (host namespace)", () => {
    const repo = findRepoRoot();
    expect(repo).not.toBeNull();
    expect(() =>
      validateProfileRoot(join(repo as string, "tmp-bw-profiles-test"), { LOCALAPPDATA: CONTAINER }),
    ).toThrowError(/repo/);
  });

  it("resolves a complete config with Windows paths deterministically", () => {
    const config = resolveWorkerConfig(baseEnv());
    expect(config.provider).toBe("CINEVISION");
    expect(config.allowedOrigin).toBe("https://panel.example.test");
    expect(config.loginPath).toBe("/api/auth/login");
    expect(config.headless).toBe(true);
    const expectedRoot = normalizeSep(`${CONTAINER}/iptv-test/profiles`);
    expect(normalizeSep(config.profileRoot).startsWith(expectedRoot)).toBe(true);
    expect(normalizeSep(config.profileDir).startsWith(expectedRoot)).toBe(true);
    expect(config.profileDir).toContain("p-");
    expect(config.profileDir).not.toContain("tenant-a");
    expect(config.profileDir).not.toContain("acct-1");
  });
});

describe("config validation", () => {
  it("rejects bad tenant/account ids and missing identity", () => {
    const bad = { ...baseEnv(), BROWSER_WORKER_TENANT_ID: "../evil" };
    expect(() => resolveWorkerConfig(bad)).toThrowError();
    const missing = { ...baseEnv() };
    delete missing["BROWSER_INFISICAL_CLIENT_SECRET"];
    expect(() => resolveWorkerConfig(missing)).toThrowError(/BROWSER_INFISICAL_CLIENT_SECRET/);
  });

  it("resolves a complete config", () => {
    const config = resolveWorkerConfig(baseEnv());
    expect(config.provider).toBe("CINEVISION");
    expect(config.allowedOrigin).toBe("https://panel.example.test");
    expect(config.loginPath).toBe("/api/auth/login");
    expect(config.headless).toBe(true);
    expect(normalizeSep(config.profileDir).startsWith(normalizeSep(`${CONTAINER}/iptv-test/profiles`))).toBe(
      true,
    );
  });
});
