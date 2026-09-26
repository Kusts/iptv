import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@iptv/domain";
import type {
  AppTx,
  DbPort,
  IdempotencyClaim,
  NewDomainEvent,
  NewOutboxMessage,
  NewReviewRequest,
  StoredReviewRequest,
} from "../../src/commands/command-bus.js";
import type { CommandResult } from "@iptv/domain";
import type { AuditEventInput } from "@iptv/auth";
import type { InboxStore } from "../../src/inbox/inbox-processor.js";

/** In-memory `AppTx` backing bus/command unit tests (no Postgres). */
export class MemoryAppTx implements AppTx {
  readonly events: EventEnvelope[] = [];
  readonly outbox: NewOutboxMessage[] = [];
  readonly audits: AuditEventInput[] = [];
  readonly reviews = new Map<string, StoredReviewRequest>();
  readonly actions: Array<{ requestId: string; actionType: string; actorUserId: string; content: Record<string, unknown> }> = [];
  private readonly versions = new Map<string, number>();

  constructor(readonly tenantId: string) {}

  async nextAggregateVersion(aggregateType: string, aggregateId: string): Promise<number> {
    const key = `${this.tenantId}:${aggregateType}:${aggregateId}`;
    const next = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, next);
    return next;
  }

  async emitDomainEvent(input: NewDomainEvent): Promise<{ domainEventId: string }> {
    const e = input.envelope;
    const key = `${this.tenantId}:${e.aggregate_type}:${e.aggregate_id}`;
    const expected = (this.versions.get(key) ?? 0) + 1;
    // Mirror the Kysely guard: envelope version must extend the log.
    // (nextAggregateVersion pre-advanced the counter for handlers that
    // asked; accept either the fresh or the already-advanced value.)
    if (e.aggregate_version !== expected && e.aggregate_version !== expected - 1) {
      throw new Error(`stale aggregate version: expected ${expected}, got ${e.aggregate_version}`);
    }
    this.versions.set(key, Math.max(expected - 1, e.aggregate_version));
    this.events.push(e);
    return { domainEventId: `de-${this.events.length}` };
  }

  async enqueueOutbox(input: NewOutboxMessage): Promise<void> {
    this.outbox.push(input);
  }

  async writeAudit(input: AuditEventInput): Promise<void> {
    this.audits.push(input);
  }

  async createReviewRequest(input: NewReviewRequest): Promise<StoredReviewRequest> {
    const stored: StoredReviewRequest = {
      id: randomUUID(),
      tenantId: this.tenantId,
      status: "REQUESTED",
      reviewMode: input.reviewMode,
      reason: input.reason,
      riskClass: input.riskClass,
      priority: input.priority,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestedByType: input.requestedByType,
      requestedById: input.requestedById,
      summary: input.summary,
      contextJson: input.contextJson,
      createdAt: new Date(),
      resolvedAt: null,
    };
    this.reviews.set(stored.id, stored);
    return stored;
  }

  async getReviewRequest(id: string): Promise<StoredReviewRequest | null> {
    const row = this.reviews.get(id);
    if (row === undefined || row.tenantId !== this.tenantId) {
      return null;
    }
    return row;
  }

  async resolveReviewRequest(id: string): Promise<StoredReviewRequest | null> {
    const row = await this.getReviewRequest(id);
    if (row === null) {
      return null;
    }
    row.status = "RESOLVED";
    row.resolvedAt = new Date();
    return row;
  }

  async createReviewAction(
    requestId: string,
    actionType: string,
    actorUserId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    this.actions.push({ requestId, actionType, actorUserId, content });
  }

  snapshot(): string {
    return JSON.stringify({
      events: this.events,
      outbox: this.outbox,
      audits: this.audits,
      reviews: [...this.reviews],
      actions: this.actions,
      versions: [...this.versions],
    });
  }

  restore(snapshot: string): void {
    const s = JSON.parse(snapshot) as {
      events: EventEnvelope[];
      outbox: NewOutboxMessage[];
      audits: AuditEventInput[];
      reviews: Array<[string, StoredReviewRequest]>;
      actions: MemoryAppTx["actions"];
      versions: Array<[string, number]>;
    };
    this.events.length = 0;
    this.events.push(...s.events);
    this.outbox.length = 0;
    this.outbox.push(...s.outbox);
    this.audits.length = 0;
    this.audits.push(...s.audits);
    this.reviews.clear();
    for (const [k, v] of s.reviews) {
      this.reviews.set(k, v);
    }
    this.actions.length = 0;
    this.actions.push(...s.actions);
    this.versions.clear();
    for (const [k, v] of s.versions) {
      this.versions.set(k, v);
    }
  }
}

