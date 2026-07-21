#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# pg_dump → S3 / Supabase Storage backup
#
# Automatic production targets:
#   backup.sh main-full       — main Postgres + cluster roles in one tar
#   backup.sh instantly-full  — instantly + instantly_dataset + roles in one tar
#
# Legacy/manual production-only single-database targets are kept for compatibility:
#   main-supabase | instantly-prod | instantly-dataset
#
# Upload priority:
#   1. S3 (via mc) — if BACKUP_S3_ENDPOINT + credentials are set
#   2. Supabase Storage (via curl) — if BACKUP_SUPABASE_URL + key are set
#   3. Skip upload, keep local dump only
#
# S3 layout  (<BACKUP_S3_BUCKET>):
#   portal-main/full/portal-main-main-full-<TS>.tar
#   instantly/full/instantly-instantly-full-<TS>.tar
#   portal-main/portal-main-main-supabase-<TS>.dump
#   instantly/prod/instantly-instantly-prod-<TS>.dump
#   instantly/dataset/instantly-instantly-dataset-<TS>.dump
#
# Supabase layout (<BACKUP_BUCKET>, default db-backups):
#   Same subpaths as S3.
# ──────────────────────────────────────────────────────────────────────────────

set -u

INSTANCE="${1:-}"
if [ -z "$INSTANCE" ]; then
  echo "Usage: backup.sh <main-full|instantly-full|main-supabase|instantly-prod|instantly-dataset>" >&2
  exit 1
fi

TS=$(date -u +%Y%m%d_%H%M%S)
DUMP_DIR="${DUMP_DIR:-/backups}"
mkdir -p "$DUMP_DIR" 2>/dev/null || {
  echo "[backup] ERROR: cannot create DUMP_DIR=$DUMP_DIR" >&2
  exit 1
}

# ─── Telegram alerts ─────────────────────────────────────────────────────────

send_alert() {
  msg="$1"
  if [ -z "${TELEGRAM_HEALTH_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_HEALTH_CHAT_ID:-}" ]; then
    return 0
  fi
  curl -sS -o /dev/null --max-time 15 \
    "https://api.telegram.org/bot${TELEGRAM_HEALTH_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_HEALTH_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    --data-urlencode "parse_mode=HTML" \
    >/dev/null 2>&1 || true
}

# ─── Resolve URL + storage layout per instance ───────────────────────────────

PG_CONN_URL=""
EXTRA_PG_DUMP_OPTS=""
PREFIX=""
SUBPATH=""
BACKUP_MODE="single"
FILE_EXT="dump"
BUNDLE_DIR=""
MC_LOG=""

cleanup_temp() {
  if [ -n "$BUNDLE_DIR" ] && [ -d "$BUNDLE_DIR" ]; then
    rm -rf "$BUNDLE_DIR"
  fi
  if [ -n "$MC_LOG" ] && [ -f "$MC_LOG" ]; then
    rm -f "$MC_LOG"
  fi
}
trap cleanup_temp EXIT
trap 'exit 130' INT TERM

