#!/usr/bin/env bash
# ops-alert-check.sh — executable pilot alert sweep (thresholds + runbook links).
#
# Every check below maps to one row of the alert table in
# docs/16-pilot-closure/P6-OBSERVABILITY.md (thresholds are PILOT_CALIBRATE:
# explicit initial values, recalibrated from staging/pilot telemetry — never
# presented as contractual SLAs). DB probes run INSIDE the postgres container
# via `docker exec` (no connection strings on argv or in logs); API probes
# are unauthenticated localhost health endpoints.
#
# Usage:
#   bash scripts/ops-alert-check.sh <container> <db-user> <db-name> [api-base-url] [backup-dir]
#
# Exit: 0 = all clear, 1 = at least one WARN/CRIT breach, 2 = usage/env error.
set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

CONTAINER="${1:?usage: ops-alert-check.sh <container> <db-user> <db-name> [api-base-url] [backup-dir]}"
DB_USER="${2:?missing db-user}"
DB_NAME="${3:?missing db-name}"
API_BASE="${4:-http://127.0.0.1:3001}"
BACKUP_DIR="${5:-}"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not available" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl not available" >&2; exit 2; }
docker container inspect "$CONTAINER" >/dev/null 2>&1 || { echo "ERROR: container '$CONTAINER' not found/running" >&2; exit 2; }

BREACHES=0
WARN=0

ok() { echo "OK    $1: $2"; }
warn() { echo "WARN  $1: $2  [runbook: $3]"; WARN=$((WARN + 1)); }
crit() { echo "CRIT  $1: $2  [runbook: $3]"; BREACHES=$((BREACHES + 1)); }

q() { docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -Atc "$1" 2>&1; }

# --- API ------------------------------------------------------------------
probe() {
  local name="$1" path="$2" budget_ms="$3"
  # No `-o /dev/null`: mingw curl fails writes to /dev/null (exit 23) while
  # still printing the status line — that corrupted the probe (`200000`).
  # Take the body on stdout and read the code off the trailing line instead.
  local start end resp code ms
  start="$(date +%s%3N)"
  resp="$(curl -s -w '\n%{http_code}' --max-time 10 "${API_BASE}${path}" 2>/dev/null || true)"
  end="$(date +%s%3N)"
  code="$(printf '%s' "$resp" | tail -n 1 | tr -d '\r ')"
  [ -n "$code" ] || code="000"
  ms=$((end - start))
  if [ "$code" != "200" ]; then
    crit "$name" "HTTP ${code} (expected 200)" "database-degraded.md"
  elif [ "$ms" -gt "$budget_ms" ]; then
    crit "$name" "HTTP 200 in ${ms}ms (budget ${budget_ms}ms)" "database-degraded.md"
  else
    ok "$name" "HTTP 200 in ${ms}ms"
  fi
}

probe "api_live" "/v1/health" 2000
probe "api_ready" "/v1/health/ready" 2000

# --- DB saturation ---------------------------------------------------------
MAX_CONN="$(q "SHOW max_connections;")"
USED="$(q "SELECT count(*) FROM pg_stat_activity;")"
PCT=$((USED * 100 / MAX_CONN))
if [ "$PCT" -ge 90 ]; then crit "db_connections" "${USED}/${MAX_CONN} (${PCT}%)" "database-degraded.md";
elif [ "$PCT" -ge 80 ]; then warn "db_connections" "${USED}/${MAX_CONN} (${PCT}%)" "database-degraded.md";
else ok "db_connections" "${USED}/${MAX_CONN} (${PCT}%)"; fi

BLOCKED="$(q "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock';")"
if [ "$BLOCKED" -gt 5 ]; then crit "db_blocked" "${BLOCKED} lock-waiting backends" "database-degraded.md";
elif [ "$BLOCKED" -gt 0 ]; then warn "db_blocked" "${BLOCKED} lock-waiting backends" "database-degraded.md";
else ok "db_blocked" "0 lock-waiting backends"; fi

OLDEST_TX="$(q "SELECT coalesce(extract(epoch FROM max(now() - xact_start))::int, 0) FROM pg_stat_activity WHERE state = 'idle in transaction';")"
if [ "$OLDEST_TX" -gt 900 ]; then crit "db_oldest_tx" "idle-in-transaction ${OLDEST_TX}s" "database-degraded.md";
elif [ "$OLDEST_TX" -gt 300 ]; then warn "db_oldest_tx" "idle-in-transaction ${OLDEST_TX}s" "database-degraded.md";
else ok "db_oldest_tx" "oldest idle-in-transaction ${OLDEST_TX}s"; fi

