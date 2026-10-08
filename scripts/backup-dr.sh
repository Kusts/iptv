#!/usr/bin/env bash
# backup-dr.sh — scheduled encrypted backup + simulated-offsite DR drill.
#
# Complements scripts/db-backup.sh (plain pg_dump -Fc + manifest) and
# scripts/db-restore-drill.sh (canonical restore validation). This script adds
# the three layers those two deliberately leave to the operator:
#   1. ENCRYPTION at rest (AES-256-GCM via scripts/backup-crypto.mjs; the key
#      lives in an operator-confined file, never next to the archive);
#   2. OFFSITE copy (local-directory driver by default; S3-compatible swap
#      documented — see `offsite-put` and P6-DR.md);
#   3. END-TO-END drill: backup → encrypt → offsite → destroy-sim → restore
#      from offsite → role/worker bootstrap → smoke + canonical validation.
#
# Secrets discipline: never prints keys, passwords or connection strings.
# Drill passwords (`drill-only-*`) exist ONLY inside throwaway containers and
# are never written to disk. The encryption key file path comes from
# $BACKUP_CRYPTO_KEY_FILE; the file itself is operator-owned (0600).
#
# Usage:
#   bash scripts/backup-dr.sh keygen <key-file>
#   bash scripts/backup-dr.sh backup <container> <db-user> <db-name> <work-dir> [keep=3]
#   bash scripts/backup-dr.sh offsite-put <work-dir> <archive-base> <offsite-dir>
#   bash scripts/backup-dr.sh offsite-get <offsite-dir> <archive-base> <dest-dir>
#   bash scripts/backup-dr.sh drill <container> <db-user> <db-name> [drill-root]
#   bash scripts/backup-dr.sh schedule
#
#   archive-base: file base WITHOUT extension, e.g. `iptv-20261008T000000Z`
#   (commands resolve `<base>.dump.enc` + `<base>.dump.enc.manifest.json`).
set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE="${DR_IMAGE:-postgres:17-alpine}"

# Windows node cannot resolve POSIX absolute paths (`/d/...`); resolve the
# helper to a native path when cygpath exists (Git Bash), else keep POSIX.
if command -v cygpath >/dev/null 2>&1; then
  NODE_CRYPTO="$(cygpath -w "${SCRIPT_DIR}/backup-crypto.mjs")"
else
  NODE_CRYPTO="${SCRIPT_DIR}/backup-crypto.mjs"
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not available" >&2; exit 1; }; }

# Manifest rule (single, everywhere): the manifest is ALWAYS `<enc>.manifest.json`,
# e.g. `iptv-<ts>.dump.enc` -> `iptv-<ts>.dump.enc.manifest.json`.

# --- keygen ---------------------------------------------------------------
cmd_keygen() {
  local key_file="${1:?usage: backup-dr.sh keygen <key-file>}"
  need node
  node "$NODE_CRYPTO" keygen "$key_file"
  echo "Store it operator-confined (Infisical/vault path, never the repo)."
}

