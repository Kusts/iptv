/**
 * Command primitives (W1-06): explicit command names, tenant from context,
 * Zod-validated input, permission-gated. Results are a discriminated union —
 * handlers never leak raw errors; unexpected throws are programmer bugs.
 */

/** Terminal result of a command execution. */
export type CommandResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; code: "validation_failed"; message: string; issues?: unknown }
  | { ok: false; code: "forbidden"; message: string }
  | { ok: false; code: "not_found"; message: string }
  | { ok: false; code: "precondition_failed"; message: string };

export type CommandResultCode = "ok" | "validation_failed" | "forbidden" | "not_found" | "precondition_failed";

export function resultCode<T>(result: CommandResult<T>): CommandResultCode {
  return result.ok ? "ok" : result.code;
}

/** Static command metadata: name, required permission, idempotency scope. */
export interface CommandMeta {
  /** Explicit command name, e.g. `human_review.request`. */
  name: string;
  /** Permission key enforced server-side before input parsing. */
  permission: string;
  /**
   * Idempotency scope for `platform.idempotency_keys` (defaults to `name`).
   * Distinct scopes isolate key namespaces between commands.
   */
  idempotencyScope?: string;
}

export function idempotencyScopeOf(meta: CommandMeta): string {
  return meta.idempotencyScope ?? meta.name;
}

/** Actor context resolved server-side (tenant never comes from input). */
export interface CommandActor {
  userId: string;
  isPlatformAdmin: boolean;
  /** Active tenant; null only before a tenant is selected (→ forbidden). */
  tenantId: string | null;
  roleKeys: string[];
  permissions: string[];
  actorType: "system" | "agent" | "human" | "external";
}

/** HTTP mapping for the result union (never raw 500s for known failures). */
export function commandResultHttpStatus<T>(result: CommandResult<T>): number {
  if (result.ok) {
    return 200;
  }
  switch (result.code) {
    case "validation_failed":
      return 400;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "precondition_failed":
      return 409;
  }
}
