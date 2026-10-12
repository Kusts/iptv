/**
 * Hatchet client environment resolution (F12 vertical slice).
 *
 * Canonical variables (verified against the published SDK
 * `@hatchet-dev/typescript-sdk@1.37.0`, `util/config-loader`):
 * - `HATCHET_CLIENT_TOKEN` (required — the SDK throws without it),
 * - `HATCHET_CLIENT_HOST_PORT` / `HATCHET_CLIENT_API_URL` (endpoint),
 * - `HATCHET_CLIENT_NAMESPACE` (optional isolation prefix).
 *
 * Legacy compat (deprecated, warn-once): `HATCHET_API_TOKEN` maps to the
 * client token and `HATCHET_SERVER_URL` maps to the API URL. Canonical
 * variables win when both are set. An empty string is treated as absent
 * (same rule as `packages/config`'s `emptyToUndefined`).
 *
 * Fail-closed: when no token resolves from either source, resolution
 * reports `ok: false` and the caller must NOT construct a Hatchet client.
 * Secret values are never included in warnings or errors.
 *
 * TLS stays SDK-managed: the provider passes only `{ token, host_port,
 * api_url, namespace }` to `init()` and the SDK's own config loader reads
 * `HATCHET_CLIENT_TLS_*` from the environment (including
 * `HATCHET_CLIENT_TLS_STRATEGY=none` for self-hosted plain-text gRPC), so
 * no TLS mode is selected here.
 */

export interface HatchetEnv {
  HATCHET_CLIENT_TOKEN?: string;
  HATCHET_CLIENT_HOST_PORT?: string;
  HATCHET_CLIENT_API_URL?: string;
  HATCHET_CLIENT_NAMESPACE?: string;
  /** @deprecated legacy name — maps to `HATCHET_CLIENT_TOKEN` with a warning. */
  HATCHET_API_TOKEN?: string;
  /** @deprecated legacy name — maps to `HATCHET_CLIENT_API_URL` with a warning. */
  HATCHET_SERVER_URL?: string;
  /**
   * Fail-closed bootstrap flag (read by `createWorkflowAdapter`, never by
   * `resolveHatchetEnv`): `1`/`true` means a missing/unusable Hatchet setup
   * throws instead of falling back to local. Never a secret.
   */
  HATCHET_REQUIRED?: string;
}

export interface HatchetResolvedConfig {
  token: string;
  hostPort?: string;
  apiUrl?: string;
  namespace?: string;
  /** True when the token came from the legacy `HATCHET_API_TOKEN`. */
  usedLegacyToken: boolean;
  /** True when the endpoint came from the legacy `HATCHET_SERVER_URL`. */
  usedLegacyServerUrl: boolean;
}

export type HatchetEnvResolution =
  | { ok: true; config: HatchetResolvedConfig; warnings: string[] }
  | { ok: false; reason: string };

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function resolveHatchetEnv(env: NodeJS.ProcessEnv | HatchetEnv = process.env): HatchetEnvResolution {
  const warnings: string[] = [];
  const record = env as Record<string, string | undefined>;

  const canonicalToken = record["HATCHET_CLIENT_TOKEN"];
  const legacyToken = record["HATCHET_API_TOKEN"];
  let token: string | undefined;
  let usedLegacyToken = false;
  if (present(canonicalToken)) {
    token = canonicalToken;
    if (present(legacyToken)) {
      warnings.push(
        "[workflows] both HATCHET_CLIENT_TOKEN and legacy HATCHET_API_TOKEN are set; using HATCHET_CLIENT_TOKEN",
      );
    }
  } else if (present(legacyToken)) {
    token = legacyToken;
    usedLegacyToken = true;
    warnings.push(
      "[workflows] HATCHET_API_TOKEN is deprecated; set HATCHET_CLIENT_TOKEN instead (legacy value used for this process)",
    );
  }
  if (!present(token)) {
    return { ok: false, reason: "hatchet is not configured (set HATCHET_CLIENT_TOKEN)" };
  }

  const hostPort = record["HATCHET_CLIENT_HOST_PORT"];
  const apiUrl = record["HATCHET_CLIENT_API_URL"];
  const namespace = record["HATCHET_CLIENT_NAMESPACE"];
  const legacyServerUrl = record["HATCHET_SERVER_URL"];
  let usedLegacyServerUrl = false;
  let resolvedApiUrl: string | undefined;
  if (present(apiUrl)) {
    resolvedApiUrl = apiUrl;
    if (present(legacyServerUrl)) {
      warnings.push(
        "[workflows] both HATCHET_CLIENT_API_URL and legacy HATCHET_SERVER_URL are set; using HATCHET_CLIENT_API_URL",
      );
    }
  } else if (present(legacyServerUrl)) {
    resolvedApiUrl = legacyServerUrl;
    usedLegacyServerUrl = true;
    warnings.push(
      "[workflows] HATCHET_SERVER_URL is deprecated; set HATCHET_CLIENT_API_URL (or HATCHET_CLIENT_HOST_PORT) instead (legacy value used for this process)",
    );
  }

  const config: HatchetResolvedConfig = { token, usedLegacyToken, usedLegacyServerUrl };
  if (present(hostPort)) {
    config.hostPort = hostPort;
  }
  if (present(resolvedApiUrl)) {
    config.apiUrl = resolvedApiUrl;
  }
  if (present(namespace)) {
    config.namespace = namespace;
  }
  return { ok: true, config, warnings };
}
