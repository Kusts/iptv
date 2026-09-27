import { describe, expect, it } from "vitest";
import {
  disableObservabilityForTests,
  extractTraceId,
  initObservability,
  injectTraceparent,
  NoopLangfuseAdapter,
  readCounters,
  recordCommandExecuted,
  recordWebhookReceived,
  resetCountersForTests,
  sanitizeAttributes,
  withSpan,
} from "../src/index.js";

describe("observability noop path", () => {
  it("init without env stays disabled and never throws", async () => {
    const state = await initObservability({});
    expect(state).toEqual({ enabled: false, endpoint: null });
  });

  it("withSpan noop path runs fn and returns its result (zero-throw)", async () => {
    disableObservabilityForTests();
    const result = await withSpan("test.op", { command: "trial.expire_due" }, async () => "ok-value");
    expect(result).toBe("ok-value");
  });

  it("withSpan propagates fn errors (telemetry never swallows work)", async () => {
    disableObservabilityForTests();
    await expect(
      withSpan("test.op", {}, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
  });

  it("sanitizes forbidden attribute keys", () => {
    const clean = sanitizeAttributes({
      command: "charge.create",
      tenant: "t1",
      code: "ok",
      payload: "dropped",
      apiToken: "shh",
    });
    expect(clean).toEqual({ command: "charge.create", tenant: "t1", code: "ok" });
  });
});

describe("correlation", () => {
  it("extracts the trace id from a valid traceparent", () => {
    const id = extractTraceId("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("generates a 32-hex id when the header is absent or invalid", () => {
    for (const header of [undefined, "bogus", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"]) {
      const id = extractTraceId(header);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("injectTraceparent round-trips through extractTraceId", () => {
    const header = injectTraceparent("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(extractTraceId(header)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });
});

describe("metrics", () => {
  it("counts commands and webhooks in-process", () => {
    resetCountersForTests();
    recordCommandExecuted("trial.expire_due", "ok");
    recordCommandExecuted("trial.expire_due", "ok");
    recordCommandExecuted("order.expire_due", "precondition_failed");
    recordWebhookReceived("waha", "accepted");
    const counters = readCounters();
    expect(counters["commands_executed_total{code=ok,command=trial.expire_due}"]).toBe(2);
    expect(counters["commands_executed_total{code=precondition_failed,command=order.expire_due}"]).toBe(1);
    expect(counters["webhooks_received_total{outcome=accepted,provider=waha}"]).toBe(1);
  });
});

describe("langfuse boundary", () => {
  it("noop adapter resolves without network", async () => {
    const adapter = new NoopLangfuseAdapter();
    expect(adapter.name).toBe("noop");
    const traced = await adapter.trace({ traceId: "abc", name: "agent.run", tenantId: "t1" });
    expect(traced.id.startsWith("noop-")).toBe(true);
  });
});