case "$INSTANCE" in
  main-full)
    PG_CONN_URL="${MAIN_SUPABASE_DATABASE_URL:-${DATABASE_URL:-}}"
    if [ -z "$PG_CONN_URL" ]; then
      echo "[backup] MAIN_SUPABASE_DATABASE_URL/DATABASE_URL is empty; cannot create main-full bundle." >&2
      exit 1
    fi
    PREFIX="portal-main"
    SUBPATH="portal-main/full"
    BACKUP_MODE="main-bundle"
    FILE_EXT="tar"
    ;;
  instantly-full)
    PG_CONN_URL="${INSTANTLY_DATABASE_URL:-}"
    if [ -z "$PG_CONN_URL" ] || [ -z "${INSTANTLY_DATASET_DATABASE_URL:-}" ]; then
      echo "[backup] INSTANTLY_DATABASE_URL and INSTANTLY_DATASET_DATABASE_URL are both required for instantly-full." >&2
      exit 1
    fi
    PREFIX="instantly"
    SUBPATH="instantly/full"
    BACKUP_MODE="instantly-bundle"
    FILE_EXT="tar"
    ;;
  main-supabase)
    PG_CONN_URL="${MAIN_SUPABASE_DATABASE_URL:-${DATABASE_URL:-}}"
    if [ -z "$PG_CONN_URL" ]; then
      echo "[backup] MAIN_SUPABASE_DATABASE_URL/DATABASE_URL is empty, skipping main-supabase backup."
      exit 0
    fi
    PREFIX="portal-main"
    SUBPATH="portal-main"
    EXTRA_PG_DUMP_OPTS="\
      --exclude-schema=_supavisor \
      --exclude-schema=_realtime \
      --exclude-schema=_analytics \
      --exclude-schema=pgsodium \
      --exclude-schema=pgsodium_masks \
      --exclude-schema=vault \
      --exclude-schema=supabase_functions \
      --exclude-schema=supabase_migrations \
      --exclude-schema=pgbouncer \
      --exclude-schema=net \
      --exclude-schema=cron \
      --exclude-schema=graphql \
      --exclude-schema=graphql_public \
      --exclude-schema=extensions"
    ;;
  instantly-prod)
    PG_CONN_URL="${INSTANTLY_DATABASE_URL:-}"
    if [ -z "$PG_CONN_URL" ]; then
      echo "[backup] INSTANTLY_DATABASE_URL is empty, skipping instantly-prod backup."
      exit 0
    fi
    PREFIX="instantly"
    SUBPATH="instantly/prod"
    ;;
  instantly-dataset)
    PG_CONN_URL="${INSTANTLY_DATASET_DATABASE_URL:-}"
    if [ -z "$PG_CONN_URL" ]; then
      echo "[backup] INSTANTLY_DATASET_DATABASE_URL is empty, skipping instantly-dataset backup."
      exit 0
    fi
    PREFIX="instantly"
    SUBPATH="instantly/dataset"
    ;;
  *)
    echo "[backup] Unknown instance: $INSTANCE" >&2
    exit 1
    ;;
esac

DUMP_FILE="${DUMP_DIR}/${PREFIX}-${INSTANCE}-${TS}.${FILE_EXT}"

# ─── TCP keep-alive for long COPY operations ─────────────────────────────────
# Production URLs are local to the DB host, but keep-alive also protects manual
# remote runs and long copies from idle connection timeouts. External values
# override these libpq defaults.
export PGKEEPALIVES="${PGKEEPALIVES:-1}"
export PGKEEPALIVES_IDLE="${PGKEEPALIVES_IDLE:-60}"
export PGKEEPALIVES_INTERVAL="${PGKEEPALIVES_INTERVAL:-10}"
export PGKEEPALIVES_COUNT="${PGKEEPALIVES_COUNT:-6}"

# ─── Dump helpers with retries ───────────────────────────────────────────────

PG_DUMP_MAX_TRIES="${BACKUP_PG_DUMP_RETRIES:-3}"
PG_DUMP_RETRY_PAUSE="${BACKUP_PG_DUMP_RETRY_PAUSE:-30}"

run_pg_dump_retry() {
  label="$1"
  url="$2"
  outfile="$3"
  preserve_ownership="$4"
  shift 4

  attempt=1
  rc=0
  while [ "$attempt" -le "$PG_DUMP_MAX_TRIES" ]; do
    if [ "$attempt" -gt 1 ]; then
      echo "[backup] pg_dump attempt ${attempt}/${PG_DUMP_MAX_TRIES} (${label})"
    fi

    if [ "$preserve_ownership" = "true" ]; then
      pg_dump \
        --dbname="$url" \
        --format=custom \
        --compress=6 \
        "$@" \
        --file="$outfile"
    else
      pg_dump \
        --dbname="$url" \
        --format=custom \
        --compress=6 \
        --no-owner \
        --no-privileges \
        "$@" \
        --file="$outfile"
    fi
    rc=$?
    if [ "$rc" -eq 0 ] && [ -s "$outfile" ]; then
      return 0
    fi
    if [ "$rc" -eq 0 ]; then
      rc=1
      echo "[backup] pg_dump produced an empty file for ${label}." >&2
    fi

    if [ "$attempt" -lt "$PG_DUMP_MAX_TRIES" ]; then
      pause=$((PG_DUMP_RETRY_PAUSE * attempt))
      echo "[backup] pg_dump failed for ${label} (rc=${rc}), retrying in ${pause}s..." >&2
      rm -f "$outfile"
      sleep "$pause"
    fi
    attempt=$((attempt + 1))
  done

  msg="🚨 [backup ${INSTANCE}] pg_dump FAILED for ${label} after ${PG_DUMP_MAX_TRIES} tries (rc=${rc})"
  echo "$msg" >&2
  send_alert "$msg"
  return "$rc"
}

