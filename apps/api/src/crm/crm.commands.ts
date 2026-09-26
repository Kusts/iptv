import { z } from "zod";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type {
  CommandBus,
  CommandHandlerContext,
} from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf, memoryStateOf } from "./wave2-store.js";

/**
 * Wave 2 CRM slice (commands only; queries live in the controller).
 *
 * Canonical rules enforced here:
 * - `User` != `Person`; `Person` lives inside ONE tenant (every write is
 *   tenant-scoped, tenant comes from the actor context).
 * - `Lead`/`Customer` are relationships around `Person`. This slice NEVER
 *   creates `crm.customers` (settled economic conversion is Wave 5).
 * - Lead statuses are EXACTLY the `leads_status_check` set from migration
 *   002: NEW|CONTACTED|QUALIFIED|ENGAGED|OFFERED|CONVERTED|NURTURE|LOST|DISQUALIFIED.
 * - Events `person.created.v1` / `lead.created.v1` are registry-listed
 *   (event catalog), so they are emitted. No other CRM events are invented.
 */

export const LEAD_STATUSES = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "ENGAGED",
  "OFFERED",
  "CONVERTED",
  "NURTURE",
  "LOST",
  "DISQUALIFIED",
] as const;

/** Owning-context transitions (subset of the status CHECK set, explicit). */
const LEAD_TRANSITIONS: Record<string, readonly string[]> = {
  NEW: ["CONTACTED", "DISQUALIFIED", "NURTURE"],
  CONTACTED: ["QUALIFIED", "ENGAGED", "DISQUALIFIED", "NURTURE", "LOST"],
  QUALIFIED: ["ENGAGED", "OFFERED", "LOST", "DISQUALIFIED"],
  ENGAGED: ["OFFERED", "QUALIFIED", "NURTURE", "LOST"],
  OFFERED: ["CONVERTED", "LOST", "NURTURE"],
  CONVERTED: [],
  NURTURE: ["CONTACTED", "QUALIFIED", "DISQUALIFIED"],
  LOST: ["NURTURE"],
  DISQUALIFIED: ["NURTURE"],
};

export const registerPersonInput = z.object({
  canonicalName: z.string().trim().min(1).max(200).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  identities: z
    .array(
      z.object({
        identityType: z.string().trim().min(1).max(64),
        normalizedValue: z.string().trim().min(1).max(320),
      }),
    )
    .max(10)
    .default([]),
});

export type RegisterPersonInput = z.infer<typeof registerPersonInput>;

export const captureLeadInput = z.object({
  personId: z.string().uuid(),
  stage: z.string().trim().min(1).max(64).optional(),
});

export type CaptureLeadInput = z.infer<typeof captureLeadInput>;

export const transitionLeadInput = z.object({
  leadId: z.string().uuid(),
  toStatus: z.enum(LEAD_STATUSES),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type TransitionLeadInput = z.infer<typeof transitionLeadInput>;

function normalizeIdentity(identityType: string, value: string): string {
  const trimmed = value.trim();
  return identityType === "WHATSAPP" ? trimmed.replace(/[^+\d]/g, "") || trimmed : trimmed;
}

async function handlePersonRegister(
  ctx: CommandHandlerContext,
  input: RegisterPersonInput,
): Promise<CommandResult<{ id: string }>> {
  const trx = kyselyTrxOf(ctx);
  const personId = newId();
  if (trx !== null) {
    await trx
      .insertInto("identity.persons")
      .values({
        id: personId,
        tenant_id: ctx.tenantId,
        status: "ACTIVE",
        canonical_name: input.canonicalName ?? null,
        locale: input.locale ?? null,
        timezone: input.timezone ?? null,
        created_at: now(),
        updated_at: now(),
        anonymized_at: null,
      })
      .execute();
    for (const identity of input.identities) {
      const normalized = normalizeIdentity(identity.identityType, identity.normalizedValue);
      try {
        await trx
          .insertInto("identity.identities")
          .values({
            id: newId(),
            tenant_id: ctx.tenantId,
            person_id: personId,
            identity_type: identity.identityType,
            normalized_value: normalized,
            external_provider: null,
            external_id: null,
            verification_status: "UNVERIFIED",
            link_confidence: null,
            metadata_json: {},
            created_at: now(),
            verified_at: null,
            detached_at: null,
          })
          .execute();
      } catch {
        return {
          ok: false,
          code: "precondition_failed",
          message: `identity already linked in this tenant: ${identity.identityType}`,
        };
      }
    }
  } else {
    const mem = memoryStateOf(ctx);
    if (mem === null) {
      throw new Error("no Wave 2 store available");
    }
    for (const identity of input.identities) {
      const normalized = normalizeIdentity(identity.identityType, identity.normalizedValue);
      for (const existing of mem.identities.values()) {
        if (
          existing.tenantId === ctx.tenantId &&
          existing.identityType === identity.identityType &&
          existing.normalizedValue === normalized &&
          existing.detachedAt === null
        ) {
          return {
            ok: false,
            code: "precondition_failed",
            message: `identity already linked in this tenant: ${identity.identityType}`,
          };
        }
      }
    }
    mem.persons.set(personId, {
      id: personId,
      tenantId: ctx.tenantId,
      status: "ACTIVE",
      canonicalName: input.canonicalName ?? null,
      locale: input.locale ?? null,
      timezone: input.timezone ?? null,
    });
    for (const identity of input.identities) {
      const id = newId();
      mem.identities.set(id, {
        id,
        tenantId: ctx.tenantId,
        personId,
        identityType: identity.identityType,
        normalizedValue: normalizeIdentity(identity.identityType, identity.normalizedValue),
        detachedAt: null,
      });
    }
  }
  await emitAndEnqueue(ctx, {
    eventType: "person.created.v1",
    aggregateType: "person",
    aggregateId: personId,
    data: { person_id: personId, canonical_name: input.canonicalName ?? null },
  });
  return { ok: true, data: { id: personId } };
}

async function handleLeadCapture(
  ctx: CommandHandlerContext,
  input: CaptureLeadInput,
): Promise<CommandResult<{ id: string }>> {
  const leadId = newId();
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const person = await trx
      .selectFrom("identity.persons")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.personId)
      .executeTakeFirst();
    if (person === undefined) {
      return { ok: false, code: "not_found", message: "person not found in this tenant" };
    }
    await trx
      .insertInto("crm.leads")
      .values({
        id: leadId,
        tenant_id: ctx.tenantId,
        person_id: input.personId,
        status: "NEW",
        stage: input.stage ?? null,
        source_attribution_id: null,
        created_at: now(),
        qualified_at: null,
        lost_at: null,
        closed_reason: null,
      })
      .execute();
  } else {
    const mem = memoryStateOf(ctx);
    if (mem === null) {
      throw new Error("no Wave 2 store available");
    }
    const person = mem.persons.get(input.personId);
    if (person === undefined || person.tenantId !== ctx.tenantId) {
      return { ok: false, code: "not_found", message: "person not found in this tenant" };
    }
    mem.leads.set(leadId, {
      id: leadId,
      tenantId: ctx.tenantId,
      personId: input.personId,
      status: "NEW",
      stage: input.stage ?? null,
      createdAt: new Date(),
      qualifiedAt: null,
      lostAt: null,
      closedReason: null,
    });
  }
  await emitAndEnqueue(ctx, {
    eventType: "lead.created.v1",
    aggregateType: "lead",
    aggregateId: leadId,
    data: { lead_id: leadId, person_id: input.personId, status: "NEW" },
  });
  return { ok: true, data: { id: leadId } };
}

