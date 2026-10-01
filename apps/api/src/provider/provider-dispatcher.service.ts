import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import { resolveSecretsPort, type SecretsPort } from "@iptv/secrets";
import type { CommandHandlerContext, DbPort } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import { applySecretPortOutcome, decideVerifyingTrialReconcile } from "./provider.commands.js";
import { applyTrialProvisionOutcome } from "../trial/trial.commands.js";
import { applySubscriptionProvisionOutcome } from "../fulfillment/fulfillment.commands.js";
import { applyAppLicensePurchaseOutcome } from "../inventory/license.commands.js";
import {
  SECRET_REQUIRED_ADAPTER_VERSION,
  StubProviderReadback,
  adapterNameFromEnv,
  genericReadbackTimeoutMsFromEnv,
  isSyntheticReadbackSubject,
  providerDispatchLeaseMsFromEnv,
  providerDispatchTimeoutMsFromEnv,
  raceGenericReadback,
  resolveOpsPort,
  type AdapterResult,
  type ProviderOperationRequest,
  type ProviderOpsPort,
  type ProviderReadbackPort,
} from "./provider-port.js";
import {
  assertBrowserSecretReady,
  buildDispatchPortPayload,
  decideTrialDispatchGate,
  isSecretRequiringPort,
  PROVIDER_CALL_UNCERTAIN_CODE,
  TRIAL_CAPABILITY_KEY,
  trialDisposableAccountIdFromEnv,
  validateSecretRefFormat,
} from "./provider-secret-gate.js";
import {
  insertProviderAttempt,
} from "../trial/trial-store.js";
import { StubTrialReadback, raceTrialReadback, trialReadbackTimeoutMsFromEnv, type TrialReadbackPort, type TrialReadbackResult } from "../trial/trial-readback.js";

/**
 * Durable post-commit provider dispatch (CV-DSP-01, migration 045;
 * hardening CV-DSP-01-FIX).
 *
 * The secret-required `provider.request_operation` path commits its REQUESTED
 * row + `operation_requested` event WITHOUT calling the port when
 * `PROVIDER_DISPATCH_MODE=durable`. This service owns everything after that
 * commit in three explicit phases (D3 — the port call is NEVER inside a DB
 * transaction):
 *
 * - Phase 0 (fail-closed gates, no tx): provenance by durable
 *   `adapter_version` (D2) + capability revalidation via the same
 *   `platform.capabilities`/`provider.cinevision` seam the request handlers
 *   use (D4). Blocked rows park HUMAN_REQUIRED through the fenced applier
 *   without ever setting the send frontier or calling a port.
 * - Phase 1 (short tx): fenced promotion QUEUED→RUNNING with
 *   `claimed_by=$token AND status='QUEUED' AND lease_expires_at > now()` (D1)
 *   + `STARTED` attempt + `dispatch_started_at` frontier marker on BOTH rows.
 * - Phase 2 (NO transaction): bounded port call (`racePortCall`).
 * - Phase 3 (short tx): fenced result application
 *   (`claimed_by=$token AND status IN ('QUEUED','RUNNING')`, 0 rows = claim
 *   lost → abort with no result write) + lease cleared atomically in the
 *   same statement (D1). A Phase-3 failure leaves the frontier marker + lease
 *   behind, so `recoverOnce` parks VERIFYING/UNKNOWN for readback.
 * - `recoverOnce(budget)`: single-statement atomic recovery (D1). The SELECT
 *   only lists candidates; the decision IS the conditional UPDATE's WHERE
 *   (pre-send requeue requires `dispatch_started_at IS NULL`, post-send park
 *   requires `dispatch_started_at IS NOT NULL`, both require in-flight status
 *   + expired lease). Zero affected rows = already moved/terminal → skipped,
 *   never counted. Terminal outcomes are never matched and never overwritten.
 *
 * Claim tokens (D1): every `drainOnce` acquisition mints
 * `provider-dispatcher-<pid>:<uuid>` and stores it in `claimed_by` (no new
 * column, no migration — `claimed_by` is already `text`). A stale worker that
 * reclaims with a fresh token can never satisfy a prior owner's fencing
 * predicate. Provenance (D2): only `secret-required-v1` rows are claimed;
 * synthetic (`echo-v1`/`manual-v1`) rows never enter the durable queue.
 *
 * Secrets: the dispatcher resolves the validated `secret_ref` STRING at
 * dispatch time (never a value, never invented) and forwards only it to a
 * secret-requiring port. When no secret resolves at runtime the operation
 * parks HUMAN_REQUIRED via the MANUAL outcome — payloads, events, audit and
 * evidence never carry ref material.
 */

export type ProviderDispatcherMode = "durable" | "inline";

