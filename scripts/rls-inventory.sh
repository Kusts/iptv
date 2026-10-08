#!/usr/bin/env bash
# scripts/rls-inventory.sh — read-only RLS/posture inventory (P1.1).
#
# Produces a per-schema/per-table inventory of every application schema/table
# in the target database plus a first-pass classification suggestion:
#   schemas; per table: schema, table, owner, tenant_id (y/n + nullability),
#   RLS on/off, policies (name + command + USING / WITH CHECK, truncated),
#   grants for iptv_app / outbox_worker / outbox_executor (+ owner column),
#   tenant_id indexes; plus an application-reference section (grep over
#   application sources — a documented approximation, see below).
#
# Output (default evidence/rls-inventory/<UTC-date>/):
#   inventory.md          per-schema tables + policy detail + app refs + rules
#   inventory.json        raw catalog data (schemas + tables incl. app_refs)
#   suggested-class.csv   table,suggestion,rule  (suggestion in
#                         GLOBAL|TENANT_SCOPED|PRE_CONTEXT|CROSS_TENANT_SYSTEM|AUDIT_ONLY|UNKNOWN)
#
# Safety:
#   - SELECT-only. Every database statement in this script is a SELECT or a
#     COPY (SELECT ...) TO STDOUT. No DDL, no DML, no counts over user tables
#     (catalog aggregates only). As defense in depth the session also sets
#     default_transaction_read_only=on, so any accidental write fails closed.
#   - Fails closed without DATABASE_URL / psql / connectivity.
#   - Never prints DATABASE_URL and never emits secrets (no password, token
#     or connection-string column is ever selected); psql stderr is captured
#     to a private temp file (removed on exit), never relayed to the terminal.
#
# Usage:
#   DATABASE_URL=postgresql://... bash scripts/rls-inventory.sh [out-dir]
#   bash scripts/rls-inventory.sh postgresql://... [out-dir]
#
# Needs bash + psql. Point at a DISPOSABLE database (migrations 001-051
# applied). On Windows use Git Bash or WSL.
set -euo pipefail

HEURISTIC_VERSION="P1.1-v1"

usage() {
  echo "usage: DATABASE_URL=postgresql://... bash scripts/rls-inventory.sh [out-dir]" >&2
  echo "   or: bash scripts/rls-inventory.sh <database-url> [out-dir]" >&2
  echo "   self-test (no database): bash scripts/rls-inventory.sh --self-test" >&2
}

# Markdown rows for the policy-detail table. Reads separator-delimited policy
# rows from stdin and prints one markdown row per policy.
# The input separator MUST be the unit separator (US, \037, non-whitespace):
# bash IFS whitespace (space/tab/newline) collapses consecutive delimiters,
# so a TAB-separated row with an empty field (e.g. an INSERT policy with
# empty USING and a present WITH CHECK) would shift WITH CHECK into the
# USING column. US preserves empty fields, including trailing ones.
render_policy_rows() {
  while IFS=$'\037' read -r key pname pcmd proles pusing pcheck; do
    [ -z "$pusing" ] && pusing="(none)"
    [ -z "$pcheck" ] && pcheck="(none)"
    printf '| %s | %s | %s | %s | %s | %s |\n' "$key" "$pname" "$pcmd" "$proles" "$pusing" "$pcheck"
  done
}

