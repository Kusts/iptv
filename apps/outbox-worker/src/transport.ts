import type { EventEnvelope } from "@iptv/domain";

/**
 * Transport port — the same seam shape as `apps/api/src/outbox/transport.ts`
 * (`TransportPort`/`LocalTransport` there), re-declared here WITHOUT Nest so
 * this standalone process has no framework dependency. A real transport
 * (Hatchet, webhook) plugs in behind this same port later.
 */
export interface TransportPort {
  readonly name: string;
  publish(envelope: EventEnvelope): Promise<void>;
}

/**
 * Local transport: structured-log delivery for tests/ops. Records envelopes
 * in memory and emits one compact log line per publish (ids + domain facts
 * only — NEVER the full payload).
 */
export class LocalTransport implements TransportPort {
  readonly name = "local";
  readonly published: EventEnvelope[] = [];

  async publish(envelope: EventEnvelope): Promise<void> {
    this.published.push(envelope);
    console.log(
      JSON.stringify({
        msg: "outbox.publish.local",
        event_id: envelope.event_id,
        event_type: envelope.event_type,
        tenant_id: envelope.tenant_id,
        aggregate_type: envelope.aggregate_type,
        aggregate_id: envelope.aggregate_id,
      }),
    );
  }

  count(): number {
    return this.published.length;
  }

  clear(): void {
    this.published.length = 0;
  }
}

export interface FakeTransportOptions {
  failWith?: Error;
  delayMs?: number;
  /** Fail this many publishes before succeeding (Infinity = always fail). */
  failTimes?: number;
}

/**
 * In-memory test double. Counts every publish ATTEMPT (`publishes`), records
 * only successful envelopes (`published`), and can inject latency/failures to
 * rehearse renew and retry paths. `atLeastOnceCount(topic)` counts successful
 * deliveries whose `event_type` equals `topic` — under crash-after-publish it
 * legitimately exceeds 1 (see `src/worker.ts` crash semantics B).
 */
export class FakeTransport implements TransportPort {
  readonly name = "fake";
  readonly published: EventEnvelope[] = [];
  publishes = 0;
  private remainingFailures: number;
  private readonly failWith: Error;
  private readonly delayMs: number;

  constructor(opts: FakeTransportOptions = {}) {
    this.remainingFailures = opts.failTimes ?? 0;
    this.failWith = opts.failWith ?? new Error("FakeTransport publish failed");
    this.delayMs = opts.delayMs ?? 0;
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    this.publishes += 1;
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw this.failWith;
    }
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.delayMs);
      });
    }
    this.published.push(envelope);
  }

  atLeastOnceCount(topic: string): number {
    return this.published.filter((e) => e.event_type === topic).length;
  }

  clear(): void {
    this.published.length = 0;
  }
}
