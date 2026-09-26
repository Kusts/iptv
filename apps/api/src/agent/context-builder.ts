import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import type { ContextBundle } from "@iptv/ai-runtime";
import { PolicyResolver } from "../policy/policy-resolver.js";

/**
 * Wave 3 Context Builder: assembles the tenant-scoped `ContextBundle` OUTSIDE
 * the model (context engineering: minimum sufficient context, bounded recent
 * window, authoritative facts over summaries, policy as structured data).
 *
 * - Person/lead summary + last N messages (bounded, `AGENT_MESSAGE_WINDOW`).
 * - Tenant `agent` policy family when PUBLISHED (structured facts only —
 *   business policy is NEVER baked into prompts).
 * - Active suppressions/opt-outs and open human-review count.
 * - Every query is tenant-scoped; a foreign conversation yields null.
 */
export const AGENT_MESSAGE_WINDOW = 20;

const OPEN_REVIEW_STATUSES = ["REQUESTED", "QUEUED", "ACKNOWLEDGED", "IN_REVIEW"];

@Injectable()
export class ContextBuilder {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(PolicyResolver) private readonly policies: PolicyResolver,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new Error("database is not configured");
    }
    return this.db;
  }

  async build(tenantId: string, conversationId: string): Promise<ContextBundle | null> {
    const db = this.requireDb();
    const conv = await db
      .selectFrom("communication.conversations")
      .select(["id", "person_id", "channel", "status", "control_mode"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (conv === undefined) {
      return null;
    }
    const person = await db
      .selectFrom("identity.persons")
      .select(["id", "canonical_name", "locale"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", conv.person_id)
      .executeTakeFirst();

    const recentDesc = await db
      .selectFrom("communication.messages")
      .select(["direction", "sender_type", "body_text", "occurred_at"])
      .where("tenant_id", "=", tenantId)
      .where("conversation_id", "=", conversationId)
      .orderBy("occurred_at", "desc")
      .limit(AGENT_MESSAGE_WINDOW)
      .execute();

    const now = new Date();
    const suppressions = await db
      .selectFrom("communication.communication_suppressions")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where((eb) => eb.or([eb("person_id", "=", conv.person_id), eb("person_id", "is", null)]))
      .where((eb) => eb.or([eb("channel", "=", conv.channel), eb("channel", "is", null)]))
      .where("starts_at", "<=", now)
      .where((eb) => eb.or([eb("ends_at", "is", null), eb("ends_at", ">", now)]))
      .limit(1)
      .execute();
    const denied = await db
      .selectFrom("communication.communication_preferences")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", conv.person_id)
      .where("channel", "=", conv.channel)
      .where("status", "=", "DENIED")
      .limit(1)
      .execute();

    const reviews = await db
      .selectFrom("agent.human_review_requests")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("status", "in", OPEN_REVIEW_STATUSES)
      .where("resource_type", "=", "agent_proposal")
      .execute();

    const decision = await this.policies.resolve("agent", { tenantId });
    const doc = decision.configured ? decision.value : {};
    const allowAutonomous = doc["allow_autonomous"] === true;
    const notes: string[] = [];
    if (typeof doc["note"] === "string" && doc["note"].length > 0) {
      notes.push(doc["note"].slice(0, 280));
    }

    return {
      tenantId,
      conversationId,
      channel: conv.channel,
      controlMode: conv.control_mode,
      personSummary:
        person === undefined
          ? null
          : { personId: person.id, canonicalName: person.canonical_name, locale: person.locale },
      recentMessages: recentDesc.reverse().map((m) => ({
        direction: m.direction as "INBOUND" | "OUTBOUND",
        senderType: m.sender_type,
        bodyText: m.body_text,
        occurredAt: m.occurred_at.toISOString(),
      })),
      policySummary: { allowAutonomous, notes },
      suppressionsActive: suppressions.length > 0 || denied.length > 0,
      openReviewCount: reviews.length,
    };
  }
}
