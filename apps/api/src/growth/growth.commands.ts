import { z } from "zod";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue } from "../crm/wave2-store.js";
import { UniqueViolationError } from "../trial/trial-store.js";
import {
  DEFAULT_TENANT_TIMEZONE,
  gateContact,
  isQuietHour,
  nextAllowedSlot,
  parseMinor,
} from "./growth-policy.js";
import {
  advisoryLockAttribution,
  advisoryLockCampaign,
  committedSpendMinor,
  countAudiencesForCampaign,
  countCreativesForCampaign,
  findConversionByKey,
  findEarliestTouchForPerson,
  findFirstTouch,
  getCampaign,
  getVersion,
  insertCampaign,
  insertTouch,
  insertVersion,
  lockCampaign,
  lockVersion,
  maxVersionNo,
  personExists,
  requireTrx,
  setCurrentVersion,
  suppressionBlock,
  tenantTimezone,
  transitionCampaign,
  type CampaignRow,
  type CampaignVersionRow,
} from "./growth-store.js";

/**
 * Wave 11 Campaigns/Attribution commands (owning context for campaigns,
 * audiences, MessageIntent scheduling and attribution).
 *
 * Canonical rules enforced here:
 * - Nothing blasts directly: outreach is a `message_intent` scheduled
 *   BEHIND the manual messaging gateway (the gateway port is never called
 *   here). Quiet-hours contacts are DEFERRED, never dropped; inbound
 *   traffic is untouched.
 * - Preferences/suppressions/budget gate every schedule: a suppressed or
 *   opted-out recipient and any contact over the version budget cap are
 *   BLOCKED with an explicit reason — the intent itself never sends.
 *   Per-contact cost is authoritative from the campaign version's
 *   `unit_cost_minor` (migration 030); caller estimates never drive the
 *   cap, and a version without a unit cost fails closed (NO_UNIT_COST).
 * - Published campaign versions are immutable: material edits publish a
 *   new version row (G17 stays reproducible via the first-touch version).
 * - First-touch wins per (person, campaign); REFERRAL_ASSIST touches are
 *   recorded separately. Conversions resolve the first-touch version.
 * - Events are registry-listed ONLY: `growth.campaign.activated.v1`,
 *   `growth.campaign.paused.v1`, `growth.campaign.completed.v1`,
 *   `growth.attribution_touch.recorded.v1`. No invented ids.
 */

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof UniqueViolationError ||
    (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505")
  );
}

const minorString = z.string().regex(/^\d{1,19}$/, "must be exact non-negative minor units");
const snapshots = z.record(z.string(), z.unknown()).default({});

export const createCampaignInput = z.object({
  campaignKey: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(2000).optional(),
});
export type CreateCampaignInput = z.infer<typeof createCampaignInput>;

export const publishVersionInput = z.object({
  campaignId: z.string().uuid(),
  offerSnapshot: snapshots,
  policySnapshot: snapshots,
  budgetCapMinor: minorString.optional(),
  unitCostMinor: minorString.optional(),
  currency: z.string().trim().min(3).max(3).default("BRL"),
});
export type PublishVersionInput = z.infer<typeof publishVersionInput>;

export const campaignIdInput = z.object({ campaignId: z.string().uuid() });
export type CampaignIdInput = z.infer<typeof campaignIdInput>;

export const defineAudienceInput = z.object({
  campaignId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  membershipType: z.enum(["DYNAMIC", "STATIC"]).default("DYNAMIC"),
  criteriaJson: z.record(z.string(), z.unknown()).default({}),
  memberPersonIds: z.array(z.string().uuid()).max(5000).default([]),
});
export type DefineAudienceInput = z.infer<typeof defineAudienceInput>;

export const addCreativeInput = z.object({
  campaignId: z.string().uuid(),
  campaignVersionId: z.string().uuid().optional(),
  channel: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  content: z.record(z.string(), z.unknown()).default({}),
});
export type AddCreativeInput = z.infer<typeof addCreativeInput>;

