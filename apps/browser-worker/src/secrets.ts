/** Per-invocation CINEVISION credentials supplied by the operator/API. */
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

export async function resolveCredentials(
  allowedOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerCredentials> {
  if (allowedOrigin.trim().length === 0) {
    throw new CredentialError("SECRET_UNAVAILABLE");
  }
  const email = (env["CINEVISION_EMAIL"] ?? "").trim();
  const password = (env["CINEVISION_PASSWORD"] ?? "").trim();
  if ((email.length === 0) !== (password.length === 0)) {
    throw new CredentialError("SECRET_UNAVAILABLE (partial credential override)");
  }
  if (email.length === 0 || password.length === 0) {
    throw new CredentialError("SECRET_UNAVAILABLE");
  }
  return { panelUrl: allowedOrigin, email, password };
}
