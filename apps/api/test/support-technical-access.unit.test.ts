import { describe, expect, it } from "vitest";
import {
  TECHNICAL_ACCESS_DEFAULT_DURATION_MINUTES,
  TECHNICAL_ACCESS_MAX_DURATION_MINUTES,
  TECHNICAL_ACCESS_MIN_DURATION_MINUTES,
  TECHNICAL_ACCESS_STATUSES,
  isTechnicalAccessActive,
  isTechnicalAccessReasonValid,
  isTechnicalAccessStatus,
  resolveTechnicalAccessExpiry,
} from "../src/support/support-policy.js";
import { technicalAccessGrantInput } from "../src/support/support.commands.js";

describe("G12 technical access policy (pure)", () => {
  it("status set is distinct from trial lifecycle", () => {
    expect([...TECHNICAL_ACCESS_STATUSES]).toEqual(["ACTIVE", "EXPIRED", "REVOKED"]);
    expect(TECHNICAL_ACCESS_STATUSES).not.toContain("REQUESTED");
    expect(TECHNICAL_ACCESS_STATUSES).not.toContain("PROVISIONING");
    expect(isTechnicalAccessStatus("ACTIVE")).toBe(true);
    expect(isTechnicalAccessStatus("REQUESTED")).toBe(false);
    expect(isTechnicalAccessStatus("ENDED")).toBe(false);
  });

  it("reason is mandatory and bounded", () => {
    expect(isTechnicalAccessReasonValid("playback travando apos reativacao")).toBe(true);
    expect(isTechnicalAccessReasonValid("")).toBe(false);
    expect(isTechnicalAccessReasonValid("   ")).toBe(false);
    expect(isTechnicalAccessReasonValid("x".repeat(501))).toBe(false);
    expect(isTechnicalAccessReasonValid("x".repeat(500))).toBe(true);
  });

  it("duration bounds keep a usable default", () => {
    expect(TECHNICAL_ACCESS_MIN_DURATION_MINUTES).toBe(1);
    expect(TECHNICAL_ACCESS_MAX_DURATION_MINUTES).toBe(10080);
    expect(TECHNICAL_ACCESS_DEFAULT_DURATION_MINUTES).toBe(180);
  });

  it("expiry resolves from grant time plus duration", () => {
    const grantedAt = new Date("2026-09-29T12:00:00.000Z");
    expect(resolveTechnicalAccessExpiry(grantedAt, 180).toISOString()).toBe("2026-09-29T15:00:00.000Z");
    expect(resolveTechnicalAccessExpiry(grantedAt, 60).toISOString()).toBe("2026-09-29T13:00:00.000Z");
  });

  it("active requires ACTIVE status with a future expiry", () => {
    const expiresAt = new Date("2026-09-29T15:00:00.000Z");
    expect(
      isTechnicalAccessActive({ status: "ACTIVE", expiresAt, at: new Date("2026-09-29T14:00:00.000Z") }),
    ).toBe(true);
    expect(
      isTechnicalAccessActive({ status: "ACTIVE", expiresAt, at: new Date("2026-09-29T15:00:00.000Z") }),
    ).toBe(false);
    expect(
      isTechnicalAccessActive({ status: "REVOKED", expiresAt, at: new Date("2026-09-29T14:00:00.000Z") }),
    ).toBe(false);
  });
});

describe("G12 technical access input", () => {
  const personId = "11111111-1111-4111-8111-111111111111";
  const ticketId = "22222222-2222-4222-8222-222222222222";

  it("accepts ticket plus reason with expiry", () => {
    const parsed = technicalAccessGrantInput.safeParse({
      personId,
      ticketId,
      reason: "ex-cliente sem sinal apos retorno",
      durationMinutes: 180,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a grant without ticket or reason", () => {
    expect(
      technicalAccessGrantInput.safeParse({ personId, reason: "motivo presente" }).success,
    ).toBe(false);
    expect(
      technicalAccessGrantInput.safeParse({ personId, ticketId, reason: "   " }).success,
    ).toBe(false);
    expect(technicalAccessGrantInput.safeParse({ personId, ticketId }).success).toBe(false);
  });

  it("rejects out-of-range durations", () => {
    expect(
      technicalAccessGrantInput.safeParse({ personId, ticketId, reason: "motivo", durationMinutes: 0 })
        .success,
    ).toBe(false);
    expect(
      technicalAccessGrantInput.safeParse({ personId, ticketId, reason: "motivo", durationMinutes: 20000 })
        .success,
    ).toBe(false);
  });
});