export const scheduleIntentInput = z.object({
  campaignId: z.string().uuid(),
  campaignVersionId: z.string().uuid().optional(),
  audienceId: z.string().uuid().optional(),
  personIds: z.array(z.string().uuid()).max(5000).default([]),
  channel: z.string().trim().min(1).max(64),
  purposeKey: z.string().trim().min(1).max(64).default("MARKETING"),
  templateRef: z.string().trim().min(1).max(320).optional(),
  scheduledFor: z.string().datetime({ offset: true }).optional(),
  // Accepted for API compatibility but IGNORED for budget accounting: the
  // per-contact cost authority is the campaign version's `unit_cost_minor`
  // (migration 030). A caller value can never lower the cap computation.
  estimatedCostMinor: minorString.default("0"),
  intentKey: z.string().trim().min(1).max(200).optional(),
});
export type ScheduleIntentInput = z.infer<typeof scheduleIntentInput>;

export const recordTouchInput = z.object({
  personId: z.string().uuid(),
  campaignId: z.string().uuid(),
  touchType: z.enum(["CLICK", "VIEW", "SCAN", "REFERRAL_ASSIST", "MANUAL"]),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});
export type RecordTouchInput = z.infer<typeof recordTouchInput>;

export const recordConversionInput = z.object({
  personId: z.string().uuid(),
  campaignId: z.string().uuid().optional(),
  conversionType: z.string().trim().min(1).max(64),
  orderId: z.string().uuid().optional(),
  amountMinor: minorString.optional(),
  currency: z.string().trim().min(3).max(3).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});
export type RecordConversionInput = z.infer<typeof recordConversionInput>;

export interface CampaignView {
  id: string;
  campaignKey: string;
  name: string;
  objective: string | null;
  status: string;
  currentVersionId: string | null;
  currentVersionNo: number | null;
  createdAt: string;
  updatedAt: string;
}

async function toCampaignView(ctx: CommandHandlerContext, campaign: CampaignRow): Promise<CampaignView> {
  let versionNo: number | null = null;
  if (campaign.currentVersionId !== null) {
    const version = await getVersion(ctx, campaign.currentVersionId);
    versionNo = version?.versionNo ?? null;
  }
  return {
    id: campaign.id,
    campaignKey: campaign.campaignKey,
    name: campaign.name,
    objective: campaign.objective,
    status: campaign.status,
    currentVersionId: campaign.currentVersionId,
    currentVersionNo: versionNo,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };
}

async function emitCampaign(
  ctx: CommandHandlerContext,
  eventType: string,
  campaign: CampaignRow,
  version: CampaignVersionRow | null,
): Promise<void> {
  await emitAndEnqueue(ctx, {
    eventType,
    aggregateType: "campaign",
    aggregateId: campaign.id,
    data: {
      campaign_id: campaign.id,
      campaign_key: campaign.campaignKey,
      status: campaign.status,
      campaign_version_id: version?.id ?? campaign.currentVersionId,
      version_no: version?.versionNo ?? null,
      tenant_id: ctx.tenantId,
    },
  });
}

async function handleCreateCampaign(
  ctx: CommandHandlerContext,
  input: CreateCampaignInput,
): Promise<CommandResult<CampaignView>> {
  // Suffix from the random tail of the id: UUIDv7 ids share their leading
  // hex (timestamp high bits) for ~65s, so a head slice collides for
  // campaigns created in the same window (unique violation → 500).
  const key = input.campaignKey ?? `cmp-${newId().replace(/-/g, "").slice(-12).toLowerCase()}`;
  let campaign: CampaignRow;
  try {
    campaign = await insertCampaign(ctx, {
      campaignKey: key,
      name: input.name,
      objective: input.objective ?? null,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, code: "precondition_failed", message: "campaign key is already in use in this tenant" };
    }
    throw err;
  }
  // Every campaign starts with a DRAFT v1 shell; publishing freezes the
  // first real snapshots.
  await insertVersion(ctx, {
    campaignId: campaign.id,
    versionNo: 1,
    status: "DRAFT",
    offerSnapshot: {},
    policySnapshot: {},
    budgetCapMinor: null,
    unitCostMinor: null,
    currency: "BRL",
  });
  return { ok: true, data: await toCampaignView(ctx, campaign) };
}