run_globals_retry() {
  label="$1"
  url="$2"
  outfile="$3"
  without_passwords="$4"

  attempt=1
  rc=0
  while [ "$attempt" -le "$PG_DUMP_MAX_TRIES" ]; do
    if [ "$attempt" -gt 1 ]; then
      echo "[backup] pg_dumpall attempt ${attempt}/${PG_DUMP_MAX_TRIES} (${label})"
    fi

    if [ "$without_passwords" = "true" ]; then
      pg_dumpall --dbname="$url" --globals-only --no-role-passwords --file="$outfile"
    else
      pg_dumpall --dbname="$url" --globals-only --file="$outfile"
    fi
    rc=$?
    if [ "$rc" -eq 0 ] && [ -s "$outfile" ]; then
      return 0
    fi
    if [ "$rc" -eq 0 ]; then
      rc=1
      echo "[backup] pg_dumpall produced an empty file for ${label}." >&2
    fi

    if [ "$attempt" -lt "$PG_DUMP_MAX_TRIES" ]; then
      pause=$((PG_DUMP_RETRY_PAUSE * attempt))
      echo "[backup] pg_dumpall failed for ${label} (rc=${rc}), retrying in ${pause}s..." >&2
      rm -f "$outfile"
      sleep "$pause"
    fi
    attempt=$((attempt + 1))
  done

  msg="🚨 [backup ${INSTANCE}] pg_dumpall FAILED for ${label} after ${PG_DUMP_MAX_TRIES} tries (rc=${rc})"
  echo "$msg" >&2
  send_alert "$msg"
  return "$rc"
}

create_bundle() {
  bundle_kind="$1"
  BUNDLE_DIR=$(mktemp -d "${DUMP_DIR}/.${INSTANCE}-${TS}.XXXXXX") || return 1
  chmod 700 "$BUNDLE_DIR" || return $?

  restore_script="${BACKUP_RESTORE_SCRIPT:-/restore-bundle.sh}"
  if [ ! -f "$restore_script" ]; then
    echo "[backup] FATAL: restore script not found: $restore_script" >&2
    return 1
  fi
  cp "$restore_script" "$BUNDLE_DIR/restore-bundle.sh" || return $?
  chmod +x "$BUNDLE_DIR/restore-bundle.sh" || return $?

  case "$bundle_kind" in
    main)
      run_globals_retry main-pre "$PG_CONN_URL" "$BUNDLE_DIR/main-globals-pre.sql" true || return $?
      run_globals_retry main "$PG_CONN_URL" "$BUNDLE_DIR/main-globals.sql" false || return $?
      run_pg_dump_retry main-postgres "$PG_CONN_URL" "$BUNDLE_DIR/main-postgres.dump" true || return $?
      cat > "$BUNDLE_DIR/manifest.txt" <<EOF
bundle_version=1
bundle_type=main
created_at_utc=${TS}
databases=postgres
contains_roles=true
dev_databases_included=false
restore=./restore-bundle.sh main main-postgres
EOF
      [ -s "$BUNDLE_DIR/manifest.txt" ] || return 1
      ;;
    instantly)
      run_globals_retry instantly-pre "$PG_CONN_URL" "$BUNDLE_DIR/instantly-globals-pre.sql" true || return $?
      run_globals_retry instantly "$PG_CONN_URL" "$BUNDLE_DIR/instantly-globals.sql" false || return $?
      run_pg_dump_retry instantly "$PG_CONN_URL" "$BUNDLE_DIR/instantly.dump" true || return $?
      run_pg_dump_retry instantly_dataset "$INSTANTLY_DATASET_DATABASE_URL" "$BUNDLE_DIR/instantly_dataset.dump" true || return $?
      cat > "$BUNDLE_DIR/manifest.txt" <<EOF