async function handleLeadTransition(
  ctx: CommandHandlerContext,
  input: TransitionLeadInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const trx = kyselyTrxOf(ctx);
  let from: string;
  if (trx !== null) {
    const lead = await trx
      .selectFrom("crm.leads")
      .select(["id", "status"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.leadId)
      .executeTakeFirst();
    if (lead === undefined) {
      return { ok: false, code: "not_found", message: "lead not found in this tenant" };
    }
    from = lead.status;
    const allowed = LEAD_TRANSITIONS[from] ?? [];
    if (!allowed.includes(input.toStatus)) {
      return {
        ok: false,
        code: "precondition_failed",
        message: `invalid lead transition: ${from} -> ${input.toStatus}`,
      };
    }
    await trx
      .updateTable("crm.leads")
      .set({
        status: input.toStatus,
        qualified_at: input.toStatus === "QUALIFIED" ? now() : undefined,
        lost_at: input.toStatus === "LOST" || input.toStatus === "DISQUALIFIED" ? now() : undefined,
        closed_reason: input.reason ?? undefined,
      })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.leadId)
      .execute();
  } else {
    const mem = memoryStateOf(ctx);
    if (mem === null) {
      throw new Error("no Wave 2 store available");
    }
    const lead = mem.leads.get(input.leadId);
    if (lead === undefined || lead.tenantId !== ctx.tenantId) {
      return { ok: false, code: "not_found", message: "lead not found in this tenant" };
    }
    from = lead.status;
    const allowed = LEAD_TRANSITIONS[from] ?? [];
    if (!allowed.includes(input.toStatus)) {
      return {
        ok: false,
        code: "precondition_failed",
        message: `invalid lead transition: ${from} -> ${input.toStatus}`,
      };
    }
    lead.status = input.toStatus;
    if (input.toStatus === "QUALIFIED") {
      lead.qualifiedAt = new Date();
    }
    if (input.toStatus === "LOST" || input.toStatus === "DISQUALIFIED") {
      lead.lostAt = new Date();
    }
    if (input.reason !== undefined) {
      lead.closedReason = input.reason;
    }
  }
  // No registry-listed event exists for lead transitions; the bus audit row
  // is the durable trace. Do NOT invent a public event id here.
  return { ok: true, data: { id: input.leadId, status: input.toStatus } };
}

export function registerCrmCommands(bus: CommandBus): void {
  bus.register<RegisterPersonInput, { id: string }>({
    name: "person.register",
    permission: "crm.lead.write",
    auditAction: "crm.person.register",
    auditResource: "person",
    input: registerPersonInput,
    handler: handlePersonRegister,
  });
  bus.register<CaptureLeadInput, { id: string }>({
    name: "lead.capture",
    permission: "crm.lead.write",
    auditAction: "crm.lead.capture",
    auditResource: "lead",
    input: captureLeadInput,
    handler: handleLeadCapture,
  });
  bus.register<TransitionLeadInput, { id: string; status: string }>({
    name: "lead.transition",
    permission: "crm.lead.write",
    auditAction: "crm.lead.transition",
    auditResource: "lead",
    input: transitionLeadInput,
    handler: handleLeadTransition,
  });
}
