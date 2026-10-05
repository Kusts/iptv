import { describe, expect, it } from "vitest";
import {
  DEFAULT_HITL_SLA_POLICY,
  HITL_SLA_POLICY_FAMILY,
  INCIDENT_STATUSES,
  RESOLVE_UNLOCKING_OUTCOMES,
  TICKET_STATUSES,
  classifySlaBand,
  incidentEntryEvent,
  isIncidentTransition,
  isTicketTransition,
  parseHitlSlaPolicy,
  ticketEntryEvent,
  unlocksResolve,
  type IncidentStatus,
  type TicketStatus,
} from "../src/support/support-policy.js";
import {
  CENTER_SOURCES,
  PROVIDER_OPERATION_CENTER_PERMISSION,
  PROVIDER_OPERATION_CENTER_SUMMARY,
  PROVIDER_OPERATION_HUMAN_REQUIRED_STATUS,
  PROVIDER_OPERATION_SOURCE,
  classifyCenterSla,
  normalizeCenterItem,
  planCenterSources,
  providerOperationCenterItem,
  resolveSlaPolicy,
} from "../src/human-review/center-policy.js";
import { rankSuggestions, tokenize } from "../src/knowledge/knowledge-policy.js";

describe("Wave 8 ticket lifecycle (pure)", () => {
  it("status set matches the 010 CHECK exactly", () => {
    expect([...TICKET_STATUSES]).toEqual([
      "NEW",
      "TRIAGING",
      "IN_PROGRESS",
      "WAITING_CUSTOMER",
      "WAITING_INTERNAL",
      "WAITING_PROVIDER",
      "RESOLVED",
      "CLOSED",
      "CANCELLED",
    ]);
  });

  it("SPEC flow is walkable: NEW → TRIAGING → IN_PROGRESS → WAITING_* → RESOLVED → CLOSED", () => {
    for (const pair of [
      ["NEW", "TRIAGING"],
      ["TRIAGING", "IN_PROGRESS"],
      ["IN_PROGRESS", "WAITING_CUSTOMER"],
      ["WAITING_CUSTOMER", "IN_PROGRESS"],
      ["IN_PROGRESS", "WAITING_INTERNAL"],
      ["WAITING_INTERNAL", "RESOLVED"],
      ["IN_PROGRESS", "WAITING_PROVIDER"],
      ["WAITING_PROVIDER", "RESOLVED"],
      ["RESOLVED", "CLOSED"],
    ] as Array<[string, string]>) {
      expect(isTicketTransition(pair[0], pair[1])).toBe(true);
    }
  });

  it("reopen is allowed from RESOLVED/CLOSED only", () => {
    expect(isTicketTransition("RESOLVED", "IN_PROGRESS")).toBe(true);
    expect(isTicketTransition("CLOSED", "IN_PROGRESS")).toBe(true);
    expect(isTicketTransition("CANCELLED", "IN_PROGRESS")).toBe(false);
    expect(isTicketTransition("NEW", "IN_PROGRESS")).toBe(false);
  });

  it("CANCELLED is terminal; CLOSED exits only via reopen", () => {
    for (const status of TICKET_STATUSES) {
      expect(isTicketTransition("CANCELLED", status)).toBe(false);
      expect(isTicketTransition("CLOSED", status)).toBe(status === "IN_PROGRESS");
    }
  });

  it("NEW never resolves directly", () => {
    expect(isTicketTransition("NEW", "RESOLVED")).toBe(false);
    expect(isTicketTransition("TRIAGING", "RESOLVED")).toBe(false);
  });

  it("every status entry maps to a registry-listed event", () => {
    const seen = new Set<string>();
    for (const to of TICKET_STATUSES) {
      for (const from of TICKET_STATUSES) {
        if (isTicketTransition(from, to)) {
          seen.add(ticketEntryEvent(to as TicketStatus, from as TicketStatus));
        }
      }
    }
    expect(seen).toEqual(
      new Set([
        "support.triage_started.v1",
        "support.work_started.v1",
        "support.work_resumed.v1",
        "support.reopened.v1",
        "support.waiting_customer.v1",
        "support.waiting_internal.v1",
        "support.waiting_provider.v1",
        "support.resolved.v1",
        "support.closed.v1",
        "support.cancelled.v1",
      ]),
    );
  });

  it("IN_PROGRESS entry disambiguates fresh vs resumed vs reopened work", () => {
    expect(ticketEntryEvent("IN_PROGRESS", "TRIAGING")).toBe("support.work_started.v1");
    expect(ticketEntryEvent("IN_PROGRESS", "WAITING_CUSTOMER")).toBe("support.work_resumed.v1");
    expect(ticketEntryEvent("IN_PROGRESS", "WAITING_PROVIDER")).toBe("support.work_resumed.v1");
    expect(ticketEntryEvent("IN_PROGRESS", "RESOLVED")).toBe("support.reopened.v1");
    expect(ticketEntryEvent("IN_PROGRESS", "CLOSED")).toBe("support.reopened.v1");
  });

  it("resolve unlocks only on SUCCEEDED/PARTIAL attempts", () => {
    expect([...RESOLVE_UNLOCKING_OUTCOMES]).toEqual(["SUCCEEDED", "PARTIAL"]);
    expect(unlocksResolve("SUCCEEDED")).toBe(true);
    expect(unlocksResolve("PARTIAL")).toBe(true);
    expect(unlocksResolve("FAILED")).toBe(false);
    expect(unlocksResolve("INCONCLUSIVE")).toBe(false);
    expect(unlocksResolve("NOT_APPLICABLE")).toBe(false);
    expect(unlocksResolve(null)).toBe(false);
  });
});