/** In-memory `DbPort` with rollback-on-throw (snapshot/restore). */
export class MemoryDb implements DbPort {
  readonly txByTenant = new Map<string, MemoryAppTx>();
  private readonly claims = new Map<string, { hash: string; state: "IN_PROGRESS" | "SUCCEEDED" | "FAILED"; response: CommandResult | null; status: number | null }>();

  txFor(tenantId: string): MemoryAppTx {
    let tx = this.txByTenant.get(tenantId);
    if (tx === undefined) {
      tx = new MemoryAppTx(tenantId);
      this.txByTenant.set(tenantId, tx);
    }
    return tx;
  }

  async withTransaction<T>(tenantId: string, fn: (tx: AppTx) => Promise<T>): Promise<T> {
    const tx = this.txFor(tenantId);
    const snap = tx.snapshot();
    try {
      return await fn(tx);
    } catch (err) {
      tx.restore(snap);
      throw err;
    }
  }

  async claimIdempotency(input: { tenantId: string; scope: string; key: string; requestHash: string }): Promise<IdempotencyClaim> {
    const k = `${input.tenantId}:${input.scope}:${input.key}`;
    const existing = this.claims.get(k);
    if (existing === undefined) {
      this.claims.set(k, { hash: input.requestHash, state: "IN_PROGRESS", response: null, status: null });
      return { status: "claimed" };
    }
    if (existing.state === "SUCCEEDED") {
      if (existing.hash === input.requestHash) {
        return { status: "replay", responseStatus: existing.status, response: existing.response as CommandResult };
      }
      return { status: "conflict" };
    }
    if (existing.state === "FAILED" && existing.hash === input.requestHash) {
      existing.state = "IN_PROGRESS";
      return { status: "claimed" };
    }
    if (existing.state === "FAILED") {
      return { status: "conflict" };
    }
    return { status: "in_progress" };
  }

  async finishIdempotency(input: {
    tenantId: string;
    scope: string;
    key: string;
    state: "SUCCEEDED" | "FAILED";
    responseStatus: number | null;
    response: CommandResult;
  }): Promise<void> {
    this.claims.set(`${input.tenantId}:${input.scope}:${input.key}`, {
      hash: this.claims.get(`${input.tenantId}:${input.scope}:${input.key}`)?.hash ?? "",
      state: input.state,
      response: input.response,
      status: input.responseStatus,
    });
  }
}

/** In-memory `InboxStore` proving dedupe without Postgres. */
export class MemoryInboxStore implements InboxStore {
  private readonly rows = new Map<string, { id: string; state: string; errorCode: string | null }>();

  async tryInsert(input: {
    tenantId: string;
    provider: string;
    externalEventId: string;
    eventType: string | null;
    payloadHash: string;
    payload: unknown;
    correlationId: string;
  }): Promise<{ inserted: boolean; id: string }> {
    const key = `${input.tenantId}:${input.provider}:${input.externalEventId}`;
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      return { inserted: false, id: existing.id };
    }
    const id = randomUUID();
    this.rows.set(key, { id, state: "RECEIVED", errorCode: null });
    return { inserted: true, id };
  }

  async markState(input: { tenantId: string; id: string; state: "PROCESSED" | "FAILED"; errorCode?: string }): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.id === input.id) {
        row.state = input.state;
        row.errorCode = input.errorCode ?? null;
      }
    }
  }

  size(): number {
    return this.rows.size;
  }
}
