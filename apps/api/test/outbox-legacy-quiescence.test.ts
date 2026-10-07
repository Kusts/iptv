import { afterEach, describe, expect, it } from "vitest";
import {
  LegacyOutboxDrainDisabledError,
  OutboxDrainer,
  isLegacyOutboxDrainEnabled,
} from "../src/outbox/outbox-drainer.js";
import { LocalTransport } from "../src/outbox/transport.js";

const ENV_KEY = "LEGACY_OUTBOX_DRAIN_ENABLED";
const saved = process.env[ENV_KEY];

afterEach(() => {
  if (saved === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = saved;
  }
});

function drainerWithNullDb(): OutboxDrainer {
  return new OutboxDrainer(null, new LocalTransport());
}

describe("legacy outbox drain gate (pure, no DB)", () => {
  it("defaults to enabled when env is absent", () => {
    delete process.env[ENV_KEY];
    expect(isLegacyOutboxDrainEnabled()).toBe(true);
    expect(isLegacyOutboxDrainEnabled({})).toBe(true);
  });

  it('is enabled with "1" and disabled with "0"', () => {
    expect(isLegacyOutboxDrainEnabled({ [ENV_KEY]: "1" })).toBe(true);
    expect(isLegacyOutboxDrainEnabled({ [ENV_KEY]: "0" })).toBe(false);
  });

  it("rejects any other value fail-closed without echoing it", () => {
    expect(() => isLegacyOutboxDrainEnabled({ [ENV_KEY]: "yes" })).toThrow(
      'invalid environment configuration: LEGACY_OUTBOX_DRAIN_ENABLED must be "0" or "1"',
    );
    expect(() => isLegacyOutboxDrainEnabled({ [ENV_KEY]: "" })).toThrow(
      'invalid environment configuration: LEGACY_OUTBOX_DRAIN_ENABLED must be "0" or "1"',
    );
  });

  it("disabled drain throws before touching the DB (db=null still disabled)", async () => {
    process.env[ENV_KEY] = "0";
    const drainer = drainerWithNullDb();
    // If the gate did not precede requireDb(), this would throw
    // "database is not configured" instead.
    await expect(drainer.drain()).rejects.toBeInstanceOf(LegacyOutboxDrainDisabledError);
    await expect(drainer.drain()).rejects.toThrow(
      "legacy outbox drain is disabled (LEGACY_OUTBOX_DRAIN_ENABLED=0)",
    );
    // A rejected gate never enters the gauge.
    expect(drainer.getDrainState()).toMatchObject({ enabled: false, inFlight: 0, totalDrains: 0 });
  });

  it("enabled drain with db=null fails on DB and releases the gauge (finally)", async () => {
    delete process.env[ENV_KEY];
    const drainer = drainerWithNullDb();
    await expect(drainer.drain()).rejects.toThrow("database is not configured");
    const state = drainer.getDrainState();
    expect(state.inFlight).toBe(0);
    expect(state.totalDrains).toBe(1);
    expect(state.lastFinishedAt).not.toBeNull();
  });

  it("waitForQuiescence resolves immediately when idle", async () => {
    delete process.env[ENV_KEY];
    await expect(drainerWithNullDb().waitForQuiescence(100)).resolves.toBeUndefined();
  });

  it("waitForQuiescence validates its timeout range", async () => {
    const drainer = drainerWithNullDb();
    await expect(drainer.waitForQuiescence(50)).rejects.toThrow("invalid quiescence timeout");
    await expect(drainer.waitForQuiescence(300001)).rejects.toThrow("invalid quiescence timeout");
  });

  // Seam note: `waitForQuiescence` polls the protected `currentInFlight()`
  // method (not the private counter directly) so tests can pin the gauge
  // without a database — the real drainer only increments the counter
  // around a live claim/publish cycle, which cannot be held open without a
  // DB. Subclassing below pins the gauge at 1 (timeout path) or 0
  // (resolve path); production code never subclasses.
  it("waitForQuiescence times out while a drain is pinned in flight", async () => {
    class PinnedDrainer extends OutboxDrainer {
      protected override currentInFlight(): number {
        return 1;
      }
    }
    const drainer = new PinnedDrainer(null, new LocalTransport());
    await expect(drainer.waitForQuiescence(150)).rejects.toThrow(
      "legacy outbox drain quiescence timeout (drain still in flight)",
    );
  });

  it("waitForQuiescence resolves when the seam reports idle", async () => {
    class IdleDrainer extends OutboxDrainer {
      protected override currentInFlight(): number {
        return 0;
      }
    }
    const drainer = new IdleDrainer(null, new LocalTransport());
    await expect(drainer.waitForQuiescence(150)).resolves.toBeUndefined();
  });
});