self_test() {
  # Hermetic regression proof for the P1-RLS-INVENTORY review findings.
  # No database required: case 1 drives the real script with a stub psql
  # that relays the URL to stderr (worst case); case 2 feeds a synthetic
  # INSERT-with-empty-USING fixture through render_policy_rows (same code
  # path as the report generation).
  local tdir evil_url out status fail=0
  tdir="$(mktemp -d)"
  mkdir -p "$tdir/stubbin"
  cat > "$tdir/stubbin/psql" <<'STUB'
#!/usr/bin/env bash
# Worst-case simulator: relays its arguments to stderr the way real psql
# diagnostics can echo connection-string fragments (e.g. invalid
# percent-encoding in the password). The script under test must never
# relay this output to the terminal.
echo "psql: error: invalid percent-encoding in connection string: $*" >&2
exit 1
STUB
  chmod +x "$tdir/stubbin/psql"
  evil_url='postgresql://inv_user:S3cr3t-P4ss%ZZw0rd@db.invalid:5432/iptv_rls_inventory'
  set +e
  out="$(PATH="$tdir/stubbin:$PATH" bash "${BASH_SOURCE[0]}" "$evil_url" "$tdir/out" 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "SELF-TEST FAIL [stderr-hygiene]: script accepted an unreachable database" >&2
    fail=1
  fi
  case "$out" in
    *S3cr3t-P4ss*|*inv_user*|*%ZZ*|*db.invalid*)
      echo "SELF-TEST FAIL [stderr-hygiene]: credential fragment leaked to terminal output" >&2
      fail=1
      ;;
  esac
  case "$out" in
    *"ERROR: cannot connect"*) ;;
    *)
      echo "SELF-TEST FAIL [stderr-hygiene]: fixed failure message missing" >&2
      fail=1
      ;;
  esac
  local wccheck='(tenant_id = some_check)'
  local md want_ins want_sel
  md="$(printf 'control.feature_flags\037feature_flags_insert\037INSERT\037public\037\037%s\ncontrol.feature_flags\037feature_flags_select\037SELECT\037public\037%s\037\n' "$wccheck" "$wccheck" | render_policy_rows)"
  want_ins="| control.feature_flags | feature_flags_insert | INSERT | public | (none) | $wccheck |"
  want_sel="| control.feature_flags | feature_flags_select | SELECT | public | $wccheck | (none) |"
  case "$md" in
    *"$want_ins"*) ;;
    *)
      echo "SELF-TEST FAIL [insert-empty-using]: INSERT row mis-rendered:" >&2
      printf '%s\n' "$md" >&2
      fail=1
      ;;
  esac
  case "$md" in
    *"$want_sel"*) ;;
    *)
      echo "SELF-TEST FAIL [insert-empty-using]: control SELECT row mis-rendered:" >&2
      printf '%s\n' "$md" >&2
      fail=1
      ;;
  esac
  rm -rf "$tdir"
  if [ "$fail" -eq 0 ]; then
    echo "SELF-TEST PASS: stderr-hygiene + insert-empty-using"
  else
    echo "SELF-TEST FAIL" >&2
  fi
  return "$fail"
}

DATABASE_URL="${DATABASE_URL:-}"
OUT_DIR=""
SELF_TEST=0
for arg in "$@"; do
  case "$arg" in
    *://*) DATABASE_URL="$arg" ;;
    -h|--help) usage; exit 0 ;;
    --self-test) SELF_TEST=1 ;;
    *) OUT_DIR="$arg" ;;
  esac
done

if [ "$SELF_TEST" -eq 1 ]; then
  if self_test; then exit 0; else exit 1; fi
fi
OUT_DIR="${OUT_DIR:-evidence/rls-inventory/$(date -u +%Y%m%d)}"

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is required (env or first argument). Use a disposable database." >&2
  usage
  exit 2
fi
command -v psql >/dev/null 2>&1 || { echo "ERROR: psql not available (use Git Bash/WSL with postgresql-client)" >&2; exit 2; }

# Defense in depth: read-only session on top of SELECT-only statements.
export PGOPTIONS="${PGOPTIONS:-} -c default_transaction_read_only=on"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# psql writes connection diagnostics to stderr, and those diagnostics can echo
# fragments of the connection string (e.g. invalid percent-encoding in the
# password). Every psql call below captures stderr into this private file
# (inside $TMP, removed on exit) and only fixed messages reach the terminal —
# the URL/credential is never relayed. See --self-test (case stderr-hygiene).
PSQL_ERR="$TMP/psql.err"
: > "$PSQL_ERR"
run_psql() {
  psql "$DATABASE_URL" "$@" 2>"$PSQL_ERR" || {
    echo "ERROR: database query failed (details withheld; no connection string or credential is printed)." >&2
    exit 1
  }
}

# Fail closed: connectivity probe. The URL itself is never printed.
if ! psql "$DATABASE_URL" -X -q -tA -v ON_ERROR_STOP=1 -c "SELECT 1;" >/dev/null 2>"$PSQL_ERR"; then
  echo "ERROR: cannot connect to the target database." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$OUT_DIR" in
  /*|?:*) OUT_ABS="$OUT_DIR" ;;
  *) OUT_ABS="$ROOT/$OUT_DIR" ;;
esac
mkdir -p "$OUT_ABS"

# Application source roots actually scanned (recorded verbatim in the output).
SCAN_ROOTS=()
for d in "$ROOT"/apps/*/src "$ROOT"/apps/web/app "$ROOT"/apps/web/lib "$ROOT"/apps/web/components; do
  [ -d "$d" ] && SCAN_ROOTS+=("$d")
