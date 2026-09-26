import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import {
  POLICY_CLASS_ORDER,
  isPolicyClass,
  mergePolicyLayers,
  notConfigured,
  type EffectiveDecision,
  type PolicyClass,
  type ResolutionStep,
} from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { StoredPolicyDocument } from "../commands/command-bus.js";

/**
 * Published-document source port. The Kysely implementation reads
 * `platform.policy_documents` outside a command transaction (resolution is a
 * read); command handlers use the `AppTx` variant instead.
 */
export interface PolicyRepository {
  listPublished(family: string, tenantId: string, partnerId?: string): Promise<StoredPolicyDocument[]>;
}

/** Kysely-backed read port (latest published versions first). */
@Injectable()
export class KyselyPolicyRepository implements PolicyRepository {
  constructor(@Inject("DB") private readonly db: Kysely<Database> | null) {}

  async listPublished(family: string, tenantId: string, partnerId?: string): Promise<StoredPolicyDocument[]> {
    if (this.db === null) {
      return [];
    }
    const partner = partnerId ?? tenantId;
    const rows = await this.db
      .selectFrom("platform.policy_documents")
      .select([
        "id",
        "tenant_id",
        "family",
        "scope",
        "class",
        "version",
        "status",
        "document",
        "published_at",
      ])
      .where("family", "=", family)
      .where("status", "=", "PUBLISHED")
      .where((eb) =>
        eb.or([
          eb.and([eb("scope", "=", "PLATFORM"), eb("tenant_id", "is", null)]),
          eb.and([eb("scope", "=", "TENANT"), eb("tenant_id", "=", tenantId)]),
          eb.and([eb("scope", "=", "PARTNER"), eb("tenant_id", "=", partner)]),
        ]),
      )
      .orderBy("version", "desc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      family: row.family,
      scope: row.scope,
      class: row.class,
      version: Number(row.version),
      status: row.status,
      document:
        row.document !== null && typeof row.document === "object" && !Array.isArray(row.document)
          ? (row.document as Record<string, unknown>)
          : {},
      publishedAt: row.published_at,
    }));
  }
}

export interface ResolveContext {
  tenantId: string;
  partnerId?: string;
}

/**
 * PolicyResolver (W1-09): loads applicable PUBLISHED documents in precedence
 * order (`PLATFORM_INVARIANT → PLATFORM_POLICY → TENANT_POLICY →
 * PARTNER_POLICY`; latest published version wins within a class), merges
 * with higher-class-wins semantics, and returns the effective decision with
 * a full provenance chain. A missing family yields a typed
 * `configured: false` result — never an exception.
 */
@Injectable()
export class PolicyResolver {
  constructor(@Inject("POLICY_REPOSITORY") private readonly repo: PolicyRepository) {}

  async resolve(
    family: string,
    ctx: ResolveContext,
  ): Promise<EffectiveDecision<Record<string, unknown>>> {
    const rows = await this.repo.listPublished(family, ctx.tenantId, ctx.partnerId);
    if (rows.length === 0) {
      return notConfigured();
    }
    // Latest published version per class (highest version wins,
    // independent of repository row order).
    const latestByClass = new Map<PolicyClass, StoredPolicyDocument>();
    for (const row of rows) {
      if (!isPolicyClass(row.class)) {
        continue;
      }
      const current = latestByClass.get(row.class);
      if (current === undefined || row.version > current.version) {
        latestByClass.set(row.class, row);
      }
    }
    const ordered = [...latestByClass.entries()].sort(
      ([a], [b]) => POLICY_CLASS_ORDER[a] - POLICY_CLASS_ORDER[b],
    );
    if (ordered.length === 0) {
      return notConfigured();
    }
    const provenance: ResolutionStep[] = ordered.map(([, row]) => ({
      source: row.class as PolicyClass,
      ref: `${row.scope}:${row.family}:v${row.version}`,
      decision: row.document,
    }));
    const value = mergePolicyLayers(provenance.map((step) => step.decision as Record<string, unknown>));
    return { configured: true, value, provenance };
  }
}
