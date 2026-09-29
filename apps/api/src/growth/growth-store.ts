import { sql, type Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";

/**
 * Wave 11 Growth store accessors (Kysely only — no in-memory path).
 *
 * Units run against the pure `growth-policy.ts` helpers; the full flow is
 * covered by the `TEST_DATABASE_URL` integration suite.
 *
 * Storage rules (migrations 028/029):
 * - Published campaign versions are immutable: commands never UPDATE them;
 *   material edits publish a new version row and repoint
 *   `campaigns.current_version_id`.
 * - First-touch is preserved by the `attribution_touches_first_touch_unique`
 *   partial unique index: writers pre-check + take a per-(person, campaign)
 *   advisory lock instead of catching PG 23505 (a caught unique violation
 *   would abort the surrounding transaction).
 * - Touches and conversion events are append-only (DB trigger rejects
 *   UPDATE/DELETE).
 * - Budget serialization: schedulers lock the campaign version row
 *   (`FOR UPDATE`) before summing committed contact spend, so concurrent
 *   schedules cannot both slip under the cap.
 */

export function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const inner = ctx.tx.innerDb() as Record<string, unknown> | null;
  if (
    inner !== null &&
    typeof inner === "object" &&
    typeof (inner as { selectFrom?: unknown }).selectFrom === "function"
  ) {
    return inner as unknown as Transaction<Database>;
  }
  throw new Error("growth commands require a database transaction");
}

export async function advisoryLockAttribution(
  trx: Transaction<Database>,
  tenantId: string,
  personId: string,
  campaignId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"growth-attrib:" + tenantId + ":" + personId + ":" + campaignId}))`.execute(
    trx,
  );
}

export interface CampaignRow {
  id: string;
  campaignKey: string;
  name: string;
  objective: string | null;
  status: string;
  currentVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignVersionRow {
  id: string;
  campaignId: string;
  versionNo: number;
  status: string;
  offerSnapshot: Record<string, unknown>;
  policySnapshot: Record<string, unknown>;
  budgetCapMinor: string | null;
  unitCostMinor: string | null;
  currency: string;
  publishedAt: Date | null;
  createdAt: Date;
}

function toCampaignRow(row: {
  id: string;
  campaign_key: string;
  name: string;
  objective: string | null;
  status: string;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}): CampaignRow {
  return {
    id: row.id,
    campaignKey: row.campaign_key,
    name: row.name,
    objective: row.objective,
    status: row.status,
    currentVersionId: row.current_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVersionRow(row: {
  id: string;
  campaign_id: string;
  version_no: number;
  status: string;
  offer_snapshot_json: unknown;
  policy_snapshot_json: unknown;
  budget_cap_minor: string | null;
  unit_cost_minor: string | null;
  currency: string;
  published_at: Date | null;
  created_at: Date;
}): CampaignVersionRow {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    versionNo: row.version_no,
    status: row.status,
    offerSnapshot: (row.offer_snapshot_json ?? {}) as Record<string, unknown>,
    policySnapshot: (row.policy_snapshot_json ?? {}) as Record<string, unknown>,
    budgetCapMinor: row.budget_cap_minor === null ? null : String(row.budget_cap_minor),
    unitCostMinor: row.unit_cost_minor === null ? null : String(row.unit_cost_minor),
    currency: row.currency,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}

export async function getCampaign(ctx: CommandHandlerContext, campaignId: string): Promise<CampaignRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("growth.campaigns")
    .select(["id", "campaign_key", "name", "objective", "status", "current_version_id", "created_at", "updated_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", campaignId)
    .executeTakeFirst();
  return row === undefined ? null : toCampaignRow(row);
}

export async function getVersion(ctx: CommandHandlerContext, versionId: string): Promise<CampaignVersionRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("growth.campaign_versions")
    .select([
      "id",
      "campaign_id",
      "version_no",
      "status",
      "offer_snapshot_json",
      "policy_snapshot_json",
      "budget_cap_minor",
      "unit_cost_minor",
      "currency",
      "published_at",
      "created_at",
    ])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", versionId)
    .executeTakeFirst();
  return row === undefined ? null : toVersionRow(row);
}

/** Lock the version row and return it (serializes budget checks per version). */
export async function lockVersion(
  trx: Transaction<Database>,
  tenantId: string,
  versionId: string,
): Promise<CampaignVersionRow | null> {
  const row = await sql`SELECT id, campaign_id, version_no, status, offer_snapshot_json, policy_snapshot_json, budget_cap_minor, unit_cost_minor, currency, published_at, created_at FROM growth.campaign_versions WHERE tenant_id = ${tenantId} AND id = ${versionId} FOR UPDATE`.execute(
    trx,
  );
  const found = (row.rows as Array<Record<string, unknown>>)[0];
  if (found === undefined) {
    return null;
  }
  return toVersionRow({
    id: found["id"] as string,
    campaign_id: found["campaign_id"] as string,
    version_no: found["version_no"] as number,
    status: found["status"] as string,
    offer_snapshot_json: found["offer_snapshot_json"],
    policy_snapshot_json: found["policy_snapshot_json"],
    budget_cap_minor: found["budget_cap_minor"] === null ? null : String(found["budget_cap_minor"]),
    unit_cost_minor: found["unit_cost_minor"] === null ? null : String(found["unit_cost_minor"]),
    currency: found["currency"] as string,
    published_at: found["published_at"] as Date | null,
    created_at: found["created_at"] as Date,
  });
}

/**
 * Serialize schedulers against lifecycle transitions for one campaign.
 * Both `growth.schedule_intent` and pause/complete take this transaction-
 * scoped advisory lock, and schedulers re-read the campaign row
 * `FOR UPDATE` before writing contacts, so a concurrent pause/complete
 * cannot slip between the schedule-time status check and the insert.
 */
export async function advisoryLockCampaign(
  trx: Transaction<Database>,
  tenantId: string,
  campaignId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"growth-campaign:" + tenantId + ":" + campaignId}))`.execute(
    trx,
  );
}