done
if [ "${#SCAN_ROOTS[@]}" -eq 0 ]; then
  echo "ERROR: no application source roots found under $ROOT/apps" >&2
  exit 1
fi

# Shared object filter: application schemas (system catalogs excluded).
# NOTE: keep this predicate byte-identical in every query below.
OBJ_FILTER="n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\_%'"

DB_NAME="$(run_psql -X -q -tA -v ON_ERROR_STOP=1 -c "SELECT current_database();")"
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---------------------------------------------------------------- tables TSV
# Columns (TAB-separated, no tabs/newlines inside fields — sanitized in SQL):
# key | schema | table | owner | has_tenant_id(y/n) | tenant_nullable(y/n/-)
#   | rls(y/n) | rls_forced(y/n) | policies_summary | grant_app | grant_worker
#   | grant_executor | tenant_indexes
cat > "$TMP/tables.sql" <<'SQL'
SELECT
  n.nspname || '.' || c.relname
  || chr(9) || n.nspname
  || chr(9) || c.relname
  || chr(9) || pg_get_userbyid(c.relowner)
  || chr(9) || CASE WHEN EXISTS (
       SELECT 1 FROM information_schema.columns k
       WHERE k.table_schema = n.nspname AND k.table_name = c.relname AND k.column_name = 'tenant_id'
     ) THEN 'y' ELSE 'n' END
  || chr(9) || COALESCE((
       SELECT CASE WHEN k.is_nullable = 'YES' THEN 'y' ELSE 'n' END
       FROM information_schema.columns k
       WHERE k.table_schema = n.nspname AND k.table_name = c.relname AND k.column_name = 'tenant_id'
     ), '-')
  || chr(9) || CASE WHEN c.relrowsecurity THEN 'y' ELSE 'n' END
  || chr(9) || CASE WHEN c.relforcerowsecurity THEN 'y' ELSE 'n' END
  || chr(9) || COALESCE((
       SELECT replace(string_agg(p.polname || ':' ||
         CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
           WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE '*' END,
         ', ' ORDER BY p.polname), '|', '/')
       FROM pg_policy p WHERE p.polrelid = c.oid
     ), '(none)')
  || chr(9) || CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN 'ROLE ABSENT'
       ELSE COALESCE(NULLIF((
         SELECT string_agg(q.p, ',' ORDER BY q.p) FROM
           (SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p) q
         WHERE has_table_privilege('iptv_app', c.oid, q.p)), ''), 'NONE') END
  || chr(9) || CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_worker') THEN 'ROLE ABSENT'
       ELSE COALESCE(NULLIF((
         SELECT string_agg(q.p, ',' ORDER BY q.p) FROM
           (SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p) q
         WHERE has_table_privilege('outbox_worker', c.oid, q.p)), ''), 'NONE') END
  || chr(9) || CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_executor') THEN 'ROLE ABSENT'
       ELSE COALESCE(NULLIF((
         SELECT string_agg(q.p, ',' ORDER BY q.p) FROM
           (SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p) q
         WHERE has_table_privilege('outbox_executor', c.oid, q.p)), ''), 'NONE') END
  || chr(9) || COALESCE((
       SELECT string_agg(ic.relname, ', ' ORDER BY ic.relname)
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
       WHERE i.indrelid = c.oid AND pg_get_indexdef(i.indexrelid) ILIKE '%tenant_id%'
     ), '(none)')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND __OBJ_FILTER__
ORDER BY n.nspname, c.relname;
SQL
sed -i "s/__OBJ_FILTER__/$OBJ_FILTER/" "$TMP/tables.sql"
run_psql -X -q -tA -v ON_ERROR_STOP=1 -f "$TMP/tables.sql" > "$TMP/tables.tsv"

