import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@iptv/domain";
import type { OutboxWorkerConfig } from "../src/config.js";
import type { ClaimRow, DbPort } from "../src/rpc.js";
import { FakeTransport } from "../src/transport.js";
import { OutboxWorker } from "../src/worker.js";

const TOPIC = "proof.exit_bounded.v1";
// Long on purpose: before the clear fix, the leftover heartbeat timer held
// the event loop ~this long after `runOnce` resolved, so `run --once`
// (CLI, staging smoke, container default path) lingered instead of exiting.
const HEARTBEAT_MS = 30_000;

function testConfig(): OutboxWorkerConfig {
  return {
    workerId: "wExit",
    databaseUrl: "postgres://outbox_worker@localhost:5432/iptv",
    batchSize: 10,
    pollMs: 50,
    leaseSeconds: 300,
    renewAfterMs: HEARTBEAT_MS,
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

describe("outbox worker process exit", () => {
  it("runOnce leaves no ref'd sleep timers behind (prompt exit)", async () => {
    // Capture exactly the timers the worker arms (delay === renewAfterMs is
    // only used by the publish heartbeat in this test), plus every cleared
    // handle so the test can prove the heartbeat wait was cancelled.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const heartbeatTimers: unknown[] = [];
    const clearedTimers = new Set<unknown>();
    globalThis.setTimeout = (((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const timer = realSetTimeout(handler, timeout, ...args);
      if (timeout === HEARTBEAT_MS) heartbeatTimers.push(timer);
      return timer;
    }) as unknown) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = (((
      handle: unknown,
      ...args: unknown[]
    ) => {
      clearedTimers.add(handle);
      return (realClearTimeout as (...a: unknown[]) => void)(handle, ...args);
    }) as unknown) as typeof globalThis.clearTimeout;
    try {
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
        transport: new FakeTransport(),
        logger: silent,
      });
      const outcome = await worker.runOnce();
      expect(outcome).toMatchObject({ claimed: 1, published: 1 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
    // The heartbeat race owns a dedicated wall-clock timer per wait and clears
    // it on settle; no timer (ref'd or otherwise) may survive the batch, so
    // `run --once` (and the process) exits instead of lingering up to
    // renewAfterMs.
    expect(heartbeatTimers.length).toBeGreaterThan(0);
    expect(heartbeatTimers.every((t) => clearedTimers.has(t))).toBe(true);
  });
});
