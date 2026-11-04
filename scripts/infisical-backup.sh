#!/usr/bin/env bash
# infisical-backup.sh — public-key backup of the self-hosted Infisical instance to Cloudflare R2.
#
# SECURITY MODEL (review-driven): the backup host holds ONLY the recipient
# PUBLIC key. It can encrypt but never decrypt. The private recovery key stays
# operator-local (artifacts/infisical-recovery/, gitignored) and is used solely
# for isolated restores. The symmetric BACKUP_CRYPTO_KEY_FILE convention is
# DELIBERATELY NOT USED here — provisioning that AES key to the VPS would put
# decryption capability on the host. This script never reads it, and
# backup-dr.sh's symmetric `backup` path is never invoked.
#
# What it does (code + docs only; touches nothing live by itself):
#   1. Captures a plaintext pg_dump (-Fc) via `docker exec`/`docker cp`
#      against iptv-infisical-postgres into a 0600 temp file, then encrypts it
#      with the recipient public key (hybrid RSA-OAEP-SHA256 + AES-256-GCM via
#      `infisical-public-crypto.mjs`, format IPUB1, streamed with temp +
#      atomic publish) and unlinks the plaintext immediately. `rm -f` only
#      unlinks — it is NOT a secure shred (see residual-risk note below).
#      Temp cleanup is trap-guaranteed (EXIT/INT/TERM), even on encrypt failure.
#   2. Encrypts a recovery copy of the host `.env.infisical` with the SAME
#      public key (read in place; no plaintext copy is ever staged).
#   3. Uploads ONLY ciphertext + non-secret manifests to R2 with `rclone`
#      (S3-compatible remote configured via environment — no AWS CLI, no
#      secret-bearing config file written by rclone). Unique timestamp keys;
#      no overwrites across runs.
#   4. Verifies the remote objects, fails closed on any error, and keeps local
#      ciphertext on upload/verification failure for recovery.
#
# Secrets discipline: env values are NEVER printed, logged, or embedded in
# manifests. Missing inputs fail closed (exit 2) naming the VARIABLE, never
# the value. The source `.env.infisical` and live volumes are never altered
# or removed.
#
# Usage (host-only; run on the backup host, e.g. from cron):
#   INFISICAL_BACKUP_PUBLIC_KEY_FILE=/etc/infisical-recovery/infisical-backup.pub.pem \
#   INFISICAL_R2_ENDPOINT=... INFISICAL_R2_BUCKET=... \
#   INFISICAL_R2_ACCESS_KEY_ID=... INFISICAL_R2_SECRET_ACCESS_KEY=... \
#   bash scripts/infisical-backup.sh backup
#
#   bash scripts/infisical-backup.sh selftest   # stubbed, no live touch
#
# Config (environment only; see runbook for the host-only shape):
#   INFISICAL_ENV_FILE           source env file (default /home/deploy/infisical/.env.infisical)
#   INFISICAL_PG_CONTAINER       live postgres container (default iptv-infisical-postgres)
#   INFISICAL_PG_USER            db user (default infisical)
#   INFISICAL_PG_DB              db name (default infisical)
#   INFISICAL_BACKUP_DIR         local work dir (default /var/backups/infisical)
#   INFISICAL_BACKUP_KEEP        local retention count (default 7)
#   INFISICAL_BACKUP_PUBLIC_KEY_FILE  recipient PUBLIC key PEM on the host (REQUIRED;
#                                the ONLY key material on the host — never a private
#                                key, never BACKUP_CRYPTO_KEY_FILE)
#   INFISICAL_R2_ENDPOINT        R2 S3 endpoint, e.g. https://<account>.r2.cloudflarestorage.com (REQUIRED)
#   INFISICAL_R2_BUCKET          R2 bucket (REQUIRED, e.g. iptv-infisical-backups)
#   INFISICAL_R2_PREFIX          object prefix (default infisical/)
#   INFISICAL_R2_ACCESS_KEY_ID / INFISICAL_R2_SECRET_ACCESS_KEY (REQUIRED)
#   INFISICAL_R2_REGION          S3 region for the remote (default auto)
set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Windows node cannot resolve POSIX absolute paths (`/d/...`); resolve the
# helper to a native path when cygpath exists (Git Bash), else keep POSIX.
if command -v cygpath >/dev/null 2>&1; then
  NODE_PUBCRYPTO="$(cygpath -w "${SCRIPT_DIR}/infisical-public-crypto.mjs")"
else
  NODE_PUBCRYPTO="${SCRIPT_DIR}/infisical-public-crypto.mjs"
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not available" >&2; exit 1; }; }

# Native Windows `node` cannot open MSYS POSIX paths (/tmp/..., /d/...),
# while every bash tool in this script handles them. Convert file arguments
# for `node` only, and only where cygpath exists (Linux: identity, no-op).
# `-m` (mixed, forward slashes) is safe inside `node -e "..."` JS strings.
nodepath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1";
  else printf '%s\n' "$1"; fi
}

# --- config ---------------------------------------------------------------
load_config() {
  : "${INFISICAL_ENV_FILE:=/home/deploy/infisical/.env.infisical}"
  : "${INFISICAL_PG_CONTAINER:=iptv-infisical-postgres}"
  : "${INFISICAL_PG_USER:=infisical}"
  : "${INFISICAL_PG_DB:=infisical}"
  : "${INFISICAL_BACKUP_DIR:=/var/backups/infisical}"
  : "${INFISICAL_BACKUP_KEEP:=7}"
  : "${INFISICAL_R2_PREFIX:=infisical/}"
  : "${INFISICAL_R2_REGION:=auto}"

  local missing=()
  for var in INFISICAL_BACKUP_PUBLIC_KEY_FILE INFISICAL_R2_ENDPOINT INFISICAL_R2_BUCKET \
             INFISICAL_R2_ACCESS_KEY_ID INFISICAL_R2_SECRET_ACCESS_KEY; do
    [ -n "${!var:-}" ] || missing+=("$var")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    # Names only — never values.
    echo "ERROR: missing required config: ${missing[*]}" >&2
    echo "HINT: export the variables above on the host (see runbook); no defaults exist for secrets." >&2
    echo "HINT: the host takes ONLY the recipient PUBLIC key — never a private key, never BACKUP_CRYPTO_KEY_FILE." >&2
    exit 2
  fi
  [ -r "${INFISICAL_BACKUP_PUBLIC_KEY_FILE}" ] || { echo "ERROR: INFISICAL_BACKUP_PUBLIC_KEY_FILE is not readable (check the public-key path)" >&2; exit 2; }
  [ -f "${INFISICAL_ENV_FILE}" ] || { echo "ERROR: INFISICAL_ENV_FILE not found: ${INFISICAL_ENV_FILE}" >&2; exit 2; }
}