# ---------------------------------------------------------------- tables JSONL
# One compact JSON object per table (TAB-prefixed by key); free text carries
# no tabs/newlines (sanitized in SQL) so bash can split on the first TAB.
cat > "$TMP/tables_json.sql" <<'SQL'
SELECT (n.nspname || '.' || c.relname) || chr(9) || json_build_object(
  'schema', n.nspname,
  'table', c.relname,
  'owner', pg_get_userbyid(c.relowner),
  'has_tenant_id', EXISTS (
    SELECT 1 FROM information_schema.columns k
    WHERE k.table_schema = n.nspname AND k.table_name = c.relname AND k.column_name = 'tenant_id'),
  'tenant_id_nullable', (
    SELECT (k.is_nullable = 'YES')
    FROM information_schema.columns k
    WHERE k.table_schema = n.nspname AND k.table_name = c.relname AND k.column_name = 'tenant_id'),
  'rls_enabled', c.relrowsecurity,
  'rls_forced', c.relforcerowsecurity,
  'policies', COALESCE((
    SELECT json_agg(json_build_object(
      'name', p.polname,
      'command', CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
      'roles', (SELECT string_agg(CASE WHEN r = 0 THEN 'public' ELSE r::regrole::text END, ',' ORDER BY 1)
                FROM unnest(p.polroles) r),
      'using', left(replace(replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), chr(9), ' '), chr(10), ' '), 180),
      'with_check', left(replace(replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), chr(9), ' '), chr(10), ' '), 180)
    ) ORDER BY 1) FROM pg_policy p WHERE p.polrelid = c.oid), '[]'::json),
  'grants', json_build_object(
    'iptv_app', CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN 'ROLE ABSENT'
      ELSE COALESCE(NULLIF((
        SELECT string_agg(q.p, ',' ORDER BY q.p) FROM
          (SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p) q
        WHERE has_table_privilege('iptv_app', c.oid, q.p)), ''), 'NONE') END,
    'outbox_worker', CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_worker') THEN 'ROLE ABSENT'
      ELSE COALESCE(NULLIF((
        SELECT string_agg(q.p, ',' ORDER BY q.p) FROM
          (SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p) q
        WHERE has_table_privilege('outbox_worker', c.oid, q.p)), ''), 'NONE') END,
    'outbox_executor', CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_executor') THEN 'ROLE ABSENT'
      ELSE COALESCE(NULLIF((
        SELECT string_agg(q.p, ',' ORDER BY q.p) FROM
          (SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p) q
        WHERE has_table_privilege('outbox_executor', c.oid, q.p)), ''), 'NONE') END),
  'tenant_id_indexes', COALESCE((
    SELECT json_agg(ic.relname ORDER BY ic.relname)
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = c.oid AND pg_get_indexdef(i.indexrelid) ILIKE '%tenant_id%'), '[]'::json)
)::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND __OBJ_FILTER__
ORDER BY n.nspname, c.relname;
SQL
sed -i "s/__OBJ_FILTER__/$OBJ_FILTER/" "$TMP/tables_json.sql"
run_psql -X -q -tA -v ON_ERROR_STOP=1 -f "$TMP/tables_json.sql" > "$TMP/tables.jsonl"

# ---------------------------------------------------------------- policies TSV
# key | policy | command | roles | using(<=180) | with_check(<=180)
# Fields are chr(31) (unit separator) delimited, NOT TAB: TAB is IFS
# whitespace in bash and collapses empty fields, which shifted WITH CHECK
# into the USING column for INSERT policies with empty USING. chr(31) is
# sanitized out of the expression columns so it can never occur in data.
cat > "$TMP/policies.sql" <<'SQL'
SELECT (n.nspname || '.' || c.relname)
  || chr(31) || p.polname
  || chr(31) || CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
      WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END
  || chr(31) || (SELECT string_agg(CASE WHEN r = 0 THEN 'public' ELSE r::regrole::text END, ',' ORDER BY 1)
                FROM unnest(p.polroles) r)
  || chr(31) || left(replace(replace(replace(replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), chr(31), ' '), chr(9), ' '), chr(10), ' '), '|', '/'), 180)
  || chr(31) || left(replace(replace(replace(replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), chr(31), ' '), chr(9), ' '), chr(10), ' '), '|', '/'), 180)
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE __OBJ_FILTER__
ORDER BY n.nspname, c.relname, p.polname;
SQL
sed -i "s/__OBJ_FILTER__/$OBJ_FILTER/" "$TMP/policies.sql"
run_psql -X -q -tA -v ON_ERROR_STOP=1 -f "$TMP/policies.sql" > "$TMP/policies.tsv"

