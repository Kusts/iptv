export type WahaRiskState = "HEALTHY" | "DEGRADED" | "CAPPED";

export interface WahaRiskEntry {
  state: WahaRiskState;
  reason: string | null;
  updatedAt: Date;
}

const risks = new Map<string, WahaRiskEntry>();

export function riskKeyFor(tenantId: string, channel: string): string {
  return `${tenantId}:${channel.trim().toUpperCase()}`;
}

export function getRiskState(tenantId: string, channel: string): WahaRiskState {
  return risks.get(riskKeyFor(tenantId, channel))?.state ?? "HEALTHY";
}

export function getRiskEntry(tenantId: string, channel: string): WahaRiskEntry | null {
  return risks.get(riskKeyFor(tenantId, channel)) ?? null;
}

export function setRiskState(
  tenantId: string,
  channel: string,
  state: WahaRiskState,
  reason: string | null = null,
): WahaRiskEntry {
  const entry: WahaRiskEntry = { state, reason, updatedAt: new Date() };
  risks.set(riskKeyFor(tenantId, channel), entry);
  return entry;
}

export function resetRiskStateForTests(): void {
  risks.clear();
}

export function riskBlockReason(state: WahaRiskState): string {
  return state === "CAPPED"
    ? "new outreach deferred: channel is capped/timelocked"
    : "new outreach deferred: channel is degraded";
}