describe("Wave 8 incident lifecycle (pure)", () => {
  it("status set matches the 010 CHECK exactly", () => {
    expect([...INCIDENT_STATUSES]).toEqual(["DETECTED", "CONFIRMED", "MONITORING", "RESOLVED", "CANCELLED"]);
  });

  it("DETECTED → CONFIRMED → MONITORING → RESOLVED with cancellation exits", () => {
    expect(isIncidentTransition("DETECTED", "CONFIRMED")).toBe(true);
    expect(isIncidentTransition("DETECTED", "RESOLVED")).toBe(false);
    expect(isIncidentTransition("CONFIRMED", "MONITORING")).toBe(true);
    expect(isIncidentTransition("MONITORING", "RESOLVED")).toBe(true);
    expect(isIncidentTransition("MONITORING", "CONFIRMED")).toBe(true);
    expect(isIncidentTransition("RESOLVED", "CONFIRMED")).toBe(false);
    expect(isIncidentTransition("CANCELLED", "DETECTED")).toBe(false);
  });

  it("incident entries map to registry-listed events", () => {
    expect(incidentEntryEvent("DETECTED" as IncidentStatus)).toBe("incident.detected.v1");
    expect(incidentEntryEvent("CONFIRMED" as IncidentStatus)).toBe("incident.confirmed.v1");
    expect(incidentEntryEvent("MONITORING" as IncidentStatus)).toBe("incident.updated.v1");
    expect(incidentEntryEvent("RESOLVED" as IncidentStatus)).toBe("incident.resolved.v1");
  });
});