# ---------------------------------------------------------------- suggested-class.csv
# Heuristic P1.1-v1 (declared; UNKNOWN is an allowed outcome at this stage).
# Order matters: RESOLVER wins over ENROLLED on purpose — membership/channel
# tables ARE RLS-enrolled (049/042) but must stay readable pre-context via
# SECURITY DEFINER resolvers, so the rollout-relevant property is PRE_CONTEXT
# (the RLS/policy columns still show the enrolled state):
#   RESOLVER ......... membership / channel tables read pre-context via
#                      SECURITY DEFINER resolvers -> PRE_CONTEXT
#   WORKER-SYSTEM .... outbox publisher spine (050/051) -> CROSS_TENANT_SYSTEM
#   AUTH-SURFACE ..... pre-context auth tables (no tenant data) -> GLOBAL
#   RBAC-CATALOG ..... owner-seeded RBAC catalogs -> GLOBAL
#   GLOBAL-CATALOG ... hybrid/nullable-tenant catalogs with global rows -> GLOBAL
#   MIGRATION-BOOK .. platform.migration_history -> GLOBAL
#   AUDIT-APPEND ..... append-only audit/event trail -> AUDIT_ONLY
#   TENANT-ID ........ tenant_id NOT NULL but unenrolled -> TENANT_SCOPED
#                      (unenrolled candidate for P1.2+)
#   NULLABLE ......... nullable tenant_id, unreviewed -> UNKNOWN
#   NO-TENANT-ID ..... no tenant_id and no allow-list entry -> UNKNOWN
cat > "$TMP/classes.sql" <<'SQL'
COPY (
SELECT tbl, suggestion, rule FROM (
SELECT n.nspname || '.' || c.relname AS tbl,
  CASE
    WHEN (n.nspname || '.' || c.relname) IN (
      'control.tenant_memberships', 'control.membership_roles',
      'communication.tenant_channels', 'billing.tenant_channels')
      THEN 'PRE_CONTEXT'
    WHEN EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
      THEN 'TENANT_SCOPED'
    WHEN (n.nspname || '.' || c.relname) IN (
      'platform.outbox_messages', 'platform.outbox_runtime_control',
      'platform.outbox_runtime_transitions', 'platform.outbox_transitions')
      THEN 'CROSS_TENANT_SYSTEM'
    WHEN (n.nspname || '.' || c.relname) IN (
      'control.tenants', 'control.users', 'control.auth_credentials', 'control.auth_sessions')
      THEN 'GLOBAL'
    WHEN (n.nspname || '.' || c.relname) IN (
      'control.roles', 'control.permissions', 'control.role_permissions')
      THEN 'GLOBAL'
    WHEN (n.nspname || '.' || c.relname) IN (
      'control.feature_flags', 'platform.capabilities',
      'platform.capability_events', 'platform.policy_documents',
      'platform.migration_history')
      THEN 'GLOBAL'
    WHEN (n.nspname || '.' || c.relname) IN (
      'platform.audit_log', 'platform.domain_events')
      THEN 'AUDIT_ONLY'
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns k
      WHERE k.table_schema = n.nspname AND k.table_name = c.relname
        AND k.column_name = 'tenant_id' AND k.is_nullable = 'NO')
      THEN 'TENANT_SCOPED'
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns k
      WHERE k.table_schema = n.nspname AND k.table_name = c.relname
        AND k.column_name = 'tenant_id')
      THEN 'UNKNOWN'
    ELSE 'UNKNOWN'
  END AS suggestion,
  CASE
    WHEN (n.nspname || '.' || c.relname) IN (
      'control.tenant_memberships', 'control.membership_roles',
      'communication.tenant_channels', 'billing.tenant_channels')
      THEN 'RESOLVER:pre-context-read-via-security-definer'
    WHEN EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
      THEN 'ENROLLED:tenant_isolation'
    WHEN (n.nspname || '.' || c.relname) IN (
      'platform.outbox_messages', 'platform.outbox_runtime_control',
      'platform.outbox_runtime_transitions', 'platform.outbox_transitions')
      THEN 'WORKER-SYSTEM:050-051-outbox-publisher-spine'
    WHEN (n.nspname || '.' || c.relname) IN (
      'control.tenants', 'control.users', 'control.auth_credentials', 'control.auth_sessions')
      THEN 'AUTH-SURFACE:pre-context-no-tenant-data'
    WHEN (n.nspname || '.' || c.relname) IN (
      'control.roles', 'control.permissions', 'control.role_permissions')
      THEN 'RBAC-CATALOG:owner-seeded'
    WHEN (n.nspname || '.' || c.relname) IN (
      'control.feature_flags', 'platform.capabilities',
      'platform.capability_events', 'platform.policy_documents',
      'platform.migration_history')
      THEN 'GLOBAL-CATALOG:global-rows-or-bookkeeping'
    WHEN (n.nspname || '.' || c.relname) IN (
      'platform.audit_log', 'platform.domain_events')
      THEN 'AUDIT-APPEND:append-only-trail'
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns k
      WHERE k.table_schema = n.nspname AND k.table_name = c.relname
        AND k.column_name = 'tenant_id' AND k.is_nullable = 'NO')
      THEN 'TENANT-ID-NOTNULL:unenrolled-candidate'
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns k
      WHERE k.table_schema = n.nspname AND k.table_name = c.relname
        AND k.column_name = 'tenant_id')
      THEN 'NULLABLE-TENANT-ID:needs-review'
    ELSE 'NO-TENANT-ID:needs-review'
  END AS rule
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND __OBJ_FILTER__
) s ORDER BY tbl
) TO STDOUT WITH (FORMAT csv, HEADER);
SQL
sed -i "s/__OBJ_FILTER__/$OBJ_FILTER/" "$TMP/classes.sql"
run_psql -X -q -v ON_ERROR_STOP=1 -f "$TMP/classes.sql" > "$OUT_ABS/suggested-class.csv"

