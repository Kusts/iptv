#!/usr/bin/env bash
# Negative guards for migration 050 (P1: unsafe pre-existing worker roles).
#
# Replays ONLY the 050 file on scratch databases whose 001–049 state was cloned
# from a template, with hostile or compatible pre-existing cluster-global roles.
# Each hostile posture MUST make 050 fail closed with "migration 050 refused";
# the compatible posture (roles created exactly as the migration would) MUST
# succeed with the same minimal grants.
#
# Why a separate script (not db/tests/*.sql): roles are cluster-GLOBAL, so a
# hostile role created inside a db/tests proof would leak to every other
# database on the server (including parallel vitest suites). This script owns
# its scratch databases AND its roles, and drops both, so the shared-cluster
# shape of P1 is tested without cross-suite interference.
#
# Isolation contract (reviewer-enforced):
#   * every database name carries a per-run unique suffix: two sequential runs
#     never share a name, and a pre-existing `iptv_050neg*` database aborts
#     the run instead of being dropped (foreign DBs are never touched);
#   * runs sharing the same ANCHOR database serialize on a session-level
#     advisory lock held for the whole run: a second concurrent run waits
#     instead of racing the pre-flight and deleting the first run's
#     cluster-global roles. Cross-anchor concurrency on ONE server is NOT
#     interlocked (advisory locks are database-scoped) — give each
#     concurrent run its own server, as the CI job does;
#   * roles are dropped only if this run created them; pre-existing roles
#     abort the run up front (foreign roles are never touched);
#   * cleanup never swallows errors: every DROP is VERIFIED, failures are
#     accumulated and reported loudly, and a failed cleanup fails the run;
#   * the template applies only migrations sorting strictly BEFORE the 050
#     filename, so a future 051 can never be applied ahead of 050 here.
#
# Usage:
#   DATABASE_URL='postgresql://owner@host:5432/any_existing_db' \
#     bash scripts/run_outbox_role_negative_tests.sh
# Only the server part of DATABASE_URL is used (query parameters preserved).
set -euo pipefail
export LC_ALL=C

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required (owner connection; scratch DBs are created beside it)." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG050_FILENAME="202610070000_050_platform_outbox_worker.sql"
MIG050="$ROOT/db/migrations/$MIG050_FILENAME"
RUN_ID="$(date +%s)_$$_$RANDOM"
TPL="iptv_050neg_tpl_${RUN_ID}"
CURRENT_DB=""
CURRENT_ROLES=""
TEMPLATE_OK=""
LOCK_PID=""
CLEANUP_ERRORS=""
RUN_ADVISORY_LOCK_KEY="759150050"

