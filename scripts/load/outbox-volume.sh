#!/usr/bin/env bash
# outbox-volume.sh — outbox lease-recovery index + claim throughput under volume.
#
# Spins a THROWAWAY postgres, applies every db/migrations/*.sql (same order as
# scripts/run_pg_tests.sh), seeds a synthetic volume (small jsonb payloads —
# assumption recorded in P6-PERFORMANCE.md), then measures:
#   1. EXPLAIN (ANALYZE) of the lease-reclaim predicate -> must use
#      `outbox_lease_recovery_idx` (acceptance criterion);
#   2. `platform.outbox_claim` throughput as `outbox_worker` (fresh PENDING
#      drain + expired-lease reclaim);
#   3. queue-age query latency; 4. pool headroom under 8 parallel claimers.
#
# Destroys its container on exit. Never touches staging/production.
#
# Usage:
#   bash scripts/load/outbox-volume.sh [pending=100000] [expired=20000] [live=10000]
set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

PENDING="${1:-100000}"
EXPIRED="${2:-20000}"
LIVE="${3:-10000}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMAGE="${DR_IMAGE:-postgres:17-alpine}"
SITE="iptv-load-volume-$$"
DB="loadvol"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not available" >&2; exit 2; }

cleanup() { docker rm -f "$SITE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "LOAD-VOLUME: starting throwaway ${IMAGE} (${SITE})"
docker run -d --rm --name "$SITE" -e POSTGRES_PASSWORD=load -e POSTGRES_USER=postgres "$IMAGE" >/dev/null
ready=0
for _ in $(seq 1 30); do
  if docker exec "$SITE" pg_isready -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = "1" ] || { echo "LOAD FAIL: scratch postgres never ready" >&2; exit 1; }
docker exec "$SITE" psql -U postgres -d postgres -qc "CREATE DATABASE \"${DB}\";" >/dev/null