# ---------------------------------------------------------------- app references
# Documented approximation (two full-tree scans, not one grep per table):
#   scan 1 (precise): mentions of schema-qualified names (crm.customers).
#   scan 2 (recall): whole-word mentions of bare table names, counted ONLY
#     for tables with zero qualified mentions (bare names collide with
#     ordinary words, e.g. "orders", so these counts are upper bounds).
QUAL_ALT="$(cut -f1 "$TMP/tables.tsv" | sed 's/\./\\./' | paste -sd'|' -)"
printf '' > "$TMP/qual.tsv"
if [ -n "$QUAL_ALT" ]; then
  grep -rhoE -e "$QUAL_ALT" "${SCAN_ROOTS[@]}" --include='*.ts' --include='*.tsx' 2>/dev/null \
    | sort | uniq -c | sort -rn | awk '{print $2 "\t" $1}' > "$TMP/qual.tsv" || true
fi
ZERO_TABLES=""
cut -f1 "$TMP/tables.tsv" | sort -u > "$TMP/all_keys.txt"
cut -f1 "$TMP/qual.tsv" | sort -u > "$TMP/qual_keys.txt"
if [ -s "$TMP/qual_keys.txt" ]; then
  ZERO_TABLES="$(grep -vxF -f "$TMP/qual_keys.txt" "$TMP/all_keys.txt" || true)"
else
  ZERO_TABLES="$(cat "$TMP/all_keys.txt")"
fi
printf '' > "$TMP/bare.tsv"
BARE_ALT="$(printf '%s\n' "$ZERO_TABLES" | sed 's/.*\.//' | sort -u | paste -sd'|' -)"
if [ -n "$BARE_ALT" ]; then
  grep -rhoEw -e "$BARE_ALT" "${SCAN_ROOTS[@]}" --include='*.ts' --include='*.tsx' 2>/dev/null \
    | sort | uniq -c | sort -rn | awk '{print $2 "\t" $1}' > "$TMP/bare.tsv" || true
fi
# refs.tsv: key \t qualified_mentions \t bare_mentions \t basis
while IFS= read -r t; do
  q="$(awk -F'\t' -v k="$t" '$1==k{print $2}' "$TMP/qual.tsv" | head -n1)"
  bname="${t##*.}"
  b="$(awk -F'\t' -v k="$bname" '$1==k{print $2}' "$TMP/bare.tsv" | head -n1)"
  q="${q:-0}"; b="${b:-0}"
  basis="none"
  if [ "$q" != "0" ]; then basis="qualified"; elif [ "$b" != "0" ]; then basis="bare-approx"; fi
  printf '%s\t%s\t%s\t%s\n' "$t" "$q" "$b" "$basis"
