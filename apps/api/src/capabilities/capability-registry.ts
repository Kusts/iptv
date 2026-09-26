import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import {
  baseAutonomyOf,
  clampAutonomyToMax,
  maxAutonomyOf,
  type AutonomyLevel,
  type PolicyClass,
  type ResolutionStep,
} from "@iptv/domain";
import { requirePermission } from "@iptv/auth";
import type { Database } from "@iptv/database";
import type { StoredCapability } from "../commands/command-bus.js";
import { PolicyResolver } from "../policy/policy-resolver.js";

/** Capability read port (global catalog; resolution scopes per tenant). */
export interface CapabilityStore {
  get(key: string): Promise<StoredCapability | null>;
  list(): Promise<StoredCapability[]>;
}

/** Kysely-backed read port. */
@Injectable()
export class KyselyCapabilityStore implements CapabilityStore {
  constructor(@Inject("DB") private readonly db: Kysely<Database> | null) {}

  private requireDb(): Kysely<Database> | null {
    return this.db;
  }

  async get(key: string): Promise<StoredCapability | null> {
    const db = this.requireDb();
    if (db === null) {
      return null;
    }
    const row = await db
      .selectFrom("platform.capabilities")
      .select([
        "key",
        "owner_context",
        "availability",
        "certification_status",
        "risk_level",
        "mvp_phase",
        "manual_equivalent",
        "policy_family",
        "degradation",
        "permissions",
      ])
      .where("key", "=", key)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return {
      key: row.key,
      ownerContext: row.owner_context,
      availability: row.availability,
      certificationStatus: row.certification_status,
      riskLevel: row.risk_level,
      mvpPhase: row.mvp_phase,
      manualEquivalent: row.manual_equivalent,
      policyFamily: row.policy_family,
      degradation: row.degradation,
      permissions: Array.isArray(row.permissions)
        ? row.permissions.filter((v): v is string => typeof v === "string")
        : [],
    };
  }

  async list(): Promise<StoredCapability[]> {
    const db = this.requireDb();
    if (db === null) {
      return [];
    }
    const rows = await db
      .selectFrom("platform.capabilities")
      .select([
        "key",
        "owner_context",
        "availability",
        "certification_status",
        "risk_level",
        "mvp_phase",
        "manual_equivalent",
        "policy_family",
        "degradation",
        "permissions",
      ])
      .orderBy("key", "asc")
      .execute();
    return rows.map((row) => ({
      key: row.key,
      ownerContext: row.owner_context,
      availability: row.availability,
      certificationStatus: row.certification_status,
      riskLevel: row.risk_level,
      mvpPhase: row.mvp_phase,
      manualEquivalent: row.manual_equivalent,
      policyFamily: row.policy_family,
      degradation: row.degradation,
      permissions: Array.isArray(row.permissions)
        ? row.permissions.filter((v): v is string => typeof v === "string")
        : [],
    }));
  }
}

/** Minimal actor surface the gate needs (mirrors `CommandActor`). */
export interface GateActor {
  userId: string;
  isPlatformAdmin: boolean;
  tenantId: string | null;
  permissions: string[];
}

export interface GateOptions {
  tenantId: string;
  partnerId?: string;
  /** Domain preconditions evaluated after authz/policy (step 4). */
  preconditions?: () => boolean | Promise<boolean>;
}

export interface GateResult {
  action: AutonomyLevel;
  provenance: ResolutionStep[];
  degraded: boolean;
  reason: string;
}

/**
 * ActionGate (W1-10): canonical resolution
 * `capability available? → actor permitted? → policy allows? →
 * preconditions valid? → autonomy level? → AUTO/APPROVAL/MANUAL/DENY`.
 *
 * Tool existence never implies authorization: every step can deny, and the
 * platform maximum (from the PLATFORM_INVARIANT document) only ever
 * downgrades — a silent upgrade is impossible by construction.
 */
@Injectable()
export class ActionGate {
  constructor(@Inject(PolicyResolver) private readonly policies: PolicyResolver) {}

  async resolve(
    capability: StoredCapability | null,
    actor: GateActor,
    opts: GateOptions,
  ): Promise<GateResult> {
    if (capability === null) {
      return { action: "DENY", provenance: [], degraded: false, reason: "capability_not_found" };
    }
    // Step 1 — availability BEFORE any permission check: an unavailable
    // capability denies for everyone, without leaking permission detail.
    if (capability.availability === "UNAVAILABLE") {
      return {
        action: "DENY",
        provenance: [],
        degraded: false,
        reason: "unavailable",
      };
    }
    const degraded = capability.availability === "DEGRADED";
    // Step 2 — actor permission via the shared guard (platform bypass kept).
    try {
      for (const permission of capability.permissions) {
        requirePermission(
          {
            userId: actor.userId,
            isPlatformAdmin: actor.isPlatformAdmin,
            tenantId: actor.tenantId,
            roleKeys: [],
            permissions: actor.permissions as never,
          },
          opts.tenantId,
          permission,
        );
      }
    } catch {
      return { action: "DENY", provenance: [], degraded, reason: "forbidden" };
    }
    // Step 3 — policy check on the capability's family.
    const decision = await this.policies.resolve(capability.policyFamily, {
      tenantId: opts.tenantId,
      partnerId: opts.partnerId,
    });
    if (decision.configured && decision.value["allow"] === false) {
      return { action: "DENY", provenance: decision.provenance, degraded, reason: "policy_denied" };
    }
    let base: AutonomyLevel = decision.configured ? baseAutonomyOf(decision.value) : "AUTO";
    // Step 4 — preconditions callback.
    if (opts.preconditions !== undefined) {
      const satisfied = await opts.preconditions();
      if (!satisfied) {
        return {
          action: "DENY",
          provenance: decision.provenance,
          degraded,
          reason: "precondition_failed",
        };
      }
    }
    // Step 5 — autonomy bounded by the platform maximum (downgrade-only).
    const invariantMax = decision.configured ? platformMaxOf(decision.provenance) : null;
    if (invariantMax !== null) {
      base = clampAutonomyToMax(base, invariantMax);
    }
    const reason =
      base === "AUTO" ? "allowed" : base === "DENY" ? "policy_denied" : "downgraded";
    return { action: base, provenance: decision.provenance, degraded, reason };
  }
}

/** Platform maximum carried by the PLATFORM_INVARIANT provenance layer. */
function platformMaxOf(provenance: ResolutionStep[]): AutonomyLevel | null {
  for (const step of provenance) {
    if ((step.source as PolicyClass) !== "PLATFORM_INVARIANT") {
      continue;
    }
    if (step.decision !== null && typeof step.decision === "object" && !Array.isArray(step.decision)) {
      const max = maxAutonomyOf(step.decision as Record<string, unknown>);
      if (max !== null) {
        return max;
      }
    }
  }
  return null;
}
