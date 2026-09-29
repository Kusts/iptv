import { resetRiskStateForTests } from "./waha-risk-state.js";

const bindings = new Map<string, string>();

export function defaultSessionFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["WAHA_SESSION"];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "default";
}

export function expectedSessionFor(tenantId: string, env: NodeJS.ProcessEnv = process.env): string {
  return bindings.get(tenantId) ?? defaultSessionFromEnv(env);
}

export function bindSession(tenantId: string, session: string): void {
  bindings.set(tenantId, session);
}

export function clearSessionBindingsForTests(): void {
  bindings.clear();
  resetRiskStateForTests();
}

export type SessionValidation = { ok: true; session: string } | { ok: false; expected: string; observed: string };

export function validateSessionForTenant(
  tenantId: string,
  observed: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SessionValidation {
  const expected = expectedSessionFor(tenantId, env);
  if (observed === null || observed === undefined || observed.length === 0) {
    return { ok: true, session: expected };
  }
  if (observed !== expected) {
    return { ok: false, expected, observed };
  }
  return { ok: true, session: expected };
}

export type RestartValidation = { ok: true; session: string } | { ok: false; expected: string; observed: string };

export function noteSessionRestart(
  tenantId: string,
  observed: string,
  env: NodeJS.ProcessEnv = process.env,
): RestartValidation {
  const checked = validateSessionForTenant(tenantId, observed, env);
  if (!checked.ok) {
    return checked;
  }
  return { ok: true, session: checked.session };
}