export interface ProviderDispatcherOverrides {
  opsPort?: ProviderOpsPort;
  secretsPort?: SecretsPort;
  /** Test seam: override the tenant-scoped `secret_ref` loader. */
  loadSecretRef?: (tenantId: string, providerAccountId: string) => Promise<string | null>;
  timeoutMs?: number;
  leaseMs?: number;
  /**
   * Test seam: override the `platform.capabilities` key revalidated in
   * Phase 0b. Defaults to the instance key (production: `provider.cinevision`).
   * Lets parallel integration suites isolate their UNAVAILABLE flips on
   * private rows instead of racing on the GLOBAL row.
   */
  capabilityKey?: string;
  /**
   * FASE5-S4S5 test seam: override the per-action `trial.provision`
   * capability key revalidated in Phase 0b2. Defaults to the instance trial
   * key (production: `provider.cinevision.trial`). Lets parallel suites
   * isolate their trial-gate flips on a private row instead of racing on
   * the shared gate row.
   */
  trialCapabilityKey?: string;
  /**
   * FASE5-S4S5 test seam: override the designated disposable trial account
   * checked in Phase 0b2. Defaults to
   * `PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID` (absent = no designation =
   * fail-closed for real trial writes).
   */
  trialDisposableAccountId?: string;
  /**
   * FASE5-FIX4-N1 test seam: generic effect readback consulted by
   * `reconcileOnce` for VERIFYING secret-required `trial.provision` rows.
   * Defaults to `StubProviderReadback` (fail-closed: secret-required rows
   * are always INCONCLUSIVE → HUMAN_REQUIRED convergence).
   */
  readbackPort?: ProviderReadbackPort;
  /**
   * FASE5-FIX5 test seam: generic effect-readback budget in milliseconds
   * for `reconcileOnce` (SPEC §35). Defaults to
   * `genericReadbackTimeoutMsFromEnv()` (30s default, 300s cap — same shape
   * as the sibling budgets).
   */
  genericReadbackTimeoutMs?: number;
  /**
   * FASE5-S6 (SPEC §25) test seam: readback port consulted after a
   * secret-required `trial.provision` SUCCEEDED, BEFORE the Phase-3 fenced
   * write — with NO open transaction (same region as the Phase-2 port
   * call). Defaults to `StubTrialReadback` (fail-closed INCONCLUSIVE →
   * VERIFYING). Bounded by `raceTrialReadback` (SPEC §35): a hanging or
   * throwing port resolves to inconclusive — the POST is never re-sent
   * and the throw never propagates.
   */
  trialReadbackPort?: TrialReadbackPort;
  /**
   * FASE5-S6-FIX2 (SPEC §35) test seam: READ_CUSTOMER budget in
   * milliseconds. Defaults to `trialReadbackTimeoutMsFromEnv()` (same
   * 30s default/cap as the port-call budget).
   */
  trialReadbackTimeoutMs?: number;
}

export interface ProviderDispatcherOptions {
  /**
   * Instance-level `platform.capabilities` key (production default:
   * `provider.cinevision`). Injected via `DISPATCH_CAPABILITY_KEY` when the
   * service is built by Nest; passed directly in tests.
   */
  capabilityKey?: string;
  /**
   * FASE5-S4S5 instance-level per-action trial capability key (production
   * default: `provider.cinevision.trial`). Injected via
   * `DISPATCH_TRIAL_CAPABILITY_KEY` when built by Nest; passed directly
   * (4th constructor arg) in tests.
   */
  trialCapabilityKey?: string;
}

export interface DispatchDrainSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  verifying: number;
  humanRequired: number;
  skipped: number;
  operationIds: string[];
}

export interface DispatchRecoverSummary {
  released: number;
  verifying: number;
  operationIds: string[];
}

/**
 * FASE5-FIX4-N1: outcome of one `reconcileOnce` pass over VERIFYING
 * secret-required `trial.provision` rows. `checked` counts candidates seen;
 * `skipped` counts rows a concurrent resolution already moved (CAS loser,
 * zero writes) plus load failures; `verifying` is a defensive bucket that
 * stays zero by construction (the shared decision never re-parks
 * VERIFYING — N2).
 */
export interface DispatchReconcileSummary {
  checked: number;
  succeeded: number;
  failed: number;
  verifying: number;
  humanRequired: number;
  skipped: number;
  operationIds: string[];
}

export type DispatchRecoveryDecision = "release_to_requested" | "park_verifying" | "none";

/**
 * Pure recovery decision (unit-tested matrix): which expired-lease rows may
 * go back to REQUESTED, which must park VERIFYING, and which are untouched.
 * Only QUEUED/RUNNING rows with an EXPIRED lease are actionable; everything
 * else (vigorous lease, terminal or foreign status) is `none`.
 *
 * HINT ONLY (D1): the SELECT side may use this to pick which atomic
 * statement to attempt, but the decision that counts is the conditional
 * UPDATE's WHERE + affected-rows check in `recoverOnce`.
 */
export function decideDispatchRecovery(input: {
  status: string;
  leaseExpired: boolean;
  dispatchStarted: boolean;
}): DispatchRecoveryDecision {
  if (!input.leaseExpired) {
    return "none";
  }
  if (input.status !== "QUEUED" && input.status !== "RUNNING") {
    return "none";
  }
  if (!input.dispatchStarted) {
    return "release_to_requested";
  }
  return "park_verifying";
}

/** Capability row the dispatcher revalidates (same key handlers gate on). */
export const DISPATCH_CAPABILITY_KEY = "provider.cinevision";

/**
 * FASE5-S4S5: per-action capability row the dispatcher revalidates for real
 * `trial.provision` sends (same key the request handlers gate on). A
 * flipped GLOBAL row alone never releases trial writes.
 */
export const TRIAL_DISPATCH_CAPABILITY_KEY = TRIAL_CAPABILITY_KEY;

/**
 * D1: unique claim token per acquisition. `base` is the worker identity
 * (`provider-dispatcher-<pid>`); the uuid suffix makes every acquisition —
 * even two drains from the same process — mutually fencing.
 */
export function buildClaimToken(base: string, id: string = newId()): string {
  return `${base}:${id}`;
}

/** D2: durable provenance — only this version may run through the dispatcher. */
export function isSecretRequiredProvenance(adapterVersion: string | null): boolean {
  return (
    typeof adapterVersion === "string" &&
    adapterVersion.toLowerCase() === SECRET_REQUIRED_ADAPTER_VERSION.toLowerCase()
  );
}

export type DispatchProvenance = "secret-required" | "synthetic" | "other";

/**
 * D2: classify an operation by its DURABLE provenance (persisted
 * `adapter_version` + recorded `requested_payload.adapter`), never by the
 * resolved port name or env. Synthetic subjects reuse the readback gate
 * (`isSyntheticReadbackSubject`) so both seams agree on what "synthetic"
 * means.
 */
export function classifyDispatchProvenance(input: {
  adapterVersion: string | null;
  adapter?: string | null;
}): DispatchProvenance {
  if (isSecretRequiredProvenance(input.adapterVersion)) {
    return "secret-required";
  }
  if (
    isSyntheticReadbackSubject({
      adapter: input.adapter ?? null,
      adapterVersion: input.adapterVersion,
    })
  ) {
    return "synthetic";
  }
  return "other";
}