bundle_version=1
bundle_type=instantly
created_at_utc=${TS}
databases=instantly,instantly_dataset
contains_roles=true
dev_databases_included=false
restore=./restore-bundle.sh instantly instantly-postgres-prod
EOF
      [ -s "$BUNDLE_DIR/manifest.txt" ] || return 1
      ;;
    *) return 1 ;;
  esac

  echo "[backup] Packing ${bundle_kind} bundle -> ${DUMP_FILE}"
  tar -cf "$DUMP_FILE" -C "$BUNDLE_DIR" . || return $?
  chmod 600 "$DUMP_FILE" || return $?
  rm -rf "$BUNDLE_DIR"
  BUNDLE_DIR=""
}

echo "[backup] Starting ${BACKUP_MODE} for ${INSTANCE} -> ${DUMP_FILE}"

case "$BACKUP_MODE" in
  main-bundle)
    create_bundle main || exit 1
    ;;
  instantly-bundle)
    create_bundle instantly || exit 1
    ;;
  single)
    if [ "$INSTANCE" = "main-supabase" ]; then
      # shellcheck disable=SC2086
      run_pg_dump_retry "$INSTANCE" "$PG_CONN_URL" "$DUMP_FILE" false $EXTRA_PG_DUMP_OPTS || exit 1
    else
      run_pg_dump_retry "$INSTANCE" "$PG_CONN_URL" "$DUMP_FILE" false || exit 1
    fi
    ;;
esac

DUMP_SIZE=$(stat -c '%s' "$DUMP_FILE" 2>/dev/null || stat -f '%z' "$DUMP_FILE" 2>/dev/null || echo '?')
echo "[backup] Dump complete: ${DUMP_FILE} (${DUMP_SIZE} bytes)"

# ─── Resolve storage backend ─────────────────────────────────────────────────
# BACKUP_S3_* take priority; fall back to MAIN_S3_* from .env.

S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-${MAIN_S3_ENDPOINT:-}}"
S3_BUCKET="${BACKUP_S3_BUCKET:-${MAIN_S3_BUCKET:-}}"
S3_ACCESS_KEY="${BACKUP_S3_ACCESS_KEY_ID:-${MAIN_S3_ACCESS_KEY_ID:-}}"
S3_SECRET_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-${MAIN_S3_SECRET_ACCESS_KEY:-}}"
S3_REGION="${BACKUP_S3_REGION:-${MAIN_S3_REGION:-us-east-1}}"

BACKUP_BUCKET="${BACKUP_BUCKET:-db-backups}"

upload_failed=0
UPLOAD_BACKEND="none"
FILENAME="${PREFIX}-${INSTANCE}-${TS}.${FILE_EXT}"

# ─── Upload: S3 via mc (primary) ─────────────────────────────────────────────