/** Re-read the campaign row under lock (null when it vanished concurrently). */
export async function lockCampaign(
  trx: Transaction<Database>,
  tenantId: string,
  campaignId: string,
): Promise<CampaignRow | null> {
  const row = await sql`SELECT id, campaign_key, name, objective, status, current_version_id, created_at, updated_at FROM growth.campaigns WHERE tenant_id = ${tenantId} AND id = ${campaignId} FOR UPDATE`.execute(
    trx,
  );
  const found = (row.rows as Array<Record<string, unknown>>)[0];
  if (found === undefined) {
    return null;
  }
  return toCampaignRow({
    id: found["id"] as string,
    campaign_key: found["campaign_key"] as string,
    name: found["name"] as string,
    objective: found["objective"] as string | null,
    status: found["status"] as string,
    current_version_id: found["current_version_id"] as string | null,
    created_at: found["created_at"] as Date,
    updated_at: found["updated_at"] as Date,
  });
}

export async function maxVersionNo(ctx: CommandHandlerContext, campaignId: string): Promise<number> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("growth.campaign_versions")
    .select((eb) => eb.fn.max("version_no").as("max_no"))
    .where("tenant_id", "=", ctx.tenantId)
    .where("campaign_id", "=", campaignId)
    .executeTakeFirst();
  const maxNo = row?.max_no;
  return typeof maxNo === "number" ? maxNo : 0;
}

export async function insertCampaign(
  ctx: CommandHandlerContext,
  input: { campaignKey: string; name: string; objective: string | null },
): Promise<CampaignRow> {
  const trx = requireTrx(ctx);
  const row = await trx
    .insertInto("growth.campaigns")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      campaign_key: input.campaignKey,
      name: input.name,
      objective: input.objective,
      status: "DRAFT",
      current_version_id: null,
      created_at: now(),
      updated_at: now(),
    })
    .returning(["id", "campaign_key", "name", "objective", "status", "current_version_id", "created_at", "updated_at"])
    .executeTakeFirstOrThrow();
  return toCampaignRow(row);
}