/**
 * D4: fail-closed capability check for the dispatch seam. Missing row or
 * UNAVAILABLE blocks the send; anything else (AVAILABLE, DEGRADED) lets the
 * dispatcher proceed. Mirrors the request-handler gate's UNAVAILABLE-wins
 * rule, but missing fails CLOSED here (the handlers' legacy
 * `capability_not_catalogued` fail-open never releases a send).
 */
export function isDispatchCapabilityBlocked(capability: { availability: string } | null): boolean {
  if (capability === null) {
    return true;
  }
  return capability.availability === "UNAVAILABLE";
}

export type PortCallResolution =
  | { kind: "result"; result: AdapterResult }
  | { kind: "timeout" }
  | { kind: "threw" };

/**
 * Bounded port call: resolves `timeout` when the budget lapses and `threw`
 * when the port rejects. The late settlement (a timed-out call that later
 * resolves) is swallowed — its uncertainty is exactly why the frontier
 * marker forces VERIFYING instead of FAILED.
 *
 * D3: this helper is deliberately transaction-unaware. Callers MUST await it
 * OUTSIDE any `withTransaction` callback — see `dispatchOne` phases.
 */
export function racePortCall(
  port: ProviderOpsPort,
  input: ProviderOperationRequest,
  timeoutMs: number,
): Promise<PortCallResolution> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(Math.floor(timeoutMs), 1));
    void Promise.resolve()
      .then(() => port.requestOperation(input))
      .then(
        (result) => {
          clearTimeout(timer);
          resolve({ kind: "result", result });
        },
        () => {
          clearTimeout(timer);
          resolve({ kind: "threw" });
        },
      );
  });
}

/**
 * CV-DSP-02 closed action→applier registry for Phase-3 result application.
 * Every applier shares the provider applier's contract (`{ status
 * (operation status), effectCertainty } | null`, fenced conditional write,
 * zero rows → `null` with no side effects) and is the same function the
 * inline secret-branch handler calls — the single source of truth per
 * domain. Unknown actions keep the provider applier (owning context for
 * `provider.request_operation` rows). `app_license.purchase` rows persist
 * `intent-v1` today so the claim filter never picks them up; the entry keeps
 * the map closed for the future secret-branch migration.
 */
const DISPATCH_APPLIERS: Record<string, "trial" | "subscription" | "license" | "provider"> = {
  "trial.provision": "trial",
  "subscription.provision": "subscription",
  "app_license.purchase": "license",
};

export function selectDispatchApplier(action: string): "trial" | "subscription" | "license" | "provider" {
  return DISPATCH_APPLIERS[action] ?? "provider";
}

function dispatcherActor(tenantId: string): CommandHandlerContext["actor"] {
  return {
    userId: "provider-dispatcher",
    isPlatformAdmin: true,
    tenantId,
    roleKeys: [],
    permissions: [],
    actorType: "system",
  };
}

interface ClaimedOperation {
  id: string;
  tenantId: string;
}

interface DispatchableOperation {
  id: string;
  tenantId: string;
  providerAccountId: string;
  action: string;
  entityType: string;
  entityId: string;
  idempotencyKey: string;
  requestedPayload: Record<string, unknown>;
  adapterVersion: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function recordedAdapterOf(payload: Record<string, unknown>): string | null {
  const candidate = payload["adapter"];
  return typeof candidate === "string" ? candidate : null;
}

@Injectable()
export class ProviderDispatcherService {
  private readonly capabilityKey: string;
  private readonly trialCapabilityKey: string;

  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject("COMMAND_DB") private readonly commandDb: DbPort | null,
    @Optional() @Inject("DISPATCH_CAPABILITY_KEY") capabilityKey?: string,
    @Optional() @Inject("DISPATCH_TRIAL_CAPABILITY_KEY") trialCapabilityKey?: string,
  ) {
    this.capabilityKey = capabilityKey ?? DISPATCH_CAPABILITY_KEY;
    this.trialCapabilityKey = trialCapabilityKey ?? TRIAL_DISPATCH_CAPABILITY_KEY;
  }

  /** Effective Phase-0b capability key: per-call override wins over the instance key. */
  private resolveCapabilityKey(overrides: ProviderDispatcherOverrides): string {
    const candidate = overrides.capabilityKey ?? this.capabilityKey;
    return candidate.length > 0 ? candidate : DISPATCH_CAPABILITY_KEY;
  }

