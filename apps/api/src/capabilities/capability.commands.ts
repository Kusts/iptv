import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";

/**
 * Capability registry commands (W1-10).
 *
 * - `capability.register` inserts a global catalog row (platform-admin-only;
 *   tool existence never implies authorization — permissions + policy still
 *   gate every action).
 * - `capability.set_availability` flips availability and appends an
 *   `platform.capability_events` row in the same transaction.
 */

export const AVAILABILITY = ["AVAILABLE", "DEGRADED", "UNAVAILABLE"] as const;
export const CERTIFICATION = ["UNCERTIFIED", "SANDBOX_CERTIFIED", "CERTIFIED"] as const;
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const registerCapabilityInput = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "capability key must be a lowercase dotted path"),
  ownerContext: z.string().trim().min(1).max(120),
  policyFamily: z.string().trim().min(1).max(120),
  permissions: z.array(z.string().trim().min(1).max(120)).default([]),
  availability: z.enum(AVAILABILITY).default("AVAILABLE"),
  certificationStatus: z.enum(CERTIFICATION).default("UNCERTIFIED"),
  riskLevel: z.enum(RISK_LEVELS).default("LOW"),
  mvpPhase: z.string().trim().max(60).default(""),
  manualEquivalent: z.string().trim().max(300).default(""),
  degradation: z.string().trim().max(500).default(""),
});

export type RegisterCapabilityInput = z.infer<typeof registerCapabilityInput>;

export const setAvailabilityInput = z.object({
  key: z.string().trim().min(1).max(120),
  availability: z.enum(AVAILABILITY),
  reason: z.string().trim().max(500).default(""),
});

export type SetAvailabilityInput = z.infer<typeof setAvailabilityInput>;

function requirePlatformAdmin(ctx: CommandHandlerContext): CommandResult<never> | null {
  if (ctx.actor.isPlatformAdmin) {
    return null;
  }
  return { ok: false, code: "forbidden", message: "only platform admins manage the capability catalog" };
}

async function handleRegister(
  ctx: CommandHandlerContext,
  input: RegisterCapabilityInput,
): Promise<CommandResult<{ key: string }>> {
  const denied = requirePlatformAdmin(ctx);
  if (denied !== null) {
    return denied;
  }
  const existing = await ctx.tx.getCapability(input.key);
  if (existing !== null) {
    return { ok: false, code: "precondition_failed", message: `capability already registered: ${input.key}` };
  }
  // Every tool declares tenant scope: the catalog row itself is global, so
  // resolution stays tenant-scoped via actor + policy (see ActionGate).
  const stored = await ctx.tx.createCapability({
    key: input.key,
    ownerContext: input.ownerContext,
    availability: input.availability,
    certificationStatus: input.certificationStatus,
    riskLevel: input.riskLevel,
    mvpPhase: input.mvpPhase,
    manualEquivalent: input.manualEquivalent,
    policyFamily: input.policyFamily,
    degradation: input.degradation,
    permissions: input.permissions,
  });
  return { ok: true, data: { key: stored.key } };
}

async function handleSetAvailability(
  ctx: CommandHandlerContext,
  input: SetAvailabilityInput,
): Promise<CommandResult<{ key: string; availability: string }>> {
  const denied = requirePlatformAdmin(ctx);
  if (denied !== null) {
    return denied;
  }
  const stored = await ctx.tx.setCapabilityAvailability(
    input.key,
    input.availability,
    input.reason,
    ctx.actor.userId,
  );
  if (stored === null) {
    return { ok: false, code: "not_found", message: `capability not found: ${input.key}` };
  }
  return { ok: true, data: { key: stored.key, availability: stored.availability } };
}

export function registerCapabilityCommands(bus: CommandBus): void {
  bus.register<RegisterCapabilityInput, { key: string }>({
    name: "capability.register",
    permission: "settings.manage",
    auditAction: "capability.register",
    auditResource: "capability",
    input: registerCapabilityInput,
    handler: handleRegister,
  });
  bus.register<SetAvailabilityInput, { key: string; availability: string }>({
    name: "capability.set_availability",
    permission: "settings.manage",
    auditAction: "capability.set_availability",
    auditResource: "capability",
    input: setAvailabilityInput,
    handler: handleSetAvailability,
  });
}
