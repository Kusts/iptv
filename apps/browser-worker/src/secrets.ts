/**
 * Credential resolution — fixed refs only.
 *
 * The worker resolves exactly the three CINEVISION refs from
 * `FIXED_SECRET_REFS` through its OWN Infisical identity
 * (`BROWSER_INFISICAL_*`). It never reads the API `INFISICAL_*` vars and
 * never accepts caller-supplied refs/URLs.
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
 */
export async function resolveCredentials(port: SecretsPort): Promise<WorkerCredentials> {
  const [urlRef, emailRef, passwordRef] = FIXED_SECRET_REFS;
  let panelUrl: string;
  let email: string;
  let password: string;
  try {
    panelUrl = (await port.getSecret(urlRef)).trim();
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
