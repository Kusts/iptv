import { describe, expect, it } from "vitest";
import {
  buildEnvelope,
  eventEnvelopeSchema,
  parseEnvelope,
  type EventActor,
} from "../src/events.js";

const actor: EventActor = { type: "human", id: "user-1" };

function base() {
  return {
    event_type: "hitl.review_requested.v1",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    aggregate_type: "human_review",
    aggregate_id: "22222222-2222-4222-8222-222222222222",
    aggregate_version: 1,
    data: { review_id: "22222222-2222-4222-8222-222222222222" },
    actor,
  };
}

describe("event envelope", () => {
  it("roundtrips with schema_version 1 and filled defaults", () => {
    const envelope = buildEnvelope(base());
    expect(envelope.schema_version).toBe(1);
    expect(envelope.event_type).toBe("hitl.review_requested.v1");
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(envelope)) as unknown);
    expect(parsed).toEqual(envelope);
  });

  it("rejects a non-const schema_version", () => {
    const envelope = buildEnvelope(base());
    const bad = { ...envelope, schema_version: 2 };
    expect(() => parseEnvelope(bad)).toThrow();
  });

  it("rejects non-public event ids", () => {
    expect(() => buildEnvelope({ ...base(), event_type: "internal.thing" })).toThrow();
    expect(() => buildEnvelope({ ...base(), event_type: "trial.requested.v2" })).toThrow();
  });

  it("rejects aggregate_version 0 and carries correlation/causation", () => {
    const withIds = buildEnvelope({
      ...base(),
      aggregate_version: 3,
      correlation_id: "33333333-3333-4333-8333-333333333333",
      causation_id: "44444444-4444-4434-8344-444444444444",
    });
    expect(withIds.correlation_id).toBe("33333333-3333-4333-8333-333333333333");
    expect(withIds.causation_id).toBe("44444444-4444-4434-8344-444444444444");
    expect(() => buildEnvelope({ ...base(), aggregate_version: 0 })).toThrow();
    // asyncapi parity: every required base field present
    for (const field of [
      "event_id",
      "event_type",
      "occurred_at",
      "recorded_at",
      "tenant_id",
      "aggregate_type",
      "aggregate_id",
      "aggregate_version",
      "correlation_id",
      "actor",
      "schema_version",
      "data",
    ] as const) {
      expect(eventEnvelopeSchema.keyof().options).toContain(field);
    }
  });
});