if [ -n "$S3_ENDPOINT" ] && [ -n "$S3_BUCKET" ] && [ -n "$S3_ACCESS_KEY" ] && [ -n "$S3_SECRET_KEY" ] && command -v mc >/dev/null 2>&1; then
  UPLOAD_BACKEND="s3"
  REMOTE_PATH="${S3_BUCKET}/${SUBPATH}/${FILENAME}"
  echo "[backup] Uploading to S3: ${S3_ENDPOINT}/${REMOTE_PATH}"

  # Stderr mc больше НЕ глушим: без него причина (AccessDenied / SignatureDoesNotMatch /
  # EntityTooLarge / NoSuchBucket / RequestTimeout / quota) не попадала ни в логи
  # контейнера, ни в Telegram-алерт — оставались только "rc=1".
  MC_LOG="$(mktemp)"

  alias_rc=0
  mc alias set backup "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" --api s3v4 >>"$MC_LOG" 2>&1 || alias_rc=$?
  if [ "$alias_rc" -ne 0 ]; then
    alias_tail=$(tail -n 5 "$MC_LOG" | tr '\n' ' ' | cut -c1-500)
    msg="🚨 [backup ${INSTANCE}] mc alias set FAILED (rc=${alias_rc}) for ${S3_ENDPOINT}: ${alias_tail}"
    echo "$msg" >&2
    send_alert "$msg"
    upload_failed=1
  else
    MC_ENV="MC_REGION=${S3_REGION}"

    # Ретраи multipart upload. На TWC видели транзиентные «икоты» по 5–10s
    # на служебных запросах (Initiate/Complete) — без ретрая один такой обрыв
    # роняет весь дамп. 3 попытки с экспоненциальной паузой = ~45s суммарно
    # в худшем случае, что укладывается в окно cron (раз в 6 часов).
    UPLOAD_MAX_TRIES="${BACKUP_S3_UPLOAD_RETRIES:-3}"
    UPLOAD_RETRY_PAUSE="${BACKUP_S3_UPLOAD_RETRY_PAUSE:-15}"
    mc_rc=0
    attempt=1
    while [ "$attempt" -le "$UPLOAD_MAX_TRIES" ]; do
      echo "[backup] mc cp attempt ${attempt}/${UPLOAD_MAX_TRIES}" >>"$MC_LOG"
      mc_rc=0
      env $MC_ENV mc cp "$DUMP_FILE" "backup/${REMOTE_PATH}" >>"$MC_LOG" 2>&1 || mc_rc=$?
      if [ "$mc_rc" -eq 0 ]; then
        break
      fi
      if [ "$attempt" -lt "$UPLOAD_MAX_TRIES" ]; then
        pause=$((UPLOAD_RETRY_PAUSE * attempt))
        echo "[backup] mc cp failed (rc=${mc_rc}), retrying in ${pause}s..." | tee -a "$MC_LOG" >&2
        sleep "$pause"
      fi
      attempt=$((attempt + 1))
    done

    if [ "$mc_rc" -eq 0 ]; then
      if [ "$attempt" -gt 1 ]; then
        echo "[backup] S3 upload OK on attempt ${attempt}/${UPLOAD_MAX_TRIES}"
      else
        echo "[backup] S3 upload OK"
      fi
    else
      # Берём последние ~5 строк stderr — там обычно код ошибки и URL запроса.
      mc_tail=$(tail -n 5 "$MC_LOG" | tr '\n' ' ' | cut -c1-500)
      msg="🚨 [backup ${INSTANCE}] S3 upload FAILED after ${UPLOAD_MAX_TRIES} tries (rc=${mc_rc} size=${DUMP_SIZE}) for ${REMOTE_PATH}: ${mc_tail}"
      echo "$msg" >&2
      echo "[backup] mc stderr (full):" >&2
      cat "$MC_LOG" >&2 || true
      send_alert "$msg"
      upload_failed=1
    fi
  fi

# ─── Upload: Supabase Storage via curl (fallback) ────────────────────────────

elif [ -n "${BACKUP_SUPABASE_URL:-}" ] && [ -n "${BACKUP_SUPABASE_KEY:-}" ]; then
  UPLOAD_BACKEND="supabase"
  REMOTE_PATH="${BACKUP_BUCKET}/${SUBPATH}/${FILENAME}"
  echo "[backup] Uploading to Supabase Storage: ${REMOTE_PATH}"

  curl_rc=0
  HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 600 \
    -X POST "${BACKUP_SUPABASE_URL}/storage/v1/object/${REMOTE_PATH}" \
    -H "Authorization: Bearer ${BACKUP_SUPABASE_KEY}" \
    -H 'Content-Type: application/octet-stream' \
    -H 'x-upsert: true' \
    -T "${DUMP_FILE}") || curl_rc=$?

  case "$HTTP_CODE" in
    200|201)
      echo "[backup] Upload OK (HTTP ${HTTP_CODE})"
      ;;
    *)
      msg="🚨 [backup ${INSTANCE}] Upload FAILED (HTTP ${HTTP_CODE} rc=${curl_rc} size=${DUMP_SIZE}) for ${REMOTE_PATH}"
      echo "$msg" >&2
      send_alert "$msg"
      upload_failed=1
      ;;
  esac