describe("Wave 8 hitl.sla policy (pure)", () => {
  it("family name and safe defaults (warn 4h, breach 24h)", () => {
    expect(HITL_SLA_POLICY_FAMILY).toBe("hitl.sla");
    expect(DEFAULT_HITL_SLA_POLICY).toEqual({ warnAfterHours: 4, breachAfterHours: 24 });
    expect(parseHitlSlaPolicy(null)).toEqual(DEFAULT_HITL_SLA_POLICY);
    expect(resolveSlaPolicy(null)).toEqual(DEFAULT_HITL_SLA_POLICY);
  });

  it("unknown shapes fall back safely; breach clamps to warn", () => {
    expect(parseHitlSlaPolicy({})).toEqual(DEFAULT_HITL_SLA_POLICY);
    expect(parseHitlSlaPolicy({ warn_after_hours: -1, breach_after_hours: "soon" })).toEqual(
      DEFAULT_HITL_SLA_POLICY,
    );
    expect(parseHitlSlaPolicy({ warn_after_hours: 8, breach_after_hours: 48 })).toEqual({
      warnAfterHours: 8,
      breachAfterHours: 48,
    });
    expect(parseHitlSlaPolicy({ warn_after_hours: 48, breach_after_hours: 4 })).toEqual({
      warnAfterHours: 48,
      breachAfterHours: 48,
    });
  });

  it("bands are boundary-exact", () => {
    const policy = { ...DEFAULT_HITL_SLA_POLICY };
    const created = new Date("2026-09-26T00:00:00Z");
    const at = (hours: number) => new Date(created.getTime() + hours * 3_600_000);
    expect(classifySlaBand(policy, { createdAt: created, at: at(3.999) })).toBe("OK");
    expect(classifySlaBand(policy, { createdAt: created, at: at(4) })).toBe("WARN");
    expect(classifySlaBand(policy, { createdAt: created, at: at(23.999) })).toBe("WARN");
    expect(classifySlaBand(policy, { createdAt: created, at: at(24) })).toBe("BREACH");
  });

  it("explicit sla_due_at breaches on deadline; future deadlines never excuse age", () => {
    const policy = { ...DEFAULT_HITL_SLA_POLICY };
    const created = new Date("2026-09-26T00:00:00Z");
    // Past deadline → BREACH even when young.
    expect(
      classifyCenterSla(policy, {
        createdAt: created,
        slaDueAt: new Date("2026-09-26T01:00:00Z"),
        at: new Date("2026-09-26T02:00:00Z"),
      }),
    ).toBe("BREACH");
    // Future deadline + old age → age band still applies.
    expect(
      classifyCenterSla(policy, {
        createdAt: created,
        slaDueAt: new Date("2026-09-30T00:00:00Z"),
        at: new Date("2026-09-27T02:00:00Z"),
      }),
    ).toBe("BREACH");
    expect(
      classifyCenterSla(policy, {
        createdAt: created,
        slaDueAt: null,
        at: new Date("2026-09-26T05:00:00Z"),
      }),
    ).toBe("WARN");
  });

  it("center normalization carries age, band and deep link", () => {
    const policy = { ...DEFAULT_HITL_SLA_POLICY };
    const created = new Date("2026-09-26T00:00:00Z");
    const item = normalizeCenterItem(
      policy,
      {
        source: "human_review",
        id: "r1",
        kind: "APPROVAL/FINANCIAL_REVIEW",
        summary: "refund review",
        createdAt: created,
        deepLink: "/v1/human-reviews/r1",
      },
      new Date("2026-09-26T05:30:00Z"),
    );
    expect(item).toMatchObject({
      source: "human_review",
      ageMinutes: 330,
      sla: "WARN",
      deepLink: "/v1/human-reviews/r1",
    });
  });
});