  /** Effective Phase-0b2 trial capability key: per-call override wins over the instance key. */
  private resolveTrialCapabilityKey(overrides: ProviderDispatcherOverrides): string {
    const candidate = overrides.trialCapabilityKey ?? this.trialCapabilityKey;
    return candidate.length > 0 ? candidate : TRIAL_DISPATCH_CAPABILITY_KEY;
  }

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new Error("database is not configured");
    }
    return this.db;
  }

  private requireCommandDb(): DbPort {
    if (this.commandDb === null) {
      throw new Error("command database is not configured");
    }
    return this.commandDb;
  }

  /**
   * Claim up to `budget` secret-required REQUESTED operations
   * (SKIP LOCKED, oldest first) and dispatch each. D2: the claim filter
   * itself excludes synthetic rows (`adapter_version = secret-required-v1`),
   * so echo/manual operations never enter the durable queue even when
   * `PROVIDER_OPS_ADAPTER=echo`. Claim and send-frontier are separate
   * commits: a crash between them is recoverable by `recoverOnce`
   * (pre-send → REQUESTED, post-send → VERIFYING).
   */
  async drainOnce(budget = 10, overrides: ProviderDispatcherOverrides = {}): Promise<DispatchDrainSummary> {
    const db = this.requireDb();
    const safeBudget = Math.min(Math.max(Math.floor(budget), 1), 100);
    // D1: fresh token per acquisition — a stale worker reclaiming later mints
    // a different token and can never satisfy the prior owner's fencing.
    const claimToken = buildClaimToken(`provider-dispatcher-${process.pid}`);
    const leaseSecs = Math.max(Math.floor((overrides.leaseMs ?? providerDispatchLeaseMsFromEnv()) / 1000), 1);
    const claimed = await sql<ClaimedOperation>`
      UPDATE provider.provider_operations AS op SET
        claimed_by = ${claimToken},
        claimed_at = now(),
        lease_expires_at = now() + make_interval(secs => ${leaseSecs}),
        status = 'QUEUED'
      WHERE op.id IN (
        SELECT id FROM provider.provider_operations
        WHERE status = 'REQUESTED' AND claimed_by IS NULL
          AND adapter_version = ${SECRET_REQUIRED_ADAPTER_VERSION}
        ORDER BY requested_at ASC
        LIMIT ${safeBudget}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING op.id AS id, op.tenant_id AS "tenantId"
    `.execute(db);

    const summary: DispatchDrainSummary = {
      claimed: claimed.rows.length,
      succeeded: 0,
      failed: 0,
      verifying: 0,
      humanRequired: 0,
      skipped: 0,
      operationIds: claimed.rows.map((row) => row.id),
    };
    for (const row of claimed.rows) {
      const outcome = await this.dispatchOne(row.tenantId, row.id, claimToken, overrides).catch(() => null);
      if (outcome === null) {
        summary.skipped += 1;
        continue;
      }
      if (outcome === "SUCCEEDED") {
        summary.succeeded += 1;
      } else if (outcome === "FAILED") {
        summary.failed += 1;
      } else if (outcome === "VERIFYING") {
        summary.verifying += 1;
      } else {
        summary.humanRequired += 1;
      }
    }
    return summary;
  }

  /**
   * Recover expired dispatch leases with single-statement atomicity (D1).
   *
   * The SELECT only lists candidates; each row is then resolved by ONE
   * conditional UPDATE whose WHERE revalidates everything (in-flight status,
   * frontier marker polarity, expired lease, held claim). Zero affected rows
   * means a concurrent dispatcher already moved the row (promoted, resolved,
   * or terminalized) — the row is skipped and never counted. Terminal
   * outcomes never match the WHERE and are never overwritten.
   */
  async recoverOnce(budget = 100, overrides: ProviderDispatcherOverrides = {}): Promise<DispatchRecoverSummary> {
    void overrides;
    const db = this.requireDb();
    const commandDb = this.requireCommandDb();
    const safeBudget = Math.min(Math.max(Math.floor(budget), 1), 500);
    const expired = await sql<{ id: string; tenantId: string; status: string; started: boolean }>`
      SELECT id AS id, tenant_id AS "tenantId", status AS status,
        (dispatch_started_at IS NOT NULL) AS started
      FROM provider.provider_operations
      WHERE status IN ('QUEUED','RUNNING')
        AND claimed_by IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= now()
      ORDER BY lease_expires_at ASC
      LIMIT ${safeBudget}
    `.execute(db);

    const summary: DispatchRecoverSummary = { released: 0, verifying: 0, operationIds: [] };
    for (const row of expired.rows) {
      const decision = decideDispatchRecovery({
        status: row.status,
        leaseExpired: true,
        dispatchStarted: row.started,
      });
      if (decision === "release_to_requested") {
        // D1: atomic pre-send requeue — the WHERE revalidates the SELECT
        // snapshot. A concurrent promotion that already set the frontier
        // marker (or resolved the row) matches zero rows and is preserved.
        const released = await withTenantTransaction(db, row.tenantId, async (trx) => {
          const updated = await trx
            .updateTable("provider.provider_operations")
            .set({
              status: "REQUESTED",
              effect_certainty: "UNKNOWN",
              claimed_by: null,
              claimed_at: null,
              lease_expires_at: null,
              dispatch_started_at: null,
            })
            .where("tenant_id", "=", row.tenantId)
            .where("id", "=", row.id)
            .where("status", "in", ["QUEUED", "RUNNING"])
            .where("dispatch_started_at", "is", null)
            .where("claimed_by", "is not", null)
            .where(sql<boolean>`lease_expires_at <= now()`)
            .executeTakeFirst();
          return Number(updated.numUpdatedRows ?? 0);
        }).catch(() => 0);
        if (released < 1) {
          continue;
        }
        summary.released += 1;
        summary.operationIds.push(row.id);
      } else if (decision === "park_verifying") {
        // D1: atomic post-send park — same revalidation shape, opposite
        // frontier polarity, plus the VERIFYING attempt only when fenced.
        const parked = await commandDb
          .withTransaction(row.tenantId, async (tx) => {
            const ctx: CommandHandlerContext = {
              actor: dispatcherActor(row.tenantId),
              tenantId: row.tenantId,
              commandId: newId(),
              correlationId: newId(),
              causationId: null,
              tx,
            };
            const trx = kyselyTrxOf(ctx);
            if (trx === null) {
              return null;
            }
            const updated = await trx
              .updateTable("provider.provider_operations")
              .set({
                status: "VERIFYING",
                effect_certainty: "UNKNOWN",
                execution_channel: "MANUAL",
                result_summary_json: { error_code: PROVIDER_CALL_UNCERTAIN_CODE },
                started_at: sql`coalesce(started_at, now())`,
                claimed_by: null,
                claimed_at: null,
                lease_expires_at: null,
              })
              .where("tenant_id", "=", row.tenantId)
              .where("id", "=", row.id)
              .where("status", "in", ["QUEUED", "RUNNING"])
              .where("dispatch_started_at", "is not", null)
              .where("claimed_by", "is not", null)
              .where(sql<boolean>`lease_expires_at <= now()`)
              .executeTakeFirst();
            if (Number(updated.numUpdatedRows ?? 0) < 1) {
              return null;
            }
            await insertProviderAttempt(ctx, {
              operationId: row.id,
              status: "VERIFYING",
              errorCode: PROVIDER_CALL_UNCERTAIN_CODE,
            });
            return "VERIFYING" as const;
          })
          .catch(() => null);
        if (parked === null) {
          continue;
        }
        summary.verifying += 1;
        summary.operationIds.push(row.id);
      }
    }
    return summary;
  }

  /**
   * FASE5-FIX4-N1 (SPEC §12/§41): reconcile VERIFYING secret-required
   * `trial.provision` rows — the executor behind the `provider.reconcile`
   * scheduling response. Runs the FIX3-R3 gate with the SAME branch
   * contract, but ALL provider/readback I/O happens with NO open
   * transaction (Phase A), and the outcome lands in a short CAS-fenced
   * write on `status='VERIFYING'` (Phase B, loser writes nothing):
   *
   * - generic inconclusive → HUMAN_REQUIRED (S3, never a re-send);
   * - generic conclusive NOT_APPLIED → FAILED/REQUESTED (trial readback
   *   never consulted);
   * - generic conclusive APPLIED + conclusive trial readback WITH customer
   *   → postcondition gate (satisfied → SUCCEEDED/ACTIVE+binding, violated
   *   → HUMAN_REQUIRED/POSTCONDITION_MISMATCH);
   * - generic conclusive APPLIED but trial readback absent/inconclusive or
   *   conclusive-WITHOUT-customer → HUMAN_REQUIRED directly (N2, never a
   *   VERIFYING self-loop).
   *
   * Only `secret-required-v1` + `trial.provision` + `trial` + VERIFYING
   * rows are candidates — synthetic rows and other actions keep their
   * command-path behavior and are never touched here. Idempotent: a repeat
   * pass over converged rows checks nothing (terminal rows never match).
   */
  async reconcileOnce(budget = 100, overrides: ProviderDispatcherOverrides = {}): Promise<DispatchReconcileSummary> {
    const db = this.requireDb();
    const commandDb = this.requireCommandDb();
    const summary: DispatchReconcileSummary = {
      checked: 0,
      succeeded: 0,
      failed: 0,
      verifying: 0,
      humanRequired: 0,
      skipped: 0,
      operationIds: [],
    };
    const safeBudget = Math.min(Math.max(Math.floor(budget), 1), 500);
    const candidates = await sql<{
      id: string;
      tenantId: string;
      providerAccountId: string;
      entityId: string;
      requestedPayload: unknown;
      adapterVersion: string | null;
      resultSummary: unknown;
    }>`
      SELECT id AS id, tenant_id AS "tenantId",
        provider_account_id AS "providerAccountId", entity_id AS "entityId",
        requested_payload_json AS "requestedPayload", adapter_version AS "adapterVersion",
        result_summary_json AS "resultSummary"
      FROM provider.provider_operations
      WHERE status = 'VERIFYING'
        AND adapter_version = ${SECRET_REQUIRED_ADAPTER_VERSION}
        AND action = 'trial.provision'
        AND entity_type = 'trial'
      ORDER BY requested_at ASC
      LIMIT ${safeBudget}
    `.execute(db).catch(() => null);
    if (candidates === null) {
      return summary;
    }
    const genericReadback = overrides.readbackPort ?? new StubProviderReadback();
    const genericReadbackTimeoutMs = overrides.genericReadbackTimeoutMs ?? genericReadbackTimeoutMsFromEnv();
    const trialReadbackPort = overrides.trialReadbackPort ?? new StubTrialReadback();
    const trialReadbackTimeoutMs = overrides.trialReadbackTimeoutMs ?? trialReadbackTimeoutMsFromEnv();
    for (const row of candidates.rows) {
      summary.checked += 1;
      // ---- Phase A (NO transaction): bounded observations. --------------
      // Both awaits sit OUTSIDE any `withTransaction` callback — no DB
      // transaction is held open during provider I/O (reviewer invariant) —
      // and BOTH carry a finite budget (SPEC §35): a hanging generic
      // verify resolves to inconclusive instead of wedging the scheduler
      // tick or the admin drain.
      const requestedPayload = asRecord(row.requestedPayload);
      const resultSummary = asRecord(row.resultSummary);
      const externalRef = typeof resultSummary["external_ref"] === "string"
        ? (resultSummary["external_ref"] as string)
        : null;
      const observed = (await raceGenericReadback(
        genericReadback,
        {
          tenantId: row.tenantId,
          operationId: row.id,
          action: "trial.provision",
          externalRef,
          adapter: recordedAdapterOf(requestedPayload),
          adapterVersion: row.adapterVersion,
        },
        genericReadbackTimeoutMs,
      )) ?? { effectApplied: false, evidence: "reconcile:readback-inconclusive", conclusive: false };
      let trialReadback: TrialReadbackResult | null = null;
      if (observed.conclusive === true && observed.effectApplied === true) {
        trialReadback = await raceTrialReadback(
          trialReadbackPort,
          {
            tenantId: row.tenantId,
            operationId: row.id,
            trialId: row.entityId,
            providerAccountId: row.providerAccountId,
            externalRef,
          },
          trialReadbackTimeoutMs,
        );
      }
      const decision = decideVerifyingTrialReconcile(observed, trialReadback);
      // ---- Phase B (short tx): CAS-fenced outcome application. ----------
      const outcome = await commandDb
        .withTransaction(row.tenantId, async (tx) => {
          const ctx: CommandHandlerContext = {
            actor: dispatcherActor(row.tenantId),
            tenantId: row.tenantId,
            commandId: newId(),
            correlationId: newId(),
            causationId: null,
            tx,
          };
          const fence = { expectedStatus: "VERIFYING" };
          if (decision.kind === "converge-human-required") {
            const converged = await applySecretPortOutcome(
              ctx,
              {
                operationId: row.id,
                action: "trial.provision",
                entityType: "trial",
                entityId: row.entityId,
                raw: { outcome: "MANUAL", detail: "reconcile: inconclusive trial readback", externalRef: null },
              },
              fence,
            );
            return converged?.status ?? null;
          }
          if (decision.kind === "fail-not-applied") {
            const failed = await applyTrialProvisionOutcome(
              ctx,
              {
                operationId: row.id,
                trialId: row.entityId,
                raw: { outcome: "FAILED", detail: "reconcile: conclusive readback", externalRef: null },
              },
              fence,
            );
            return failed?.status ?? null;
          }
          const gated = await applyTrialProvisionOutcome(
            ctx,
            {
              operationId: row.id,
              trialId: row.entityId,
              raw: { outcome: "SUCCEEDED", detail: "reconcile: conclusive readback", externalRef: null },
              trialReadback: decision.trialReadback,
            },
            fence,
          );
          return gated?.status ?? null;
        })
        .catch(() => null);
      if (outcome === null) {
        summary.skipped += 1;
        continue;
      }
      summary.operationIds.push(row.id);
      if (outcome === "SUCCEEDED") {
        summary.succeeded += 1;
      } else if (outcome === "FAILED") {
        summary.failed += 1;
      } else if (outcome === "VERIFYING") {
        summary.verifying += 1;
      } else {
        summary.humanRequired += 1;
      }
    }
    return summary;
  }

  private async dispatchOne(
    tenantId: string,
    operationId: string,
    claimToken: string,
    overrides: ProviderDispatcherOverrides,
  ): Promise<"SUCCEEDED" | "FAILED" | "VERIFYING" | "HUMAN_REQUIRED" | null> {
    const db = this.requireDb();
    const commandDb = this.requireCommandDb();
    const op = await this.loadDispatchable(tenantId, operationId);
    if (op === null) {
      return null;
    }

    // ---- Phase 0a (D2, no tx, no frontier, no port): durable provenance. ----
    // Synthetic rows can only reach here via a concurrent version change
    // after the claim filter; release them back to REQUESTED (the next drain
    // will not reclaim them) and count as skipped — with zero port effect.
    const provenance = classifyDispatchProvenance({
      adapterVersion: op.adapterVersion,
      adapter: recordedAdapterOf(op.requestedPayload),
    });
    if (provenance === "synthetic") {
      await withTenantTransaction(db, tenantId, async (trx) => {
        await trx
          .updateTable("provider.provider_operations")
          .set({
            status: "REQUESTED",
            claimed_by: null,
            claimed_at: null,
            lease_expires_at: null,
            dispatch_started_at: null,
          })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", operationId)
          .where("claimed_by", "=", claimToken)
          .where("status", "=", "QUEUED")
          .execute();
      }).catch(() => undefined);
      return null;
    }
    if (provenance !== "secret-required") {
      return await this.parkHumanRequiredFenced(tenantId, op, claimToken);
    }

    // ---- Phase 0b (D4, no tx, no frontier, no port): capability recheck. --
    // Same table/key the request handlers gate on; read here (outside any
    // transaction) so an AVAILABLE→UNAVAILABLE flip between request and drain
    // parks HUMAN_REQUIRED instead of sending. The key is injectable for
    // test isolation (default `provider.cinevision` = production behavior).
    const capability = await db
      .selectFrom("platform.capabilities")
      .select(["availability"])
      .where("key", "=", this.resolveCapabilityKey(overrides))
      .executeTakeFirst()
      .catch(() => undefined);
    if (isDispatchCapabilityBlocked(capability ?? null)) {
      return await this.parkHumanRequiredFenced(tenantId, op, claimToken);
    }

    // ---- Phase 0b2 (FASE5-S4S5, no tx, no frontier, no port): per-action
    // trial gate. A real `trial.provision` send additionally requires the
    // `provider.cinevision.trial` row AVAILABLE plus an explicit disposable
    // designation naming exactly this operation's account (which must still
    // be ACTIVE in this tenant). Anything else parks HUMAN_REQUIRED without
    // ever setting the send frontier or calling a port — even when the
    // GLOBAL row is AVAILABLE. Non-trial actions (notably
    // `subscription.provision`) skip this phase entirely: no per-action
    // gate exists for them in this slice.
    if (op.action === "trial.provision") {
      const trialCapability = await db
        .selectFrom("platform.capabilities")
        .select(["availability"])
        .where("key", "=", this.resolveTrialCapabilityKey(overrides))
        .executeTakeFirst()
        .catch(() => undefined);
      const trialGate = decideTrialDispatchGate({
        action: op.action,
        trialCapability: trialCapability ?? null,
        designatedAccountId: overrides.trialDisposableAccountId ?? trialDisposableAccountIdFromEnv(),
        providerAccountId: op.providerAccountId,
      });
      if (trialGate !== "allow") {
        return await this.parkHumanRequiredFenced(tenantId, op, claimToken);
      }
      const designatedActive = await db
        .selectFrom("provider.provider_accounts")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", op.providerAccountId)
        .where("status", "=", "ACTIVE")
        .executeTakeFirst()
        .catch(() => undefined);
      if (designatedActive === undefined) {
        return await this.parkHumanRequiredFenced(tenantId, op, claimToken);
      }
    }

    // ---- Phase 0c (D2, no tx, no frontier, no port): port compatibility. --
    // A secret-required operation may ONLY run on a secret-requiring port.
    // With `PROVIDER_OPS_ADAPTER=echo` (or any synthetic override) there is
    // no compatible port — park HUMAN_REQUIRED, never a synthetic SUCCEEDED.
    const port = this.resolvePort(op, overrides);
    if (!isSecretRequiringPort(port)) {
      return await this.parkHumanRequiredFenced(tenantId, op, claimToken);
    }
    const secretRef = await this.resolveSecretRef(tenantId, op, port, overrides);
    // The frontier marker is NOT set on any path above: from here on, an
    // unsettled external effect is possible, so a missing secret parks
    // HUMAN_REQUIRED (never an invented credential).
    if (secretRef === null) {
      return await this.parkHumanRequiredFenced(tenantId, op, claimToken);
    }

    // ---- Phase 1 (short tx): fenced promotion + frontier marker. ---------
    // Only the claiming worker may flip it, and only while its lease is still
    // valid — a concurrent recovery that already released the row affects
    // zero rows and we skip.
    const frontierAt = new Date();
    const promoted = await withTenantTransaction(db, tenantId, async (trx) => {
      const attempt = await trx
        .selectFrom("provider.provider_operation_attempts")
        .select(["attempt_no"])
        .where("tenant_id", "=", tenantId)
        .where("provider_operation_id", "=", operationId)
        .orderBy("attempt_no", "desc")
        .limit(1)
        .executeTakeFirst();
      const attemptNo = Number(attempt?.attempt_no ?? 0) + 1;
      const updated = await trx
        .updateTable("provider.provider_operations")
        .set({
          status: "RUNNING",
          effect_certainty: "UNKNOWN",
          dispatch_started_at: frontierAt,
          started_at: sql`coalesce(started_at, now())`,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", operationId)
        .where("claimed_by", "=", claimToken)
        .where("status", "=", "QUEUED")
        .where(sql<boolean>`lease_expires_at > now()`)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows ?? 0) < 1) {
        return null;
      }
      await trx
        .insertInto("provider.provider_operation_attempts")
        .values({
          id: newId(),
          tenant_id: tenantId,
          provider_operation_id: operationId,
          attempt_no: attemptNo,
          status: "STARTED",
          started_at: frontierAt,
          completed_at: null,
          error_class: null,
          error_code: null,
          trace_ref: null,
          dispatch_started_at: frontierAt,
        })
        .execute();
      return { attemptNo };
    }).catch(() => null);
    if (promoted === null) {
      return null;
    }

    // ---- Phase 2 (D3): port call with NO open transaction. ---------------
    // This await sits BETWEEN the Phase-1 commit above and the Phase-3
    // transaction below — never inside a `withTransaction` callback — so no
    // DB transaction is held open during the external call.
    const timeoutMs = overrides.timeoutMs ?? providerDispatchTimeoutMsFromEnv();
    // CV-DSP-02-FIX F1: shared projection with the inline secret-branch
    // handlers — certified fields only per action (domain metadata such as
    // `trial_kind`/`customer_id` stays on the persisted row, never on the
    // wire), so the durable port payload always equals the inline one.
    const payload = buildDispatchPortPayload(op.action, op.requestedPayload);
    const call = await racePortCall(
      port,
      {
        tenantId,
        providerAccountId: op.providerAccountId,
        action: op.action,
        entityType: op.entityType,
        entityId: op.entityId,
        idempotencyKey: op.idempotencyKey,
        payload,
        correlationId: newId(),
        secretRef,
      },
      timeoutMs,
    );

    // ---- Phase 2b (FASE5-S6, D3, NO transaction): trial readback. -------
    // On the REAL path (`trial.provision` SUCCEEDED) an isolated HTTP 200
    // never terminates the operation: READ_CUSTOMER runs here — after the
    // send, before any result write, with no open transaction — and Phase
    // 3 decides on it (satisfied → SUCCEEDED + binding; violated →
    // HUMAN_REQUIRED/`POSTCONDITION_MISMATCH`; inconclusive/error →
    // VERIFYING/UNKNOWN). Other actions and non-SUCCEEDED outcomes skip
    // this phase entirely (no readback traffic, no re-send, no throw).
    // FASE5-S6-FIX2 (SPEC §35): bounded by `raceTrialReadback` — a
    // hanging or throwing readback resolves to null (INCONCLUSIVE →
    // VERIFYING/UNKNOWN, never FAILED, never a re-send).
    let trialReadback: TrialReadbackResult | null = null;
    if (op.action === "trial.provision" && call.kind === "result" && call.result.outcome === "SUCCEEDED") {
      const readbackPort = overrides.trialReadbackPort ?? new StubTrialReadback();
      const readbackTimeoutMs = overrides.trialReadbackTimeoutMs ?? trialReadbackTimeoutMsFromEnv();
      trialReadback = await raceTrialReadback(readbackPort, {
        tenantId,
        operationId,
        trialId: op.entityId,
        providerAccountId: op.providerAccountId,
        externalRef: call.result.externalRef,
      }, readbackTimeoutMs);
    }

    // ---- Phase 3 (short tx): fenced result application + lease clear. ----
    // Zero affected rows = claim lost after the send (recovery parked the
    // row) → abort with NO result write; recovery/readback owns resolution.
    if (call.kind !== "result") {
      const parked = await commandDb
        .withTransaction(tenantId, async (tx) => {
          const ctx: CommandHandlerContext = {
            actor: dispatcherActor(tenantId),
            tenantId,
            commandId: newId(),
            correlationId: newId(),
            causationId: null,
            tx,
          };
          const trx = kyselyTrxOf(ctx);
          if (trx === null) {
            return null;
          }
          const updated = await trx
            .updateTable("provider.provider_operations")
            .set({
              status: "VERIFYING",
              effect_certainty: "UNKNOWN",
              execution_channel: "MANUAL",
              result_summary_json: { error_code: PROVIDER_CALL_UNCERTAIN_CODE },
              started_at: sql`coalesce(started_at, now())`,
              claimed_by: null,
              claimed_at: null,
              lease_expires_at: null,
            })
            .where("tenant_id", "=", tenantId)
            .where("id", "=", operationId)
            .where("claimed_by", "=", claimToken)
            .where("status", "in", ["QUEUED", "RUNNING"])
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows ?? 0) < 1) {
            return null;
          }
          await insertProviderAttempt(ctx, {
            operationId,
            status: "VERIFYING",
            errorCode: PROVIDER_CALL_UNCERTAIN_CODE,
          });
          return "VERIFYING" as const;
        })
        .catch(() => null);
      return parked;
    }
    const outcome = await commandDb
      .withTransaction(tenantId, async (tx) => {        const ctx: CommandHandlerContext = {
          actor: dispatcherActor(tenantId),
          tenantId,
          commandId: newId(),
          correlationId: newId(),
          causationId: null,
          tx,
        };
        const raw = {
          outcome: call.result.outcome,
          detail: call.result.detail,
          externalRef: call.result.externalRef,
        };
        const fence = { claimedBy: claimToken };
        // CV-DSP-02: closed action→applier registry. Each domain applier is
        // the same function its inline secret-branch handler calls, with the
        // same fenced contract (lost claim → null, no result write).
        const applier = selectDispatchApplier(op.action);
        if (applier === "trial") {
          const applied = await applyTrialProvisionOutcome(
            ctx,
            { operationId, trialId: op.entityId, raw, trialReadback },
            fence,
          );
          return applied?.status ?? null;
        }
        if (applier === "subscription") {
          const applied = await applySubscriptionProvisionOutcome(
            ctx,
            { operationId, subscriptionId: op.entityId, providerAccountId: op.providerAccountId, raw },
            fence,
          );
          return applied?.status ?? null;
        }
        if (applier === "license") {
          const applied = await applyAppLicensePurchaseOutcome(ctx, { operationId, raw }, fence);
          return applied?.status ?? null;
        }
        const applied = await applySecretPortOutcome(
          ctx,
          {
            operationId,
            action: op.action,
            entityType: op.entityType,
            entityId: op.entityId,
            raw,
          },
          fence,
        );
        return applied?.status ?? null;
      })
      .catch(() => null);
    if (outcome === "SUCCEEDED" || outcome === "FAILED" || outcome === "VERIFYING" || outcome === "HUMAN_REQUIRED") {
      return outcome;
    }
    return null;
  }

  /**
   * D2/D4 fail-closed park: fenced QUEUED/RUNNING → HUMAN_REQUIRED through
   * the single shared applier (never a synthetic port call, never a frontier
   * marker). Returns HUMAN_REQUIRED on success, null when the claim was
   * already lost (caller counts it as skipped; recovery owns the row).
   */
  private async parkHumanRequiredFenced(
    tenantId: string,
    op: DispatchableOperation,
    claimToken: string,
  ): Promise<"HUMAN_REQUIRED" | null> {
    const commandDb = this.requireCommandDb();
    const parked = await commandDb
      .withTransaction(tenantId, async (tx) => {
        const ctx: CommandHandlerContext = {
          actor: dispatcherActor(tenantId),
          tenantId,
          commandId: newId(),
          correlationId: newId(),
          causationId: null,
          tx,
        };
        const applied = await applySecretPortOutcome(
          ctx,
          {
            operationId: op.id,
            action: op.action,
            entityType: op.entityType,
            entityId: op.entityId,
            raw: { outcome: "MANUAL", detail: "dispatcher: fail-closed park", externalRef: null },
          },
          { claimedBy: claimToken },
        );
        return applied?.status ?? null;
      })
      .catch(() => null);
    return parked === "HUMAN_REQUIRED" ? "HUMAN_REQUIRED" : null;
  }

  private async loadDispatchable(tenantId: string, operationId: string): Promise<DispatchableOperation | null> {
    const db = this.requireDb();
    const row = await db
      .selectFrom("provider.provider_operations")
      .select([
        "id",
        "tenant_id",
        "provider_account_id",
        "action",
        "entity_type",
        "entity_id",
        "idempotency_key",
        "requested_payload_json",
        "adapter_version",
      ])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", operationId)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      providerAccountId: row.provider_account_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      idempotencyKey: row.idempotency_key,
      requestedPayload: asRecord(row.requested_payload_json),
      adapterVersion: row.adapter_version,
    };
  }

  /**
   * Same seam as the request handlers: an explicit override wins, otherwise
   * the adapter recorded on the operation (echo/manual) stands, otherwise
   * the env default. D2 provenance enforcement happens in `dispatchOne`
   * AFTER this resolution: a secret-required operation paired here with a
   * synthetic port parks HUMAN_REQUIRED instead of executing anything.
   */
  private resolvePort(op: DispatchableOperation, overrides: ProviderDispatcherOverrides): ProviderOpsPort {
    if (overrides.opsPort !== undefined) {
      return overrides.opsPort;
    }
    const recorded = op.requestedPayload["adapter"];
    if (recorded === "echo" || recorded === "manual") {
      return resolveOpsPort(recorded);
    }
    return resolveOpsPort(adapterNameFromEnv());
  }

  /**
   * Runtime secret resolution: loads the tenant-scoped `secret_ref` STRING
   * and verifies a configured SecretsPort WITHOUT ever fetching a value.
   * Returns null when the port needs no secret, or when no secret resolves
   * (caller parks HUMAN_REQUIRED). Never throws for a missing ref.
   */
  private async resolveSecretRef(
    tenantId: string,
    op: DispatchableOperation,
    port: ProviderOpsPort,
    overrides: ProviderDispatcherOverrides,
  ): Promise<string | null> {
    if (!isSecretRequiringPort(port)) {
      return null;
    }
    // Branch-derived provenance decides the gate path, never the port name:
    // only secret-required operations reach a secret-requiring port.
    const isSecretOperation = isSecretRequiredProvenance(op.adapterVersion);
    if (!isSecretOperation) {
      return null;
    }
    let ref: string | null;
    if (overrides.loadSecretRef !== undefined) {
      ref = await overrides.loadSecretRef(tenantId, op.providerAccountId);
    } else {
      const db = this.requireDb();
      const row = await db
        .selectFrom("provider.provider_accounts")
        .select(["secret_ref"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", op.providerAccountId)
        .executeTakeFirst();
      const candidate = (row as { secret_ref: unknown } | undefined)?.secret_ref;
      ref = typeof candidate === "string" ? candidate : null;
    }
    if (validateSecretRefFormat(ref).ok !== true) {
      return null;
    }
    const gate = assertBrowserSecretReady({
      secretRef: ref,
      secretsPort: overrides.secretsPort ?? resolveSecretsPort(),
    });
    if (!gate.ok) {
      return null;
    }
    return gate.secretRef;
  }
}

/** Drop dispatcher bookkeeping keys before handing the payload to the port. */
export function stripDispatchMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const { adapter: _adapter, capability: _capability, ...rest } = payload;
  void _adapter;
  void _capability;
  return rest;
}
