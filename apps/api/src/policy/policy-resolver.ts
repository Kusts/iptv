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
import { withTenantTransaction, type Database } from "@iptv/database";
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
    // Tenant-context read (053): `platform.policy_documents` is RLS-enrolled
    // with the 048 split (global defaults + own-tenant rows). A pool-level
    // SELECT with no `app.tenant_id` would silently drop the tenant layers
    // and resolve on platform defaults only, so the caller's tenant rides
    // along explicitly -- same wrap as the Asaas chargeback lookup.
    //
    // Named-partner layer under RLS: another tenant's PARTNER rows are
    // invisible under the caller's context, so the own layers (PLATFORM
    // globals + TENANT rows) read under the caller and the exact named
    // partner's PARTNER layer (PUBLISHED, same family) reads under the
    // PARTNER's tenant instead -- never a cross-tenant wildcard. The visible
    // set matches the pre-RLS resolution exactly; pair authorization above
    // this port (which partner a tenant may name) is unchanged.
    const partner = partnerId ?? tenantId;
    if (partner === tenantId) {
      return withTenantTransaction(this.db, tenantId, async (trx) => {
        const rows = await trx
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
        return rows.map(mapPolicyRow);
      });
    }
    const db = this.db;
    const own = await withTenantTransaction(db, tenantId, async (trx) => {
      const rows = await trx
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
          ]),
        )
        .orderBy("version", "desc")
        .execute();
      return rows.map(mapPolicyRow);
    });
    const partnerRows = await withTenantTransaction(db, partner, async (trx) => {
      const rows = await trx
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
        .where("scope", "=", "PARTNER")
        .where("tenant_id", "=", partner)
        .orderBy("version", "desc")
        .execute();
      return rows.map(mapPolicyRow);
    });
    return [...own, ...partnerRows];
  }
}

function mapPolicyRow(row: {
  id: string;
  tenant_id: string | null;
  family: string;
  scope: string;
  class: string;
  version: number | string;
  status: string;
  document: unknown;
  published_at: Date | null;
}): StoredPolicyDocument {
  return {
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
  };
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
