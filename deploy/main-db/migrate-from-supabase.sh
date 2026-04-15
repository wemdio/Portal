#!/bin/bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
# Перенос основной БД из Supabase в self-hosted Postgres.
#
# Использование:
#   1) Задай переменные SOURCE_* и TARGET_* ниже (или через env).
#   2) Запусти на DB-сервере (где docker с main-postgres).
#   3) После успешного pg_restore — переключи .env на Portal-сервере.
#
# Требуется: pg_dump, pg_restore, psql (из postgres:16-alpine или установлены на хосте).
# ══════════════════════════════════════════════════════════════════════════════

# ─── Supabase (источник) ─────────────────────────────────────────────────────
SOURCE_HOST="${SOURCE_HOST:?Set SOURCE_HOST (Supabase direct connection host, e.g. db.xxxx.supabase.co)}"
SOURCE_PORT="${SOURCE_PORT:-5432}"
SOURCE_USER="${SOURCE_USER:-postgres}"
SOURCE_PASSWORD="${SOURCE_PASSWORD:?Set SOURCE_PASSWORD}"
SOURCE_DB="${SOURCE_DB:-postgres}"

# ─── Новый PG (цель) ────────────────────────────────────────────────────────
TARGET_HOST="${TARGET_HOST:-127.0.0.1}"
TARGET_PORT="${TARGET_PORT:-35434}"
TARGET_USER="${TARGET_USER:-portal}"
TARGET_PASSWORD="${TARGET_PASSWORD:?Set TARGET_PASSWORD}"
TARGET_DB="${TARGET_DB:-portal}"

DUMP_DIR="${DUMP_DIR:-/tmp}"
TS=$(date -u +%Y%m%d_%H%M%S)
DUMP_FILE="${DUMP_DIR}/portal-supabase-${TS}.dump"
JOBS="${JOBS:-4}"

echo "═══════════════════════════════════════════════════════"
echo " Supabase → self-hosted PG migration"
echo " Source: ${SOURCE_USER}@${SOURCE_HOST}:${SOURCE_PORT}/${SOURCE_DB}"
echo " Target: ${TARGET_USER}@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}"
echo " Dump:   ${DUMP_FILE}"
echo " Jobs:   ${JOBS}"
echo "═══════════════════════════════════════════════════════"

# ─── Step 1: pg_dump from Supabase ──────────────────────────────────────────
echo ""
echo "▸ Step 1/4: pg_dump from Supabase..."
PGPASSWORD="$SOURCE_PASSWORD" pg_dump \
  --host="$SOURCE_HOST" \
  --port="$SOURCE_PORT" \
  --username="$SOURCE_USER" \
  --dbname="$SOURCE_DB" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --no-comments \
  --exclude-schema='supabase_*' \
  --exclude-schema='_supavisor' \
  --exclude-schema='_realtime' \
  --exclude-schema='_analytics' \
  --exclude-schema='auth' \
  --exclude-schema='storage' \
  --exclude-schema='graphql' \
  --exclude-schema='graphql_public' \
  --exclude-schema='pgsodium*' \
  --exclude-schema='vault' \
  --exclude-schema='pgbouncer' \
  --exclude-schema='net' \
  --exclude-schema='extensions' \
  --exclude-schema='information_schema' \
  --exclude-schema='pg_*' \
  --jobs="$JOBS" \
  --file="$DUMP_FILE"

DUMP_SIZE=$(stat -c '%s' "$DUMP_FILE" 2>/dev/null || stat -f '%z' "$DUMP_FILE" 2>/dev/null || echo '?')
echo "  Dump complete: ${DUMP_FILE} (${DUMP_SIZE} bytes)"

# ─── Step 2: Prepare target database ───────────────────────────────────────
echo ""
echo "▸ Step 2/4: Preparing target database..."
PGPASSWORD="$TARGET_PASSWORD" psql \
  -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" \
  -c "SELECT 1;" >/dev/null
echo "  Target database is reachable."

# ─── Step 3: pg_restore into new PG ────────────────────────────────────────
echo ""
echo "▸ Step 3/4: pg_restore into target..."
PGPASSWORD="$TARGET_PASSWORD" pg_restore \
  --host="$TARGET_HOST" \
  --port="$TARGET_PORT" \
  --username="$TARGET_USER" \
  --dbname="$TARGET_DB" \
  --no-owner \
  --no-privileges \
  --jobs="$JOBS" \
  --if-exists \
  --clean \
  "$DUMP_FILE" || {
    echo ""
    echo "  ⚠ pg_restore finished with warnings (normal for --clean on first run)."
    echo "  Check above for actual errors vs harmless 'does not exist' warnings."
  }

# ─── Step 4: Verify ────────────────────────────────────────────────────────
echo ""
echo "▸ Step 4/4: Verifying..."
PGPASSWORD="$TARGET_PASSWORD" psql \
  -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" \
  -c "SELECT schemaname, COUNT(*) as tables FROM pg_tables WHERE schemaname = 'public' GROUP BY schemaname;"
echo ""
PGPASSWORD="$TARGET_PASSWORD" psql \
  -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" \
  -c "SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 15;"

echo ""
echo "═══════════════════════════════════════════════════════"
echo " Done! Dump saved at: ${DUMP_FILE}"
echo ""
echo " Next steps:"
echo " 1) Check table counts above match Supabase"
echo " 2) On Portal server, update .env:"
echo "    DATABASE_URL=postgresql://${TARGET_USER}:<password>@<DB_HOST_IP>:${TARGET_PORT}/${TARGET_DB}?sslmode=disable"
echo "    SUPABASE_DB_URL=postgresql://${TARGET_USER}:<password>@<DB_HOST_IP>:${TARGET_PORT}/${TARGET_DB}?sslmode=disable"
echo " 3) Restart portal: docker compose -p portal -f docker-compose.prod.yml up -d --force-recreate portal"
echo "═══════════════════════════════════════════════════════"