echo "LOAD-VOLUME: applying ${REPO_ROOT}/db/migrations (*.sql, filename order)"
for file in "${REPO_ROOT}"/db/migrations/*.sql; do
  docker exec -i "$SITE" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -f - < "$file" >/dev/null
done
echo "LOAD-VOLUME: migrations applied"

LOAD_TENANT="$(docker exec "$SITE" psql -U postgres -d "$DB" -qAtc \
  "INSERT INTO control.tenants (slug, name) VALUES ('load-volume','Load Volume') RETURNING id;" | tr -d '\r')"
echo "LOAD-VOLUME: seeding tenant ${LOAD_TENANT} (pending=${PENDING} expired=${EXPIRED} live=${LIVE})"

docker exec "$SITE" psql -U postgres -d "$DB" -qc "
INSERT INTO platform.domain_events
  (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, actor_type)
SELECT '${LOAD_TENANT}', 'load.volume.v1', 'load', gen_random_uuid(), 1, now(), gen_random_uuid(), 'system'
FROM generate_series(1, $((PENDING + EXPIRED + LIVE + 50000)));"
docker exec "$SITE" psql -U postgres -d "$DB" -qc "
WITH ev AS (SELECT id, row_number() OVER () AS rn FROM platform.domain_events WHERE tenant_id = '${LOAD_TENANT}' ORDER BY recorded_at)
INSERT INTO platform.outbox_messages (tenant_id, domain_event_id, topic, payload_json, state, attempt_count, next_attempt_at, lease_expires_at, claimed_by)
SELECT '${LOAD_TENANT}', ev.id, 'load.volume',
  '{\"n\":1}'::jsonb,
  CASE WHEN ev.rn <= ${PENDING} THEN 'PENDING'
       WHEN ev.rn <= $((PENDING + EXPIRED)) THEN 'PUBLISHING'
       ELSE 'PUBLISHING' END,
  0,
  CASE WHEN ev.rn <= ${PENDING} THEN now() - (ev.rn || ' seconds')::interval ELSE now() END,
  CASE WHEN ev.rn > ${PENDING} AND ev.rn <= $((PENDING + EXPIRED)) THEN now() - interval '10 minutes'
       WHEN ev.rn > $((PENDING + EXPIRED)) AND ev.rn <= $((PENDING + EXPIRED + LIVE)) THEN now() + interval '5 minutes'
       ELSE NULL END,
  CASE WHEN ev.rn > ${PENDING} THEN 'load-seeder' ELSE NULL END
FROM ev WHERE ev.rn <= $((PENDING + EXPIRED + LIVE));"
docker exec "$SITE" psql -U postgres -d "$DB" -qc "ANALYZE platform.outbox_messages;"

SEED_COUNTS="$(docker exec "$SITE" psql -U postgres -d "$DB" -Atc \
  "SELECT 'pending:' || count(*) FILTER (WHERE state='PENDING') || ' expired_pub:' || count(*) FILTER (WHERE state='PUBLISHING' AND lease_expires_at < now()) || ' live_pub:' || count(*) FILTER (WHERE state='PUBLISHING' AND lease_expires_at >= now()) FROM platform.outbox_messages;")"
echo "LOAD-VOLUME seeded: ${SEED_COUNTS}"

# 1. lease-reclaim predicate must use the partial index -----------------------
echo "--- lease-reclaim plan (must use outbox_lease_recovery_idx)"
PLAN="$(docker exec "$SITE" psql -U postgres -d "$DB" -Atc \
  "EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, COSTS OFF) SELECT count(*) FROM platform.outbox_messages WHERE state = 'PUBLISHING' AND lease_expires_at <= now();")"
echo "$PLAN" | sed 's/^/  /'
echo "$PLAN" | grep -q 'outbox_lease_recovery_idx' || { echo "LOAD FAIL: reclaim predicate did NOT use outbox_lease_recovery_idx" >&2; exit 1; }
echo "CHECK index: outbox_lease_recovery_idx used for lease reclaim"
PEND_PLAN="$(docker exec "$SITE" psql -U postgres -d "$DB" -Atc \
  "EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, COSTS OFF) SELECT id FROM platform.outbox_messages WHERE state IN ('PENDING','FAILED') AND next_attempt_at <= now() ORDER BY next_attempt_at, created_at LIMIT 100;")"
echo "$PEND_PLAN" | sed 's/^/  /'
echo "$PEND_PLAN" | grep -q 'outbox_pending_idx' || { echo "LOAD FAIL: pending predicate did NOT use outbox_pending_idx" >&2; exit 1; }
echo "CHECK index: outbox_pending_idx used for pending drain"

# 2. claim throughput as outbox_worker ----------------------------------------
# outbox_claim is 051-gated to WORKER mode: rehearse the cutover in scratch
# (LEGACY gen1 -> QUIESCING gen2 -> WORKER gen3, zero rows in flight — the same
# CAS procedure as the staging cutover rehearsal, scratch-only here).
docker exec "$SITE" psql -U postgres -d "$DB" -qc \
  "SELECT platform.outbox_runtime_set('LEGACY','QUIESCING','load-volume-script',1);" >/dev/null
docker exec "$SITE" psql -U postgres -d "$DB" -qc \
  "SELECT platform.outbox_runtime_set('QUIESCING','WORKER','load-volume-script',2);" >/dev/null
docker exec "$SITE" psql -U postgres -d "$DB" -Atc "SELECT platform.outbox_runtime_mode();"
docker exec "$SITE" psql -U postgres -d "$DB" -qc "ALTER ROLE outbox_worker PASSWORD 'load-only';" >/dev/null
wexec() { docker exec -e PGPASSWORD=load-only "$SITE" psql -h 127.0.0.1 -U outbox_worker -d "$DB" -Atc "$1" 2>&1; }
echo "--- claim throughput (20 x claim(100, 'load-probe', 60) over ${PENDING} PENDING)"
t0="$(date +%s%3N)"
CLAIMED=0
for _ in $(seq 1 20); do
  n="$(wexec "SELECT count(*) FROM platform.outbox_claim(100, 'load-probe', 60);")"
  CLAIMED=$((CLAIMED + n))
done
t1="$(date +%s%3N)"
ms=$((t1 - t0))
echo "LOAD claim-fresh: ${CLAIMED} rows in ${ms}ms ($((CLAIMED * 1000 / (ms + 1))) claims/s over 20 batches)"
echo "--- reclaim throughput (10 x claim(100) over ${EXPIRED} expired leases)"
t0="$(date +%s%3N)"
RECLAIMED=0
for _ in $(seq 1 10); do
  n="$(wexec "SELECT count(*) FROM platform.outbox_claim(100, 'load-probe', 60);")"
  RECLAIMED=$((RECLAIMED + n))
done
t1="$(date +%s%3N)"
ms=$((t1 - t0))
echo "LOAD claim-reclaim: ${RECLAIMED} rows in ${ms}ms ($((RECLAIMED * 1000 / (ms + 1))) claims/s over 10 batches)"

# 3. queue-age query latency ----------------------------------------------------
t0="$(date +%s%3N)"
AGE="$(docker exec "$SITE" psql -U postgres -d "$DB" -Atc \
  "SELECT coalesce(extract(epoch FROM max(now() - created_at))::int, 0) FROM platform.outbox_messages WHERE state IN ('PENDING','FAILED');")"
t1="$(date +%s%3N)"
echo "LOAD queue-age: oldest PENDING/FAILED ${AGE}s (query $((t1 - t0))ms)"

# 4. pool headroom under 8 parallel claimers -------------------------------------
echo "--- 8 parallel claimers x claim(50)"
for _ in $(seq 1 8); do
  docker exec -e PGPASSWORD=load-only "$SITE" psql -h 127.0.0.1 -U outbox_worker -d "$DB" -Atc \
    "SELECT count(*) FROM platform.outbox_claim(50, 'load-parallel', 60); SELECT pg_sleep(2);" >/dev/null 2>&1 &
done
sleep 1
PEAK="$(docker exec "$SITE" psql -U postgres -d "$DB" -Atc "SELECT count(*) FROM pg_stat_activity;")"
MAXC="$(docker exec "$SITE" psql -U postgres -d "$DB" -Atc "SHOW max_connections;")"
wait
echo "LOAD pool: peak backends ${PEAK}/${MAXC} during 8 parallel claimers"
echo "LOAD-VOLUME DONE"
