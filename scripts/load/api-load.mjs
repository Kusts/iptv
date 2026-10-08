#!/usr/bin/env node
// api-load.mjs — closed-loop HTTP capacity probe (stdlib only).
//
// Hammers localhost API endpoints with fixed total requests at fixed
// concurrency and reports per-path latency percentiles + status mix +
// achieved rps. This is a CAPACITY PROBE (saturation/latency shape), not a
// soak test and not an authenticated journey: paths requiring session auth
// are represented by their 401 floor (routing + guard cost), and provider
// latency is operator-gated (P3) — both declared in P6-PERFORMANCE.md.
//
// Usage:
//   node scripts/load/api-load.mjs [--base URL] [--requests N]
//     [--concurrency N] [--paths "METHOD:/path,..."] [--timeout-ms N]
//
// Default paths: liveness (no DB), readiness (DB probe), webhook ingress
// with an unknown tenant (fail-closed path incl. channel lookup; status
// depends on stack revision — 404 on current code, 500 observed on the
// 051-era staging lane — see P6-PERFORMANCE.md §4).
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const BASE = opt("--base", "http://127.0.0.1:3001");
const TOTAL = Math.max(1, Number(opt("--requests", "300")));
const CONC = Math.min(64, Math.max(1, Number(opt("--concurrency", "10"))));
const TIMEOUT = Math.max(1000, Number(opt("--timeout-ms", "10000")));
const PATHS = opt(
  "--paths",
  "GET:/v1/health,GET:/v1/health/ready,POST:/v1/webhooks/asaas/no-such-tenant",
)
  .split(",")
  .map((s) => {
    const i = s.indexOf(":");
    return { method: s.slice(0, i).trim().toUpperCase(), path: s.slice(i + 1).trim() };
  });

if (!Number.isFinite(TOTAL) || !Number.isFinite(CONC)) {
  console.error("usage: api-load.mjs [--base URL] [--requests N] [--concurrency N] [--paths ...] [--timeout-ms N]");
  process.exit(2);
}

function one(req) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.path, BASE);
    const lib = url.protocol === "https:" ? "node:https" : "node:http";
    import(lib).then(({ request }) => {
      const body = req.method === "POST" ? "{}" : null;
      const r = request(
        url,
        {
          method: req.method,
          timeout: TIMEOUT,
          headers: body
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
            : {},
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            resolve({ path: req.path, status: res.statusCode ?? 0, ms });
          });
        },
      );
      r.on("timeout", () => r.destroy(new Error("timeout")));
      r.on("error", () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        resolve({ path: req.path, status: 0, ms });
      });
      if (body) r.write(body);
      r.end();
    });
  });
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const perPath = new Map(PATHS.map((p) => [`${p.method} ${p.path}`, []]));
const startedAll = Date.now();
let next = 0;
const jobs = Array.from({ length: Math.min(CONC, TOTAL) }, async () => {
  for (;;) {
    const i = next++;
    if (i >= TOTAL) return;
    const target = PATHS[i % PATHS.length];
    const sample = await one(target);
    perPath.get(`${target.method} ${target.path}`).push(sample);
  }
});
await Promise.all(jobs);
const elapsedS = (Date.now() - startedAll) / 1000;

console.log(`API-LOAD base=${BASE} requests=${TOTAL} concurrency=${CONC} elapsed=${elapsedS.toFixed(1)}s rps=${(TOTAL / elapsedS).toFixed(1)}`);
let errors = 0;
for (const [label, samples] of perPath) {
  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus = {};
  for (const s of samples) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    if (s.status === 0) errors += 1;
  }
  console.log(
    `  ${label} n=${samples.length} status=${JSON.stringify(byStatus)} ` +
      `p50=${pct(lat, 50).toFixed(1)}ms p95=${pct(lat, 95).toFixed(1)}ms p99=${pct(lat, 99).toFixed(1)}ms ` +
      `max=${(lat[lat.length - 1] ?? 0).toFixed(1)}ms`,
  );
}
console.log(`ERRORS=${errors}`);