describe("HITL center provider_operation source (pure)", () => {
  it("provider_operation is a real fifth source bound to provider.operation.read + HUMAN_REQUIRED", () => {
    expect([...CENTER_SOURCES]).toEqual([
      "human_review",
      "comm_exception",
      "billing_exception",
      "recovery_task",
      "provider_operation",
    ]);
    expect(PROVIDER_OPERATION_SOURCE).toBe("provider_operation");
    expect(PROVIDER_OPERATION_CENTER_PERMISSION).toBe("provider.operation.read");
    expect(PROVIDER_OPERATION_HUMAN_REQUIRED_STATUS).toBe("HUMAN_REQUIRED");
  });

  it("unfiltered plan includes provider rows only for an authorized caller", () => {
    expect(planCenterSources(undefined, true)).toEqual({
      kind: "plan",
      wanted: null,
      includeProviderOperations: true,
    });
    expect(planCenterSources(undefined, false)).toEqual({
      kind: "plan",
      wanted: null,
      includeProviderOperations: false,
    });
  });

  it("the four legacy sources behave exactly as before for both callers", () => {
    for (const legacy of ["human_review", "comm_exception", "billing_exception", "recovery_task"] as const) {
      expect(planCenterSources(legacy, true)).toEqual({ kind: "plan", wanted: legacy, includeProviderOperations: false });
      expect(planCenterSources(legacy, false)).toEqual({ kind: "plan", wanted: legacy, includeProviderOperations: false });
    }
  });

  it("explicit provider_operation is 403 without the permission (before any provider read)", () => {
    expect(planCenterSources(PROVIDER_OPERATION_SOURCE, false)).toEqual({
      kind: "error",
      status: 403,
      code: "FORBIDDEN",
      message: `missing permission: ${PROVIDER_OPERATION_CENTER_PERMISSION}`,
    });
    expect(planCenterSources(PROVIDER_OPERATION_SOURCE, true)).toEqual({
      kind: "plan",
      wanted: PROVIDER_OPERATION_SOURCE,
      includeProviderOperations: true,
    });
  });

  it("an unknown source stays 400 even when the permission is missing", () => {
    for (const canRead of [true, false]) {
      expect(planCenterSources("nope", canRead)).toEqual({
        kind: "error",
        status: 400,
        code: "INVALID_SOURCE",
        message: "unknown center source: nope",
      });
    }
  });

  it("the provider item exposes only id/action/requested_at with a fixed generic summary", () => {
    const item = providerOperationCenterItem({
      id: "11111111-1111-4111-8111-111111111111",
      action: "trial.provision",
      requestedAt: new Date("2026-10-02T00:00:00Z"),
    });
    expect(item).toEqual({
      source: "provider_operation",
      id: "11111111-1111-4111-8111-111111111111",
      kind: "provider_operation/trial.provision",
      summary: PROVIDER_OPERATION_CENTER_SUMMARY,
      priority: null,
      createdAt: new Date("2026-10-02T00:00:00Z"),
      deepLink: "/v1/provider/operations/11111111-1111-4111-8111-111111111111",
    });
    // O resumo é constante: nenhum campo da operação entra na linha.
    expect(item.summary).toBe(PROVIDER_OPERATION_CENTER_SUMMARY);
    expect(Object.keys(item).sort()).toEqual([
      "createdAt",
      "deepLink",
      "id",
      "kind",
      "priority",
      "source",
      "summary",
    ]);
  });
});

describe("Wave 8 knowledge suggest heuristic (pure)", () => {
  it("tokenizes with normalization + stopwords + dedupe", () => {
    expect(tokenize("Playback TRAVA no app! e o buffering...")).toEqual(
      expect.arrayContaining(["playback", "trava", "app", "buffering"]),
    );
    expect(tokenize("o e de para um uma")).toEqual([]);
    expect(tokenize("App app APP")).toEqual(["app"]);
  });

  it("ranks by distinct overlap, drops zero scores, caps at limit", () => {
    const ranked = rankSuggestions(["playback", "trava", "app"], [
      { id: "b", text: "reinicie o app e teste o playback" },
      { id: "a", text: "guia de playback com trava resolvida no app" },
      { id: "c", text: "fatura e cobrança" },
    ], 10);
    expect(ranked.map((r) => r.id)).toEqual(["a", "b"]);
    expect(ranked[0]).toMatchObject({ score: 3, matchedTerms: ["app", "playback", "trava"] });
    expect(rankSuggestions(["x"], [{ id: "a", text: "nada" }], 5)).toEqual([]);
  });
});
