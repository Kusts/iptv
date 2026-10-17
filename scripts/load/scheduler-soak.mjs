#!/usr/bin/env node
// scheduler-soak.mjs — spaced scheduler/outbox soak probe (stdlib only).
//
// Publishes a STEADY TRICKLE of fail-closed webhook ingress requests over a
// load window (spaced events, not a volume burst like outbox-volume.sh and
// not a saturation probe like api-load.mjs), then keeps probing readiness
// through an observe window sized to cover whole scheduler ticks. Reports
// per-phase latency percentiles + status mix + achieved rps and proves the
// absence of a growing backlog (convergence), exiting fail-closed when any
// SLO is violated.
//
// What it observes (unauthenticated, no secrets): readiness p95 against the
// reads target, webhook-ingress ack p95 against the ingest target, transport
// errors, and the `scheduler` field of `GET /v1/health` (must not flip
// mid-soak). It does NOT sample `drain-state` (platform-admin auth) and it
// does NOT measure provider latency (operator-gated, P3) — both declared in
// P6-PERFORMANCE.md.
//
// SLO defaults (docs/15-implementation-baseline/13-nfr-slo-dr.md):
//   reads p95 <= 500 ms, webhook ingest ack p95 <= 2000 ms.
//
// Convergence rule (multi-tick tolerant: the scheduler may converge over
// several ticks, so the verdict uses whole-window stats, never one sample):
//   - backlog growth: readiness p95 of the LAST load third exceeds the FIRST
//     third by >50% AND above a 100 ms floor -> BACKLOG_GROWING (fail);
//   - settle: observe-window readiness p95 within target and zero transport
//     errors -> converged; otherwise NOT_CONVERGED (fail).
//
// Usage:
//   node scripts/load/scheduler-soak.mjs [--base URL] [--duration S]
//     [--rate RPS] [--observe S] [--read-p95-ms N] [--webhook-p95-ms N]
//     [--timeout-ms N] [--help]
//
// Never touches staging/production data: the webhook path uses a fixed
// unknown-tenant slug (fail-closed 404/500, zero real effects) and every
// slug here is a constant — no random ids (repo gotcha: newId().slice(0,8)
// collides on the UUIDv7 timestamp head).
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "usage: scheduler-soak.mjs [--base URL] [--duration S] [--rate RPS] [--observe S]\n" +
      "  [--read-p95-ms N] [--webhook-p95-ms N] [--timeout-ms N]\n" +
      "defaults: --base http://127.0.0.1:3001 --duration 300 --rate 2 --observe 120\n" +
      "  --read-p95-ms 500 --webhook-p95-ms 2000 --timeout-ms 10000",
  );
  process.exit(0);
}

const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const BASE = opt("--base", "http://127.0.0.1:3001");
const DURATION = Math.max(1, Math.floor(Number(opt("--duration", "300"))));
const RATE = Math.max(0.1, Number(opt("--rate", "2")));
const OBSERVE = Math.max(1, Math.floor(Number(opt("--observe", "120"))));
const READ_P95 = Math.max(1, Number(opt("--read-p95-ms", "500")));
const WEBHOOK_P95 = Math.max(1, Number(opt("--webhook-p95-ms", "2000")));
const TIMEOUT = Math.max(1000, Number(opt("--timeout-ms", "10000")));

if (
  !Number.isFinite(DURATION) ||
  !Number.isFinite(RATE) ||
  !Number.isFinite(OBSERVE) ||
  !Number.isFinite(READ_P95) ||
  !Number.isFinite(WEBHOOK_P95)
) {
  console.error(
    "usage: scheduler-soak.mjs [--base URL] [--duration S] [--rate RPS] [--observe S] [--read-p95-ms N] [--webhook-p95-ms N] [--timeout-ms N]",
  );
  process.exit(2);
}

// Fixed unknown-tenant slug: fail-closed ingress path (routing + channel
// lookup cost), constant by design — never a random id.
const LOAD_PATHS = [
  { method: "GET", path: "/v1/health" },
  { method: "GET", path: "/v1/health/ready" },
  { method: "POST", path: "/v1/webhooks/asaas/soak-probe-no-such-tenant" },
];
const OBSERVE_PATH = { method: "GET", path: "/v1/health/ready" };

function one(req) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const at = Date.now();
    const url = new URL(req.path, BASE);
    const lib = url.protocol === "https:" ? "node:https" : "node:http";
    import(lib).then(
      ({ request }) => {
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
            let text = "";
            res.on("data", (chunk) => {
              if (text.length < 4096) text += chunk.toString("utf8");
            });
            res.on("end", () => {
              const ms = Number(process.hrtime.bigint() - started) / 1e6;
              let scheduler = null;
              if (req.path === "/v1/health") {
                try {
                  const parsed = JSON.parse(text);
                  if (parsed.scheduler === "enabled" || parsed.scheduler === "disabled") {
                    scheduler = parsed.scheduler;
                  }
                } catch {
                  scheduler = null;
                }
              }
              resolve({ path: req.path, status: res.statusCode ?? 0, ms, at, scheduler });
            });
          },
        );
        r.on("timeout", () => r.destroy(new Error("timeout")));
        r.on("error", () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          resolve({ path: req.path, status: 0, ms, at, scheduler: null });
        });
        if (body) r.write(body);
        r.end();
      },
      () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        resolve({ path: req.path, status: 0, ms, at, scheduler: null });
      },
    );
  });
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(label, samples) {
  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus = {};
  let transportErrors = 0;
  for (const s of samples) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    if (s.status === 0) transportErrors += 1;
  }
  return { label, n: samples.length, byStatus, transportErrors, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) };
}

