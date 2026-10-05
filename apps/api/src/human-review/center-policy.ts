import {
  DEFAULT_HITL_SLA_POLICY,
  classifySlaBand,
  parseHitlSlaPolicy,
  type HitlSlaPolicy,
  type SlaBand,
} from "../support/support-policy.js";

/**
 * Wave 8 HITL center read-model helpers (pure, unit-tested).
 *
 * The "center" is NOT a table — it aggregates OPEN work from the existing
 * queues (human reviews, communications exceptions, billing exceptions,
 * recovery tasks and — permission-gated — provider operations parked in
 * `HUMAN_REQUIRED`) into one normalized, tenant-scoped view. Staleness is
 * policy-driven (`hitl.sla` family, safe defaults 4h/24h): an explicit
 * per-item `slaDueAt` (reviews) breaches on deadline first; everything else
 * classifies by age.
 */

export const CENTER_SOURCES = [
  "human_review",
  "comm_exception",
  "billing_exception",
  "recovery_task",
  "provider_operation",
] as const;

export type CenterSource = (typeof CENTER_SOURCES)[number];

/**
 * Provider operations parked in `HUMAN_REQUIRED` reach the center as a
 * read-only fifth source. Two independent boundaries apply:
 *
 * - authorization: the source is opt-in per caller via
 *   `provider.operation.read` (never via `support.ticket.read`), so an
 *   unfiltered center for a support-only caller omits provider rows entirely
 *   and an explicit `?source=provider_operation` is a 403 BEFORE any provider
 *   query runs;
 * - payload minimization: only `id`/`action`/`requested_at` are ever read and
 *   the summary is a fixed constant — no `requested_payload_json`,
 *   `result_summary_json`, `secret_ref`, account/customer identifiers,
 *   evidence, traces or raw adapter errors.
 */
export const PROVIDER_OPERATION_SOURCE = "provider_operation" as const;

/** Permission required to see (or filter by) provider operations. */
export const PROVIDER_OPERATION_CENTER_PERMISSION = "provider.operation.read";

/** Exact status that parks an operation awaiting a human. */
export const PROVIDER_OPERATION_HUMAN_REQUIRED_STATUS = "HUMAN_REQUIRED";

/**
 * Fixed summary for every provider_operation row. Intentionally carries no
 * interpolated provider data: the operator opens the deep link
 * (`GET /v1/provider/operations/:id`) for the authorized detail view.
 */
export const PROVIDER_OPERATION_CENTER_SUMMARY = "provider operation awaiting human resolution";

export type CenterSourcePlan =
  | { readonly kind: "plan"; readonly wanted: CenterSource | null; readonly includeProviderOperations: boolean }
  | { readonly kind: "error"; readonly status: number; readonly code: string; readonly message: string };

/**
 * Pure admission decision for `?source`:
 * unknown → 400; explicit `provider_operation` without
 * `provider.operation.read` → 403 (caller learns only that the permission is
 * missing, and no provider row is read); otherwise a plan where
 * `includeProviderOperations` is true only for an authorized caller — so an
 * unfiltered request from a caller without the permission never includes
 * provider rows.
 */
export function planCenterSources(
  source: string | undefined,
  canReadProviderOperations: boolean,
): CenterSourcePlan {
  if (source === undefined) {
    return {
      kind: "plan",
      wanted: null,
      includeProviderOperations: canReadProviderOperations,
    };
  }
  if (!(CENTER_SOURCES as readonly string[]).includes(source)) {
    return { kind: "error", status: 400, code: "INVALID_SOURCE", message: `unknown center source: ${source}` };
  }
  if (source === PROVIDER_OPERATION_SOURCE && !canReadProviderOperations) {
    return {
      kind: "error",
      status: 403,
      code: "FORBIDDEN",
      message: `missing permission: ${PROVIDER_OPERATION_CENTER_PERMISSION}`,
    };
  }
  return {
    kind: "plan",
    wanted: source as CenterSource,
    includeProviderOperations: source === PROVIDER_OPERATION_SOURCE,
  };
}

/**
 * Normalizes a `provider.provider_operations` row parked in `HUMAN_REQUIRED`
 * into a center item. Only the three fields below are read by the caller;
 * `slaDueAt` is left undefined so the row classifies by age like the other
 * provider-free sources, and `deepLink` points at the IMPLEMENTED read
 * endpoint `GET /v1/provider/operations/:id` (permission
 * `provider.operation.read`) — never the manual resolve command.
 */
export function providerOperationCenterItem(row: {
  id: string;
  action: string;
  requestedAt: Date;
}): CenterItemInput {
  return {
    source: PROVIDER_OPERATION_SOURCE,
    id: row.id,
    kind: `provider_operation/${row.action}`,
    summary: PROVIDER_OPERATION_CENTER_SUMMARY,
    priority: null,
    createdAt: row.requestedAt,
    deepLink: `/v1/provider/operations/${row.id}`,
  };
}

export interface CenterItemInput {
  source: CenterSource;
  id: string;
  kind: string;
  summary: string;
  createdAt: Date;
  slaDueAt?: Date | null;
  deepLink: string;
  priority?: string | null;
}

export interface CenterItem extends CenterItemInput {
  ageMinutes: number;
  sla: SlaBand;
}

export function classifyCenterSla(
  policy: HitlSlaPolicy,
  input: { createdAt: Date; slaDueAt?: Date | null; at: Date },
): SlaBand {
  // An explicit deadline is authoritative: past-due is always a breach,
  // even under a lenient age policy. A future deadline never excuses age
  // staleness — the band is the worse of the two signals.
  if (input.slaDueAt !== undefined && input.slaDueAt !== null && input.at.getTime() > input.slaDueAt.getTime()) {
    return "BREACH";
  }
  return classifySlaBand(policy, { createdAt: input.createdAt, at: input.at });
}

export function normalizeCenterItem(
  policy: HitlSlaPolicy,
  input: CenterItemInput,
  at: Date,
): CenterItem {
  return {
    ...input,
    ageMinutes: Math.max(0, Math.floor((at.getTime() - input.createdAt.getTime()) / 60_000)),
    sla: classifyCenterSla(policy, { createdAt: input.createdAt, slaDueAt: input.slaDueAt, at }),
  };
}

export function resolveSlaPolicy(document: Record<string, unknown> | null): HitlSlaPolicy {
  return parseHitlSlaPolicy(document);
}

export { DEFAULT_HITL_SLA_POLICY };