export async function insertVersion(
  ctx: CommandHandlerContext,
  input: {
    campaignId: string;
    versionNo: number;
    status: "DRAFT" | "PUBLISHED";
    offerSnapshot: Record<string, unknown>;
    policySnapshot: Record<string, unknown>;
    budgetCapMinor: string | null;
    unitCostMinor: string | null;
    currency: string;
  },
): Promise<CampaignVersionRow> {
  const trx = requireTrx(ctx);
  const at = now();
  const row = await trx
    .insertInto("growth.campaign_versions")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      campaign_id: input.campaignId,
      version_no: input.versionNo,
      status: input.status,
      offer_snapshot_json: input.offerSnapshot,
      policy_snapshot_json: input.policySnapshot,
      budget_cap_minor: input.budgetCapMinor,
      unit_cost_minor: input.unitCostMinor,
      currency: input.currency,
      published_at: input.status === "PUBLISHED" ? at : null,
      created_at: at,
    })
    .returning([
      "id",
      "campaign_id",
      "version_no",
      "status",
      "offer_snapshot_json",
      "policy_snapshot_json",
      "budget_cap_minor",
      "unit_cost_minor",
      "currency",
      "published_at",
      "created_at",
    ])
    .executeTakeFirstOrThrow();
  return toVersionRow(row);
}

export async function setCurrentVersion(
  ctx: CommandHandlerContext,
  campaignId: string,
  versionId: string,
): Promise<void> {
  const trx = requireTrx(ctx);
  await trx
    .updateTable("growth.campaigns")
    .set({ current_version_id: versionId, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", campaignId)
    .execute();
}

export async function transitionCampaign(
  ctx: CommandHandlerContext,
  input: { campaignId: string; from: string[]; to: "ACTIVE" | "PAUSED" | "COMPLETED" },
): Promise<CampaignRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .updateTable("growth.campaigns")
    .set({ status: input.to, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.campaignId)
    .where("status", "in", input.from)
    .returning(["id", "campaign_key", "name", "objective", "status", "current_version_id", "created_at", "updated_at"])
    .executeTakeFirst();
  return row === undefined ? null : toCampaignRow(row);
}

export async function countAudiencesForCampaign(ctx: CommandHandlerContext, campaignId: string): Promise<number> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("growth.audience_definitions")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("tenant_id", "=", ctx.tenantId)
    .where("campaign_id", "=", campaignId)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function countCreativesForCampaign(ctx: CommandHandlerContext, campaignId: string): Promise<number> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("growth.creatives")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("tenant_id", "=", ctx.tenantId)
    .where("campaign_id", "=", campaignId)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function personExists(ctx: CommandHandlerContext, personId: string): Promise<boolean> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("identity.persons")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", personId)
    .executeTakeFirst();
  return row !== undefined;
}

export async function tenantTimezone(ctx: CommandHandlerContext): Promise<string> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("control.tenants")
    .select(["timezone"])
    .where("id", "=", ctx.tenantId)
    .executeTakeFirst();
  return row?.timezone ?? "America/Sao_Paulo";
}

/**
 * Active suppression for (person, channel) or a DENIED preference on (person, channel).
 *
 * A suppression row matches a person ONLY when it names that person
 * directly (`person_id`) or names an identity linked to that person
 * (`identity_id` in the person's non-detached identities). A row with a
 * NULL `person_id` is an identity-directed suppression (migration 009
 * allows `person_id IS NULL` exactly for that case) — it is NEVER a
 * tenant-wide wildcard.
 */
export async function suppressionBlock(
  ctx: CommandHandlerContext,
  personId: string,
  channel: string,
): Promise<{ blocked: true; reason: "SUPPRESSED" | "OPTED_OUT" } | { blocked: false }> {
  const trx = requireTrx(ctx);
  const at = now();
  const identities = await trx
    .selectFrom("identity.identities")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("person_id", "=", personId)
    .where("detached_at", "is", null)
    .execute();
  const identityIds = identities.map((row) => row.id);
  let suppressed = await trx
    .selectFrom("communication.communication_suppressions")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("person_id", "=", personId)
    .where((eb) => eb.or([eb("channel", "=", channel), eb("channel", "is", null)]))
    .where("starts_at", "<=", at)
    .where((eb) => eb.or([eb("ends_at", "is", null), eb("ends_at", ">", at)]))
    .executeTakeFirst();
  if (suppressed === undefined && identityIds.length > 0) {
    suppressed = await trx
      .selectFrom("communication.communication_suppressions")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("identity_id", "in", identityIds)
      .where((eb) => eb.or([eb("channel", "=", channel), eb("channel", "is", null)]))
      .where("starts_at", "<=", at)
      .where((eb) => eb.or([eb("ends_at", "is", null), eb("ends_at", ">", at)]))
      .executeTakeFirst();
  }
  if (suppressed !== undefined) {
    return { blocked: true, reason: "SUPPRESSED" };
  }
  const preference = await trx
    .selectFrom("communication.communication_preferences")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("person_id", "=", personId)
    .where("channel", "=", channel)
    .where("status", "=", "DENIED")
    .executeTakeFirst();
  if (preference !== undefined) {
    return { blocked: true, reason: "OPTED_OUT" };
  }
  return { blocked: false };
}