async function handlePublishVersion(
  ctx: CommandHandlerContext,
  input: PublishVersionInput,
): Promise<CommandResult<{ versionId: string; versionNo: number; campaignId: string }>> {
  const campaign = await getCampaign(ctx, input.campaignId);
  if (campaign === null) {
    return { ok: false, code: "not_found", message: "campaign not found in this tenant" };
  }
  if (campaign.status === "COMPLETED") {
    return { ok: false, code: "precondition_failed", message: "completed campaigns cannot publish new versions" };
  }
  const current = campaign.currentVersionId !== null ? await getVersion(ctx, campaign.currentVersionId) : null;
  const versionNo = (await maxVersionNo(ctx, campaign.id)) + 1;
  const version = await insertVersion(ctx, {
    campaignId: campaign.id,
    versionNo,
    status: "PUBLISHED",
    offerSnapshot: input.offerSnapshot,
    policySnapshot: input.policySnapshot,
    budgetCapMinor: input.budgetCapMinor ?? current?.budgetCapMinor ?? null,
    unitCostMinor: input.unitCostMinor ?? current?.unitCostMinor ?? null,
    currency: input.currency ?? current?.currency ?? "BRL",
  });
  await setCurrentVersion(ctx, campaign.id, version.id);
  return { ok: true, data: { versionId: version.id, versionNo: version.versionNo, campaignId: campaign.id } };
}

function lifecycleHandler(to: "ACTIVE" | "PAUSED" | "COMPLETED", eventType: string) {
  return async (ctx: CommandHandlerContext, input: CampaignIdInput): Promise<CommandResult<CampaignView>> => {
    const trx = requireTrx(ctx);
    // Serialize against concurrent schedulers (same advisory key as
    // `handleScheduleIntent`): a pause/complete cannot slip between a
    // schedule-time status check and the contact inserts.
    await advisoryLockCampaign(trx, ctx.tenantId, input.campaignId);
    const campaign = await getCampaign(ctx, input.campaignId);
    if (campaign === null) {
      return { ok: false, code: "not_found", message: "campaign not found in this tenant" };
    }
    const fromByTo: Record<string, string[]> = {
      ACTIVE: ["DRAFT", "PAUSED"],
      PAUSED: ["ACTIVE"],
      COMPLETED: ["ACTIVE", "PAUSED"],
    };
    const from = fromByTo[to] ?? [];
    if (!from.includes(campaign.status)) {
      return { ok: false, code: "precondition_failed", message: `campaign is ${campaign.status}; cannot move to ${to}` };
    }
    // Activation readiness (preferences/suppressions/budget are enforced
    // per recipient at schedule time; activation checks campaign-level
    // readiness: a published version with a budget cap, an audience and a
    // creative behind the manual gateway).
    let version: CampaignVersionRow | null = null;
    if (to === "ACTIVE") {
      version =
        campaign.currentVersionId !== null ? await getVersion(ctx, campaign.currentVersionId) : null;
      if (version === null || version.status !== "PUBLISHED") {
        return { ok: false, code: "precondition_failed", message: "campaign has no published version to activate" };
      }
      if (version.budgetCapMinor === null) {
        return { ok: false, code: "precondition_failed", message: "published version has no budget cap" };
      }
      if ((await countAudiencesForCampaign(ctx, campaign.id)) === 0) {
        return { ok: false, code: "precondition_failed", message: "campaign has no audience" };
      }
      if ((await countCreativesForCampaign(ctx, campaign.id)) === 0) {
        return { ok: false, code: "precondition_failed", message: "campaign has no creative" };
      }
    }
    const moved = await transitionCampaign(ctx, { campaignId: campaign.id, from, to });
    if (moved === null) {
      return { ok: false, code: "precondition_failed", message: "campaign changed concurrently" };
    }
    await emitCampaign(ctx, eventType, moved, version);
    return { ok: true, data: await toCampaignView(ctx, moved) };
  };
}

async function handleDefineAudience(
  ctx: CommandHandlerContext,
  input: DefineAudienceInput,
): Promise<CommandResult<{ audienceId: string; memberCount: number; already: boolean }>> {
  const trx = requireTrx(ctx);
  if (input.campaignId !== undefined) {
    const campaign = await getCampaign(ctx, input.campaignId);
    if (campaign === null) {
      return { ok: false, code: "not_found", message: "campaign not found in this tenant" };
    }
  }
  for (const personId of input.memberPersonIds) {
    if (!(await personExists(ctx, personId))) {
      return { ok: false, code: "not_found", message: "person not found in this tenant" };
    }
  }
  const audienceId = newId();
  const at = now();
  await trx
    .insertInto("growth.audience_definitions")
    .values({
      id: audienceId,
      tenant_id: ctx.tenantId,
      campaign_id: input.campaignId ?? null,
      name: input.name,
      membership_type: input.membershipType,
      criteria_json: input.criteriaJson,
      created_at: at,
      updated_at: at,
    })
    .execute();
  let memberCount = 0;
  for (const personId of new Set(input.memberPersonIds)) {
    await trx
      .insertInto("growth.audience_members")
      .values({ id: newId(), tenant_id: ctx.tenantId, audience_id: audienceId, person_id: personId, added_at: at })
      .onConflict((oc) => oc.columns(["tenant_id", "audience_id", "person_id"]).doNothing())
      .execute();
    memberCount += 1;
  }
  return { ok: true, data: { audienceId, memberCount, already: false } };
}

