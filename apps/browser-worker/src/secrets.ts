/**
 * Credential resolution — fixed refs only, with per-invocation env override.
 *
 * The worker resolves exactly the three CINEVISION refs from
 * `FIXED_SECRET_REFS` through its OWN Infisical identity
 * (`BROWSER_INFISICAL_*`). It never reads the API `INFISICAL_*` vars and
 * never accepts caller-supplied refs/URLs.
 *
 * S4A per-invocation override (Issue #88, etapas 1-2): when the child
 * process is spawned per tenant/account, the API passes that binding's
 * credentials via `CINEVISION_EMAIL` + `CINEVISION_PASSWORD`. When BOTH are
 * present (non-empty after trimming), they win over the fixed refs and the
 * vault is touched ONLY for the panel URL. An empty value counts as absent
 * (repo loader convention: `KEY=` is AUSENTE). A PARTIAL override (only one
 * of the two present) fails closed — never mix a tenant user with the
 * deployment password. Values are NEVER logged: errors carry fixed code
 * words only, and the child inherits only the necessary env (see API
 * `cinevision-worker-probe.ts`).
 */

import { FIXED_SECRET_REFS } from "./constants.js";
import { InfisicalSecretsAdapter, type SecretsPort } from "@iptv/secrets";
import type { WorkerConfig } from "./config.js";

export interface WorkerCredentials {
  /** CINEVISION panel base URL (origin-checked before navigation). */
  panelUrl: string;
  email: string;
  password: string;
}

export class CredentialError extends Error {
  constructor(detail: string) {
    super(`browser-worker credentials: ${detail}`);
    this.name = "CredentialError";
  }
}

/** Build the worker's own secrets port from the `BROWSER_INFISICAL_*` identity. */
export function buildWorkerSecretsPort(config: WorkerConfig): SecretsPort {
  return new InfisicalSecretsAdapter({
    siteUrl: config.infisicalSiteUrl,
    projectId: config.infisicalProjectId,
    clientId: config.infisicalClientId,
    clientSecret: config.infisicalClientSecret,
    defaultEnvironment: "dev",
  });
}

/**
 * Resolve exactly the fixed CINEVISION refs, in order
 * [URL, EMAIL, PASSWORD]. Values are non-empty; failures throw
 * `CredentialError` with a fixed code word (never the value/ref detail).
 *
 * When `env` carries BOTH `CINEVISION_EMAIL` and `CINEVISION_PASSWORD`
 * (non-empty), they win over the fixed EMAIL/PASSWORD refs (the vault is
 * then read ONLY for the panel URL). A partial override fails closed.
 * Defaults to `process.env` so existing call sites keep working.
 */
export async function resolveCredentials(
  port: SecretsPort,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerCredentials> {
  const [urlRef, emailRef, passwordRef] = FIXED_SECRET_REFS;
  let panelUrl: string;
  try {
    panelUrl = (await port.getSecret(urlRef)).trim();
  } catch {
    throw new CredentialError("SECRET_UNAVAILABLE");
  }
  const envEmail = (env["CINEVISION_EMAIL"] ?? "").trim();
  const envPassword = (env["CINEVISION_PASSWORD"] ?? "").trim();
  const hasEmail = envEmail.length > 0;
  const hasPassword = envPassword.length > 0;
  if (hasEmail || hasPassword) {
    if (!hasEmail || !hasPassword) {
      throw new CredentialError("SECRET_UNAVAILABLE (partial credential override)");
    }
    if (panelUrl.length === 0) {
      throw new CredentialError("SECRET_UNAVAILABLE (empty value)");
    }
    return { panelUrl, email: envEmail, password: envPassword };
  }
  let email: string;
  let password: string;
  try {
    email = (await port.getSecret(emailRef)).trim();
    password = (await port.getSecret(passwordRef)).trim();
  } catch {
    throw new CredentialError("SECRET_UNAVAILABLE");
  }
  if (panelUrl.length === 0 || email.length === 0 || password.length === 0) {
    throw new CredentialError("SECRET_UNAVAILABLE (empty value)");
  }
  return { panelUrl, email, password };
}
