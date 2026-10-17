#!/usr/bin/env node
// scheduler-soak.mjs — HTTP stability probe over spaced scheduler ticks (stdlib only).
//
// Publishes a STEADY TRICKLE of fail-closed webhook ingress requests over a
// load window (spaced events, not a volume burst like outbox-volume.sh and
// not a saturation probe like api-load.mjs), then keeps probing readiness
// through an observe window sized to cover whole scheduler ticks. Reports
// per-phase latency percentiles + status mix + offered vs. achieved rate and
// fails closed when any SLO, status gate, coverage floor, or pacing check
// is violated.
//
// What this probe IS: an HTTP stability probe (unauthenticated, no
// secrets). It observes readiness p95 against the reads target,
// webhook-ingress p95 against the ingest target, transport errors, HTTP
// status gates, and the `scheduler` field of `GET /v1/health` (must not
// flip mid-soak).
//
// What this probe IS NOT (semantic honesty): webhook accept (ack 202) and
// outbox drain/backlog are NOT measured here. The real proof of accept +
// drain under volume lives in `scripts/load/outbox-volume.sh` plus staging
// evidence; this script only proves the HTTP surface stayed stable while
// spaced ingress trickled across scheduler ticks. It does NOT sample
// `drain-state` (platform-admin auth) and it does NOT measure provider
// latency (operator-gated, P3) — both declared in P6-PERFORMANCE.md.
//
// Nominal statuses (status gates, fail-closed):
//   - GET /v1/health and GET /v1/health/ready must answer HTTP 200; any
//     other completed status counts as a health status error (READ_STATUS).
//     (`/ready` answers 503 while the database is unreachable — that is a
//     failed probe, not a pass.)
//   - POST /v1/webhooks/asaas/soak-probe-no-such-tenant uses a fixed
//     unknown-tenant slug and must answer exactly HTTP 404 (unknown webhook
//     endpoint, cf. asaas-webhook.controller.ts); 500/200/401 or anything
//     else counts as WEBHOOK_STATUS. Transport errors (no response at all)
//     keep their own TRANSPORT_ERRORS reason.
//
// Scheduler field: `scheduler` ("enabled"|"disabled") and `tickSeconds` are
// read from the `GET /v1/health` payload — the only health payload that
// carries them (`/ready` answers only status/checks). Zero samples carrying
// the field -> SCHEDULER_ABSENT; a flip mid-soak -> SCHEDULER_FLIP (FAIL).
//
// Result precedence (exit 1 for both): any entry in `failures` forces
// RESULT=FAIL even when SCHEDULER_ABSENT also occurs; RESULT=INCONCLUSIVE
// only when failures is empty and SCHEDULER_ABSENT fired.
//
// Coverage floors (checked before any PASS verdict):
//   (a) >= 9 load-window samples per route (the thirds drift comparison
//       needs them); (b) the observe window runs BY TIME for
//       observeSeconds = max(--observe, 2 x tickSeconds) (tickSeconds
//       from the /health payload when present, else 60) and the EFFECTIVE
//       elapsed must reach observeSeconds within tolerance (0.5 s clock
//       skew); short of either -> COVERAGE (exit != 0, never PASS).
//   (--observe means seconds of real observed duration, not a sample
//   count; a small configured value is raised to 2 ticks, never shrunk.)
//
// Pacing (open-loop, honest): launches are timer-driven on a fixed spacing
// and NEVER wait for responses, so a degraded server cannot relieve its own
// load and there is no catch-up burst to recover lost spacing.
// Concurrency is bounded by an explicit cap of 3x the configured rate
// (MAX_INFLIGHT); when inflight == MAX_INFLIGHT the launch opportunity is
// DEFERRED (counted with first/last timestamp, nothing launched), which
// surfaces as an OFFERED_RATE shortfall: deferred share > 5% of offered
// across the load window -> FAIL with a cap-deferral reason, while
// achieved < 90% of offered without cap pressure -> FAIL with a slowness
// reason — never as silent relief.
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
// (--observe = seconds of REAL observed duration for the observe window;
//  the load window stays count-based at --duration x --rate.)
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
      "HTTP stability probe (spaced trickle across scheduler ticks); nominal statuses:\n" +
      "  reads=200 webhook=404; scheduler field read from /v1/health payload.\n" +
      "Webhook accept (202) and outbox drain/backlog are NOT measured here;\n" +
      "  see scripts/load/outbox-volume.sh + staging evidence.\n" +
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
              let tickSeconds = null;
              if (req.path === "/v1/health") {
                // `scheduler`/`tickSeconds` live on /v1/health only (/ready
                // answers status/checks); validated against HealthController.
                try {
                  const parsed = JSON.parse(text);
                  if (parsed.scheduler === "enabled" || parsed.scheduler === "disabled") {
                    scheduler = parsed.scheduler;
                  }
                  if (Number.isFinite(parsed.tickSeconds) && parsed.tickSeconds > 0) {
                    tickSeconds = Math.floor(parsed.tickSeconds);
                  }
                } catch {
                  scheduler = null;
                }
              }
              resolve({ path: req.path, status: res.statusCode ?? 0, ms, at, scheduler, tickSeconds });
            });
          },
        );
        r.on("timeout", () => r.destroy(new Error("timeout")));
        r.on("error", () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          resolve({ path: req.path, status: 0, ms, at, scheduler: null, tickSeconds: null });
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

// Open-loop pace with an explicit concurrency cap: 3x the configured rate
// (3s worth of offered load). Launches are timer-driven on a FIXED spacing
// and never gated on the previous response, so a degraded server cannot
// relieve its own load and there is no catch-up burst: when in-flight is at
// the cap the opportunity is counted as DEFERRED (with timestamps) and
// skipped, surfacing as OFFERED_RATE instead of silent relief.
const MAX_INFLIGHT = Math.max(1, Math.ceil(RATE * 3));

function makeTracker() {
  return {
    samples: [],
    inFlight: new Set(),
    maxInflight: 0,
    deferred: 0,
    firstDeferredAt: null,
    lastDeferredAt: null,
    capSince: null,
    maxInflightHoldMs: 0,
  };
}

async function pacedRun(count, intervalMs, pick) {
  const tr = makeTracker();
  const t0 = Date.now();
  for (let i = 0; i < count; i += 1) {
    // Fixed spacing, never a catch-up burst: each opportunity after the
    // first waits exactly intervalMs, even when behind schedule.
    if (i > 0) await sleep(intervalMs);
    if (tr.inFlight.size >= MAX_INFLIGHT) {
      tr.deferred += 1;
      const now = Date.now();
      if (tr.firstDeferredAt === null) tr.firstDeferredAt = now;
      tr.lastDeferredAt = now;
      if (tr.capSince === null) tr.capSince = now;
      continue;
    }
    // Self-referencing `p` inside .then is safe: the callback runs after
    // assignment, so inFlight.delete(p) removes the right handle.
    const p = one(pick(i)).then((s) => {
      const wasFull = tr.inFlight.size >= MAX_INFLIGHT;
      tr.inFlight.delete(p);
      tr.samples.push(s);
      // Close a cap-hold streak when a slot frees up.
      if (wasFull && tr.inFlight.size < MAX_INFLIGHT && tr.capSince !== null) {
        const hold = Date.now() - tr.capSince;
        if (hold > tr.maxInflightHoldMs) tr.maxInflightHoldMs = hold;
        tr.capSince = null;
      }
    });
    tr.inFlight.add(p);
    if (tr.inFlight.size >= MAX_INFLIGHT && tr.capSince === null) {
      tr.capSince = Date.now();
    }
    if (tr.inFlight.size > tr.maxInflight) tr.maxInflight = tr.inFlight.size;
  }
  await Promise.all(tr.inFlight);
  if (tr.capSince !== null) {
    const hold = Date.now() - tr.capSince;
    if (hold > tr.maxInflightHoldMs) tr.maxInflightHoldMs = hold;
    tr.capSince = null;
  }
  return {
    samples: tr.samples,
    elapsedS: (Date.now() - t0) / 1000,
    maxInflight: tr.maxInflight,
    offered: count,
    deferred: tr.deferred,
    maxInflightHoldMs: tr.maxInflightHoldMs,
  };
}

// Time-based observe: launches every intervalMs until the clock reaches
// t0 + durationS (observeStart + observeSeconds). Opportunity count is
// derived from elapsed time, never fixed up front.
async function timedRun(durationS, intervalMs, pick) {
  const tr = makeTracker();
  const t0 = Date.now();
  const tEnd = t0 + Math.max(1, durationS) * 1000;
  let i = 0;
  while (Date.now() < tEnd) {
    if (i > 0) await sleep(intervalMs);
    if (Date.now() >= tEnd) break;
    if (tr.inFlight.size >= MAX_INFLIGHT) {
      tr.deferred += 1;
      const now = Date.now();
      if (tr.firstDeferredAt === null) tr.firstDeferredAt = now;
      tr.lastDeferredAt = now;
      if (tr.capSince === null) tr.capSince = now;
      i += 1;
      continue;
    }
    const p = one(pick(i)).then((s) => {
      const wasFull = tr.inFlight.size >= MAX_INFLIGHT;
      tr.inFlight.delete(p);
      tr.samples.push(s);
      if (wasFull && tr.inFlight.size < MAX_INFLIGHT && tr.capSince !== null) {
        const hold = Date.now() - tr.capSince;
        if (hold > tr.maxInflightHoldMs) tr.maxInflightHoldMs = hold;
        tr.capSince = null;
      }
    });
    tr.inFlight.add(p);
    if (tr.inFlight.size >= MAX_INFLIGHT && tr.capSince === null) {
      tr.capSince = Date.now();
    }
    if (tr.inFlight.size > tr.maxInflight) tr.maxInflight = tr.inFlight.size;
    i += 1;
  }
  await Promise.all(tr.inFlight);
  if (tr.capSince !== null) {
    const hold = Date.now() - tr.capSince;
    if (hold > tr.maxInflightHoldMs) tr.maxInflightHoldMs = hold;
    tr.capSince = null;
  }
  return {
    samples: tr.samples,
    elapsedS: (Date.now() - t0) / 1000,
    maxInflight: tr.maxInflight,
    offered: i,
    deferred: tr.deferred,
    maxInflightHoldMs: tr.maxInflightHoldMs,
  };
}

const failures = [];

// Phase 1: spaced load window (steady trickle, round-robin paths).
const loadCount = Math.max(1, Math.round(DURATION * RATE));
console.log(`SOAK-LOAD base=${BASE} duration=${DURATION}s rate=${RATE}/s planned=${loadCount} cap=${MAX_INFLIGHT}`);
const load = await pacedRun(loadCount, 1000 / RATE, (i) => LOAD_PATHS[i % LOAD_PATHS.length]);
const loadSums = report("LOAD", load.samples, load.elapsedS);

// Open-loop honesty: achieved vs. offered rate across the load window.
// Deferred share > 5% of offered -> cap-deferral FAIL; otherwise achieved
// < 90% of offered -> slowness FAIL.
const achievedRps = load.samples.length / Math.max(load.elapsedS, 1e-3);
const deferredShare = load.deferred / Math.max(load.offered, 1);
console.log(
  `OFFERED offered=${RATE.toFixed(2)}/s achieved=${achievedRps.toFixed(2)}/s ` +
    `deferred=${load.deferred} maxInflightHold=${load.maxInflightHoldMs}ms maxInflight=${load.maxInflight}`,
);
if (deferredShare > 0.05) {
  failures.push(
    `OFFERED_RATE deferred=${load.deferred}/${load.offered} (${(deferredShare * 100).toFixed(1)}% > 5%) cap-deferral at maxInflight=${load.maxInflight}`,
  );
} else if (achievedRps < 0.9 * RATE) {
  failures.push(`OFFERED_RATE achieved=${achievedRps.toFixed(2)}/s < 90% of offered=${RATE.toFixed(2)}/s slowness (deferred=${load.deferred})`);
}

// Coverage floor (a): >= 9 load-window samples per route (the thirds drift
// comparison needs them).
for (const { path } of LOAD_PATHS) {
  const n = load.samples.filter((s) => s.path === path).length;
  if (n < 9) failures.push(`COVERAGE ${path} load-samples=${n} < 9`);
}

// Scheduler field must not flip mid-soak (environment changed under test).
// Field source: the /v1/health payload (the only health payload carrying
// it); zero samples carrying it -> SCHEDULER_ABSENT (INCONCLUSIVE only when
// failures is empty, else FAIL wins — see result precedence).
const seen = new Set(
  load.samples.map((s) => s.scheduler).filter((v) => v !== null),
);
const schedulerSamples = load.samples.filter((s) => s.scheduler !== null).length;
const tickSeen = load.samples.map((s) => s.tickSeconds).find((v) => v !== null && v !== undefined) ?? 60;
console.log(`SCHEDULER states=${JSON.stringify([...seen])} samples=${schedulerSamples} tickSeconds=${tickSeen}`);
const inconclusive = [];
if (seen.size > 1) {
  failures.push(`SCHEDULER_FLIP states=${[...seen].join(",")}`);
}
if (schedulerSamples === 0) {
  inconclusive.push("SCHEDULER_ABSENT no /v1/health sample carried the scheduler field");
}

// Time floor: observe runs BY TIME for observeSeconds =
// max(configured, 2 ticks) when a tick is known; when no sample carried
// tickSeconds the configured value is used as-is (the effective-duration
// check below still applies, and SCHEDULER_ABSENT is reported separately).
const observeSeconds = schedulerSamples > 0 ? Math.max(OBSERVE, 2 * tickSeen) : OBSERVE;

// Phase 2: observe window (readiness only, whole-window convergence).
// Runs BY TIME: launches every ~1s until the clock reaches
// observeStart + observeSeconds.
console.log(`SOAK-OBSERVE path=${OBSERVE_PATH.path} duration=${observeSeconds}s (configured=${OBSERVE}s ticks=${tickSeen}s)`);
const obs = await timedRun(observeSeconds, 1000, () => OBSERVE_PATH);
const obsSums = report("OBSERVE", obs.samples, obs.elapsedS);

// Coverage floor (b): effective observed duration must reach the time
// floor within tolerance (clock/skew), else the observe window did not
// actually cover whole ticks.
const OBSERVE_TOL_S = 0.5;
if (obs.elapsedS < observeSeconds - OBSERVE_TOL_S) {
  failures.push(
    `COVERAGE observe-elapsed=${obs.elapsedS.toFixed(2)}s < ${observeSeconds}s (tol ${OBSERVE_TOL_S}s)`,
  );
}

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
// Status gates: reads must be 200, the nominal webhook exactly 404.
// Transport errors (status 0) keep their own TRANSPORT_ERRORS reason.
let transportErrors = 0;
const readStatusBad = {};
let webhookStatusBad = 0;
for (const s of [...load.samples, ...obs.samples]) {
  if (s.status === 0) {
    transportErrors += 1;
  } else if (s.path === "/v1/webhooks/asaas/soak-probe-no-such-tenant") {
    if (s.status !== 404) webhookStatusBad += 1;
  } else if (s.status !== 200) {
    const key = `${s.path} ${s.status}`;
    readStatusBad[key] = (readStatusBad[key] ?? 0) + 1;
  }
}
for (const [key, n] of Object.entries(readStatusBad)) {
  failures.push(`READ_STATUS ${key} n=${n}`);
}
if (webhookStatusBad > 0) {
  failures.push(`WEBHOOK_STATUS nominal=404 bad=${webhookStatusBad}`);
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
// Result precedence (exit 1 for both): any failure forces FAIL, even with
// SCHEDULER_ABSENT present; INCONCLUSIVE only when failures is empty.
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  for (const f of inconclusive) console.log(`INCONCLUSIVE ${f}`);
  console.log("RESULT=FAIL");
  process.exit(1);
}
if (inconclusive.length > 0) {
  for (const f of inconclusive) console.log(`INCONCLUSIVE ${f}`);
  console.log("RESULT=INCONCLUSIVE");
  process.exit(1);
}
console.log("RESULT=PASS");