# --- outbox / worker / lease ------------------------------------------------
OB_AGE="$(q "SELECT coalesce(extract(epoch FROM max(now() - created_at))::int, 0) FROM platform.outbox_messages WHERE state IN ('PENDING','FAILED');")"
if [ "$OB_AGE" -gt 900 ]; then crit "outbox_queue_age" "oldest PENDING/FAILED ${OB_AGE}s" "outbox-workflow-backlog.md";
elif [ "$OB_AGE" -gt 300 ]; then warn "outbox_queue_age" "oldest PENDING/FAILED ${OB_AGE}s" "outbox-workflow-backlog.md";
else ok "outbox_queue_age" "oldest PENDING/FAILED ${OB_AGE}s"; fi

OB_COUNT="$(q "SELECT count(*) FROM platform.outbox_messages WHERE state IN ('PENDING','FAILED');")"
if [ "$OB_COUNT" -gt 1000 ]; then crit "outbox_backlog" "${OB_COUNT} rows" "outbox-workflow-backlog.md";
elif [ "$OB_COUNT" -gt 100 ]; then warn "outbox_backlog" "${OB_COUNT} rows" "outbox-workflow-backlog.md";
else ok "outbox_backlog" "${OB_COUNT} rows"; fi

STUCK_LEASE="$(q "SELECT count(*) FROM platform.outbox_messages WHERE state = 'PUBLISHING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now();")"
if [ "$STUCK_LEASE" -gt 50 ]; then crit "outbox_lease" "${STUCK_LEASE} expired unreclaimed leases" "outbox-workflow-backlog.md";
elif [ "$STUCK_LEASE" -gt 0 ]; then warn "outbox_lease" "${STUCK_LEASE} expired unreclaimed leases" "outbox-workflow-backlog.md";
else ok "outbox_lease" "0 expired unreclaimed leases"; fi

# --- inbox / UNKNOWN ---------------------------------------------------------
IB_AGE="$(q "SELECT coalesce(extract(epoch FROM max(now() - received_at))::int, 0) FROM platform.inbox_messages WHERE state = 'RECEIVED';")"
if [ "$IB_AGE" -gt 900 ]; then crit "inbox_queue_age" "oldest RECEIVED ${IB_AGE}s" "payment-webhook-failure.md";
elif [ "$IB_AGE" -gt 300 ]; then warn "inbox_queue_age" "oldest RECEIVED ${IB_AGE}s" "payment-webhook-failure.md";
else ok "inbox_queue_age" "oldest RECEIVED ${IB_AGE}s"; fi

IB_STUCK="$(q "SELECT count(*) FROM platform.inbox_messages WHERE state = 'PROCESSING' AND received_at < now() - interval '15 minutes';")"
if [ "$IB_STUCK" -gt 0 ]; then warn "inbox_stuck" "${IB_STUCK} PROCESSING older than 15min (manual requeue)" "rls-role-split-cutover.md#inbox-stuck-rows";
else ok "inbox_stuck" "0 stuck PROCESSING rows"; fi

IB_UNKNOWN="$(q "SELECT count(*) FROM platform.inbox_messages WHERE state IN ('RECEIVED','PROCESSING') AND event_type ILIKE '%unknown%';")"
if [ "$IB_UNKNOWN" -gt 0 ]; then warn "inbox_unknown" "${IB_UNKNOWN} unprocessed unknown-kind rows" "payment-webhook-failure.md";
else ok "inbox_unknown" "0 unprocessed unknown-kind rows"; fi

# --- provider: HUMAN_REQUIRED + UNKNOWN effect --------------------------------
PROV_HUMAN="$(q "SELECT count(*) FROM provider.provider_operations WHERE status = 'HUMAN_REQUIRED';")"
if [ "$PROV_HUMAN" -gt 0 ]; then warn "provider_hitl" "${PROV_HUMAN} HUMAN_REQUIRED operations" "provider-down.md";
else ok "provider_hitl" "0 HUMAN_REQUIRED operations"; fi

PROV_UNKNOWN="$(q "SELECT count(*) FROM provider.provider_operations WHERE status IN ('REQUESTED','QUEUED','RUNNING','VERIFYING','RETRY_WAIT') AND effect_certainty = 'UNKNOWN' AND requested_at < now() - interval '30 minutes';")"
if [ "$PROV_UNKNOWN" -gt 0 ]; then warn "provider_unknown" "${PROV_UNKNOWN} in-flight UNKNOWN-effect ops older than 30min" "reconciliation-drift.md";
else ok "provider_unknown" "0 stale UNKNOWN-effect ops"; fi