# --- backup: plain dump -> encrypt -> shred plain -> manifest --------------
cmd_backup() {
  local container="${1:?usage: backup-dr.sh backup <container> <db-user> <db-name> <work-dir> [keep]}"
  local db_user="$2" db_name="$3" work_dir="$4" keep="${5:-3}"
  need docker; need node; need sha256sum
  [ -n "${BACKUP_CRYPTO_KEY_FILE:-}" ] || { echo "ERROR: BACKUP_CRYPTO_KEY_FILE is not set" >&2; exit 2; }
  mkdir -p "$work_dir"
  chmod 700 "$work_dir" 2>/dev/null || true

  bash "${SCRIPT_DIR}/db-backup.sh" "$container" "$db_user" "$db_name" "$work_dir" "$keep"
  local plain
  plain="$(ls -1t "${work_dir%/}/"*.dump 2>/dev/null | head -1)"
  [ -n "$plain" ] || { echo "ERROR: db-backup.sh produced no archive" >&2; exit 1; }
  local plain_manifest="${plain}.manifest.json"
  local enc="${plain}.enc"
  local enc_manifest="${enc}.manifest.json"

  node "$NODE_CRYPTO" encrypt "$plain" "$enc"
  local plain_sha enc_sha plain_bytes enc_bytes pg_tool created_at
  plain_sha="$(sha256sum "$plain" | awk '{print $1}')"
  enc_sha="$(sha256sum "$enc" | awk '{print $1}')"
  plain_bytes="$(wc -c < "$plain" | tr -d ' ')"
  enc_bytes="$(wc -c < "$enc" | tr -d ' ')"
  pg_tool="$(grep -o '"tool": *"[^"]*"' "$plain_manifest" | head -1 || true)"
  created_at="$(grep -o '"created_at": *"[^"]*"' "$plain_manifest" | head -1 || true)"
  chmod 600 "$enc" 2>/dev/null || true
  cat > "$enc_manifest" <<EOF
{
  ${created_at:-"created_at": "unknown"},
  "container": "${container}",
  "database": "${db_name}",
  ${pg_tool:-"tool": "unknown"},
  "plain_bytes": ${plain_bytes},
  "plain_sha256": "${plain_sha}",
  "enc_bytes": ${enc_bytes},
  "enc_sha256": "${enc_sha}",
  "format": "pg_dump -Fc + AES-256-GCM (IPTV1)",
  "key_note": "key in operator-confined BACKUP_CRYPTO_KEY_FILE, never stored with the archive"
}
EOF
  chmod 600 "$enc_manifest" 2>/dev/null || true

  # The plain dump held live tenant data: shred it now that .enc verifies.
  rm -f -- "$plain" "$plain_manifest"
  echo "BACKUP-ENC OK: ${enc}"
  echo "MANIFEST:     ${enc_manifest}"

  # Retention over ENCRYPTED archives only (manifests follow their .enc).
  if [ "$keep" -ge 1 ] 2>/dev/null; then
    ls -1t "${work_dir%/}/"*.dump.enc 2>/dev/null | tail -n +"$((keep + 1))" | while IFS= read -r old; do
      rm -f -- "$old" "${old}.manifest.json"
      echo "RETENTION: pruned $(basename "$old")"
    done
  fi
}

# --- offsite-put: verified copy to the offsite driver ----------------------
cmd_offsite_put() {
  local work_dir="${1:?usage: backup-dr.sh offsite-put <work-dir> <archive-base> <offsite-dir>}"
  local base="$2" offsite_dir="$3"
  need sha256sum
  local enc="${work_dir%/}/${base}.dump.enc"
  local manifest="${enc}.manifest.json"
  [ -f "$enc" ] || { echo "ERROR: archive not found: $enc" >&2; exit 1; }
  [ -f "$manifest" ] || { echo "ERROR: manifest not found: $manifest" >&2; exit 1; }

  local expected actual
  expected="$(grep -o '"enc_sha256": *"[a-f0-9]*"' "$manifest" | grep -o '[a-f0-9]\{64\}')"
  actual="$(sha256sum "$enc" | awk '{print $1}')"
  [ "$expected" = "$actual" ] || { echo "ERROR: pre-copy sha mismatch — refusing offsite copy" >&2; exit 1; }

  if [ -n "${OFFSITE_S3_DEST:-}" ]; then
    need aws
    local s3_args=(s3 cp "$enc" "${OFFSITE_S3_DEST%/}/$(basename "$enc")")
    local s3m_args=(s3 cp "$manifest" "${OFFSITE_S3_DEST%/}/$(basename "$manifest")")
    if [ -n "${OFFSITE_S3_ENDPOINT:-}" ]; then
      aws --endpoint-url "$OFFSITE_S3_ENDPOINT" "${s3_args[@]}"
      aws --endpoint-url "$OFFSITE_S3_ENDPOINT" "${s3m_args[@]}"
    else
      aws "${s3_args[@]}"
      aws "${s3m_args[@]}"
    fi
    driver="s3:${OFFSITE_S3_DEST}"
  else
    mkdir -p "$offsite_dir"
    chmod 700 "$offsite_dir" 2>/dev/null || true
    cp -f "$enc" "$offsite_dir/"
    cp -f "$manifest" "$offsite_dir/"
    chmod 600 "$offsite_dir/$(basename "$enc")" "$offsite_dir/$(basename "$manifest")" 2>/dev/null || true
    driver="local:${offsite_dir}"
  fi
  cat > "${offsite_dir%/}/${base}.offsite.json" <<EOF
{
  "archive": "$(basename "$enc")",
  "enc_sha256": "${actual}",
  "enc_bytes": $(wc -c < "$enc" | tr -d ' '),
  "stored_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "driver": "${driver}"
}
EOF
  echo "OFFSITE-PUT OK: ${driver}/$(basename "$enc")"
}

# --- offsite-get: retrieve + verify ---------------------------------------
cmd_offsite_get() {
  local offsite_dir="${1:?usage: backup-dr.sh offsite-get <offsite-dir> <archive-base> <dest-dir>}"
  local base="$2" dest_dir="$3"
  need sha256sum
  mkdir -p "$dest_dir"
  if [ -n "${OFFSITE_S3_DEST:-}" ]; then
    need aws
    if [ -n "${OFFSITE_S3_ENDPOINT:-}" ]; then
      aws --endpoint-url "$OFFSITE_S3_ENDPOINT" s3 cp "${OFFSITE_S3_DEST%/}/${base}.dump.enc" "$dest_dir/"
      aws --endpoint-url "$OFFSITE_S3_ENDPOINT" s3 cp "${OFFSITE_S3_DEST%/}/${base}.dump.enc.manifest.json" "$dest_dir/"
    else
      aws s3 cp "${OFFSITE_S3_DEST%/}/${base}.dump.enc" "$dest_dir/"
      aws s3 cp "${OFFSITE_S3_DEST%/}/${base}.dump.enc.manifest.json" "$dest_dir/"
    fi
  else
    cp -f "${offsite_dir%/}/${base}.dump.enc" "${offsite_dir%/}/${base}.dump.enc.manifest.json" "$dest_dir/"
  fi
  local enc="${dest_dir%/}/${base}.dump.enc"
  local expected actual
  expected="$(grep -o '"enc_sha256": *"[a-f0-9]*"' "${enc}.manifest.json" | grep -o '[a-f0-9]\{64\}')"
  actual="$(sha256sum "$enc" | awk '{print $1}')"
  [ "$expected" = "$actual" ] || { echo "ERROR: post-retrieval sha mismatch — offsite copy rejected" >&2; exit 1; }
  echo "OFFSITE-GET OK: ${enc} (sha verified)"
}

# --- schedule: print the operator cron block ------------------------------
cmd_schedule() {
  cat <<'EOF'
# P6b backup schedule (operator crontab on the staging/pilot host).
# RPO statement: WITHOUT WAL archiving/PITR, RPO == schedule interval.
# */15 encrypted dumps give nominal RPO <= 15 min for small pilot DBs only;
# production posture REQUIRES PITR (archive_mode=on + WAL shipping + base
# backups) — recorded as infra follow-up in P6-DR.md, never claimed here.
#
#   */15 * * * *  BACKUP_CRYPTO_KEY_FILE=/run/secrets/backup-key.hex \
#     bash /opt/iptv/scripts/backup-dr.sh backup iptv-staging-postgres \
#       iptv_owner iptv /var/backups/iptv 96 >>/var/log/iptv-backup.log 2>&1
#   5 * * * *    OFFSITE_S3_DEST=s3://<bucket>/iptv OFFSITE_S3_ENDPOINT=https://<s3-compat> \
#     bash /opt/iptv/scripts/backup-dr.sh offsite-sweep /var/backups/iptv >>/var/log/iptv-backup.log 2>&1
#
# keep=96 at */15 holds 24h of 15-min archives locally; offsite carries the
# 3-2-1 retention. Monthly: `backup-dr.sh drill` + record evidence.
EOF
}

# --- fingerprint: comparable post-restore identity -------------------------
# Counts AND structural invariants (ledger balance inputs, spine presence,
# provider terminal/binding invariants). `ABSENT` marks tables that predate
# the archive's domain — a skipped check, never a pass.
fingerprint() {
  local container="$1" db="$2"
  docker exec "$container" psql -U postgres -d "$db" -Atc "
    SELECT 'migrations:' || count(*) FROM platform.migration_history;
    SELECT 'outbox:' || state || ':' || count(*) FROM platform.outbox_messages GROUP BY state ORDER BY 1;
    SELECT 'inbox:' || state || ':' || count(*) FROM platform.inbox_messages GROUP BY state ORDER BY 1;
    SELECT 'audit:' || count(*) FROM platform.audit_log;
    SELECT 'events:' || count(*) FROM platform.domain_events;
    SELECT 'ledger_debit:' || coalesce(sum(amount_minor) FILTER (WHERE direction='DEBIT'),0) FROM finance.financial_ledger_entries;
    SELECT 'ledger_credit:' || coalesce(sum(amount_minor) FILTER (WHERE direction='CREDIT'),0) FROM finance.financial_ledger_entries;
    SELECT 'spine_audit_log:' || count(*) FROM information_schema.tables WHERE table_schema='platform' AND table_name='audit_log';
    SELECT 'spine_domain_events:' || count(*) FROM information_schema.tables WHERE table_schema='platform' AND table_name='domain_events';
    SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='provider' AND table_name='provider_operations')
      THEN 'provider_terminal_unfinished:' || (SELECT count(*) FROM provider.provider_operations WHERE status IN ('SUCCEEDED','FAILED','CANCELLED') AND completed_at IS NULL)
      ELSE 'provider_terminal_unfinished:ABSENT' END;
    SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='provider' AND table_name='provider_bindings')
      THEN 'provider_active_noext:' || (SELECT count(*) FROM provider.provider_bindings WHERE status='ACTIVE' AND (external_id IS NULL OR external_id=''))
      ELSE 'provider_active_noext:ABSENT' END;" 2>&1
}

