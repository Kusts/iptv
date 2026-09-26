import { Injectable } from "@nestjs/common";
import type { EventEnvelope } from "@iptv/domain";

/**
 * Outbox transport port (W1-07). The drainer publishes claimed envelopes
 * through this interface; real transports (Hatchet, webhook) come later
 * behind the same port. The default is `LocalTransport`.
 */
export interface TransportPort {
  readonly name: string;
  publish(envelope: EventEnvelope): Promise<void>;
}

/**
 * Local transport: structured-log delivery for tests/ops. Counts as
 * delivered for the Wave 1 exit path; never touches the network.
 */
@Injectable()
export class LocalTransport implements TransportPort {
  readonly name = "local";
  readonly published: EventEnvelope[] = [];

  async publish(envelope: EventEnvelope): Promise<void> {
    this.published.push(envelope);
    // Structured log line (no secrets: envelopes carry ids + domain facts).
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
