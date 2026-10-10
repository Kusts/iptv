import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  emitLog,
  initObservability,
  recordCommandExecuted,
  recordWebhookReceived,
  shutdownObservability,
  withSpan,
} from "../src/index.js";

/**
 * Automated OTLP proof (in-process mirror of `scripts/otlp-proof.mjs`).
 *
 * Boots the REAL OTLP path (NodeTracerProvider/MeterProvider/LoggerProvider +
 * OTLP/HTTP exporters) against a stub receiver on 127.0.0.1 — loopback only,
 * no external network, no credentials — drives one span, two counters and one
 * structured log through the public API, flushes and requires at least one
 * non-empty request per signal (traces/metrics/logs). Guards the OTel 2.x
 * wiring: a broken generation (exporter/SDK mismatch) exports zero bytes.
 */
describe("otlp proof (local stub receiver)", () => {
  const SIGNAL_PATHS = ["/v1/traces", "/v1/metrics", "/v1/logs"] as const;
  const hits = new Map<string, { requests: number; bytes: number; contentTypes: Set<string> }>();
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url?.split("?")[0] ?? "";
      if (req.method !== "POST" || !(SIGNAL_PATHS as readonly string[]).includes(path)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const hit = hits.get(path) ?? { requests: 0, bytes: 0, contentTypes: new Set<string>() };
        hit.requests += 1;
        hit.bytes += Buffer.concat(chunks).length;
        hit.contentTypes.add(req.headers["content-type"] ?? "");
        hits.set(path, hit);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}`;

    const state = await initObservability({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_SDK_DISABLED: "false",
      OTEL_METRIC_EXPORT_INTERVAL_MS: "1000",
    });
    expect(state.enabled).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await shutdownObservability();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 30_000);

  it("exports traces, metrics and logs to the receiver", async () => {
    await withSpan("test.otlp_proof", { component: "otlp-proof-test" }, async () => {
      recordCommandExecuted("p6b.proof_command", "ok");
      recordWebhookReceived("p6b-proof", "accepted");
      emitLog("info", "otlp proof log", { component: "otlp-proof-test" });
      return "proof-ok";
    });

    // Flush every provider (batch processors + periodic metric reader).
    await shutdownObservability();

    // Receipt is asynchronous; poll briefly before asserting.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const ready = SIGNAL_PATHS.every((path) => (hits.get(path)?.requests ?? 0) >= 1);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    for (const path of SIGNAL_PATHS) {
      const hit = hits.get(path) ?? { requests: 0, bytes: 0, contentTypes: new Set<string>() };
      expect(hit.requests, `${path} recebeu requisição`).toBeGreaterThanOrEqual(1);
      expect(hit.bytes, `${path} transportou bytes OTLP`).toBeGreaterThan(0);
      for (const contentType of hit.contentTypes) {
        expect(
          contentType.startsWith("application/x-protobuf") || contentType.startsWith("application/json"),
          `${path} content-type OTLP inesperado: ${contentType}`,
        ).toBe(true);
      }
    }
  }, 60_000);
});