async function handleAddCreative(
  ctx: CommandHandlerContext,
  input: AddCreativeInput,
): Promise<CommandResult<{ creativeId: string }>> {
  const trx = requireTrx(ctx);
  const campaign = await getCampaign(ctx, input.campaignId);
  if (campaign === null) {
    return { ok: false, code: "not_found", message: "campaign not found in this tenant" };
  }
  if (input.campaignVersionId !== undefined) {
    const version = await getVersion(ctx, input.campaignVersionId);
    if (version === null || version.campaignId !== campaign.id) {
      return { ok: false, code: "not_found", message: "campaign version not found for this campaign" };
    }
  }
  const creativeId = newId();
  const at = now();
  await trx
    .insertInto("growth.creatives")
    .values({
      id: creativeId,
      tenant_id: ctx.tenantId,
      campaign_id: campaign.id,
      campaign_version_id: input.campaignVersionId ?? campaign.currentVersionId,
      channel: input.channel,
      name: input.name,
      content_json: input.content,
      status: "DRAFT",
      created_at: at,
      updated_at: at,
    })
    .execute();
  return { ok: true, data: { creativeId } };
}

export interface ScheduleContactResult {
  personId: string;
  status: "SCHEDULED" | "DEFERRED" | "BLOCKED";
  reason: string | null;
  /** Per-contact release instant: requested time, or the next allowed slot for DEFERRED. */
  scheduledFor: string;
}

export interface ScheduleResult {
  intentId: string;
  status: "SCHEDULED" | "BLOCKED";
  scheduledFor: string;
  contacts: ScheduleContactResult[];
  already: boolean;
}

