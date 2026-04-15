#!/bin/sh
set -e

# Usage: backup.sh <prod|dev>
# Dumps the specified Instantly Postgres instance and uploads to Supabase Storage.

INSTANCE="${1:?Usage: backup.sh <prod|dev>}"
TS=$(date -u +%Y%m%d_%H%M%S)
DUMP_DIR="/backups"
mkdir -p "$DUMP_DIR"

case "$INSTANCE" in
  prod)
    PG_HOST="$PROD_PG_HOST"
    PG_PORT="$PROD_PG_PORT"
    PG_USER="$PROD_PG_USER"
    PG_PASSWORD="$PROD_PG_PASSWORD"
    PG_DB="$PROD_PG_DB"
    PREFIX="instantly"
    ;;
  dev)
    PG_HOST="$DEV_PG_HOST"
    PG_PORT="$DEV_PG_PORT"
    PG_USER="$DEV_PG_USER"
    PG_PASSWORD="$DEV_PG_PASSWORD"
    PG_DB="$DEV_PG_DB"
    PREFIX="instantly"
    ;;
  main)
    PG_HOST="$MAIN_PG_HOST"
    PG_PORT="$MAIN_PG_PORT"
    PG_USER="$MAIN_PG_USER"
    PG_PASSWORD="$MAIN_PG_PASSWORD"
    PG_DB="$MAIN_PG_DB"
    PREFIX="portal"
    ;;
  *)
    echo "[backup] Unknown instance: $INSTANCE (expected prod, dev, or main)" >&2
    exit 1
    ;;
esac

DUMP_FILE="${DUMP_DIR}/${PREFIX}-${INSTANCE}-${TS}.dump"
echo "[backup] Starting pg_dump for ${INSTANCE} -> ${DUMP_FILE}"

export PGPASSWORD="$PG_PASSWORD"
pg_dump \
  --host="$PG_HOST" \
  --port="$PG_PORT" \
  --username="$PG_USER" \
  --dbname="$PG_DB" \
  --format=custom \
  --compress=6 \
  --file="$DUMP_FILE"

DUMP_SIZE=$(stat -c '%s' "$DUMP_FILE" 2>/dev/null || stat -f '%z' "$DUMP_FILE" 2>/dev/null || echo '?')
echo "[backup] Dump complete: ${DUMP_FILE} (${DUMP_SIZE} bytes)"

# Upload to Supabase Storage
if [ -n "$BACKUP_SUPABASE_URL" ] && [ -n "$BACKUP_SUPABASE_KEY" ]; then
  REMOTE_PATH="deploy-backups/${PREFIX}/${INSTANCE}/${PREFIX}-${INSTANCE}-${TS}.dump"
  echo "[backup] Uploading to ${REMOTE_PATH}..."
  HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 120 \
    -X POST "${BACKUP_SUPABASE_URL}/storage/v1/object/${REMOTE_PATH}" \
    -H "Authorization: Bearer ${BACKUP_SUPABASE_KEY}" \
    -H 'Content-Type: application/octet-stream' \
    -H 'x-upsert: true' \
    --data-binary @"${DUMP_FILE}")

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo "[backup] Upload OK (HTTP ${HTTP_CODE})"
  else
    echo "[backup] Upload FAILED (HTTP ${HTTP_CODE})" >&2
  fi
else
  echo "[backup] BACKUP_SUPABASE_URL or BACKUP_SUPABASE_KEY not set, skipping upload."
fi

# Rotate old local dumps
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
echo "[backup] Cleaning dumps older than ${RETENTION_DAYS} days..."
find "$DUMP_DIR" -name "${PREFIX}-${INSTANCE}-*.dump" -type f -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true

REMAINING=$(find "$DUMP_DIR" -name "${PREFIX}-${INSTANCE}-*.dump" -type f | wc -l)
echo "[backup] Done. ${REMAINING} local dump(s) for ${INSTANCE} retained."