function report(prefix, samples, elapsedS) {
  const byPath = new Map();
  for (const s of samples) {
    const key = s.path;
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(s);
  }
  console.log(`${prefix} n=${samples.length} elapsed=${elapsedS.toFixed(1)}s rps=${(samples.length / elapsedS).toFixed(2)}`);
  const out = [];
  for (const [path, list] of byPath) {
    const sum = summarize(path, list);
    out.push(sum);
    console.log(
      `  ${sum.label} n=${sum.n} status=${JSON.stringify(sum.byStatus)} ` +
        `p50=${sum.p50.toFixed(1)}ms p95=${sum.p95.toFixed(1)}ms p99=${sum.p99.toFixed(1)}ms`,
    );
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pacedRun(count, intervalMs, pick) {
  const samples = [];
  const t0 = Date.now();
  for (let i = 0; i < count; i += 1) {
    const target = pick(i);
    samples.push(await one(target));
    if (i < count - 1) {
      const want = t0 + (i + 1) * intervalMs;
      const wait = want - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }
  return { samples, elapsedS: (Date.now() - t0) / 1000 };
}

const failures = [];

// Phase 1: spaced load window (steady trickle, round-robin paths).
const loadCount = Math.max(1, Math.round(DURATION * RATE));
console.log(`SOAK-LOAD base=${BASE} duration=${DURATION}s rate=${RATE}/s planned=${loadCount}`);
const load = await pacedRun(loadCount, 1000 / RATE, (i) => LOAD_PATHS[i % LOAD_PATHS.length]);
const loadSums = report("LOAD", load.samples, load.elapsedS);

// Scheduler field must not flip mid-soak (environment changed under test).
const seen = new Set(
  load.samples.map((s) => s.scheduler).filter((v) => v !== null),
);
console.log(`SCHEDULER states=${JSON.stringify([...seen])}`);
if (seen.size > 1) {
  failures.push(`SCHEDULER_FLIP states=${[...seen].join(",")}`);
}

// Phase 2: observe window (readiness only, whole-window convergence).
const obsCount = Math.max(1, OBSERVE);
console.log(`SOAK-OBSERVE path=${OBSERVE_PATH.path} duration=${OBSERVE}s`);
const obs = await pacedRun(obsCount, 1000, () => OBSERVE_PATH);
const obsSums = report("OBSERVE", obs.samples, obs.elapsedS);

// Backlog-growth signal: readiness p95 drift across load thirds (floor
// guards tiny-number flakiness; whole thirds, never single samples).
const readyLoad = load.samples.filter((s) => s.path === "/v1/health/ready").sort((a, b) => a.at - b.at);
if (readyLoad.length >= 9) {
  const third = Math.floor(readyLoad.length / 3);
  const first = readyLoad.slice(0, third).map((s) => s.ms).sort((a, b) => a - b);
  const last = readyLoad.slice(readyLoad.length - third).map((s) => s.ms).sort((a, b) => a - b);
  const p95First = pct(first, 95);
  const p95Last = pct(last, 95);
  console.log(`DRIFT ready-p95 first-third=${p95First.toFixed(1)}ms last-third=${p95Last.toFixed(1)}ms`);
  if (p95Last > 100 && p95Last > p95First * 1.5) {
    failures.push(`BACKLOG_GROWING ready-p95 ${p95First.toFixed(1)}ms -> ${p95Last.toFixed(1)}ms`);
  }
}

// SLO verdicts (fail-closed: any breach is exit 1).
let transportErrors = 0;
for (const s of [...load.samples, ...obs.samples]) {
  if (s.status === 0) transportErrors += 1;
}
const readP95 = Math.max(
  ...[...loadSums, ...obsSums].filter((s) => s.label !== "/v1/webhooks/asaas/soak-probe-no-such-tenant").map((s) => s.p95),
);
const hookSum = loadSums.find((s) => s.label === "/v1/webhooks/asaas/soak-probe-no-such-tenant");
if (transportErrors > 0) failures.push(`TRANSPORT_ERRORS=${transportErrors}`);
if (readP95 > READ_P95) failures.push(`READ_P95 ${readP95.toFixed(1)}ms > ${READ_P95}ms`);
if (hookSum && hookSum.p95 > WEBHOOK_P95) {
  failures.push(`WEBHOOK_P95 ${hookSum.p95.toFixed(1)}ms > ${WEBHOOK_P95}ms`);
}
const obsReady = obsSums.find((s) => s.label === OBSERVE_PATH.path);
if (!obsReady || obsReady.transportErrors > 0 || obsReady.p95 > READ_P95) {
  failures.push("NOT_CONVERGED observe window did not settle within read target");
}

console.log(`ERRORS=${transportErrors}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log("RESULT=FAIL");
  process.exit(1);
}
console.log("RESULT=PASS");
