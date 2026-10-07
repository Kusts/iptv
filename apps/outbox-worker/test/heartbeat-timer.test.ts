import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEnvelope } from "@iptv/domain";
import type { OutboxWorkerConfig } from "../src/config.js";
import type { ClaimRow, DbPort } from "../src/rpc.js";
import { FakeTransport } from "../src/transport.js";
import { OutboxWorker } from "../src/worker.js";

const TOPIC = "proof.heartbeat_timer_regress.v1";

function testConfig(): OutboxWorkerConfig {
  return {
    workerId: "wHeartbeat",
    databaseUrl: "postgres://outbox_worker@localhost:5432/iptv",
    batchSize: 10,
    pollMs: 50,
    leaseSeconds: 300,
    // Production-like: a fast publish must NOT leave a ~2.5min timer behind.
    renewAfterMs: 150_000,
    maxConcurrency: 2,
    minBackoffMs: 1000,
    maxBackoffMs: 60_000,
    shutdownTimeoutMs: 1000,
    maxRenews: 5,
  };
}

/** Minimal DbPort: one PENDING row, outcomes always apply. */
class OneRowDb implements DbPort {
  private readonly row: ClaimRow;
  private readonly token = randomUUID();

  constructor(payload: unknown) {
    this.row = {
      id: randomUUID(),
      tenant_id: randomUUID(),
      domain_event_id: randomUUID(),
      topic: TOPIC,
      message_key: null,
      payload_json: payload,
      headers_json: null,
      claim_token: this.token,
      lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
      attempt_count: 0,
    };
  }

  async claim(): Promise<ClaimRow[]> {
    return [this.row];
  }

  async complete(id: string, token: string): Promise<number> {
    return id === this.row.id && token === this.token ? 1 : 0;
  }

  async fail(id: string, token: string): Promise<number> {
    return id === this.row.id && token === this.token ? 1 : 0;
  }

  async renew(id: string, token: string): Promise<number> {
    return id === this.row.id && token === this.token ? 1 : 0;
  }
}

const silent = (): void => undefined;

describe("outbox worker heartbeat timer (P1-A regression)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runOnce with a fast publish leaves zero pending timers", async () => {
    vi.useFakeTimers();
    const envelope = buildEnvelope({
      event_type: TOPIC,
      tenant_id: randomUUID(),
      aggregate_type: "proof",
      aggregate_id: randomUUID(),
      aggregate_version: 1,
      data: { n: 1 },
      actor: { type: "system", id: null },
    });
    const worker = new OutboxWorker({
      config: testConfig(),
      rpc: new OneRowDb(envelope as unknown as Record<string, unknown>),
      // No delay: publish settles long before renewAfterMs, so the heartbeat
      // wait loses the race — its timer must be cleared, not left pending.
      transport: new FakeTransport(),
      logger: silent,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 1, published: 1 });
    // Before the fix the losing `setTimeout(renewAfterMs)` stayed referenced
    // here (count 1, unref'd but still pending); after the fix it is cleared.
    expect(vi.getTimerCount()).toBe(0);
  });
});