# Split DATABASE_URL into base (scheme://authority) + database + query suffix,
# preserving parameters such as sslmode.
if [[ "$DATABASE_URL" =~ ^([a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+)/([^?#]*)(\?[^#]*)?$ ]]; then
  BASE="${BASH_REMATCH[1]}"
  QUERY="${BASH_REMATCH[3]:-}"
else
  echo "cannot parse DATABASE_URL (expected scheme://authority/database[?params])" >&2
  exit 2
fi
db_url() {
  printf '%s/%s%s' "$BASE" "$1" "$QUERY"
}
# Same server/database/query, but authenticating as another role (for the
# non-superuser deployer proof). The password is an ephemeral throwaway for
# a disposable server, never a real credential.
db_url_as() {
  local user="$1" password="$2" db="$3"
  if [[ "$BASE" =~ ^([a-zA-Z][a-zA-Z0-9+.-]*://)([^@/?#]*@)?([^/?#]+)$ ]]; then
    printf '%s%s:%s@%s/%s%s' "${BASH_REMATCH[1]}" "$user" "$password" "${BASH_REMATCH[3]}" "$db" "$QUERY"
  else
    echo "cannot rewrite DATABASE_URL userinfo" >&2
    exit 2
  fi
}
ANCHOR_URL="$DATABASE_URL"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

note_cleanup_error() {
  if [[ -z "$CLEANUP_ERRORS" ]]; then
    CLEANUP_ERRORS="$1"
  else
    CLEANUP_ERRORS="$CLEANUP_ERRORS; $1"
  fi
}

# Best-effort drops for the EXIT trap: try, VERIFY, and record — never abort
# the remaining cleanup and never silence a failure.
drop_db_best_effort() {
  local db="$1"
  if psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1; then
    if [[ "$(psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM pg_database WHERE datname = '$db'" 2>/dev/null)" != "0" ]]; then
      note_cleanup_error "database $db still exists after DROP"
      return
    fi
  else
    note_cleanup_error "DROP DATABASE $db failed"
    return
  fi
}

drop_role_best_effort() {
  local role="$1"
  if psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -q -c "DROP ROLE IF EXISTS \"$role\"" >/dev/null 2>&1; then
    if [[ "$(psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM pg_roles WHERE rolname = '$role'" 2>/dev/null)" != "0" ]]; then
      note_cleanup_error "role $role still exists after DROP"
      return
    fi
  else
    note_cleanup_error "DROP ROLE $role failed"
    return
  fi
}

# Drop helpers verify the removal and fail loudly instead of swallowing errors.
# All admin commands run from the ANCHOR connection: connecting to the very
# database being dropped (or to the template being cloned) is an error.
drop_db_verified() {
  local db="$1"
  psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null
  if [[ "$(psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM pg_database WHERE datname = '$db'")" != "0" ]]; then
    fail "scratch database $db still exists after DROP"
  fi
}

create_from_template() {
  local db="$1"
  psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$db\" TEMPLATE \"$TPL\"" >/dev/null
}

drop_role_verified() {
  local role="$1"
  psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -q -c "DROP ROLE IF EXISTS \"$role\"" >/dev/null
  if [[ "$(psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM pg_roles WHERE rolname = '$role'")" != "0" ]]; then
    fail "role $role still exists after DROP (check dependent objects)"
  fi
}

drop_current_roles() {
  if [[ -n "$CURRENT_ROLES" ]]; then
    # shellcheck disable=SC2086
    for r in $CURRENT_ROLES; do
      drop_role_verified "$r"
    done
    CURRENT_ROLES=""
  fi
}

cleanup() {
  if [[ -n "$CURRENT_DB" ]]; then
    drop_db_best_effort "$CURRENT_DB"
    CURRENT_DB=""
  fi
  if [[ -n "$CURRENT_ROLES" ]]; then
    # shellcheck disable=SC2086
    for r in $CURRENT_ROLES; do
      drop_role_best_effort "$r"
    done
    CURRENT_ROLES=""
  fi
  if [[ -n "$TEMPLATE_OK" ]]; then
    drop_db_best_effort "$TPL"
    TEMPLATE_OK=""
  fi
  if [[ -n "$LOCK_PID" ]]; then
    kill "$LOCK_PID" 2>/dev/null || true
    LOCK_PID=""
  fi
  if [[ -n "$CLEANUP_ERRORS" ]]; then
    echo "FAIL[cleanup]: $CLEANUP_ERRORS" >&2
    exit 1
  fi
}
trap cleanup EXIT

# Run interlock (same anchor): hold a session-level advisory lock for the
# whole run so a second concurrent run WAITS here instead of racing the
# pre-flight below and deleting this run's cluster-global roles. The holder
# is a coprocess whose ONLY stdout line — emitted by SQL after the lock is
# actually acquired — is the handshake the main shell waits for; process
# liveness alone would also match a holder still blocked in pg_advisory_lock,
# so a fixed sleep is NOT accepted as proof. Timeout covers a full preceding
# run; EOF/death fails loudly instead of proceeding unlocked.
coproc LOCK_HOLDER {
  psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -X -q -At \
    -c "SELECT pg_advisory_lock($RUN_ADVISORY_LOCK_KEY);" \
    -c "SELECT 'LOCK_ACQUIRED' AS interlock;" \
    -c "SELECT pg_sleep(86400);"
}
LOCK_PID=$LOCK_HOLDER_PID
LOCK_LINE=""
while true; do
  if IFS= read -t 1800 -r LOCK_LINE <&"${LOCK_HOLDER[0]}"; then
    # The void lock call may emit a blank line under -At: only the explicit
    # marker proves acquisition, in the session that keeps the lock.
    [[ "$LOCK_LINE" == "LOCK_ACQUIRED" ]] && break
  else
    rc=$?
    if (( rc > 128 )); then
      # Timeout: the holder may still be alive waiting for the lock — keep
      # LOCK_PID so the trap terminates it instead of leaking a connection.
      fail "timed out waiting for the run interlock"
    else
      # EOF: the holder died; nothing left to terminate.
      LOCK_PID=""
      fail "run interlock holder terminated before acquiring the lock"
    fi
  fi
done

# --- Pre-flight: refuse foreign state instead of touching it. ---
PRE_ROLES="$(psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -tAc \
  "SELECT rolname FROM pg_roles WHERE rolname IN ('outbox_worker','outbox_executor','neg_admin','neg_attacker','neg_deployer') ORDER BY 1")"
if [[ -n "$PRE_ROLES" ]]; then
  echo "refusing: server already has roles that this script must create from scratch:" >&2
  echo "$PRE_ROLES" >&2
  echo "run this script before any migration-applying step, on a server without 050 applied." >&2
  exit 2
fi
PRE_DBS="$(psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -tAc \
  "SELECT datname FROM pg_database WHERE datname LIKE 'iptv_050neg%' ORDER BY 1")"
if [[ -n "$PRE_DBS" ]]; then
  echo "refusing: server already has scratch databases from another run (concurrent or leaked):" >&2
  echo "$PRE_DBS" >&2
  echo "wait for the other run or drop its leftovers explicitly; this run will not drop foreign databases." >&2
  exit 2
fi

echo "==> template: create $TPL and apply migrations strictly before 050"
psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$TPL\"" >/dev/null
TEMPLATE_OK="1"
for file in "$ROOT"/db/migrations/*.sql; do
  base="$(basename "$file")"
  if [[ "$base" < "$MIG050_FILENAME" ]]; then
    echo "    migration: $base"
    psql "$(db_url "$TPL")" -v ON_ERROR_STOP=1 -q -f "$file" >/dev/null
  fi
done

PASS_REFUSE=0
PASS_ACCEPT=0

# expect_refuse <scenario> <expected-message-fragment> <setup-sql...>
# Runs the 050 replay as the superuser owner. For a replay as another role,
# set REPLAY_URL (full connection string) for the duration of the call; set
# ASSERT_SESSION_USER to require the replay to authenticate as that role
# (proves the refusal came from the intended identity, not a URL mixup).
REPLAY_URL=""
ASSERT_SESSION_USER=""
expect_refuse() {
  local scenario="$1"; local want="$2"; shift 2
  local db="iptv_050neg_${RUN_ID}_${scenario}"
  local replay="${REPLAY_URL:-$(db_url "$db")}"
  CURRENT_DB="$db"
  create_from_template "$db"
  for stmt in "$@"; do
    psql "$(db_url "$db")" -v ON_ERROR_STOP=1 -q -c "$stmt" >/dev/null
  done
  if [[ -n "${ASSERT_SESSION_USER:-}" ]]; then
    local probe
    probe="$(psql "$replay" -v ON_ERROR_STOP=1 -tAc "SELECT session_user")"
    if [[ "$probe" != "$ASSERT_SESSION_USER" ]]; then
      fail "[$scenario]: replay identity is '$probe', expected '$ASSERT_SESSION_USER'"
    fi
  fi
  local out
  if out="$(psql "$replay" -v ON_ERROR_STOP=1 -f "$MIG050" 2>&1)"; then
    fail "[$scenario]: 050 SUCCEEDED with hostile posture (must refuse)"
  fi
  if [[ "$out" != *"$want"* ]]; then
    echo "[$scenario]: refusal message missing '$want':" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "PASS[$scenario]: 050 refused as expected ('$want')"
  PASS_REFUSE=$((PASS_REFUSE + 1))
  drop_db_verified "$db"
  CURRENT_DB=""
  drop_current_roles
}

# --- Hostile postures: 050 MUST refuse each one. ---

CURRENT_ROLES="outbox_worker"
expect_refuse "worker-bypassrls" 'has BYPASSRLS' \
  "CREATE ROLE outbox_worker LOGIN BYPASSRLS"

CURRENT_ROLES="outbox_worker"
expect_refuse "worker-superuser" 'is SUPERUSER' \
  "CREATE ROLE outbox_worker LOGIN SUPERUSER"

CURRENT_ROLES="neg_admin outbox_worker"
expect_refuse "worker-member-of-admin" 'unexpected role memberships' \
  "CREATE ROLE neg_admin NOLOGIN" \
  "CREATE ROLE outbox_worker LOGIN NOBYPASSRLS" \
  "GRANT neg_admin TO outbox_worker"

CURRENT_ROLES="neg_attacker outbox_worker"
expect_refuse "attacker-member-of-worker" 'unexpected role memberships' \
  "CREATE ROLE neg_attacker LOGIN" \
  "CREATE ROLE outbox_worker LOGIN NOBYPASSRLS" \
  "GRANT outbox_worker TO neg_attacker"

# The critical P1 case: executor already granted to another principal would
# let that principal exercise the SECURITY DEFINER boundary — must refuse,
# never normalize.
CURRENT_ROLES="neg_attacker outbox_executor"
expect_refuse "executor-granted-to-attacker" 'unexpected role memberships' \
  "CREATE ROLE outbox_executor NOLOGIN NOINHERIT NOBYPASSRLS" \
  "CREATE ROLE neg_attacker LOGIN" \
  "GRANT outbox_executor TO neg_attacker"

CURRENT_ROLES="outbox_executor"
expect_refuse "executor-login" 'has LOGIN' \
  "CREATE ROLE outbox_executor LOGIN NOINHERIT NOBYPASSRLS"

CURRENT_ROLES="outbox_executor"
expect_refuse "executor-inherit" 'has INHERIT' \
  "CREATE ROLE outbox_executor NOLOGIN INHERIT NOBYPASSRLS"

CURRENT_ROLES="outbox_worker"
expect_refuse "worker-owns-table" 'owns database objects' \
  "CREATE ROLE outbox_worker LOGIN NOBYPASSRLS" \
  "CREATE TABLE platform.neg_owned (id integer)" \
  "ALTER TABLE platform.neg_owned OWNER TO outbox_worker"

# Column-level grants live in attacl, not relacl: a hostile column GRANT must
# refuse even when the role attributes are otherwise compatible.
CURRENT_ROLES="outbox_worker"
expect_refuse "worker-column-grant" 'direct privileges on database objects' \
  "CREATE ROLE outbox_worker LOGIN NOBYPASSRLS" \
  "GRANT SELECT (tenant_id) ON platform.outbox_messages TO outbox_worker"

# Default privileges inject grants AT CREATE time: a hostile
# ALTER DEFAULT PRIVILEGES must be caught by the install-verification block
# (unexpected grantee on the new functions), not silently committed.
CURRENT_ROLES="neg_attacker"
expect_refuse "default-privs-exec-inject" 'unexpected grantee' \
  "CREATE ROLE neg_attacker LOGIN" \
  "ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT EXECUTE ON FUNCTIONS TO neg_attacker"

# Cross-schema reuse (P1b): a worker with compatible attributes but a live
# grant OUTSIDE platform (here SELECT on billing.charges) must refuse — the
# EXECUTE-only boundary is database-wide, not platform-scoped.
CURRENT_ROLES="outbox_worker"
expect_refuse "worker-cross-schema-grant" 'direct privileges on database objects' \
  "CREATE ROLE outbox_worker LOGIN NOBYPASSRLS" \
  "GRANT SELECT ON billing.charges TO outbox_worker"

# Large-object reuse: a worker retaining LO access must refuse — readable
# via lo_get(oid) outside every table/function audit.
CURRENT_ROLES="outbox_worker"
expect_refuse "worker-large-object-grant" 'direct privileges on database objects' \
  "CREATE ROLE outbox_worker LOGIN NOBYPASSRLS" \
  "SELECT lo_create(170001)" \
  "GRANT SELECT ON LARGE OBJECT 170001 TO outbox_worker"

# Non-superuser deployer (P1a): establishing executor ownership (ALTER ...
# OWNER TO a fresh zero-membership role) needs membership-or-superuser, and
# the membership rule forbids the former by design — so 050 fails closed
# HERE with a clear message instead of obscurely at ALTER/CREATE. Replay as
# a throwaway non-superuser LOGIN on a template clone. The password is an
# ephemeral test-only value for a disposable server, never a real secret.
CURRENT_ROLES="neg_deployer"
NEG_DEPLOYER_PW="NegDeployer0k_ephemeral"
REPLAY_URL="$(db_url_as "neg_deployer" "$NEG_DEPLOYER_PW" "iptv_050neg_${RUN_ID}_nonsuper-deployer")"
ASSERT_SESSION_USER="neg_deployer"
expect_refuse "nonsuper-deployer" 'must run as a superuser owner' \
  "CREATE ROLE neg_deployer LOGIN PASSWORD '$NEG_DEPLOYER_PW'"
REPLAY_URL=""
ASSERT_SESSION_USER=""

CURRENT_ROLES=""

# --- Compatible pre-existing roles: 050 MUST accept with minimal grants. ---
echo "==> compatible reuse: pre-created exact-posture roles must be accepted"
COMPAT_DB="iptv_050neg_${RUN_ID}_compat"
CURRENT_DB="$COMPAT_DB"
CURRENT_ROLES="outbox_worker outbox_executor"
create_from_template "$COMPAT_DB"
psql "$(db_url "$COMPAT_DB")" -v ON_ERROR_STOP=1 -q \
  -c "CREATE ROLE outbox_worker LOGIN NOBYPASSRLS" >/dev/null
psql "$(db_url "$COMPAT_DB")" -v ON_ERROR_STOP=1 -q \
  -c "CREATE ROLE outbox_executor NOLOGIN NOINHERIT NOBYPASSRLS" >/dev/null
psql "$(db_url "$COMPAT_DB")" -v ON_ERROR_STOP=1 -f "$MIG050" >/dev/null
psql "$(db_url "$COMPAT_DB")" -v ON_ERROR_STOP=1 -q <<'SQL' >/dev/null
DO $$
BEGIN
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'outbox_worker') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'compatible worker must stay LOGIN';
  END IF;
  IF (SELECT count(*) FROM pg_auth_members AS m JOIN pg_roles AS r
      ON r.oid IN (m.roleid, m.member)
      WHERE r.rolname IN ('outbox_worker', 'outbox_executor')) <> 0 THEN
    RAISE EXCEPTION 'compatible roles must hold zero memberships';
  END IF;
  IF NOT has_function_privilege('outbox_worker',
      'platform.outbox_claim(integer, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'compatible worker must hold EXECUTE on outbox_claim';
  END IF;
  IF has_table_privilege('outbox_worker', 'platform.outbox_messages', 'SELECT') THEN
    RAISE EXCEPTION 'compatible worker must hold zero table privileges';
  END IF;
  IF (SELECT count(*) FROM pg_proc AS p JOIN pg_roles AS r ON r.oid = p.proowner
      WHERE r.rolname = 'outbox_executor') <> 4 THEN
    RAISE EXCEPTION 'compatible executor must own exactly the four functions';
  END IF;
END $$;
SQL
echo "PASS[compatible-reuse]: 050 accepted exact-posture roles with minimal grants"
PASS_ACCEPT=$((PASS_ACCEPT + 1))
drop_db_verified "$COMPAT_DB"
CURRENT_DB=""
drop_current_roles

# --- Final sweep: nothing owned by this run may remain. ---
LEFTOVER_ROLES="$(psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -tAc \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('outbox_worker','outbox_executor','neg_admin','neg_attacker','neg_deployer')")"
LEFTOVER_DBS="$(psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -tAc \
  "SELECT count(*) FROM pg_database WHERE datname LIKE 'iptv_050neg%'")"
drop_db_verified "$TPL"
TEMPLATE_OK=""
LEFTOVER_AFTER="$(psql "$ANCHOR_URL" -v ON_ERROR_STOP=1 -tAc \
  "SELECT count(*) FROM pg_database WHERE datname LIKE 'iptv_050neg%'")"
if [[ "$LEFTOVER_ROLES" != "0" || "$LEFTOVER_DBS" != "1" || "$LEFTOVER_AFTER" != "0" ]]; then
  fail "cleanup incomplete (roles=$LEFTOVER_ROLES, dbs-before-template-drop=$LEFTOVER_DBS, dbs-after=$LEFTOVER_AFTER)"
fi

# The EXIT trap stays armed through this line: it releases the interlock and
# turns any cleanup failure into a loud non-zero exit.
echo "OK: outbox 050 role guards passed ($PASS_REFUSE refusals, $PASS_ACCEPT acceptance)"