else
  echo "[backup] No upload backend configured (S3 or Supabase Storage), keeping local dump only."
fi

# ─── Remote cleanup ──────────────────────────────────────────────────────────

cleanup_remote() {
  if [ "$upload_failed" = 1 ]; then
    echo "[backup] Skipping remote cleanup because upload failed"
    return 0
  fi

  retention_days="${BACKUP_REMOTE_RETENTION_DAYS:-30}"

  # ── S3 cleanup via mc ──
  if [ "$UPLOAD_BACKEND" = "s3" ]; then
    echo "[backup] S3 cleanup: removing dumps older than ${retention_days}d in ${SUBPATH}/..."
    mc rm --recursive --force --older-than "${retention_days}d" "backup/${S3_BUCKET}/${SUBPATH}/" 2>/dev/null || true
    echo "[backup] S3 cleanup done"
    return 0
  fi

  # ── Supabase Storage cleanup via curl ──
  if [ "$UPLOAD_BACKEND" = "supabase" ]; then
    if [ -z "${BACKUP_SUPABASE_URL:-}" ] || [ -z "${BACKUP_SUPABASE_KEY:-}" ]; then
      return 0
    fi

    echo "[backup] Cleaning remote dumps older than ${retention_days} days in ${SUBPATH}/..."

    list_response=$(mktemp)
    list_code=$(curl -sS -o "$list_response" -w '%{http_code}' --max-time 30 \
      -X POST "${BACKUP_SUPABASE_URL}/storage/v1/object/list/${BACKUP_BUCKET}" \
      -H "Authorization: Bearer ${BACKUP_SUPABASE_KEY}" \
      -H 'Content-Type: application/json' \
      --data "{\"prefix\":\"${SUBPATH}\",\"limit\":1000,\"sortBy\":{\"column\":\"created_at\",\"order\":\"asc\"}}")

    if [ "$list_code" != "200" ]; then
      msg="⚠️ [backup ${INSTANCE}] list FAILED (HTTP ${list_code}); skipping cleanup"
      echo "$msg" >&2
      send_alert "$msg"
      rm -f "$list_response"
      return 0
    fi

    cutoff=$(date -u -d "${retention_days} days ago" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || \
             date -u -v-"${retention_days}"d '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo '')
    if [ -z "$cutoff" ]; then
      echo "[backup] WARNING: cannot compute cutoff date, skipping remote cleanup"
      rm -f "$list_response"
      return 0
    fi

    tr '}' '\n' < "$list_response" | while IFS= read -r line; do
      name=$(echo "$line" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
      created=$(echo "$line" | sed -n 's/.*"created_at":"\([^"]*\)".*/\1/p')
      if [ -z "$name" ] || [ -z "$created" ]; then
        continue
      fi
      if [ "$created" \< "$cutoff" ]; then
        remote="${BACKUP_BUCKET}/${SUBPATH}/${name}"
        echo "[backup] Removing old object: ${remote} (created=${created})"
        del_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
          -X DELETE "${BACKUP_SUPABASE_URL}/storage/v1/object/${remote}" \
          -H "Authorization: Bearer ${BACKUP_SUPABASE_KEY}")
        case "$del_code" in
          200|204) ;;
          *) echo "[backup] WARNING: DELETE returned HTTP ${del_code} for ${remote}" >&2 ;;
        esac
      fi
    done

    rm -f "$list_response"
    echo "[backup] Remote cleanup done"
  fi
}

cleanup_remote

# ─── Local rotation ──────────────────────────────────────────────────────────

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
echo "[backup] Cleaning local dumps older than ${RETENTION_DAYS} days..."
find "$DUMP_DIR" -name "${PREFIX}-${INSTANCE}-*.${FILE_EXT}" -type f -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true

REMAINING=$(find "$DUMP_DIR" -name "${PREFIX}-${INSTANCE}-*.${FILE_EXT}" -type f 2>/dev/null | wc -l)
echo "[backup] Done. ${REMAINING} local dump(s) for ${INSTANCE} retained."

if [ "$upload_failed" = 1 ]; then
  exit 1
fi

exit 0
