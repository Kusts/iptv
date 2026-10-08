#!/usr/bin/env node
// otlp-proof.mjs — proves OTLP export end-to-end against a LOCAL stub receiver.
//
// Starts a stub OTLP/HTTP collector on 127.0.0.1, enables the real SDK path
// (OTEL_EXPORTER_OTLP_ENDPOINT + OTEL_SDK_DISABLED=false), drives one span,
// two counters and one structured log through @iptv/observability, flushes,
// and asserts at least one request arrived per signal (traces/metrics/logs).
// No external network, no credentials, no secrets. Exit 0 = PROOF PASS.
//
// Usage:
//   node scripts/otlp-proof.mjs [--port 4319]
//
// Proof contract (see docs/16-pilot-closure/P6-OBSERVABILITY.md): 1 trace +
// 1 metric export + 1 log flowing into the receiver.
import { createServer } from "node:http";

const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4319;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`ERROR: invalid --port`);
  process.exit(2);
}

const hits = { "/v1/traces": [], "/v1/metrics": [], "/v1/logs": [] };

const server = createServer((req, res) => {
  const path = req.url?.split("?")[0] ?? "";
  if (req.method !== "POST" || !(path in hits)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    hits[path].push({ bytes: body.length, contentType: req.headers["content-type"] ?? "" });
    // Minimal OTLP/HTTP success shape both protobuf and JSON clients accept.
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = `http://127.0.0.1:${PORT}`;
process.env["OTEL_SDK_DISABLED"] = "false";
process.env["OTEL_METRIC_EXPORT_INTERVAL_MS"] = "1000";

const { initObservability, withSpan, recordCommandExecuted, recordWebhookReceived, emitLog, shutdownObservability } =
  await import("../packages/observability/dist/index.js");

const state = await initObservability();
if (!state.enabled) {
  console.error("PROOF FAIL: initObservability did not enable the OTLP path");
  server.close();
  process.exit(1);
}

await withSpan("p6b.otlp_proof", { component: "otlp-proof" }, async () => {
  recordCommandExecuted("p6b.proof_command", "ok");
  recordWebhookReceived("p6b-proof", "accepted");
  emitLog("info", "p6b otlp proof log", { component: "otlp-proof" });
  return "proof-ok";
});

// Let the 1s metric reader fire at least once before the flush shutdown.
await new Promise((resolve) => setTimeout(resolve, 2500));
await shutdownObservability();
// Shutdown races in-flight exports; one grace slice lets the stub record them.
await new Promise((resolve) => setTimeout(resolve, 1500));
server.close();

let failures = 0;
for (const path of [" /v1/traces", "/v1/metrics", "/v1/logs"]) {
  const key = path.trim();
  const deliveries = hits[key] ?? [];
  const bytes = deliveries.reduce((sum, h) => sum + h.bytes, 0);
  const ok = deliveries.length >= 1 && bytes > 0;
  if (!ok) failures += 1;
  console.log(`${ok ? "RECEIVED" : "MISSING "} ${key}: ${deliveries.length} request(s), ${bytes} byte(s)`);
}
if (failures > 0) {
  console.error(`PROOF FAIL: ${failures} signal(s) never reached the stub receiver`);
  process.exit(1);
}
console.log("OTLP-PROOF PASS: 1 trace + metric export + 1 log flowed into the local receiver");