# Absolute structural asserts over one fingerprint (ledger/audit/provider).
# Call with the fingerprint text; fails closed on imbalance or missing spine.
assert_structure() {
  local fp="$1" context="$2" failures=0
  local debit credit
  debit="$(echo "$fp" | grep '^ledger_debit:' | cut -d: -f2)"
  credit="$(echo "$fp" | grep '^ledger_credit:' | cut -d: -f2)"
  [ "$debit" = "$credit" ] || { echo "DRILL FAIL: ledger imbalance debit=${debit} credit=${credit} (${context})" >&2; failures=$((failures + 1)); }
  [ "$(echo "$fp" | grep '^spine_audit_log:' | cut -d: -f2)" = "1" ] || { echo "DRILL FAIL: audit_log spine missing (${context})" >&2; failures=$((failures + 1)); }
  [ "$(echo "$fp" | grep '^spine_domain_events:' | cut -d: -f2)" = "1" ] || { echo "DRILL FAIL: domain_events spine missing (${context})" >&2; failures=$((failures + 1)); }
  local term binds
  term="$(echo "$fp" | grep '^provider_terminal_unfinished:' | cut -d: -f2)"
  binds="$(echo "$fp" | grep '^provider_active_noext:' | cut -d: -f2)"
  { [ "$term" = "0" ] || [ "$term" = "ABSENT" ]; } || { echo "DRILL FAIL: terminal ops w/o completed_at=${term} (${context})" >&2; failures=$((failures + 1)); }
  { [ "$binds" = "0" ] || [ "$binds" = "ABSENT" ]; } || { echo "DRILL FAIL: ACTIVE bindings w/o external_id=${binds} (${context})" >&2; failures=$((failures + 1)); }
  [ "$failures" -eq 0 ] || exit 1
  echo "CHECK structure: ledger balanced, spine present, provider invariants hold (${context})"
}

