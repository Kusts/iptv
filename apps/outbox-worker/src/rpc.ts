/**
 * Outbox RPC port — the ONLY database surface the worker may touch.
 *
 * INVARIANT: the worker issues exactly these four calls, each hitting exactly
 * one `platform.outbox_*` lifecycle function from migration 050. NO direct
 * queries against `platform.outbox_messages`, `platform.outbox_transitions`,
 * or any other table — table access flows through the SECURITY DEFINER
 * executor, and `src/roleGuard.ts` proves at boot that this process holds no
 * direct table grants to bypass it with.
 */

export interface ClaimRow {
  id: string;
  tenant_id: string;
  domain_event_id: string;
  topic: string;
  message_key: string | null;
  payload_json: unknown;
  headers_json: unknown;
  claim_token: string;
  lease_expires_at: string;
  attempt_count: number;
}

export type OutboxDbQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface DbPort {
  claim(limit: number, worker: string, leaseSeconds: number): Promise<ClaimRow[]>;
  renew(id: string, token: string, leaseSeconds: number): Promise<number>;
  complete(id: string, token: string): Promise<number>;
  fail(id: string, token: string, code: string, retryAt: string): Promise<number>;
}

function asString(value: unknown, what: string): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error(`outbox rpc: malformed claim row (${what})`);
}

function toClaimRow(row: Record<string, unknown>): ClaimRow {
  const messageKey = row["message_key"];
  if (messageKey !== null && messageKey !== undefined && typeof messageKey !== "string") {
    throw new Error("outbox rpc: malformed claim row (message_key)");
  }
  const attempt = row["attempt_count"];
  if (typeof attempt !== "number" && typeof attempt !== "string") {
    throw new Error("outbox rpc: malformed claim row (attempt_count)");
  }
  return {
    id: asString(row["id"], "id"),
    tenant_id: asString(row["tenant_id"], "tenant_id"),
    domain_event_id: asString(row["domain_event_id"], "domain_event_id"),
    topic: asString(row["topic"], "topic"),
    message_key: (messageKey ?? null) as string | null,
    payload_json: row["payload_json"],
    headers_json: row["headers_json"],
    claim_token: asString(row["claim_token"], "claim_token"),
    lease_expires_at: asString(row["lease_expires_at"], "lease_expires_at"),
    attempt_count: Number(attempt),
  };
}

function toCount(rows: Array<Record<string, unknown>>): number {
  const first = rows[0];
  if (first === undefined) return 0;
  return Number(first["n"] ?? 0);
}

export class PgOutboxRpc implements DbPort {
  constructor(private readonly query: OutboxDbQuery) {}

  async claim(limit: number, worker: string, leaseSeconds: number): Promise<ClaimRow[]> {
    const res = await this.query("SELECT * FROM platform.outbox_claim($1, $2, $3)", [
      limit,
      worker,
      leaseSeconds,
    ]);
    return res.rows.map(toClaimRow);
  }

  async renew(id: string, token: string, leaseSeconds: number): Promise<number> {
    const res = await this.query("SELECT platform.outbox_renew($1, $2, $3) AS n", [
      id,
      token,
      leaseSeconds,
    ]);
    return toCount(res.rows);
  }

  async complete(id: string, token: string): Promise<number> {
    const res = await this.query("SELECT platform.outbox_complete($1, $2) AS n", [id, token]);
    return toCount(res.rows);
  }

  async fail(id: string, token: string, code: string, retryAt: string): Promise<number> {
    const res = await this.query("SELECT platform.outbox_fail($1, $2, $3, $4) AS n", [
      id,
      token,
      code,
      retryAt,
    ]);
    return toCount(res.rows);
  }
}
