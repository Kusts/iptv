# @iptv/outbox-worker

Dedicated platform outbox worker process (issue #10). Claims due rows from
`platform.outbox_messages` and publishes them through a `TransportPort`,
recording the outcome with the four migration-050 lifecycle functions
(`outbox_claim` / `outbox_renew` / `outbox_complete` / `outbox_fail`).

## Identity

The process connects EXCLUSIVELY as the `outbox_worker` database role
(migration `202610070000_050_platform_outbox_worker.sql`): LOGIN with no
superuser/createdb/createrole/replication/bypassrls powers, zero role
memberships, NO direct table grants — only `USAGE` on schema `platform` plus
`EXECUTE` on the four lifecycle functions. Table access flows through the
`outbox_executor`-owned `SECURITY DEFINER` functions.

Boot order is fail-closed: `config → connect → roleGuard → activation gate`.
Any step failing refuses to claim anything (`check` exits 2, `run` never
starts). `OUTBOX_WORKER_DATABASE_URL` must authenticate exactly as
`outbox_worker`; owner/API URLs are refused at parse time, and the role guard
re-proves the posture on the live connection.

## Environment

| Variable | Required | Default | Range | Notes |
|---|---|---|---|---|
| `OUTBOX_WORKER_ENABLED` | yes | — | exactly `"1"` | Anything else = DISABLED, fail closed. |
| `OUTBOX_WORKER_DATABASE_URL` | yes | — | pg:/postgres:/postgresql: | Username must be exactly `outbox_worker`. No `#` fragments, no identity query keys (`user`, `role`, `options`, `host`, `port`, `database`, `db`, `dbname`, case-insensitive). |
| `OUTBOX_WORKER_ID` | yes | — | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` | Recorded as `claimed_by`; identifies the worker in transitions. |
| `OUTBOX_LEGACY_QUIESCED` | yes | — | exactly `"1"` | Operator assertion that the legacy drain is quiesced (activation gate). |
| `OUTBOX_LEGACY_DRAIN_ENABLED` | yes (explicit) | — | exactly `"0"` | Must be the OBSERVED drain-state (`1`/unset refuses boot — the API default is enabled, so unknown is fail-closed, never permission). |
| `OUTBOX_LEGACY_IN_FLIGHT` | yes (explicit) | — | exactly `0` | Observed in-flight count from drain-state; unknown or `> 0` refuses boot. |
| `OUTBOX_WORKER_BATCH_SIZE` | no | 25 | [1..100], clamped | Claim `p_limit` per batch. |
| `OUTBOX_WORKER_POLL_MS` | no | 1000 | [100..60000], clamped | Idle delay between batches. |
| `OUTBOX_WORKER_LEASE_SECONDS` | no | 300 | [1..3600], clamped | Claim/renew `p_lease_seconds`. |
| `OUTBOX_WORKER_RENEW_AFTER_MS` | no | lease×500 | [min(1000,lease×750)..lease×750], clamped | Publish duration that triggers a heartbeat renew — always strictly before expiry (`renew` requires a live lease). |
| `OUTBOX_WORKER_MAX_CONCURRENCY` | no | 4 | [1..16], clamped | Items processed concurrently per batch (pool sized lanes+2). |
| `OUTBOX_WORKER_MIN_BACKOFF_MS` | no | 60000 | [1000..3600000], clamped | `fail()` retry floor; must be ≤ max. |
| `OUTBOX_WORKER_MAX_BACKOFF_MS` | no | 3600000 | [60000..604800000], clamped | `fail()` retry ceiling; `fail()` retry = `min × 2^(attempt-1)` clamped to [min, max] AND below the server refusal (now+7d−60s — the server RAISES past 7d instead of clamping). |
| `OUTBOX_WORKER_SHUTDOWN_TIMEOUT_MS` | no | 15000 | [1000..120000], clamped | Graceful-stop budget for in-flight items. |
| `OUTBOX_WORKER_MAX_RENEWS` | no | 6 | [0..60], clamped | Max heartbeat renews per item publish. |

Out-of-range numerics are CLAMPED to the nearest bound (documented above);
absent/invalid values resolve to the default. Errors never echo values.

## Activation (legacy quiescence)

The worker must NEVER run while the legacy in-process drainer (API
`OutboxDrainer`) can still publish: the legacy drainer sets `PUBLISHING` with
NO lease and completes by id alone (no token CAS), so it could overwrite a
fenced outcome and strand rows this worker never reclaims (reclaim requires a
non-NULL lease). Procedure: stop new legacy ticks, prove no legacy drain is
in flight (a stopped scheduler is NOT enough — a running drain holds no
lease), assert `OUTBOX_LEGACY_QUIESCED=1` PLUS the observed state
(`OUTBOX_LEGACY_DRAIN_ENABLED=0`, `OUTBOX_LEGACY_IN_FLIGHT=0` copied from
`GET /v1/admin/outbox/drain-state` — unknown is refused, never assumed),
then start the worker. The pure `checkActivationGate` enforces this at boot.

## Loop / renew / crash semantics

Each batch: bounded `claim(batchSize, workerId, leaseSeconds)` →
per-item (concurrency ≤ `maxConcurrency`): validate the envelope
(`safeParseEnvelope`; invalid → `fail(INVALID_ENVELOPE)` at the retry floor)
→ `publish` with heartbeat renew (fires when publish exceeds
`renewAfterMs`, up to `maxRenews`; a stop request aborts between renewals) →
`complete` on success (0 rows = stale → reconcile log, never blind retry) or
`fail` with classified `[A-Z0-9_]` code and exponential retry on transport
error. A lost lease mid-item (renew = 0) abandons the item without
complete/fail — the recorded effect is uncertain.

At-least-once, explicitly NOT exactly-once:

- **A — crash before publish / lease lost:** nothing recorded; on lease
  expiry another worker reclaims (from_state `PUBLISHING`) and publishes.
- **B — crash after publish, before complete:** reclaim re-publishes an
  already-delivered message. The TRANSPORT must be idempotent; duplicate
  delivery is expected.
- **C — stale token (complete/fail = 0):** another worker owns the row; never
  retry blindly — count `staleTokenOutcomes`, log for reconcile.

## Rollback

Stop the worker → await in-flight items (`stop()` drains up to
`shutdownTimeoutMs`) → live leases expire on their own and the next start (or
the legacy path, once re-armed) reclaims them. NEVER complete a claimed row
just to clear state; NEVER fail rows artificially. A residual `PUBLISHING`
row with a live lease after a crash is forward-fix: restart the worker and
let reclaim → publish-with-confirmation → complete finish it. The legacy
drainer does NOT reclaim worker leases (it cannot see fenced rows the same
way) — declare the worker as the only reclaim path while active.

## Observability

`WorkerMetrics.snapshot()` / `toSafeLog()` expose counters only
(`claimed`, `emptyPolls`, `published`, `failed`, `retried`, `reclaimed`,
`renewals`, `renewFailures`, `staleTokenOutcomes`, `publishMsTotal/Max`,
`batchMsTotal`, `uptimeMs`, `shutdownState`) — no row ids, tokens, URLs, or
payloads. Batch and stale-reconcile lines are compact JSON on stdout.

## Staging smoke

```sh
# Boot rehearsal, zero claims (compose healthcheck uses this):
node apps/outbox-worker/dist/cli.js check        # exit 0 ready / 2 not-ready

# Single bounded batch, then exit:
node apps/outbox-worker/dist/cli.js run --once
```

## Restart / exit semantics

- Transient crash (non-zero exit): compose (`restart: unless-stopped`)
  restarts the loop. The operator stops it manually once logs/health show a
  config or quiescence problem.
- Invalid config → exit 2 (`INVALID_CONFIG`, fail-closed, visible in logs and
  the `check` healthcheck). Missing DB answers the same way (`BOOT_FAILED`).
- Gate denied (legacy drain not quiesced) → exit 2 not-ready WITHOUT
  claiming anything (`checkActivationGate` runs before the first claim; see
  `worker.test.ts` "refuses boot while the legacy drain is active").
- `SIGTERM`/`SIGINT` drains in-flight items up to
  `OUTBOX_WORKER_SHUTDOWN_TIMEOUT_MS`, then exits.