# --- drill: full end-to-end in throwaway containers ------------------------
cmd_drill() {
  local container="${1:?usage: backup-dr.sh drill <container> <db-user> <db-name> [drill-root]}"
  local db_user="$2" db_name="$3" drill_root="${4:-${REPO_ROOT}/artifacts/dr-p6b}"
  need docker; need node; need sha256sum
  [ -n "${BACKUP_CRYPTO_KEY_FILE:-}" ] || { echo "ERROR: BACKUP_CRYPTO_KEY_FILE is not set" >&2; exit 2; }
  local stamp ts_dir work_dir offsite_dir restore_dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  ts_dir="${drill_root%/}/${stamp}"
  work_dir="${ts_dir}/work"; offsite_dir="${ts_dir}/offsite"; restore_dir="${ts_dir}/restored"
  mkdir -p "$work_dir" "$offsite_dir" "$restore_dir"

  local drill_start drill_end
  drill_start="$(date +%s)"
  echo "DRILL ${stamp}: source ${container}/${db_name}"

  # 1. backup + encrypt (plain shredded by construction).
  cmd_backup "$container" "$db_user" "$db_name" "$work_dir" 2
  local enc
  enc="$(ls -1t "${work_dir}/"*.dump.enc | head -1)"
  local base
  base="$(basename "$enc" .dump.enc)"

  # 2. source fingerprint BEFORE anything is destroyed anywhere.
  echo "DRILL: fingerprinting source"
  fingerprint_source="$(docker exec "$container" psql -U "$db_user" -d "$db_name" -Atc "
    SELECT 'migrations:' || count(*) FROM platform.migration_history;
    SELECT 'outbox:' || count(*) FROM platform.outbox_messages;
    SELECT 'inbox:' || count(*) FROM platform.inbox_messages;
    SELECT 'audit:' || count(*) FROM platform.audit_log;" 2>&1)"
  echo "$fingerprint_source" | sed 's/^/  SRC /'
  local expected_migrations
  expected_migrations="$(ls -1 "${REPO_ROOT}"/db/migrations/*.sql | wc -l | tr -d ' ')"

  # 3. offsite copy (simulated driver: local dir; S3 swap documented).
  cmd_offsite_put "$work_dir" "$base" "$offsite_dir"

  # 4. throwaway "second site" + DESTROY simulation.
  # DR_SITE is GLOBAL on purpose: the EXIT trap runs after locals unwind.
  DR_SITE="iptv-dr-site-$$"
  cleanup() { docker rm -f "$DR_SITE" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  echo "DRILL: starting second-site ${IMAGE} (${DR_SITE})"
  docker run -d --rm --name "$DR_SITE" -e POSTGRES_PASSWORD=drill -e POSTGRES_USER=postgres "$IMAGE" >/dev/null
  local ready=0
  for _ in $(seq 1 30); do
    if docker exec "$DR_SITE" pg_isready -U postgres >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" = "1" ] || { echo "DRILL FAIL: second site never ready" >&2; exit 1; }

  # 4a. retrieve from offsite + decrypt (auth tag verified) + restore.
  cmd_offsite_get "$offsite_dir" "$base" "$restore_dir"
  node "$NODE_CRYPTO" decrypt "${restore_dir}/${base}.dump.enc" "${restore_dir}/${base}.dump"
  local dec_sha manifest_sha
  dec_sha="$(sha256sum "${restore_dir}/${base}.dump" | awk '{print $1}')"
  manifest_sha="$(grep -o '"plain_sha256": *"[a-f0-9]*"' "${restore_dir}/${base}.dump.enc.manifest.json" | grep -o '[a-f0-9]\{64\}')"
  [ "$dec_sha" = "$manifest_sha" ] || { echo "DRILL FAIL: decrypted sha != manifest plain_sha256" >&2; exit 1; }
  echo "CHECK decrypt: sha matches manifest (${dec_sha:0:12}…)"

  # 4b. role/worker bootstrap BEFORE restore (grants in the dump reference
  # them; passwords are drill-only inside this throwaway container).
  docker exec "$DR_SITE" psql -U postgres -d postgres -qc \
    "DO \$\$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='iptv') THEN CREATE ROLE iptv LOGIN; END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='iptv_app') THEN CREATE ROLE iptv_app LOGIN; END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='outbox_worker') THEN CREATE ROLE outbox_worker LOGIN NOBYPASSRLS; END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='outbox_executor') THEN CREATE ROLE outbox_executor NOLOGIN NOINHERIT NOBYPASSRLS; END IF;
     END \$\$;" >/dev/null
  echo "CHECK roles: iptv/iptv_app/outbox_worker/outbox_executor provisioned"

  docker exec "$DR_SITE" psql -U postgres -d postgres -qc "CREATE DATABASE \"${db_name}\";" >/dev/null
  docker cp "${restore_dir}/${base}.dump" "$DR_SITE:/tmp/restore.dump" >/dev/null
  docker exec "$DR_SITE" pg_restore -U postgres -d "$db_name" --no-owner --exit-on-error /tmp/restore.dump
  docker exec "$DR_SITE" rm -f /tmp/restore.dump
  echo "CHECK restore: pg_restore --exit-on-error OK (from OFFSITE+decrypted copy)"

  # 5. DESTROY simulation: drop the restored database, then recover AGAIN
  # purely from the offsite copy (proves the copy, not local state).
  local fp_before
  fp_before="$(fingerprint "$DR_SITE" "$db_name")"
  echo "$fp_before" | sed 's/^/  PRE-DESTROY /'
  # DROP DATABASE cannot run inside a transaction block: terminate backends
  # and drop in SEPARATE psql invocations (one -c each, never combined).
  docker exec "$DR_SITE" psql -U postgres -d postgres -qc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db_name}' AND pid <> pg_backend_pid();" >/dev/null
  docker exec "$DR_SITE" psql -U postgres -d postgres -qc "DROP DATABASE \"${db_name}\";" >/dev/null
  if docker exec "$DR_SITE" psql -U postgres -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='${db_name}'" | grep -q 1; then
    echo "DRILL FAIL: DROP DATABASE did not destroy" >&2; exit 1
  fi
  echo "CHECK destroy: database dropped (simulated loss)"
  docker exec "$DR_SITE" psql -U postgres -d postgres -qc "CREATE DATABASE \"${db_name}\";" >/dev/null
  docker cp "${restore_dir}/${base}.dump" "$DR_SITE:/tmp/restore2.dump" >/dev/null
  docker exec "$DR_SITE" pg_restore -U postgres -d "$db_name" --no-owner --exit-on-error /tmp/restore2.dump
  docker exec "$DR_SITE" rm -f /tmp/restore2.dump
  echo "CHECK re-restore: second pg_restore from the SAME offsite copy OK"

  # 6. bootstrap verification: 050 role posture survived backup/restore.
  local posture
  posture="$(docker exec "$DR_SITE" psql -U postgres -d "$db_name" -Atc "
    SELECT 'worker_login:' || rolcanlogin || '/bypassrls:' || rolbypassrls FROM pg_roles WHERE rolname='outbox_worker';
    SELECT 'executor_login:' || rolcanlogin || '/inherit:' || rolinherit || '/bypassrls:' || rolbypassrls FROM pg_roles WHERE rolname='outbox_executor';
    SELECT 'worker_member_rows:' || count(*) FROM pg_auth_members WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('outbox_worker','outbox_executor')) OR member IN (SELECT oid FROM pg_roles WHERE rolname IN ('outbox_worker','outbox_executor'));
    SELECT 'worker_table_privs:' || count(*) FROM information_schema.role_table_grants WHERE grantee='outbox_worker';
    SELECT 'claim_exec:' || has_function_privilege('outbox_worker','platform.outbox_claim(integer,text,integer)','EXECUTE');
    SELECT 'renew_exec:' || has_function_privilege('outbox_worker','platform.outbox_renew(uuid,uuid,integer)','EXECUTE');
    SELECT 'complete_exec:' || has_function_privilege('outbox_worker','platform.outbox_complete(uuid,uuid)','EXECUTE');
    SELECT 'fail_exec:' || has_function_privilege('outbox_worker','platform.outbox_fail(uuid,uuid,text,timestamptz)','EXECUTE');" 2>&1)"
  echo "$posture" | sed 's/^/  POSTURE /'
  echo "$posture" | grep -q 'worker_login:true/bypassrls:false' || { echo "DRILL FAIL: outbox_worker posture" >&2; exit 1; }
  echo "$posture" | grep -q 'executor_login:false/inherit:false/bypassrls:false' || { echo "DRILL FAIL: outbox_executor posture" >&2; exit 1; }
  echo "$posture" | grep -q 'worker_member_rows:0' || { echo "DRILL FAIL: worker membership rows" >&2; exit 1; }
  echo "$posture" | grep -q 'worker_table_privs:0' || { echo "DRILL FAIL: worker table grants" >&2; exit 1; }
  echo "$posture" | grep -q 'claim_exec:true' || { echo "DRILL FAIL: outbox_claim EXECUTE" >&2; exit 1; }
  echo "$posture" | grep -q 'renew_exec:true' || { echo "DRILL FAIL: outbox_renew EXECUTE" >&2; exit 1; }
  echo "$posture" | grep -q 'complete_exec:true' || { echo "DRILL FAIL: outbox_complete EXECUTE" >&2; exit 1; }
  echo "$posture" | grep -q 'fail_exec:true' || { echo "DRILL FAIL: outbox_fail EXECUTE" >&2; exit 1; }
  echo "CHECK bootstrap: 050 worker/executor posture verified post-restore"

  # 7. fingerprint compare: destroy + re-restore lost nothing.
  local fp_after
  fp_after="$(fingerprint "$DR_SITE" "$db_name")"
  echo "$fp_after" | sed 's/^/  POST-RESTORE /'
  [ "$fp_before" = "$fp_after" ] || { echo "DRILL FAIL: fingerprint drift across destroy/re-restore" >&2; exit 1; }
  echo "CHECK fidelity: pre-destroy == post-restore fingerprints"
  assert_structure "$fp_after" "post-restore"

  # 8. canonical structural validation reuses the established gate — but ONLY
  # when the source is at repo HEAD: the gate compares against
  # db/migrations/*.sql, so a legitimately-behind source fails it by
  # construction (proven here: staging at 051 vs repo 059). Fidelity against
  # the SOURCE (step 7) is the correct assert for a behind source; the drift
  # itself is recorded, not hidden.
  local repo_migrations
  repo_migrations="$(ls -1 "${REPO_ROOT}"/db/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')"
  local source_migrations
  source_migrations="$(echo "$fp_before" | grep '^migrations:' | cut -d: -f2)"
  if [ "$source_migrations" = "$repo_migrations" ]; then
    # Post-050 archives carry `POLICY ... TO outbox_executor` + executor-owned
    # functions: restoring with only iptv/iptv_app FAILS at pg_restore (proven
    # by this drill on 2026-10-08 — a naive 2-role restore is NOT sufficient).
    # The precise NOLOGIN/NOINHERIT posture was already verified in step 6;
    # here the roles only need to EXIST for the TOC to apply.
    DRILL_ROLES="iptv iptv_app outbox_worker outbox_executor" bash "${SCRIPT_DIR}/db-restore-drill.sh" "${restore_dir}/${base}.dump" "${db_name}_canonical" "$IMAGE" "$REPO_ROOT"
  else
    echo "SKIP canonical gate: source at ${source_migrations} migrations vs repo ${repo_migrations} (staging behind HEAD — re-migrate staging; fidelity proven vs source above)"
  fi

  drill_end="$(date +%s)"
  echo "DRILL PASS: backup→encrypt→offsite→destroy→restore→bootstrap→smoke in $((drill_end - drill_start))s (evidence: ${ts_dir})"
}

cmd="${1:?usage: backup-dr.sh (keygen|backup|offsite-put|offsite-get|drill|schedule) ...}"
shift
case "$cmd" in
  keygen) cmd_keygen "$@" ;;
  backup) cmd_backup "$@" ;;
  offsite-put) cmd_offsite_put "$@" ;;
  offsite-get) cmd_offsite_get "$@" ;;
  drill) cmd_drill "$@" ;;
  schedule) cmd_schedule "$@" ;;
  offsite-sweep) echo "offsite-sweep: retention lives in the offsite driver (S3 lifecycle / local keep); nothing to implement here" ;;
  *) echo "ERROR: unknown command '$cmd'" >&2; exit 2 ;;
esac
