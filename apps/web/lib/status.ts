/** Mapeamento canônico status → tom semântico. Apenas apresentação. */

export type StatusTone = "success" | "warn" | "danger" | "neutral" | "info";

const SUCCESS = new Set([
  "ACTIVE",
  "OPEN",
  "SUCCEEDED",
  "PAID",
  "CONFIRMED",
  "SETTLED",
  "RESOLVED",
  "IN_PROGRESS",
  "HUMAN_CONTROL",
  "AUTO",
]);

const WARN = new Set([
  "PENDING",
  "PROCESSING",
  "PROVISIONING",
  "REQUESTED",
  "QUEUED",
  "ACKNOWLEDGED",
  "IN_REVIEW",
  "AWAITING_PAYMENT",
  "AWAITING_CUSTOMER",
  "AWAITING_INTERNAL",
  "RENEWAL_DUE",
  "GRACE",
  "WAITING_CUSTOMER",
  "WAITING_INTERNAL",
  "WAITING_PROVIDER",
  "TRIAGING",
  "NEW",
  "RECONCILING",
  "VERIFYING",
  "WARN",
]);

const DANGER = new Set([
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "OVERDUE",
  "BREACH",
  "DENIED",
  "CHARGEBACK",
  "INVALIDATED",
]);

export function toneFor(status: string): StatusTone {
  const s = status.toUpperCase();
  if (SUCCESS.has(s)) return "success";
  if (WARN.has(s)) return "warn";
  if (DANGER.has(s)) return "danger";
  return "neutral";
}

/** Rótulo pt-BR para valores de SLA do centro HITL. */
export function slaLabel(sla: string): string {
  const s = sla.toUpperCase();
  if (s === "OK") return "Dentro do SLA";
  if (s === "WARN") return "Atenção ao SLA";
  if (s === "BREACH") return "SLA estourado";
  return sla;
}
