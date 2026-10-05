#!/usr/bin/env bash
# db-backup.sh — platform PostgreSQL backup (physical-consistency logical dump).
#
# Produces a pg_dump custom-format archive (-Fc, compressed, restorable with
# pg_restore) plus a sidecar manifest (timestamp, source, pg_dump version,
# byte size, sha256) so a restore drill can verify integrity BEFORE trusting
# the archive. Runs pg_dump INSIDE the postgres container via `docker exec`,
# so no host psql/pg_dump install is required (Windows host included).
#
# Usage:
#   bash scripts/db-backup.sh <container> <db-user> <db-name> <output-dir> [keep]
#
#   container    running postgres container (e.g. iptv-postgres-1)
#   db-user      database role to connect as (owner role, e.g. iptv)
#   db-name      database to dump (e.g. iptv)
#   output-dir   directory for <db>-<timestamp>.dump + .manifest.json
#   keep         retention: keep the N most recent backups (default 7)
#
# Retention prunes only files matching "<db>-*.dump" in output-dir. Encryption
# and offsite copy are OPERATOR/INFRA steps on top of this script — see
# docs/10-operations/runbooks/backup-restore.md (never store the encrypted
# key material next to the archive).
#
# Secrets discipline: this script never prints connection strings or
# passwords; it uses the container's local trust (docker exec as the image's
# default user), matching how the dev/staging containers authenticate.
set -euo pipefail

# Git Bash on Windows mangles leading-slash arguments ("/tmp/x.dump" becomes
# "C:/…/Temp/x.dump") before they reach docker exec — disable that conversion.
# Both vars are no-ops on Linux/macOS.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

CONTAINER="${1:?usage: db-backup.sh <container> <db-user> <db-name> <output-dir> [keep]}"
DB_USER="${2:?missing db-user}"
DB_NAME="${3:?missing db-name}"
OUTPUT_DIR="${4:?missing output-dir}"
KEEP="${5:-7}"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not available" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "ERROR: sha256sum not available (use Git Bash/WSL)" >&2; exit 1; }
docker container inspect "$CONTAINER" >/dev/null 2>&1 || { echo "ERROR: container '$CONTAINER' not found/running" >&2; exit 1; }

mkdir -p "$OUTPUT_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_PATH="${OUTPUT_DIR%/}/${DB_NAME}-${TIMESTAMP}.dump"
MANIFEST_PATH="${DUMP_PATH}.manifest.json"

PG_DUMP_VERSION="$(docker exec "$CONTAINER" pg_dump --version)"

# Custom format: compressed, parallel-restorable, and pg_restore verifies the
# archive header (TOC) before touching the target — a truncated/corrupt dump
# fails at restore time instead of half-applying.
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f "/tmp/${DB_NAME}-${TIMESTAMP}.dump"
docker cp "$CONTAINER:/tmp/${DB_NAME}-${TIMESTAMP}.dump" "$DUMP_PATH"
docker exec "$CONTAINER" rm -f "/tmp/${DB_NAME}-${TIMESTAMP}.dump"

BYTES="$(wc -c < "$DUMP_PATH" | tr -d ' ')"
SHA256="$(sha256sum "$DUMP_PATH" | awk '{print $1}')"

# Manifest is the drill's trust anchor: wrong hash = archive rejected before
# any restore is attempted.
cat > "$MANIFEST_PATH" <<EOF
{
  "created_at": "${TIMESTAMP}",
  "container": "${CONTAINER}",
  "database": "${DB_NAME}",
  "tool": "${PG_DUMP_VERSION}",
  "bytes": ${BYTES},
  "sha256": "${SHA256}",
  "format": "pg_dump -Fc"
}
EOF

echo "BACKUP OK: ${DUMP_PATH}"
echo "MANIFEST:  ${MANIFEST_PATH}"

# Retention: newest N <db>-*.dump survive (manifests follow their dump).
if [ "$KEEP" -ge 1 ] 2>/dev/null; then
  ls -1t "${OUTPUT_DIR%/}/${DB_NAME}"-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
    rm -f "$old" "${old}.manifest.json"
    echo "RETENTION: pruned $(basename "$old")"
  done
fi