# --- HITL ---------------------------------------------------------------------
HITL_OPEN="$(q "SELECT count(*) FROM agent.human_review_requests WHERE status IN ('REQUESTED','QUEUED','ACKNOWLEDGED','IN_REVIEW');")"
if [ "$HITL_OPEN" -gt 20 ]; then crit "hitl_backlog" "${HITL_OPEN} open reviews" "hitl-backlog.md";
elif [ "$HITL_OPEN" -gt 5 ]; then warn "hitl_backlog" "${HITL_OPEN} open reviews" "hitl-backlog.md";
else ok "hitl_backlog" "${HITL_OPEN} open reviews"; fi

HITL_OVERDUE="$(q "SELECT count(*) FROM agent.human_review_requests WHERE status IN ('REQUESTED','QUEUED','ACKNOWLEDGED','IN_REVIEW') AND sla_due_at IS NOT NULL AND sla_due_at < now();")"
if [ "$HITL_OVERDUE" -gt 0 ]; then warn "hitl_overdue" "${HITL_OVERDUE} reviews past sla_due_at" "hitl-backlog.md";
else ok "hitl_overdue" "0 overdue reviews"; fi

# --- reconciliation drift ------------------------------------------------------
REC_OPEN="$(q "SELECT count(*) FROM inventory.reconciliation_findings WHERE status = 'OPEN';")"
REC_AGE="$(q "SELECT coalesce(extract(epoch FROM max(now() - created_at))::int, 0) FROM inventory.reconciliation_findings WHERE status = 'OPEN';")"
if [ "$REC_OPEN" -gt 10 ] || [ "$REC_AGE" -gt 86400 ]; then crit "reconcile_drift" "${REC_OPEN} OPEN findings, oldest ${REC_AGE}s" "reconciliation-drift.md";
elif [ "$REC_OPEN" -gt 0 ]; then warn "reconcile_drift" "${REC_OPEN} OPEN findings, oldest ${REC_AGE}s" "reconciliation-drift.md";
else ok "reconcile_drift" "0 OPEN findings"; fi

# --- backup freshness ------------------------------------------------------------
if [ -n "$BACKUP_DIR" ]; then
  if [ -d "$BACKUP_DIR" ]; then
    NEWEST="$(ls -1t "${BACKUP_DIR%/}/"*.dump.enc.manifest.json 2>/dev/null | head -1 || true)"
    if [ -z "$NEWEST" ]; then
      warn "backup_fresh" "no encrypted archives in ${BACKUP_DIR}" "backup-restore.md"
    else
      CREATED="$(grep -o '"created_at": *"[^"]*"' "$NEWEST" | grep -o '[0-9]\{8\}T[0-9]\{6\}Z' | head -1)"
      NOW="$(date -u +%s)"
      if [ -n "$CREATED" ]; then
        TS="$(date -u -d "${CREATED:0:8} ${CREATED:9:2}:${CREATED:11:2}:${CREATED:13:2}" +%s 2>/dev/null || date -u -j -f '%Y%m%dT%H%M%SZ' "$CREATED" +%s 2>/dev/null || echo 0)"
        AGE=$((NOW - TS))
        if [ "$AGE" -gt 7200 ]; then crit "backup_fresh" "newest archive ${AGE}s old ($(basename "$NEWEST"))" "backup-restore.md";
        elif [ "$AGE" -gt 1800 ]; then warn "backup_fresh" "newest archive ${AGE}s old ($(basename "$NEWEST"))" "backup-restore.md";
        else ok "backup_fresh" "newest archive ${AGE}s old"; fi
      else
        warn "backup_fresh" "manifest without parseable created_at" "backup-restore.md"
      fi
    fi
  else
    echo "SKIP  backup_fresh: dir ${BACKUP_DIR} absent (no schedule yet — not a breach)"
  fi
else
  echo "SKIP  backup_fresh: no backup-dir given (pass one once scheduled)"
fi

echo "---"
echo "WARN=${WARN} CRIT=${BREACHES}"
if [ "$BREACHES" -gt 0 ]; then
  echo "ALERT-SWEEP BREACH: ${BREACHES} critical condition(s)"
  exit 1
fi
echo "ALERT-SWEEP CLEAR (warnings: ${WARN})"