done < <(cut -f1 "$TMP/tables.tsv") > "$TMP/refs.tsv"

TOTAL_FILES="$(find "${SCAN_ROOTS[@]}" -name '*.ts' -o -name '*.tsx' 2>/dev/null | wc -l | tr -d ' ')"
SCAN_ROOTS_TXT="$(printf '%s\n' "${SCAN_ROOTS[@]}")"

# ---------------------------------------------------------------- inventory.json
SCHEMAS_JSON="$(run_psql -X -q -tA -v ON_ERROR_STOP=1 -c \
  "SELECT COALESCE(json_agg(json_build_object('schema', nspname, 'owner', pg_get_userbyid(nspowner)) ORDER BY nspname), '[]'::json) FROM pg_namespace n WHERE $OBJ_FILTER;")"
{
  printf '{\n'
  printf '  "generated_at_utc": "%s",\n' "$GENERATED_AT"
  printf '  "heuristic": "%s",\n' "$HEURISTIC_VERSION"
  printf '  "database": "%s",\n' "$DB_NAME"
  printf '  "scan_roots": ['
  first=1
  while IFS= read -r r; do
    rel="${r#"$ROOT"/}"
    if [ "$first" -eq 1 ]; then first=0; else printf ', '; fi
    printf '"%s"' "$rel"
  done <<< "$SCAN_ROOTS_TXT"
  printf '],\n'
  printf '  "schemas": %s,\n' "$SCHEMAS_JSON"
  printf '  "tables": [\n'
  first=1
  while IFS=$'\t' read -r key obj; do
    refline="$(awk -F'\t' -v k="$key" '$1==k{print $2 "\t" $3 "\t" $4}' "$TMP/refs.tsv")"
    qm="${refline%%$'\t'*}"; rest="${refline#*$'\t'}"; bm="${rest%%$'\t'*}"; basis="${rest#*$'\t'}"
    if [ "$first" -eq 1 ]; then first=0; else printf ',\n'; fi
    printf '    %s, "%s": {"qualified_mentions": %s, "bare_mentions": %s, "basis": "%s"}%s' \
      "${obj%\}}" 'app_refs' "$qm" "$bm" "$basis" '}'
  done < "$TMP/tables.jsonl"
  printf '\n  ]\n}\n'
} > "$OUT_ABS/inventory.json"