async function loadIntentContacts(
  ctx: CommandHandlerContext,
  intentId: string,
): Promise<ScheduleContactResult[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("communication.scheduled_contacts")
    .select(["person_id", "status", "block_reason", "scheduled_for"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("intent_id", "=", intentId)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((row) => ({
    personId: row.person_id,
    status: row.status as ScheduleContactResult["status"],
    reason: row.block_reason,
    scheduledFor: row.scheduled_for.toISOString(),
  }));
}

async function handleScheduleIntent(
  ctx: CommandHandlerContext,
  input: ScheduleIntentInput,
): Promise<CommandResult<ScheduleResult>> {
  const trx = requireTrx(ctx);
  // Serialize against pause/complete transitions for this campaign before
  // reading any status (advisory key shared with `lifecycleHandler`).
  await advisoryLockCampaign(trx, ctx.tenantId, input.campaignId);
  const campaign = await getCampaign(ctx, input.campaignId);
  if (campaign === null) {
    return { ok: false, code: "not_found", message: "campaign not found in this tenant" };
  }
  if (campaign.status !== "ACTIVE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `campaign is ${campaign.status}; only ACTIVE campaigns schedule intents`,
    };
  }
  const version =
    input.campaignVersionId !== undefined
      ? await getVersion(ctx, input.campaignVersionId)
      : campaign.currentVersionId !== null
        ? await getVersion(ctx, campaign.currentVersionId)
        : null;
  if (version === null || version.campaignId !== campaign.id || version.status !== "PUBLISHED") {
    return { ok: false, code: "precondition_failed", message: "campaign has no published version to schedule against" };
  }
  let audienceId: string | null = null;
  if (input.audienceId !== undefined) {
    const audience = await trx
      .selectFrom("growth.audience_definitions")
      .select(["id", "campaign_id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.audienceId)
      .executeTakeFirst();
    if (audience === undefined) {
      return { ok: false, code: "not_found", message: "audience not found in this tenant" };
    }
    // Audiences are campaign-scoped: a foreign campaign's audience cannot
    // be consumed here (no cross-campaign sharing contract exists).
    if (audience.campaign_id !== null && audience.campaign_id !== campaign.id) {
      return { ok: false, code: "not_found", message: "audience does not belong to this campaign" };
    }
    audienceId = audience.id;
  }
  const audienceMembers =
    audienceId !== null
      ? await trx
          .selectFrom("growth.audience_members")
          .select(["person_id"])
          .where("tenant_id", "=", ctx.tenantId)
          .where("audience_id", "=", audienceId)
          .execute()
      : [];
  const personIds = [...new Set([...audienceMembers.map((m) => m.person_id), ...input.personIds])];
  if (personIds.length === 0) {
    return { ok: false, code: "validation_failed", message: "schedule needs an audience with members or explicit personIds" };
  }
  for (const personId of personIds) {
    if (!(await personExists(ctx, personId))) {
      return { ok: false, code: "not_found", message: "person not found in this tenant" };
    }
  }
  const intentKey = input.intentKey ?? `intent-${newId()}`;
  const scheduledFor = input.scheduledFor !== undefined ? new Date(input.scheduledFor) : now();
  // Replay-first: the same intent key resolves to the stored intent —
  // contacts are never duplicated.
  const existing = await trx
    .selectFrom("communication.message_intents")
    .select(["id", "status", "scheduled_for"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("idempotency_key", "=", intentKey)
    .executeTakeFirst();
  if (existing !== undefined) {
    return {
      ok: true,
      data: {
        intentId: existing.id,
        status: existing.status as ScheduleResult["status"],
        scheduledFor: existing.scheduled_for.toISOString(),
        contacts: await loadIntentContacts(ctx, existing.id),
        already: true,
      },
    };
  }
  // Serialize budget against the version row: lock first, then sum.
  const locked = await lockVersion(trx, ctx.tenantId, version.id);
  if (locked === null) {
    return { ok: false, code: "precondition_failed", message: "campaign version changed concurrently" };
  }
  // Revalidate liveness under the locks: a pause/complete that won the
  // advisory race lands here instead of racing the inserts below.
  const live = await lockCampaign(trx, ctx.tenantId, campaign.id);
  if (live === null || live.status !== "ACTIVE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `campaign is ${live?.status ?? "missing"}; only ACTIVE campaigns schedule intents`,
    };
  }
  // Authoritative unit cost comes from the locked version row (migration
  // 030). The caller-supplied `estimatedCostMinor` is never an authority
  // for the cap; a version without a unit cost fails closed.
  const perContactCost = locked.unitCostMinor === null ? null : parseMinor(locked.unitCostMinor, "unit_cost_minor");
  const cap = locked.budgetCapMinor === null ? null : BigInt(locked.budgetCapMinor);
  let committed = await committedSpendMinor(trx, ctx.tenantId, version.id);
  let timeZone = DEFAULT_TENANT_TIMEZONE;
  try {
    timeZone = await tenantTimezone(ctx);
  } catch {
    timeZone = DEFAULT_TENANT_TIMEZONE;
  }
  const quiet = isQuietHour(scheduledFor, timeZone);
  // DEFERRED contacts persist the next allowed release instant in the
  // tenant timezone — never the requested time inside the quiet window.
  const releaseFor = quiet ? nextAllowedSlot(scheduledFor, timeZone) : scheduledFor;
  const contacts: ScheduleContactResult[] = [];
  if (perContactCost === null) {
    for (const personId of personIds) {
      contacts.push({ personId, status: "BLOCKED", reason: "NO_UNIT_COST", scheduledFor: scheduledFor.toISOString() });
    }
  } else {
    for (const personId of personIds) {
      const block = await suppressionBlock(ctx, personId, input.channel);
      const overBudget = cap !== null && committed + perContactCost > cap;
      const gate = gateContact({
        suppressed: block.blocked && block.reason === "SUPPRESSED",
        optedOut: block.blocked && block.reason === "OPTED_OUT",
        overBudget,
        quiet,
      });
      if (gate.verdict === "BLOCKED") {
        contacts.push({ personId, status: "BLOCKED", reason: gate.reason, scheduledFor: scheduledFor.toISOString() });
      } else if (gate.verdict === "DEFERRED") {
        contacts.push({ personId, status: "DEFERRED", reason: "QUIET_HOURS", scheduledFor: releaseFor.toISOString() });
        committed += perContactCost;
      } else {
        contacts.push({ personId, status: "SCHEDULED", reason: null, scheduledFor: scheduledFor.toISOString() });
        committed += perContactCost;
      }
    }
  }
  const intentId = newId();
  const at = now();
  const intentStatus = contacts.every((c) => c.status === "BLOCKED") ? "BLOCKED" : "SCHEDULED";
  await trx
    .insertInto("communication.message_intents")
    .values({
      id: intentId,
      tenant_id: ctx.tenantId,
      campaign_id: campaign.id,
      campaign_version_id: version.id,
      audience_id: audienceId,
      channel: input.channel,
      purpose_key: input.purposeKey,
      template_ref: input.templateRef ?? null,
      idempotency_key: intentKey,
      scheduled_for: scheduledFor,
      status: intentStatus,
      created_at: at,
      updated_at: at,
    })
    .execute();
  for (const contact of contacts) {
    await trx
      .insertInto("communication.scheduled_contacts")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        intent_id: intentId,
        person_id: contact.personId,
        channel: input.channel,
        scheduled_for: new Date(contact.scheduledFor),
        status: contact.status,
        block_reason: contact.reason,
        estimated_cost_minor: (perContactCost ?? 0n).toString(),
        sent_at: null,
        created_at: at,
      })
      .execute();
  }
  return {
    ok: true,
    data: {
      intentId,
      status: intentStatus,
      scheduledFor: scheduledFor.toISOString(),
      contacts,
      already: false,
    },
  };
}

async function handleRecordTouch(
  ctx: CommandHandlerContext,
  input: RecordTouchInput,
): Promise<CommandResult<{ touchId: string; campaignVersionId: string; already: boolean }>> {
  const trx = requireTrx(ctx);
  if (!(await personExists(ctx, input.personId))) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  const campaign = await getCampaign(ctx, input.campaignId);
  if (campaign === null) {
    return { ok: false, code: "not_found", message: "campaign not found in this tenant" };
  }
  const current =
    campaign.currentVersionId !== null ? await getVersion(ctx, campaign.currentVersionId) : null;
  if (current === null || current.status !== "PUBLISHED") {
    return { ok: false, code: "precondition_failed", message: "campaign has no published version to attribute against" };
  }
  const occurredAt = input.occurredAt !== undefined ? new Date(input.occurredAt) : now();
  if (input.touchType !== "REFERRAL_ASSIST") {
    await advisoryLockAttribution(trx, ctx.tenantId, input.personId, campaign.id);
    const first = await findFirstTouch(ctx, input.personId, campaign.id);
    if (first !== null) {
      // First-touch wins: late touches resolve to the stored row, never
      // overwrite attribution.
      return { ok: true, data: { touchId: first.id, campaignVersionId: first.campaignVersionId, already: true } };
    }
  }
  const touch = await insertTouch(ctx, {
    personId: input.personId,
    campaignId: campaign.id,
    campaignVersionId: current.id,
    touchType: input.touchType,
    occurredAt,
  });
  await emitAndEnqueue(ctx, {
    eventType: "growth.attribution_touch.recorded.v1",
    aggregateType: "attribution_touch",
    aggregateId: touch.id,
    data: {
      attribution_touch_id: touch.id,
      person_id: touch.personId,
      campaign_id: touch.campaignId,
      campaign_version_id: touch.campaignVersionId,
      touch_type: touch.touchType,
      tenant_id: ctx.tenantId,
    },
  });
  return { ok: true, data: { touchId: touch.id, campaignVersionId: touch.campaignVersionId, already: false } };
}

async function handleRecordConversion(
  ctx: CommandHandlerContext,
  input: RecordConversionInput,
): Promise<
  CommandResult<{ conversionId: string; campaignId: string | null; campaignVersionId: string | null; already: boolean }>
> {
  const trx = requireTrx(ctx);
  if (!(await personExists(ctx, input.personId))) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  if (input.idempotencyKey !== undefined) {
    const replay = await findConversionByKey(ctx, input.idempotencyKey);
    if (replay !== null) {
      const row = await trx
        .selectFrom("growth.conversion_events")
        .select(["id", "campaign_id", "campaign_version_id"])
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", replay.id)
        .executeTakeFirstOrThrow();
      return {
        ok: true,
        data: {
          conversionId: row.id,
          campaignId: row.campaign_id,
          campaignVersionId: row.campaign_version_id,
          already: true,
        },
      };
    }
  }
  // G17: the conversion resolves the campaign version of the first touch —
  // reproducible even after later versions are published.
  const touch =
    input.campaignId !== undefined
      ? await findFirstTouch(ctx, input.personId, input.campaignId)
      : await findEarliestTouchForPerson(ctx, input.personId);
  if (touch === null) {
    return { ok: false, code: "precondition_failed", message: "no attribution touch for this person" };
  }
  const occurredAt = input.occurredAt !== undefined ? new Date(input.occurredAt) : now();
  const conversionId = newId();
  await trx
    .insertInto("growth.conversion_events")
    .values({
      id: conversionId,
      tenant_id: ctx.tenantId,
      person_id: input.personId,
      campaign_id: touch.campaignId,
      campaign_version_id: touch.campaignVersionId,
      conversion_type: input.conversionType,
      order_id: input.orderId ?? null,
      amount_minor: input.amountMinor ?? null,
      currency: input.currency ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      occurred_at: occurredAt,
      created_at: now(),
    })
    .execute();
  return {
    ok: true,
    data: {
      conversionId,
      campaignId: touch.campaignId,
      campaignVersionId: touch.campaignVersionId,
      already: false,
    },
  };
}

export function registerGrowthCommands(bus: CommandBus): void {
  bus.register<CreateCampaignInput, CampaignView>({
    name: "growth.create_campaign",
    permission: "crm.lead.write",
    auditAction: "growth.create_campaign",
    auditResource: "campaign",
    input: createCampaignInput,
    handler: handleCreateCampaign,
  });
  bus.register<PublishVersionInput, { versionId: string; versionNo: number; campaignId: string }>({
    name: "growth.publish_version",
    permission: "crm.lead.write",
    auditAction: "growth.publish_version",
    auditResource: "campaign",
    input: publishVersionInput,
    handler: handlePublishVersion,
  });
  bus.register<CampaignIdInput, CampaignView>({
    name: "growth.activate_campaign",
    permission: "crm.lead.write",
    auditAction: "growth.activate_campaign",
    auditResource: "campaign",
    input: campaignIdInput,
    handler: lifecycleHandler("ACTIVE", "growth.campaign.activated.v1"),
  });
  bus.register<CampaignIdInput, CampaignView>({
    name: "growth.pause_campaign",
    permission: "crm.lead.write",
    auditAction: "growth.pause_campaign",
    auditResource: "campaign",
    input: campaignIdInput,
    handler: lifecycleHandler("PAUSED", "growth.campaign.paused.v1"),
  });
  bus.register<CampaignIdInput, CampaignView>({
    name: "growth.complete_campaign",
    permission: "crm.lead.write",
    auditAction: "growth.complete_campaign",
    auditResource: "campaign",
    input: campaignIdInput,
    handler: lifecycleHandler("COMPLETED", "growth.campaign.completed.v1"),
  });
  bus.register<DefineAudienceInput, { audienceId: string; memberCount: number; already: boolean }>({
    name: "growth.define_audience",
    permission: "crm.lead.write",
    auditAction: "growth.define_audience",
    auditResource: "audience",
    input: defineAudienceInput,
    handler: handleDefineAudience,
  });
  bus.register<AddCreativeInput, { creativeId: string }>({
    name: "growth.add_creative",
    permission: "crm.lead.write",
    auditAction: "growth.add_creative",
    auditResource: "creative",
    input: addCreativeInput,
    handler: handleAddCreative,
  });
  bus.register<ScheduleIntentInput, ScheduleResult>({
    name: "growth.schedule_intent",
    permission: "crm.lead.write",
    auditAction: "growth.schedule_intent",
    auditResource: "message_intent",
    input: scheduleIntentInput,
    handler: handleScheduleIntent,
  });
  bus.register<RecordTouchInput, { touchId: string; campaignVersionId: string; already: boolean }>({
    name: "growth.record_touch",
    permission: "crm.lead.write",
    auditAction: "growth.record_touch",
    auditResource: "attribution_touch",
    input: recordTouchInput,
    handler: handleRecordTouch,
  });
  bus.register<
    RecordConversionInput,
    { conversionId: string; campaignId: string | null; campaignVersionId: string | null; already: boolean }
  >({
    name: "growth.record_conversion",
    permission: "crm.lead.write",
    auditAction: "growth.record_conversion",
    auditResource: "conversion_event",
    input: recordConversionInput,
    handler: handleRecordConversion,
  });
}