# Normalise "///infisical" -> "infisical/".
normalise_prefix() {
  local p="${INFISICAL_R2_PREFIX#/}"
  while [[ "$p" == */ ]]; do p="${p%/}"; done
  printf '%s/' "$p"
}

# rclone S3 remote purely from environment: no `rclone config` file is
# created or required; credentials travel in process env only.
# NOTE: no `*_ACL` knob is exported on purpose — Cloudflare R2's S3
# compatibility does not support ACL headers/operations, and R2 objects are
# private by default. Sending ACL headers risks a rejected request.
# `no_check_bucket = true` is REQUIRED for object-scoped API tokens: per the
# official Cloudflare R2 rclone docs, scoped tokens lack the bucket-level
# create/check permission, so rclone's default bucket existence check (and
# bucket creation attempt) is rejected with 403 even when `lsd` succeeds and
# `PutObject` would otherwise be allowed. Skipping the check limits rclone to
# object operations the token is actually granted.
configure_rclone_env() {
  export RCLONE_CONFIG_INFISICALR2_TYPE="s3"
  export RCLONE_CONFIG_INFISICALR2_PROVIDER="Cloudflare"
  export RCLONE_CONFIG_INFISICALR2_ENDPOINT="${INFISICAL_R2_ENDPOINT}"
  export RCLONE_CONFIG_INFISICALR2_ACCESS_KEY_ID="${INFISICAL_R2_ACCESS_KEY_ID}"
  export RCLONE_CONFIG_INFISICALR2_SECRET_ACCESS_KEY="${INFISICAL_R2_SECRET_ACCESS_KEY}"
  export RCLONE_CONFIG_INFISICALR2_REGION="${INFISICAL_R2_REGION}"
  export RCLONE_CONFIG_INFISICALR2_NO_CHECK_BUCKET="true"
}

# Plaintext pg_dump buffer: 0600 temp file, unlinked by trap (EXIT/INT/TERM)
# even when the encrypt step fails. Ciphertext (.penc) is NOT covered by this
# trap. `rm -f` only unlinks — it is NOT a secure shred: page cache,
# snapshots/CoW, journal blocks, or SSD wear-leveling may retain recoverable
# copies. 0600 limits access to the local owner; run the backup dir on an
# encrypted volume for higher assurance.
setup_plain_cleanup() {
  PLAIN_TMP="$1"; PLAIN_CTMP="$2"; PLAIN_CONTAINER="$3"
  cleanup_plain() {
    rm -f -- "$PLAIN_TMP" 2>/dev/null || true
    docker exec "$PLAIN_CONTAINER" rm -f -- "$PLAIN_CTMP" 2>/dev/null || true
  }
  trap cleanup_plain EXIT INT TERM
}