# ---------------------------------------------------------------- inventory.md
N_TABLES="$(wc -l < "$TMP/tables.tsv" | tr -d ' ')"
N_SCHEMAS="$(run_psql -X -q -tA -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_namespace n WHERE $OBJ_FILTER;")"
N_RLS="$(awk -F'\t' '$7=="y"' "$TMP/tables.tsv" | wc -l | tr -d ' ')"
CLASS_BREAKDOWN="$(awk -F',' 'NR>1{gsub(/"/, "", $2); print $2}' "$OUT_ABS/suggested-class.csv" \
  | sort | uniq -c | sort -rn | awk '{printf "%s %s; ", $2, $1}')"
{
  printf '# RLS inventory (%s)\n\n' "$GENERATED_AT"
  printf 'Heuristic %s. Database: `%s`. Source of truth for behavior: migrations 001-051 + live catalog.\n\n' \
    "$HEURISTIC_VERSION" "$DB_NAME"
  printf '## Summary\n\n'
  printf -- '- schemas: %s; tables: %s; RLS-enabled: %s\n' "$N_SCHEMAS" "$N_TABLES" "$N_RLS"
  printf -- '- suggested-class breakdown: %s\n' "$CLASS_BREAKDOWN"
  printf -- '- app sources scanned (%s files):\n' "$TOTAL_FILES"
  while IFS= read -r r; do printf '  - `%s`\n' "${r#"$ROOT"/}"; done <<< "$SCAN_ROOTS_TXT"
  printf '\n## Tables by schema\n\n'
  printf '| Table | Owner | tenant_id | RLS | Policies | iptv_app | outbox_worker | outbox_executor | tenant_id idx | Suggestion |\n'
  printf '|---|---|---|---|---|---|---|---|---|---|\n'
  while IFS=$'\t' read -r key sch tbl owner htid tnull rls forced pol gapp gwork gexec tidx; do
    sug="$(awk -F',' -v k="$key" '{gsub(/"/, "", $1); if ($1==k) {gsub(/"/, "", $2); print $2}}' "$OUT_ABS/suggested-class.csv")"
    if [ "$htid" = "y" ]; then tidcell="y (nullable $tnull)"; else tidcell="n"; fi
    if [ "$rls" = "y" ]; then rlscell="y"; else rlscell="n"; fi
    printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' \
      "$key" "$owner" "$tidcell" "$rlscell" "$pol" "$gapp" "$gwork" "$gexec" "$tidx" "$sug"
  done < "$TMP/tables.tsv"
  printf '\n## Policy detail (USING / WITH CHECK, truncated to 180 chars)\n\n'
  printf '| Table | Policy | Command | Roles | USING | WITH CHECK |\n'
  printf '|---|---|---|---|---|---|\n'
  if [ -s "$TMP/policies.tsv" ]; then
    render_policy_rows < "$TMP/policies.tsv"
  else
    printf '| (no policies on any inventoried table) | | | | | |\n'
  fi
  printf '\n## Application references (documented approximation)\n\n'
  printf 'Two full-tree scans over `*.ts`/`*.tsx` under the roots above.\n'
  printf 'qualified = mentions of the schema-qualified name (precise); bare = whole-word\n'
  printf 'mentions of the bare table name counted ONLY for tables with zero qualified\n'
  printf 'mentions (bare names collide with ordinary words, e.g. `orders`, so treat bare\n'
  printf 'counts as upper bounds, not proof of use).\n\n'
  printf '| Table | Qualified mentions | Bare mentions | Basis |\n'
  printf '|---|---|---|---|\n'
  while IFS=$'\t' read -r key q b basis; do
    printf '| %s | %s | %s | %s |\n' "$key" "$q" "$b" "$basis"
  done < "$TMP/refs.tsv"
  printf '\n## Classification heuristic (%s)\n\n' "$HEURISTIC_VERSION"
  cat <<'RULES'
  | Code | Suggestion | Meaning |
  |---|---|---|
  | ENROLLED | TENANT_SCOPED | `tenant_isolation` policy present (already RLS-enrolled) |
  | RESOLVER | PRE_CONTEXT | read pre-context via SECURITY DEFINER resolver (memberships, channel routing) |
  | WORKER-SYSTEM | CROSS_TENANT_SYSTEM | outbox publisher spine, migrations 050/051 (cross-tenant by design) |
  | AUTH-SURFACE | GLOBAL | pre-context auth tables, no tenant data |
  | RBAC-CATALOG | GLOBAL | owner-seeded RBAC catalogs |
  | GLOBAL-CATALOG | GLOBAL | hybrid/nullable-tenant catalogs with global rows, or migration bookkeeping |
  | AUDIT-APPEND | AUDIT_ONLY | append-only audit/event trail |
  | TENANT-ID-NOTNULL | TENANT_SCOPED | `tenant_id NOT NULL` but unenrolled: candidate for P1.2+ |
  | NULLABLE-TENANT-ID | UNKNOWN | nullable `tenant_id`, needs per-table review |
  | NO-TENANT-ID | UNKNOWN | no `tenant_id` and no allow-list entry: needs review (must be zero at cutover) |

  ## Re-run

  ```bash
  DATABASE_URL=postgresql://... bash scripts/rls-inventory.sh [out-dir]
  ```

  Read-only: SELECT-only statements plus `default_transaction_read_only=on`;
  fails closed without DATABASE_URL / psql / connectivity; never prints the
  URL and never selects secrets; psql stderr (which can echo connection-string
  fragments) is captured to a private temp file removed on exit, never relayed
  to the terminal. Idempotent: re-running overwrites the same
  dated directory. Hermetic regression proof (no database):
  `bash scripts/rls-inventory.sh --self-test`.
RULES
} > "$OUT_ABS/inventory.md"

echo "OK: inventory written to $OUT_ABS"
echo "tables=$N_TABLES schemas=$N_SCHEMAS rls=$N_RLS"
