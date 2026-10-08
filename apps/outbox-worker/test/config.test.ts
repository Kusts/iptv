import { describe, expect, it } from "vitest";
import {
  isOutboxWorkerEnabled,
  parseOutboxWorkerConfig,
} from "../src/config.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    OUTBOX_WORKER_ENABLED: "1",
    OUTBOX_WORKER_DATABASE_URL: "postgres://outbox_worker:s3cr3t-pw@localhost:5432/iptv",
    OUTBOX_WORKER_ID: "w1",
    OUTBOX_LEGACY_QUIESCED: "1",
  };
}

describe("outbox worker config", () => {
  it("resolves conservative defaults", () => {
    const config = parseOutboxWorkerConfig(baseEnv());
    expect(config).toMatchObject({
      workerId: "w1",
      batchSize: 25,
      pollMs: 1000,
      leaseSeconds: 300,
      renewAfterMs: 150_000,
      maxConcurrency: 4,
      minBackoffMs: 60_000,
      maxBackoffMs: 3_600_000,
      shutdownTimeoutMs: 15_000,
      maxRenews: 6,
    });
  });

  it("clamps out-of-range numerics instead of silently resetting to defaults", () => {
    const config = parseOutboxWorkerConfig({
      ...baseEnv(),
      OUTBOX_WORKER_BATCH_SIZE: "500",
      OUTBOX_WORKER_POLL_MS: "5",
      OUTBOX_WORKER_LEASE_SECONDS: "9999",
      OUTBOX_WORKER_MAX_CONCURRENCY: "99",
      OUTBOX_WORKER_MIN_BACKOFF_MS: "1",
      OUTBOX_WORKER_MAX_BACKOFF_MS: "99999999999",
      OUTBOX_WORKER_SHUTDOWN_TIMEOUT_MS: "1",
      OUTBOX_WORKER_MAX_RENEWS: "99",
    });
    expect(config.batchSize).toBe(100);
    expect(config.pollMs).toBe(100);
    expect(config.leaseSeconds).toBe(3600);
    expect(config.maxConcurrency).toBe(16);
    expect(config.minBackoffMs).toBe(1000);
    expect(config.maxBackoffMs).toBe(604_800_000);
    expect(config.shutdownTimeoutMs).toBe(1000);
    expect(config.maxRenews).toBe(60);
  });

  it("derives the renew default from the lease", () => {
    const config = parseOutboxWorkerConfig({
      ...baseEnv(),
      OUTBOX_WORKER_LEASE_SECONDS: "10",
    });
    expect(config.renewAfterMs).toBe(5000);
  });

  it("caps the heartbeat strictly before lease expiry", () => {
    const config = parseOutboxWorkerConfig({
      ...baseEnv(),
      OUTBOX_WORKER_LEASE_SECONDS: "300",
      OUTBOX_WORKER_RENEW_AFTER_MS: "300000",
    });
    expect(config.renewAfterMs).toBe(225_000);
  });

  it("refuses padded database urls instead of trimming credentials", () => {
    expect(() =>
      parseOutboxWorkerConfig({
        ...baseEnv(),
        OUTBOX_WORKER_DATABASE_URL: "  postgres://outbox_worker@localhost:5432/iptv",
      }),
    ).toThrow(/whitespace/);
  });

  it("refuses min backoff above max backoff", () => {
    expect(() =>
      parseOutboxWorkerConfig({
        ...baseEnv(),
        OUTBOX_WORKER_MIN_BACKOFF_MS: "3000000",
        OUTBOX_WORKER_MAX_BACKOFF_MS: "60000",
      }),
    ).toThrow(/MIN_BACKOFF/);
  });

  it("refuses a database url that is not the outbox_worker role", () => {
    expect(() =>
      parseOutboxWorkerConfig({
        ...baseEnv(),
        OUTBOX_WORKER_DATABASE_URL: "postgres://iptv_app:s3cr3t-pw@localhost:5432/iptv",
      }),
    ).toThrow(/outbox_worker/);
  });

  it("refuses identity smuggling via query keys", () => {
    for (const key of ["user", "ROLE", "Options", "dbname"]) {
      expect(() =>
        parseOutboxWorkerConfig({
          ...baseEnv(),
          OUTBOX_WORKER_DATABASE_URL: `postgres://outbox_worker@localhost:5432/iptv?${key}=x`,
        }),
      ).toThrow(/identity/);
    }
  });

  it("allows benign query keys such as sslmode", () => {
    const config = parseOutboxWorkerConfig({
      ...baseEnv(),
      OUTBOX_WORKER_DATABASE_URL: "postgres://outbox_worker@localhost:5432/iptv?sslmode=require",
    });
    expect(config.workerId).toBe("w1");
  });

  it("refuses fragments, wrong schemes, and malformed usernames", () => {
    const bad = [
      "postgres://outbox_worker@localhost:5432/iptv#frag",
      "mysql://outbox_worker@localhost:5432/iptv",
      "postgres://outbox_%ZZworker@localhost:5432/iptv",
      "postgres://localhost:5432/iptv",
      "not-a-url",
    ];
    for (const url of bad) {
      expect(() => parseOutboxWorkerConfig({ ...baseEnv(), OUTBOX_WORKER_DATABASE_URL: url })).toThrow(
        /OUTBOX_WORKER_DATABASE_URL/,
      );
    }
  });

  it("refuses to boot without the quiescence assertion", () => {
    const missing = baseEnv();
    delete missing["OUTBOX_LEGACY_QUIESCED"];
    expect(() => parseOutboxWorkerConfig(missing)).toThrow(/NOT_QUIESCED/);
    expect(() =>
      parseOutboxWorkerConfig({ ...baseEnv(), OUTBOX_LEGACY_QUIESCED: "0" }),
    ).toThrow(/NOT_QUIESCED/);
  });

  it("refuses invalid worker ids", () => {
    expect(() => parseOutboxWorkerConfig({ ...baseEnv(), OUTBOX_WORKER_ID: "bad id!" })).toThrow(
      /OUTBOX_WORKER_ID/,
    );
  });

  it("is disabled unless explicitly enabled", () => {
    expect(isOutboxWorkerEnabled(baseEnv())).toBe(true);
    expect(isOutboxWorkerEnabled({ ...baseEnv(), OUTBOX_WORKER_ENABLED: "0" })).toBe(false);
    const missing = baseEnv();
    delete missing["OUTBOX_WORKER_ENABLED"];
    expect(isOutboxWorkerEnabled(missing)).toBe(false);
    expect(() => parseOutboxWorkerConfig({ ...baseEnv(), OUTBOX_WORKER_ENABLED: "0" })).toThrow(
      /DISABLED/,
    );
  });

  it("never echoes secret values in errors", () => {
    let message = "";
    try {
      parseOutboxWorkerConfig({
        ...baseEnv(),
        OUTBOX_WORKER_DATABASE_URL: "postgres://iptv_app:s3cr3t-pw@localhost:5432/iptv",
      });
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("s3cr3t-pw");
    expect(message).not.toContain("iptv_app");
  });
});