# --- backup ---------------------------------------------------------------
cmd_backup() {
  load_config
  need docker; need node; need sha256sum; need rclone
  # Deliberately NO aws dependency and NO backup-dr.sh symmetric path:
  # R2 upload goes through rclone only, encryption is public-key envelope only.
  docker container inspect "${INFISICAL_PG_CONTAINER}" >/dev/null 2>&1 \
    || { echo "ERROR: container '${INFISICAL_PG_CONTAINER}' not found/running" >&2; exit 1; }

  mkdir -p "${INFISICAL_BACKUP_DIR}"
  chmod 700 "${INFISICAL_BACKUP_DIR}" 2>/dev/null || true
  local work_dir="${INFISICAL_BACKUP_DIR}"

  local keep="${INFISICAL_BACKUP_KEEP}"
  if [ "$keep" -ge 1 ] 2>/dev/null; then :; else
    echo "ERROR: INFISICAL_BACKUP_KEEP must be a positive integer" >&2; exit 2
  fi

  # Unique key per run: second-resolution timestamps collide for rapid
  # re-runs/cron overlap, and colliding names would silently overwrite a
  # previous ciphertext. Suffix is 4 cryptographically random bytes; any
  # pre-existing output with the same name fails closed instead of overwriting.
  local stamp rand dump_name ctmp plain_tmp dump_enc
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  rand="$(od -An -tx1 -N4 /dev/urandom 2>/dev/null | tr -d ' \n')"
  [ -n "$rand" ] || rand="$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
  stamp="${stamp}-${rand}"
  dump_name="${INFISICAL_PG_DB}-${stamp}.dump"
  ctmp="/tmp/${dump_name}"
  plain_tmp="$(mktemp "${work_dir}/.plain-XXXXXX")"
  chmod 600 "$plain_tmp" 2>/dev/null || true
  setup_plain_cleanup "$plain_tmp" "$ctmp" "${INFISICAL_PG_CONTAINER}"

  local pg_tool
  pg_tool="$(docker exec "${INFISICAL_PG_CONTAINER}" pg_dump --version 2>/dev/null || echo "pg_dump (version unknown)")"
  docker exec "${INFISICAL_PG_CONTAINER}" pg_dump -U "${INFISICAL_PG_USER}" -d "${INFISICAL_PG_DB}" -Fc -f "$ctmp"
  docker cp "${INFISICAL_PG_CONTAINER}:${ctmp}" "$plain_tmp"
  docker exec "${INFISICAL_PG_CONTAINER}" rm -f -- "$ctmp"

  local plain_sha plain_bytes
  plain_sha="$(sha256sum "$plain_tmp" | awk '{print $1}')"
  plain_bytes="$(wc -c < "$plain_tmp" | tr -d ' ')"

  # Public-key envelope encrypt (streamed, temp + atomic publish), then unlink
  # the plaintext immediately (rm -f unlinks; not a secure shred — see note
  # on setup_plain_cleanup). Fail closed if an output already exists.
  dump_enc="${work_dir%/}/${dump_name}.penc"
  if [ -e "$dump_enc" ] || [ -e "${dump_enc}.manifest.json" ]; then
    echo "ERROR: refusing to overwrite existing output $(basename "$dump_enc") (re-run with a fresh key)" >&2
    exit 1
  fi
  node "$NODE_PUBCRYPTO" encrypt "$(nodepath "${INFISICAL_BACKUP_PUBLIC_KEY_FILE}")" "$(nodepath "$plain_tmp")" "$(nodepath "$dump_enc")"
  rm -f -- "$plain_tmp"
  trap - EXIT INT TERM
  chmod 600 "$dump_enc" 2>/dev/null || true

  # Recipient public-key fingerprint: lets the operator select the matching
  # local private key through rotation. Same bytes keygen hashed at creation.
  local pub_fp
  pub_fp="$(node "$NODE_PUBCRYPTO" fingerprint "$(nodepath "${INFISICAL_BACKUP_PUBLIC_KEY_FILE}")")"

  local enc_sha enc_bytes
  enc_sha="$(sha256sum "$dump_enc" | awk '{print $1}')"
  enc_bytes="$(wc -c < "$dump_enc" | tr -d ' ')"
  cat > "${dump_enc}.manifest.json" <<EOF
{
  "created_at": "${stamp}",
  "container": "${INFISICAL_PG_CONTAINER}",
  "database": "${INFISICAL_PG_DB}",
  "tool": "${pg_tool}",
  "plain_bytes": ${plain_bytes},
  "plain_sha256": "${plain_sha}",
  "enc_bytes": ${enc_bytes},
  "enc_sha256": "${enc_sha}",
  "format": "pg_dump -Fc + hybrid RSA-OAEP-SHA256/AES-256-GCM (IPUB1)",
  "recipient_pub_sha256": "${pub_fp}",
  "key_note": "recipient PUBLIC key only on host; private recovery key stays operator-local — match recipient_pub_sha256 to the local key"
}
EOF
  chmod 600 "${dump_enc}.manifest.json" 2>/dev/null || true

  # Encrypt a recovery copy of .env.infisical IN PLACE with the same public
  # key (read the source directly; no plaintext copy is ever staged).
  # Fail closed if an output already exists.
  local env_enc="${work_dir%/}/infisical-env-${stamp}.penc"
  if [ -e "$env_enc" ] || [ -e "${env_enc}.manifest.json" ]; then
    echo "ERROR: refusing to overwrite existing output $(basename "$env_enc") (re-run with a fresh key)" >&2
    exit 1
  fi
  node "$NODE_PUBCRYPTO" encrypt "$(nodepath "${INFISICAL_BACKUP_PUBLIC_KEY_FILE}")" "$(nodepath "${INFISICAL_ENV_FILE}")" "$(nodepath "$env_enc")"
  chmod 600 "$env_enc" 2>/dev/null || true
  local env_sha env_bytes
  env_sha="$(sha256sum "$env_enc" | awk '{print $1}')"
  env_bytes="$(wc -c < "$env_enc" | tr -d ' ')"
  cat > "${env_enc}.manifest.json" <<EOF
{
  "created_at": "${stamp}",
  "kind": "infisical-env-ciphertext",
  "paired_dump": "$(basename "$dump_enc")",
  "enc_bytes": ${env_bytes},
  "enc_sha256": "${env_sha}",
  "format": ".env.infisical + hybrid RSA-OAEP-SHA256/AES-256-GCM (IPUB1)",
  "recipient_pub_sha256": "${pub_fp}",
  "key_note": "recipient PUBLIC key only on host; private recovery key stays operator-local — match recipient_pub_sha256 to the local key"
}
EOF
  chmod 600 "${env_enc}.manifest.json" 2>/dev/null || true

  # Upload ONLY ciphertext + non-secret manifests.
  configure_rclone_env
  local prefix remote_base f
  prefix="$(normalise_prefix)"
  remote_base="infisicalr2:${INFISICAL_R2_BUCKET}/${prefix}"
  local upload_fail=0
  for f in "$dump_enc" "${dump_enc}.manifest.json" "$env_enc" "${env_enc}.manifest.json"; do
    if ! rclone copyto "$f" "${remote_base}$(basename "$f")"; then
      echo "ERROR: rclone upload failed for $(basename "$f") — local ciphertext kept in ${work_dir}" >&2
      upload_fail=1
    fi
  done
  if [ "$upload_fail" -ne 0 ]; then exit 1; fi

  # Remote verification: byte-level integrity of EXACTLY the 4 just-uploaded
  # objects. `rclone check <dir> <remote:prefix> --download` requires
  # directory paths on both sides (file-to-object form reports `is a file
  # not a directory`), so stage exactly these 4 files into a 0700 temp
  # subdir and check it against the remote prefix with `--one-way` (older
  # objects in the prefix must not fail the comparison). `--download`
  # compares actual remote bytes (a listing would miss truncated/corrupt
  # uploads). The staging dir holds ciphertext/manifests only and is always
  # removed (trap + explicit cleanup). Any failure fails closed with local
  # ciphertext kept.
  local verify_dir verify_fail=0
  verify_dir="$(mktemp -d "${work_dir%/}/.verify-XXXXXX")"
  chmod 700 "$verify_dir" 2>/dev/null || true
  cleanup_verify_dir() {
    # Execution-time expansion only: no path interpolation into trap code,
    # so single quotes in INFISICAL_BACKUP_DIR cannot inject shell code.
    # Guarded to the exact temp staging dir created above.
    [ -n "${verify_dir:-}" ] || return 0
    case "$verify_dir" in
      "${work_dir%/}"/.verify-*) rm -rf -- "$verify_dir" ;;
      *) echo "ERROR: refusing to clean unexpected verify dir" >&2; return 1 ;;
    esac
  }
  trap cleanup_verify_dir EXIT INT TERM
  for f in "$dump_enc" "${dump_enc}.manifest.json" "$env_enc" "${env_enc}.manifest.json"; do
    if ! cp -f -- "$f" "$verify_dir/"; then
      echo "ERROR: verify staging failed for $(basename "$f") — local ciphertext kept in ${work_dir}" >&2
      verify_fail=1
    fi
  done
  chmod 600 "$verify_dir"/* 2>/dev/null || true
  if [ "$verify_fail" -eq 0 ]; then
    if ! rclone check "$verify_dir" "$remote_base" --download --one-way; then
      echo "ERROR: remote verification failed (content mismatch or missing under ${INFISICAL_R2_BUCKET}/${prefix}) — local ciphertext kept in ${work_dir}" >&2
      verify_fail=1
    fi
  fi
  cleanup_verify_dir
  trap - EXIT INT TERM
  if [ "$verify_fail" -ne 0 ]; then exit 1; fi

  # Local retention over ciphertext only (manifests follow their .penc).
  ls -1t "${work_dir%/}/${INFISICAL_PG_DB}-"*.dump.penc 2>/dev/null | tail -n +"$((keep + 1))" | while IFS= read -r old; do
    rm -f -- "$old" "${old}.manifest.json"
    echo "RETENTION: pruned $(basename "$old")"
  done
  ls -1t "${work_dir%/}/infisical-env-"*.penc 2>/dev/null | tail -n +"$((keep + 1))" | while IFS= read -r old; do
    rm -f -- "$old" "${old}.manifest.json"
    echo "RETENTION: pruned $(basename "$old")"
  done

  echo "INFISICAL-BACKUP OK: $(basename "$dump_enc") + $(basename "$env_enc")"
  echo "REMOTE: ${INFISICAL_R2_BUCKET}/${prefix} (4 objects verified)"
}

# --- selftest (stubbed; no live touch) ------------------------------------
cmd_selftest() {
  need bash; need node; need sha256sum
  local t stubbin workdir remotedir fakecdir privkey pubkey wrongpriv envfile marker
  t="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$t'" EXIT
  stubbin="$t/bin"; workdir="$t/work"; remotedir="$t/remote"; fakecdir="$t/fakectr"
  mkdir -p "$stubbin" "$workdir" "$remotedir" "$fakecdir"

  # Stub docker: `container inspect` ok; `exec ... pg_dump --version`;
  # `exec ... pg_dump -f /tmp/NAME` stages a fake dump carrying MARKER;
  # `cp <ctr>:/tmp/NAME <dest>` retrieves it; `exec ... rm -f` is a no-op.
  # Stub rclone: `copyto` stages into $SELFTEST_REMOTE_DIR; `check`
  # compares a source DIRECTORY against the remote prefix (all source files
  # must exist byte-identical remotely; `--one-way` ignores older extra
  # remote objects, without it extras also fail — parity with real rclone
  # directory semantics). Single-file `check <file> <remote:object>` is
  # retained only for parity. `lsf` retained for parity only — backup
  # verifies with directory `check --download --one-way`, never listings.
  # Modes via SELFTEST_RCLONE_MODE: ok | fail-put | fail-verify.
  cat > "$stubbin/docker" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
fake_cdir="${SELFTEST_FAKE_CONTAINER_DIR:-}"
if [ "$1" = "container" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  shift 2
  if [ "$1" = "pg_dump" ] && [ "${2:-}" = "--version" ]; then echo "pg_dump (PostgreSQL 17.5)"; exit 0; fi
  if [ "$1" = "pg_dump" ]; then
    out=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "-f" ]; then out="$a"; fi
      prev="$a"
    done
    printf 'SELFTEST_FAKE_DUMP\nMARKER=%s\n' "${SELFTEST_DUMP_MARKER:-nomarker}" > "$fake_cdir/$(basename "$out")"
    exit 0
  fi
  exit 0
fi
if [ "$1" = "cp" ]; then
  cp -f "$fake_cdir/$(basename "$2")" "$3"
  exit 0
fi
echo "stub-docker: unsupported: $*" >&2; exit 2
STUB
  cat > "$stubbin/rclone" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
mode="${SELFTEST_RCLONE_MODE:-ok}"
remote_dir="${SELFTEST_REMOTE_DIR:-}"
# Emulate R2 object-scoped token behaviour (official Cloudflare R2 rclone
# docs): without `no_check_bucket=true` the bucket check is rejected with
# 403 even when object puts would be allowed — so reject every op here
# unless the runtime config carries the flag. This makes the success path
# prove the wiring end to end, not just by grepping the script.
if [ "${RCLONE_CONFIG_INFISICALR2_NO_CHECK_BUCKET:-}" != "true" ]; then
  echo "stub-rclone: 403 without no_check_bucket (object-scoped token requires no_check_bucket=true)" >&2
  exit 1
fi
if [ "$1" = "copyto" ]; then
  [ "$mode" = "fail-put" ] && { echo "stub-rclone: simulated put failure" >&2; exit 1; }
  cp -f "$2" "$remote_dir/$(basename "$3")"
  exit 0
fi
if [ "$1" = "check" ]; then
  [ "$mode" = "fail-verify" ] && { echo "stub-rclone: simulated check failure" >&2; exit 1; }
  shift
  src=""; dst=""; oneway=0
  for a in "$@"; do
    case "$a" in
      --one-way) oneway=1 ;;
      -*) continue ;;
      *) if [ -z "$src" ]; then src="$a"; else dst="$a"; fi ;;
    esac
  done
  if [ -z "$src" ] || [ -z "$dst" ]; then echo "stub-rclone: check usage error" >&2; exit 2; fi
  if [ -d "$src" ]; then
    fail=0; n=0
    for sf in "$src"/*; do
      [ -e "$sf" ] || continue
      [ -f "$sf" ] || continue
      n=$((n + 1))
      name="$(basename "$sf")"
      if [ ! -f "$remote_dir/$name" ]; then echo "stub-rclone: check missing remote $name" >&2; fail=1; continue; fi
      if ! cmp -s "$sf" "$remote_dir/$name"; then echo "stub-rclone: check content differs: $name" >&2; fail=1; fi
    done
    if [ "$n" -eq 0 ]; then echo "stub-rclone: check empty source dir" >&2; exit 2; fi
    if [ "$oneway" -eq 0 ]; then
      for rf in "$remote_dir"/*; do
        [ -e "$rf" ] || continue
        rname="$(basename "$rf")"
        if [ ! -e "$src/$rname" ]; then echo "stub-rclone: check extra remote $rname" >&2; fail=1; fi
      done
    fi
    exit "$fail"
  fi
  name="$(basename "${dst:-}")"
  if [ -z "$src" ] || [ -z "$name" ]; then echo "stub-rclone: check usage error" >&2; exit 2; fi
  if [ ! -f "$remote_dir/$name" ]; then echo "stub-rclone: check missing remote $name" >&2; exit 1; fi
  if cmp -s "$src" "$remote_dir/$name"; then exit 0; fi
  echo "stub-rclone: check content differs: $name" >&2; exit 1
fi
if [ "$1" = "lsf" ]; then
  [ "$mode" = "fail-verify" ] && { echo "stub-rclone: simulated list failure" >&2; exit 1; }
  ( cd "$remote_dir" && ls -1 )
  exit 0
fi
echo "stub-rclone: unsupported args: $*" >&2; exit 2
STUB
  chmod +x "$stubbin/docker" "$stubbin/rclone"
  # Exported once (never via the `env` assignment strings below: this PATH
  # contains spaces on some hosts, which word-splitting would corrupt).
  export PATH="$stubbin:$PATH"

  # Temporary RSA pair (selftest-only; the real private key is never here).
  # A second pair proves a wrong private key cannot decrypt.
  privkey="$t/recovery.priv.pem"; pubkey="$t/recovery.pub.pem"
  node "$NODE_PUBCRYPTO" keygen "$(nodepath "$privkey")" "$(nodepath "$pubkey")" >/dev/null
  node "$NODE_PUBCRYPTO" keygen "$(nodepath "$t/wrong.priv.pem")" "$(nodepath "$t/wrong.pub.pem")" >/dev/null
  wrongpriv="$t/wrong.priv.pem"

  # Fake source env carrying a sentinel secret (must never leak).
  envfile="$t/.env.infisical"
  marker="SELFTEST_PLAINTEXT_$(date +%s%N)"
  printf 'ENCRYPTION_KEY=SELFTEST_SENTINEL_abc123\nAUTH_SECRET=SELFTEST_SENTINEL_def456\nDUMP_MARKER=%s\n' "$marker" > "$envfile"

  local passed=0 failed=0
  check() { # check <name> <expected-exit> <actual-exit>
    if [ "$2" = "$3" ]; then passed=$((passed + 1)); echo "SELFTEST PASS: $1";
    else failed=$((failed + 1)); echo "SELFTEST FAIL: $1 (expected exit $2, got $3)" >&2; fi
  }

  base_env="INFISICAL_BACKUP_DIR=$workdir INFISICAL_ENV_FILE=$envfile INFISICAL_BACKUP_PUBLIC_KEY_FILE=$pubkey"
  r2_env="INFISICAL_R2_ENDPOINT=https://stub.r2.cloudflarestorage.com INFISICAL_R2_BUCKET=stub-bucket INFISICAL_R2_PREFIX=infisical/ INFISICAL_R2_ACCESS_KEY_ID=stub-id INFISICAL_R2_SECRET_ACCESS_KEY=stub-secret"
  # Host-side runs NEVER see a private key: prove public-only encryption.
  no_priv="env -u INFISICAL_RECOVERY_PRIVATE_KEY_FILE"

  # 1. Missing config fails closed naming variables, leaking no values.
  set +e
  out="$($no_priv env -u INFISICAL_BACKUP_PUBLIC_KEY_FILE -u INFISICAL_R2_ENDPOINT -u INFISICAL_R2_BUCKET -u INFISICAL_R2_ACCESS_KEY_ID -u INFISICAL_R2_SECRET_ACCESS_KEY \
    INFISICAL_BACKUP_DIR="$workdir" INFISICAL_ENV_FILE="$envfile" \
    bash "$0" backup 2>&1)"; code="$?"
  set -e
  check "missing-config-fails-closed" 2 "$code"
  case "$out" in
    *INFISICAL_BACKUP_PUBLIC_KEY_FILE*INFISICAL_R2_ENDPOINT*) check "missing-config-names-vars" 0 0 ;;
    *) check "missing-config-names-vars" 0 1 ;;
  esac
  case "$out" in
    *SELFTEST_SENTINEL*|*"$marker"*) check "missing-config-no-secret-leak" 0 1 ;;
    *) check "missing-config-no-secret-leak" 0 0 ;;
  esac

  # 2. No symmetric-key dependency anywhere in this flow's CODE (doc mentions
  # in comments/HINT text are allowed; expansions or invocations are not).
  sym_hits="$(grep -v '^[[:space:]]*#' "$0" | grep -c 'backup-dr\.sh\|backup-crypto\.mjs\|\$[{]\?BACKUP_CRYPTO_KEY_FILE' || true)"
  { [ "$sym_hits" = "0" ]; } \
    && check "no-symmetric-key-dependency" 0 0 || check "no-symmetric-key-dependency" 0 1

  # 2b. OAEP-SHA256 is the actual padding: the helper must import the OAEP
  # constant (never the numeric `padding: 1` = PKCS#1 v1.5) and the backup
  # flow must verify with content comparison (`rclone check <dir>
  # <remote:prefix> --download --one-way`, scoped to the 4 just-uploaded
  # files so older prefix objects do not fail the comparison).
  { grep -q 'RSA_PKCS1_OAEP_PADDING' "${SCRIPT_DIR}/infisical-public-crypto.mjs" 2>/dev/null \
    || grep -q 'RSA_PKCS1_OAEP_PADDING' "$REPO_ROOT/scripts/infisical-public-crypto.mjs"; } \
    && check "oaep-constant-present" 0 0 || check "oaep-constant-present" 0 1
  mjs_path="${SCRIPT_DIR}/infisical-public-crypto.mjs"
  [ -f "$mjs_path" ] || mjs_path="$REPO_ROOT/scripts/infisical-public-crypto.mjs"
  { [ "$(grep -c 'padding: 1' "$mjs_path" || true)" = "0" ]; } \
    && check "no-numeric-pkcs1-padding" 0 0 || check "no-numeric-pkcs1-padding" 0 1
  { grep -q 'rclone check' "$0" && grep -q -- '--download' "$0"; } \
    && check "verify-uses-download-check" 0 0 || check "verify-uses-download-check" 0 1
  { grep -q -- '--one-way' "$0"; } \
    && check "verify-uses-one-way-check" 0 0 || check "verify-uses-one-way-check" 0 1
  # Verify staging cleanup must not interpolate the configurable work-dir
  # path into trap shell code (single-quote injection). Characterization:
  # trap takes a function name (execution-time quoted expansion) and the
  # function removes only the exact .verify-* staging dir.
  { grep -q 'trap cleanup_verify_dir EXIT INT TERM' "$0"; } \
    && check "verify-trap-uses-cleanup-fn" 0 0 || check "verify-trap-uses-cleanup-fn" 0 1
  { ! grep -q "trap \"rm -rf '\$verify_dir'\"" "$0"; } \
    && check "verify-trap-no-path-interpolation" 0 0 || check "verify-trap-no-path-interpolation" 0 1
  { grep -q 'rm -rf -- "$verify_dir"' "$0" && grep -q '"${work_dir%/}"/.verify-' "$0"; } \
    && check "verify-cleanup-guarded-to-staging-dir" 0 0 || check "verify-cleanup-guarded-to-staging-dir" 0 1
  # No ACL knob in CODE (comments may discuss the prohibition): R2 S3
  # compatibility does not support ACL operations and R2 objects are
  # private by default.
  { [ "$(grep -v '^[[:space:]]*#' "$0" | grep -c '_ACL'"=" || true)" = "0" ]; } \
    && check "no-acl-knob" 0 0 || check "no-acl-knob" 0 1
  # Object-scoped R2 token requires `no_check_bucket=true` (official
  # Cloudflare R2 rclone docs: bucket create/check calls are rejected with
  # 403 — `lsd` works but `PutObject` fails without the flag). Runtime
  # assertion, not grep-only: invoke the real `configure_rclone_env` and
  # inspect the exported runtime config. The stub rclone above additionally
  # rejects every op without the flag, so the success path itself proves
  # the wiring end to end.
  (
    export INFISICAL_R2_ENDPOINT="https://stub.r2.cloudflarestorage.com"
    export INFISICAL_R2_BUCKET="stub-bucket"
    export INFISICAL_R2_ACCESS_KEY_ID="stub-id"
    export INFISICAL_R2_SECRET_ACCESS_KEY="stub-secret"
    export INFISICAL_R2_REGION="auto"
    unset RCLONE_CONFIG_INFISICALR2_NO_CHECK_BUCKET
    configure_rclone_env
    [ "${RCLONE_CONFIG_INFISICALR2_NO_CHECK_BUCKET:-}" = "true" ]
  ) \
    && check "rclone-no-check-bucket-runtime" 0 0 || check "rclone-no-check-bucket-runtime" 0 1

  # 3. Upload failure keeps local ciphertext and exits nonzero.
  export SELFTEST_REMOTE_DIR="$remotedir" SELFTEST_RCLONE_MODE="fail-put"
  export SELFTEST_FAKE_CONTAINER_DIR="$fakecdir" SELFTEST_DUMP_MARKER="$marker"
  set +e
  out="$($no_priv env $base_env $r2_env SELFTEST_REMOTE_DIR="$remotedir" SELFTEST_RCLONE_MODE="fail-put" \
    SELFTEST_FAKE_CONTAINER_DIR="$fakecdir" SELFTEST_DUMP_MARKER="$marker" bash "$0" backup 2>&1)"; code="$?"
  set -e
  { [ "$code" -ne 0 ] && [ "$(ls -1 "$workdir"/*.dump.penc 2>/dev/null | wc -l | tr -d ' ')" -ge 1 ] \
    && [ "$(ls -1 "$workdir"/infisical-env-*.penc 2>/dev/null | wc -l | tr -d ' ')" -ge 1 ]; } \
    && check "upload-failure-keeps-ciphertext" 0 0 || check "upload-failure-keeps-ciphertext" 0 1
  case "$out" in
    *SELFTEST_SENTINEL*|*"$marker"*) check "failure-path-no-secret-leak" 0 1 ;;
    *) check "failure-path-no-secret-leak" 0 0 ;;
  esac
  rm -f "$workdir"/*.penc "$workdir"/*.penc.manifest.json

  # 4. Verify failure keeps local ciphertext and exits nonzero.
  set +e
  out="$($no_priv env $base_env $r2_env SELFTEST_REMOTE_DIR="$remotedir" SELFTEST_RCLONE_MODE="fail-verify" \
    SELFTEST_FAKE_CONTAINER_DIR="$fakecdir" SELFTEST_DUMP_MARKER="$marker" bash "$0" backup 2>&1)"; code="$?"
  set -e
  { [ "$code" -ne 0 ] && [ "$(ls -1 "$workdir"/infisical-env-*.penc 2>/dev/null | wc -l | tr -d ' ')" -ge 1 ]; } \
    && check "verify-failure-keeps-ciphertext" 0 0 || check "verify-failure-keeps-ciphertext" 0 1
  if ls -d "$workdir"/.verify-* 2>/dev/null | grep -q .; then
    check "verify-failure-no-verify-temp" 0 1
  else
    check "verify-failure-no-verify-temp" 0 0
  fi
  rm -rf "$remotedir"/* "$workdir"/*.penc "$workdir"/*.penc.manifest.json

  # 5. Success path with PUBLIC key only: 4 remote objects, no plaintext staged.
  set +e
  out="$($no_priv env $base_env $r2_env SELFTEST_REMOTE_DIR="$remotedir" SELFTEST_RCLONE_MODE="ok" \
    SELFTEST_FAKE_CONTAINER_DIR="$fakecdir" SELFTEST_DUMP_MARKER="$marker" bash "$0" backup 2>&1)"; code="$?"
  set -e
  check "success-path-exit-0" 0 "$code"
  n="$(ls -1 "$remotedir" 2>/dev/null | wc -l | tr -d ' ')"
  { [ "$n" = "4" ]; } && check "success-path-4-remote-objects" 0 0 || check "success-path-4-remote-objects" 0 1
  if grep -r "SELFTEST_SENTINEL" "$remotedir" "$workdir" --include='*.manifest.json' --include='*.json' >/dev/null 2>&1 \
     || printf '%s' "$out" | grep -q "SELFTEST_SENTINEL" \
     || grep -rl "$marker" "$remotedir" >/dev/null 2>&1; then
    check "success-path-no-secret-leak" 0 1
  else
    check "success-path-no-secret-leak" 0 0
  fi
  if ls "$workdir"/.plain-* "$workdir"/*.tmp "$workdir"/*.tmp.* 2>/dev/null | grep -q .; then
    check "success-path-no-plaintext-temp" 0 1
  else
    check "success-path-no-plaintext-temp" 0 0
  fi
  # Verify staging dir (ciphertext/manifests only) is always removed.
  if ls -d "$workdir"/.verify-* 2>/dev/null | grep -q .; then
    check "success-path-no-verify-temp" 0 1
  else
    check "success-path-no-verify-temp" 0 0
  fi
  # Source env file untouched (byte-identical, still present).
  if grep -q "SELFTEST_SENTINEL_abc123" "$envfile"; then check "source-env-untouched" 0 0;
  else check "source-env-untouched" 0 1; fi

  # 5b. Manifests carry the recipient public-key fingerprint so the operator
  # can select the matching local private key through rotation. The helper's
  # `fingerprint` subcommand must agree with the keygen-time PUBLIC SHA256.
  fp_expect="$(node "$NODE_PUBCRYPTO" fingerprint "$(nodepath "$pubkey")")"
  if grep -q "$fp_expect" "$workdir"/*.dump.penc.manifest.json \
     && grep -q "$fp_expect" "$workdir"/infisical-env-*.penc.manifest.json; then
    check "manifests-carry-pub-fingerprint" 0 0
  else
    check "manifests-carry-pub-fingerprint" 0 1
  fi

  # 5c. keygen and encrypt fail closed on existing outputs (never silently
  # replace a needed decryption key or a previous ciphertext).
  set +e
  node "$NODE_PUBCRYPTO" keygen "$(nodepath "$privkey")" "$(nodepath "$pubkey")" >/dev/null 2>&1; code="$?"
  set -e
  check "keygen-refuses-overwrite" 1 "$code"
  existing_enc="$(ls -1t "$workdir"/*.dump.penc | head -1)"
  existing_sha="$(sha256sum "$existing_enc" | awk '{print $1}')"
  set +e
  node "$NODE_PUBCRYPTO" encrypt "$(nodepath "$pubkey")" "$(nodepath "$envfile")" "$(nodepath "$existing_enc")" >/dev/null 2>&1; code="$?"
  set -e
  { [ "$code" -ne 0 ] && [ "$(sha256sum "$existing_enc" | awk '{print $1}')" = "$existing_sha" ]; } \
    && check "encrypt-refuses-overwrite" 0 0 || check "encrypt-refuses-overwrite" 0 1

  # 5c-i. Hardening (exclusive staging + atomic no-clobber publish): keygen
  # with a fresh private path but an EXISTING public path fails closed and
  # leaves no fresh private half behind (only newly created partials are
  # ever removed; the pre-existing public key is byte-identical).
  pub_before="$(sha256sum "$pubkey" | awk '{print $1}')"
  set +e
  node "$NODE_PUBCRYPTO" keygen "$(nodepath "$t/fresh.priv.pem")" "$(nodepath "$pubkey")" >/dev/null 2>&1; code="$?"
  set -e
  { [ "$code" -ne 0 ] && [ ! -e "$t/fresh.priv.pem" ] && [ "$(sha256sum "$pubkey" | awk '{print $1}')" = "$pub_before" ]; } \
    && check "keygen-partial-cleanup-no-leftover" 0 0 || check "keygen-partial-cleanup-no-leftover" 0 1
  # Refusals leave no staging temps behind (random exclusive temps are
  # unlinked on every failure path).
  { [ -z "$(ls "$workdir"/*.tmp.* 2>/dev/null)" ] && [ -z "$(ls "$t"/*.tmp.* 2>/dev/null)" ]; } \
    && check "refusal-no-tmp-leftover" 0 0 || check "refusal-no-tmp-leftover" 0 1
  # Static pins: staging must be exclusive (`wx` + random suffix via
  # makeTempPath) and publish must be no-clobber link (closes the
  # exists-check/rename race on POSIX and Windows).
  { grep -q 'linkSync' "$mjs_path" && grep -q '"wx"' "$mjs_path" && grep -q 'makeTempPath' "$mjs_path"; } \
    && check "crypto-uses-exclusive-tmp-and-noclobber-publish" 0 0 || check "crypto-uses-exclusive-tmp-and-noclobber-publish" 0 1

  # 5d. Second run mints distinct filenames (timestamp + random suffix):
  # no same-second overwrite of the first run's objects.
  first_dump="$(basename "$(ls -1t "$workdir"/*.dump.penc | head -1)")"
  first_env="$(basename "$(ls -1t "$workdir"/infisical-env-*.penc | head -1)")"
  set +e
  $no_priv env $base_env $r2_env SELFTEST_REMOTE_DIR="$remotedir" SELFTEST_RCLONE_MODE="ok" \
    SELFTEST_FAKE_CONTAINER_DIR="$fakecdir" SELFTEST_DUMP_MARKER="$marker" bash "$0" backup >/dev/null 2>&1; code="$?"
  set -e
  second_dump="$(basename "$(ls -1t "$workdir"/*.dump.penc | head -1)")"
  second_env="$(basename "$(ls -1t "$workdir"/infisical-env-*.penc | head -1)")"
  { [ "$code" -eq 0 ] && [ "$first_dump" != "$second_dump" ] && [ "$first_env" != "$second_env" ]; } \
    && check "unique-filenames-per-run" 0 0 || check "unique-filenames-per-run" 0 1

  # 6. Private key restores both archives byte-identical (hash equality).
  dump_penc="$(ls -1t "$remotedir"/infisical-*.dump.penc | head -1)"
  env_penc="$(ls -1t "$remotedir"/infisical-env-*.penc | head -1)"
  export INFISICAL_RECOVERY_PRIVATE_KEY_FILE="$(nodepath "$privkey")"
  node "$NODE_PUBCRYPTO" decrypt "$(nodepath "$dump_penc")" "$(nodepath "$t/restored.dump")" >/dev/null
  node "$NODE_PUBCRYPTO" decrypt "$(nodepath "$env_penc")" "$(nodepath "$t/restored.env")" >/dev/null
  if grep -q "$marker" "$t/restored.dump"; then check "private-key-restores-dump" 0 0;
  else check "private-key-restores-dump" 0 1; fi
  if cmp -s "$envfile" "$t/restored.env"; then check "private-key-restores-env-identical" 0 0;
  else check "private-key-restores-env-identical" 0 1; fi

  # 7. Wrong private key and tampered ciphertext both fail closed. Decrypt
  # also refuses to overwrite an existing plaintext output.
  set +e
  INFISICAL_RECOVERY_PRIVATE_KEY_FILE="$(nodepath "$wrongpriv")" node "$NODE_PUBCRYPTO" decrypt "$(nodepath "$dump_penc")" "$(nodepath "$t/wrong.out")" >/dev/null 2>&1; code="$?"
  set -e
  check "wrong-private-key-fails" 1 "$code"
  cp "$dump_penc" "$t/tampered.penc"
  node -e "const fs=require('fs');const p='$(nodepath "$t/tampered.penc")';const b=fs.readFileSync(p);b[b.length-1]^=0x01;fs.writeFileSync(p,b)"
  set +e
  INFISICAL_RECOVERY_PRIVATE_KEY_FILE="$(nodepath "$privkey")" node "$NODE_PUBCRYPTO" decrypt "$(nodepath "$t/tampered.penc")" "$(nodepath "$t/tampered.out")" >/dev/null 2>&1; code="$?"
  set -e
  check "tampered-ciphertext-fails" 1 "$code"
  set +e
  INFISICAL_RECOVERY_PRIVATE_KEY_FILE="$(nodepath "$privkey")" node "$NODE_PUBCRYPTO" decrypt "$(nodepath "$dump_penc")" "$(nodepath "$t/restored.dump")" >/dev/null 2>&1; code="$?"
  set -e
  check "decrypt-refuses-overwrite" 1 "$code"

  # 8. OAEP-SHA256 is proven BEHAVIORALLY on the live envelope (not just by
  # constant name). (a) OAEP/sha256 unwraps to the 32-byte DEK while the same
  # block under PKCS#1 v1.5 either throws or yields non-DEK garbage — a true
  # PKCS#1 wrap would return this exact DEK under padding:1. (b) OAEP with
  # the wrong hash (sha1) is rejected — pins SHA-256, not just any OAEP.
  # NOTE: PKCS#1 "success" here is not a flaw: this runtime's PKCS#1 decoder
  # accepts the OAEP block's leading-zero structure and returns
  # unauthenticated garbage, so the test compares against the DEK instead of
  # assuming rejection.
  set +e
  node -e "const fs=require('fs'),crypto=require('crypto');const b=fs.readFileSync('$(nodepath "$dump_penc")');const wl=b.readUInt16BE(5);const w=b.subarray(7,7+wl);const priv=fs.readFileSync('$(nodepath "$privkey")','utf8');const dek=crypto.privateDecrypt({key:priv,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},w);if(dek.length!==32){console.error('unexpected DEK length');process.exit(2);}let p1;try{p1=crypto.privateDecrypt({key:priv,padding:crypto.constants.RSA_PKCS1_PADDING},w);}catch(e){console.log('OAEP-PROVEN (PKCS1 decode rejected)');process.exit(0);}if(p1.equals(dek)){console.error('WRAP-IS-PKCS1');process.exit(1);}console.log('OAEP-PROVEN (PKCS1 yields non-DEK garbage)');" >/dev/null 2>&1; code="$?"
  set -e
  check "oaep-wrap-proven" 0 "$code"
  set +e
  node -e "const fs=require('fs'),crypto=require('crypto');const b=fs.readFileSync('$(nodepath "$dump_penc")');const wl=b.readUInt16BE(5);const w=b.subarray(7,7+wl);const priv=fs.readFileSync('$(nodepath "$privkey")','utf8');crypto.privateDecrypt({key:priv,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha1'},w);" >/dev/null 2>&1; code="$?"
  set -e
  check "oaep-wrong-hash-rejected" 1 "$code"

  # 9. The integrity path compares BYTES, not names, via a directory
  # `rclone check <verify_dir> <remote:prefix> --download --one-way`
  # scoped to exactly the 4 just-uploaded files: older prefix objects must
  # not fail the comparison, while tampering ANY of the 4 objects must.
  latest_dump="$(ls -1t "$workdir"/*.dump.penc | head -1)"
  latest_env="$(ls -1t "$workdir"/infisical-env-*.penc | head -1)"
  verify_probe="$(mktemp -d "$t/verifyprobe-XXXXXX")"
  cp -f -- "$latest_dump" "${latest_dump}.manifest.json" "$latest_env" "${latest_env}.manifest.json" "$verify_probe/"
  set +e
  PATH="$stubbin:$PATH" SELFTEST_REMOTE_DIR="$remotedir" RCLONE_CONFIG_INFISICALR2_NO_CHECK_BUCKET="true" rclone check "$verify_probe" "infisicalr2:stub-bucket/infisical/" --download --one-way >/dev/null 2>&1; code="$?"
  set -e
  check "directory-check-ignores-older-prefix-objects" 0 "$code"
  # Tamper the dump ciphertext remotely: directory check must fail.
  node -e "const fs=require('fs');const p='$(nodepath "$remotedir")/'+require('path').basename('$(nodepath "$dump_penc")');const b=fs.readFileSync(p);b[b.length-1]^=0x01;fs.writeFileSync(p,b)"
  set +e
  PATH="$stubbin:$PATH" SELFTEST_REMOTE_DIR="$remotedir" RCLONE_CONFIG_INFISICALR2_NO_CHECK_BUCKET="true" rclone check "$verify_probe" "infisicalr2:stub-bucket/infisical/" --download --one-way >/dev/null 2>&1; code="$?"
  set -e
  check "remote-tamper-check-fails" 1 "$code"
  # Restore the dump, then tamper a manifest instead: any object tampers fail.
  cp -f -- "$verify_probe/$(basename "$dump_penc")" "$remotedir/$(basename "$dump_penc")"
  node -e "const fs=require('fs');const p='$(nodepath "$remotedir")/'+require('path').basename('$(nodepath "$dump_penc")')+'.manifest.json';const b=fs.readFileSync(p);b[b.length-1]^=0x01;fs.writeFileSync(p,b)"
  set +e
  PATH="$stubbin:$PATH" SELFTEST_REMOTE_DIR="$remotedir" RCLONE_CONFIG_INFISICALR2_NO_CHECK_BUCKET="true" rclone check "$verify_probe" "infisicalr2:stub-bucket/infisical/" --download --one-way >/dev/null 2>&1; code="$?"
  set -e
  check "remote-manifest-tamper-check-fails" 1 "$code"
  rm -rf -- "$verify_probe"

  echo "SELFTEST: ${passed} passed, ${failed} failed"
  [ "$failed" -eq 0 ]
}

cmd="${1:-usage}"
case "$cmd" in
  backup) shift; cmd_backup "$@" ;;
  selftest) shift; cmd_selftest "$@" ;;
  *) cat >&2 <<'EOF'
usage: infisical-backup.sh (backup|selftest)
  backup    public-key dump + encrypted .env copy -> R2 via rclone (host-only)
  selftest  stubbed checks: fail-closed config, no symmetric dependency,
            OAEP-SHA256 padding + no ACL knob + no_check_bucket runtime,
            upload/verify failure,
            public-only encrypt + private restore, overwrite refusals +
            keygen partial cleanup + no tmp leftovers + exclusive staging
            (wx/random) with no-clobber link publish (static pin),
            pub fingerprint in manifests, unique per-run names,
            wrong-key/tamper rejection, PKCS#1 unwrap rejection,
            remote byte/manifest-tamper detected by directory check
            --download --one-way (scoped to 4, older prefix ignored), no leaks
EOF
    exit 2 ;;
esac