/** Committed (non-blocked, non-cancelled) contact spend for a campaign version. */
export async function committedSpendMinor(
  trx: Transaction<Database>,
  tenantId: string,
  versionId: string,
): Promise<bigint> {
  const row = await trx
    .selectFrom("communication.scheduled_contacts as sc")
    .innerJoin("communication.message_intents as mi", (join) =>
      join
        .onRef("mi.tenant_id", "=", "sc.tenant_id")
        .onRef("mi.id", "=", "sc.intent_id"),
    )
    .select((eb) => eb.fn.sum("sc.estimated_cost_minor").as("total"))
    .where("sc.tenant_id", "=", tenantId)
    .where("mi.campaign_version_id", "=", versionId)
    .where("sc.status", "in", ["SCHEDULED", "DEFERRED", "SENT"])
    .executeTakeFirst();
  const total = row?.total;
  if (total === null || total === undefined) {
    return 0n;
  }
  return BigInt(String(total));
}

export interface TouchRow {
  id: string;
  personId: string;
  campaignId: string;
  campaignVersionId: string;
  touchType: string;
  occurredAt: Date;
  createdAt: Date;
}

function toTouchRow(row: {
  id: string;
  person_id: string;
  campaign_id: string;
  campaign_version_id: string;
  touch_type: string;
  occurred_at: Date;
  created_at: Date;
}): TouchRow {
  return {
    id: row.id,
    personId: row.person_id,
    campaignId: row.campaign_id,
    campaignVersionId: row.campaign_version_id,
    touchType: row.touch_type,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

const TOUCH_COLUMNS = [
  "id",
  "person_id",
  "campaign_id",
  "campaign_version_id",
  "touch_type",
  "occurred_at",
  "created_at",
] as const;

/** Earliest non-assist touch for (person, campaign) — the first-touch. */
export async function findFirstTouch(
  ctx: CommandHandlerContext,
  personId: string,
  campaignId: string,
): Promise<TouchRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("growth.attribution_touches")
    .select(TOUCH_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("person_id", "=", personId)
    .where("campaign_id", "=", campaignId)
    .where("touch_type", "<>", "REFERRAL_ASSIST")
    .orderBy("occurred_at", "asc")
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  return row === undefined ? null : toTouchRow(row);
}

/** Earliest non-assist touch for a person across campaigns (global first-touch). */
export async function findEarliestTouchForPerson(ctx: CommandHandlerContext, personId: string): Promise<TouchRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("growth.attribution_touches")
    .select(TOUCH_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("person_id", "=", personId)
    .where("touch_type", "<>", "REFERRAL_ASSIST")
    .orderBy("occurred_at", "asc")
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  return row === undefined ? null : toTouchRow(row);
}

export async function insertTouch(
  ctx: CommandHandlerContext,
  input: { personId: string; campaignId: string; campaignVersionId: string; touchType: string; occurredAt: Date },
): Promise<TouchRow> {
  const trx = requireTrx(ctx);
  const row = await trx
    .insertInto("growth.attribution_touches")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      person_id: input.personId,
      campaign_id: input.campaignId,
      campaign_version_id: input.campaignVersionId,
      touch_type: input.touchType,
      occurred_at: input.occurredAt,
      created_at: now(),
    })
    .returning(TOUCH_COLUMNS)
    .executeTakeFirstOrThrow();
  return toTouchRow(row);
}

export async function findConversionByKey(
  ctx: CommandHandlerContext,
  idempotencyKey: string,
): Promise<{ id: string } | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("growth.conversion_events")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? null : { id: row.id };
}
