#!/usr/bin/env bash
# db-restore-drill.sh — reproducible backup restore drill in an ISOLATED
# throwaway container. Proves an archive is restorable and structurally
# consistent; it NEVER touches the source database.
#
# A backup script existing is NOT a validated DR capability. This drill is the
# executable proof: restore → integrity check → migration/version validation →
# ledger & audit validation → report. Record the output under evidence/ (or
# the operator log) to claim TESTED; without it the capability stays
# IMPLEMENTED only.
#
# Usage:
#   bash scripts/db-restore-drill.sh <backup.dump> <db-name> [image] [repo-root]
#
#   backup.dump  pg_dump -Fc archive (manifest sidecar <file>.manifest.json
#                is verified when present)
#   db-name      name for the restored database inside the drill container
#   image        postgres image (default postgres:17-alpine — must be >= the
#                pg_dump major version that produced the archive)
#   repo-root    repo root holding db/migrations (default: script's ../..)
set -euo pipefail

# Same MSYS path-conversion guard as db-backup.sh (no-op outside Git Bash).
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

BACKUP="${1:?usage: db-restore-drill.sh <backup.dump> <db-name> [image] [repo-root]}"
TARGET_DB="${2:?missing target db name}"
IMAGE="${3:-postgres:17-alpine}"
REPO_ROOT="${4:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not available" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "ERROR: sha256sum not available (use Git Bash/WSL)" >&2; exit 1; }
[ -f "$BACKUP" ] || { echo "ERROR: backup file not found: $BACKUP" >&2; exit 1; }

# --- integrity gate: verify sha256 BEFORE restoring -------------------------
MANIFEST="${BACKUP}.manifest.json"
if [ -f "$MANIFEST" ]; then
  EXPECTED="$(grep -o '"sha256": *"[a-f0-9]*"' "$MANIFEST" | grep -o '[a-f0-9]\{64\}')"
  ACTUAL="$(sha256sum "$BACKUP" | awk '{print $1}')"
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "DRILL FAIL: sha256 mismatch (manifest ${EXPECTED:0:12}… vs file ${ACTUAL:0:12}…) — archive rejected" >&2
    exit 1
  fi
  echo "CHECK sha256: OK (${ACTUAL:0:12}…)"
else
  echo "WARN: no manifest sidecar — integrity gate skipped (record why)"
fi

DRILL_CONTAINER="iptv-restore-drill-$$"
NET_PORT="$(shuf -i 20000-29999 -n 1 2>/dev/null || echo $((20000 + RANDOM % 9999)))"
FAILURES=0

cleanup() {
  docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "DRILL: starting throwaway ${IMAGE} (container ${DRILL_CONTAINER}, port ${NET_PORT})"
docker run -d --rm --name "$DRILL_CONTAINER" -e POSTGRES_PASSWORD=drill -e POSTGRES_USER=postgres \
  -p "127.0.0.1:${NET_PORT}:5432" "$IMAGE" >/dev/null

# Wait until the server accepts connections (bounded, no blind sleep loop
# beyond the readiness budget).
READY=0
for _ in $(seq 1 30); do
  if docker exec "$DRILL_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ "$READY" = "1" ] || { echo "DRILL FAIL: drill postgres never became ready" >&2; exit 1; }

# The image entrypoint runs a TEMPORARY server during initdb and then
# restarts: probes (and even successful writes) against the temp server die
# with it. Everything below converges by retrying REAL statements until their
# effects persist on the real server: db exists + roles exist, re-verified
# together, right before the restore.
# NOTE: no inner quotes in the ${VAR:-a b} default — quoted expansions inside
# ${} are NOT word-split (one role literally named "iptv iptv_app" would be
# created instead of the two real ones).
DB_READY=0
for _ in $(seq 1 45); do
  if docker exec "$DRILL_CONTAINER" psql -U postgres -d postgres -Atc \
      "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'" 2>/dev/null | grep -q 1; then
    DB_READY=1
    break
  fi
  docker exec "$DRILL_CONTAINER" createdb -U postgres "$TARGET_DB" >/dev/null 2>&1 || true
  for ROLE in ${DRILL_ROLES:-iptv iptv_app}; do
    if ! docker exec "$DRILL_CONTAINER" psql -U postgres -d postgres -Atc \
        "SELECT 1 FROM pg_roles WHERE rolname = '$ROLE'" 2>/dev/null | grep -q 1; then
      docker exec "$DRILL_CONTAINER" psql -U postgres -d postgres -qc "CREATE ROLE \"$ROLE\" WITH LOGIN" >/dev/null 2>&1 || true
    fi
  done
  sleep 1
done
[ "$DB_READY" = "1" ] || { echo "DRILL FAIL: drill postgres never stabilized with the target db" >&2; exit 1; }

# Role provisioning BEFORE restore: the migrations carry `GRANT ... TO
# iptv_app` (041/042/043/047), so restoring into a fresh cluster requires the
# platform roles to exist first — exactly like a real DR restore (runbook:
# backup-restore.md "Procedimento de restore real", step 5). The drill
# reproduces that step instead of hiding it. Verify (not just claim) the
# final state.
for ROLE in ${DRILL_ROLES:-iptv iptv_app}; do
  if docker exec "$DRILL_CONTAINER" psql -U postgres -d postgres -Atc \
      "SELECT 1 FROM pg_roles WHERE rolname = '$ROLE'" | grep -q 1; then
    echo "CHECK roles: $ROLE present"
  else
    echo "DRILL FAIL: role $ROLE missing before restore" >&2
    exit 1
  fi
done

echo "DRILL: restoring archive into ${TARGET_DB}"
# pg_restore validates the TOC first; --no-owner because roles from the source
# (iptv/iptv_app) may not exist in the drill container. Exit codes >= 1 are
# failures (0 = ok; some "errors were ignored" modes are NOT tolerated here).
docker cp "$BACKUP" "$DRILL_CONTAINER:/tmp/restore.dump" >/dev/null
if ! docker exec "$DRILL_CONTAINER" pg_restore -U postgres -d "$TARGET_DB" --no-owner --exit-on-error /tmp/restore.dump; then
  echo "DRILL FAIL: pg_restore reported errors" >&2
  exit 1
fi
docker exec "$DRILL_CONTAINER" rm -f /tmp/restore.dump

# --- structural validation --------------------------------------------------
# Migration/version validation: the restored platform.migration_history must
# match the repo's migration file count EXACTLY (append-only discipline means
# a partial restore is a correctness bug, not an inconvenience).
EXPECTED_MIGRATIONS="$(ls -1 "${REPO_ROOT}"/db/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')"
RESTORED_MIGRATIONS="$(docker exec "$DRILL_CONTAINER" psql -U postgres -d "$TARGET_DB" -Atc \
  "SELECT count(*) FROM platform.migration_history")" || FAILURES=$((FAILURES + 1))
echo "CHECK migrations: restored=${RESTORED_MIGRATIONS:-?} expected=${EXPECTED_MIGRATIONS}"
[ "${RESTORED_MIGRATIONS:-0}" = "$EXPECTED_MIGRATIONS" ] || FAILURES=$((FAILURES + 1))

run_sql() {
  docker exec "$DRILL_CONTAINER" psql -U postgres -d "$TARGET_DB" -Atc "$1"
}

# Ledger validation: when the domain exists, the double-entry ledger must be
# balanced (sum of debits = sum of credits). Empty ledger on a pilot restore
# is legitimate; imbalance is not.
if run_sql "SELECT 1 FROM information_schema.tables WHERE table_schema='finance' AND table_name='financial_ledger_entries'" | grep -q 1; then
  DEBITS="$(run_sql "SELECT coalesce(sum(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0) FROM finance.financial_ledger_entries")"
  CREDITS="$(run_sql "SELECT coalesce(sum(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0) FROM finance.financial_ledger_entries")"
  echo "CHECK ledger: debits=${DEBITS} credits=${CREDITS}"
  [ "$DEBITS" = "$CREDITS" ] || FAILURES=$((FAILURES + 1))
else
  echo "CHECK ledger: SKIPPED (table absent — archive predates finance domain)"
  FAILURES=$((FAILURES + 1))
fi

# Audit validation: the audit spine must exist and, when the archive carries
# domain events, the event log must be present too.
AUDIT_EXISTS="$(run_sql "SELECT count(*) FROM information_schema.tables WHERE table_schema='platform' AND table_name='audit_log'")"
[ "$AUDIT_EXISTS" = "1" ] || FAILURES=$((FAILURES + 1))
EVENTS_EXISTS="$(run_sql "SELECT count(*) FROM information_schema.tables WHERE table_schema='platform' AND table_name='domain_events'")"
[ "$EVENTS_EXISTS" = "1" ] || FAILURES=$((FAILURES + 1))
echo "CHECK audit/event spine present: audit_log=${AUDIT_EXISTS} domain_events=${EVENTS_EXISTS}"

# Provider reconciliation (structural invariants that survive a restore):
# terminal operations must be completed, and ACTIVE bindings must carry the
# provider-side anchor id. (FK integrity is already enforced by pg_restore, so
# orphan checks would be vacuous — these invariants are not.)
if run_sql "SELECT 1 FROM information_schema.tables WHERE table_schema='provider' AND table_name='provider_operations'" | grep -q 1; then
  TERMINAL_INCOMPLETE="$(run_sql "SELECT count(*) FROM provider.provider_operations WHERE status IN ('SUCCEEDED','FAILED','CANCELLED') AND completed_at IS NULL")"
  echo "CHECK provider terminal ops without completed_at: ${TERMINAL_INCOMPLETE}"
  [ "$TERMINAL_INCOMPLETE" = "0" ] || FAILURES=$((FAILURES + 1))
  BINDINGS_EMPTY_EXT="$(run_sql "SELECT count(*) FROM provider.provider_bindings WHERE status = 'ACTIVE' AND (external_id IS NULL OR external_id = '')")"
  echo "CHECK provider ACTIVE bindings without external_id: ${BINDINGS_EMPTY_EXT}"
  [ "$BINDINGS_EMPTY_EXT" = "0" ] || FAILURES=$((FAILURES + 1))
else
  echo "CHECK provider tables: SKIPPED (absent in this archive)"
fi

if [ "$FAILURES" -eq 0 ]; then
  echo "DRILL PASS: ${BACKUP} restored and validated (${TARGET_DB} @ ${IMAGE})"
else
  echo "DRILL FAIL: ${FAILURES} validation check(s) failed" >&2
  exit 1
fi
