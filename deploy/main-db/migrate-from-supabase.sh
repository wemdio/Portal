#!/bin/bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
# Перенос данных из Supabase Cloud в self-hosted main-postgres (supabase/postgres).
#
# Дампим:
#   - public schema (все приложение)
#   - auth schema (пользователи, identities, sessions, refresh_tokens)
#   - storage schema (buckets, objects metadata; файлы переносятся отдельным
#     скриптом migrate-storage-files.mjs)
#
# Что НЕ дампим (это хозяйство Supabase Cloud, у нас своё):
#   - supabase_*, _supavisor, _realtime, _analytics, vault, pgsodium, pgbouncer,
#     net, extensions, graphql, graphql_public
#
# Запускать ИЗ контейнера main-postgres (там есть pg_dump 15.x):
#   docker exec -it main-postgres bash
#   /docker-entrypoint-initdb.d/migrate-from-supabase.sh   # если положили туда
# Или просто скопировать на DB-хост и запустить локально (с pg_dump-15+).
# ══════════════════════════════════════════════════════════════════════════════

# ─── Источник: Supabase Cloud ────────────────────────────────────────────────
SOURCE_HOST="${SOURCE_HOST:?Set SOURCE_HOST (e.g. db.pwcidzaqudfkodgmesyk.supabase.co)}"
SOURCE_PORT="${SOURCE_PORT:-5432}"
SOURCE_USER="${SOURCE_USER:-postgres}"
SOURCE_PASSWORD="${SOURCE_PASSWORD:?Set SOURCE_PASSWORD (Supabase DB password)}"
SOURCE_DB="${SOURCE_DB:-postgres}"

# ─── Цель: self-hosted main-postgres ─────────────────────────────────────────
TARGET_HOST="${TARGET_HOST:-127.0.0.1}"
TARGET_PORT="${TARGET_PORT:-5432}"
TARGET_USER="${TARGET_USER:-supabase_admin}"
TARGET_PASSWORD="${TARGET_PASSWORD:?Set TARGET_PASSWORD (== MAIN_PG_PASSWORD)}"
TARGET_DB="${TARGET_DB:-postgres}"

DUMP_DIR="${DUMP_DIR:-/tmp}"
TS=$(date -u +%Y%m%d_%H%M%S)
JOBS="${JOBS:-4}"

# Supavisor pooler не поддерживает параллельные коннекты pg_dump --jobs.
# Если хост содержит "pooler.supabase.com" — переключаемся на single-thread.
if [[ "$SOURCE_HOST" == *pooler.supabase.com* ]]; then
  echo "  ▸ Источник — Supavisor pooler: дамп будет single-threaded (JOBS=1)."
  JOBS=1
fi

echo "═══════════════════════════════════════════════════════"
echo " Supabase Cloud → self-hosted Supabase migration"
echo " Source: ${SOURCE_USER}@${SOURCE_HOST}:${SOURCE_PORT}/${SOURCE_DB}"
echo " Target: ${TARGET_USER}@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}"
echo "═══════════════════════════════════════════════════════"

# ─── Step 1: dump auth schema (пользователи, sessions) ───────────────────────
echo ""
echo "▸ Step 1/6: dump auth schema (users, sessions)..."
AUTH_DUMP="${DUMP_DIR}/portal-auth-${TS}.sql"
PGPASSWORD="$SOURCE_PASSWORD" pg_dump \
  --host="$SOURCE_HOST" --port="$SOURCE_PORT" \
  --username="$SOURCE_USER" --dbname="$SOURCE_DB" \
  --schema=auth \
  --data-only \
  --no-owner --no-privileges \
  --disable-triggers \
  --file="$AUTH_DUMP"
echo "  $(wc -l < "$AUTH_DUMP") строк -> $AUTH_DUMP"

# ─── Step 2: dump storage metadata (buckets + objects rows) ──────────────────
echo ""
echo "▸ Step 2/6: dump storage metadata (buckets, objects)..."
STORAGE_DUMP="${DUMP_DIR}/portal-storage-${TS}.sql"
PGPASSWORD="$SOURCE_PASSWORD" pg_dump \
  --host="$SOURCE_HOST" --port="$SOURCE_PORT" \
  --username="$SOURCE_USER" --dbname="$SOURCE_DB" \
  --schema=storage \
  --data-only \
  --no-owner --no-privileges \
  --disable-triggers \
  --file="$STORAGE_DUMP"
echo "  $(wc -l < "$STORAGE_DUMP") строк -> $STORAGE_DUMP"

# ─── Step 3: dump public schema (всё приложение) ─────────────────────────────
# Используем custom-формат без --jobs, чтобы работать как через прямой коннект,
# так и через Supavisor pooler. На pooler параллельный pg_dump не поддерживается.
echo ""
echo "▸ Step 3/6: dump public schema..."
PUBLIC_DUMP="${DUMP_DIR}/portal-public-${TS}.dump"
PG_DUMP_PUBLIC_ARGS=(
  --host="$SOURCE_HOST" --port="$SOURCE_PORT"
  --username="$SOURCE_USER" --dbname="$SOURCE_DB"
  --schema=public
  --format=custom --compress=6
  --no-owner --no-privileges
  --file="$PUBLIC_DUMP"
)
if [ "${JOBS}" != "1" ] && [[ "$SOURCE_HOST" != *pooler.supabase.com* ]]; then
  # параллельный режим возможен только при прямом подключении и --format=directory
  PG_DUMP_PUBLIC_ARGS+=( --jobs="$JOBS" )
fi
PGPASSWORD="$SOURCE_PASSWORD" pg_dump "${PG_DUMP_PUBLIC_ARGS[@]}"
DUMP_SIZE=$(stat -c '%s' "$PUBLIC_DUMP" 2>/dev/null || stat -f '%z' "$PUBLIC_DUMP" 2>/dev/null || echo '?')
echo "  ${DUMP_SIZE} байт -> $PUBLIC_DUMP"

# ─── Step 4: restore auth + storage ──────────────────────────────────────────
echo ""
echo "▸ Step 4/6: restore auth schema..."
PGPASSWORD="$TARGET_PASSWORD" psql \
  --host="$TARGET_HOST" --port="$TARGET_PORT" \
  --username="$TARGET_USER" --dbname="$TARGET_DB" \
  --single-transaction \
  --variable=ON_ERROR_STOP=1 \
  --file="$AUTH_DUMP" || {
    echo ""
    echo "  ⚠ auth restore завершился с предупреждениями." >&2
    echo "  Проверь чтобы дубликатов не было: PRIMARY KEY conflict на auth.users — нормально, если уже импортировали." >&2
  }

echo ""
echo "▸ Step 5/6: restore storage metadata..."
PGPASSWORD="$TARGET_PASSWORD" psql \
  --host="$TARGET_HOST" --port="$TARGET_PORT" \
  --username="$TARGET_USER" --dbname="$TARGET_DB" \
  --single-transaction \
  --variable=ON_ERROR_STOP=1 \
  --file="$STORAGE_DUMP" || {
    echo "  ⚠ storage restore завершился с предупреждениями." >&2
  }

# ─── Step 6: restore public schema ───────────────────────────────────────────
# pg_restore --jobs работает в локальной БД (target — наш main-postgres), поэтому
# здесь параллелим всегда. Если упадёт — зови без --jobs.
echo ""
echo "▸ Step 6/6: restore public schema..."
PGPASSWORD="$TARGET_PASSWORD" pg_restore \
  --host="$TARGET_HOST" --port="$TARGET_PORT" \
  --username="$TARGET_USER" --dbname="$TARGET_DB" \
  --no-owner --no-privileges \
  --jobs=4 \
  --if-exists --clean \
  "$PUBLIC_DUMP" || {
    echo ""
    echo "  ⚠ public restore завершился с предупреждениями (нормально для --clean на первом проходе)." >&2
  }

# ─── Verify ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo " Проверка"
echo "═══════════════════════════════════════════════════════"

PGPASSWORD="$TARGET_PASSWORD" psql \
  --host="$TARGET_HOST" --port="$TARGET_PORT" \
  --username="$TARGET_USER" --dbname="$TARGET_DB" \
  -c "select 'auth.users' as src, count(*) from auth.users
      union all select 'storage.buckets', count(*) from storage.buckets
      union all select 'storage.objects', count(*) from storage.objects
      union all select 'public.profiles', count(*) from public.profiles;"

echo ""
echo " Топ таблиц public по строкам:"
PGPASSWORD="$TARGET_PASSWORD" psql \
  --host="$TARGET_HOST" --port="$TARGET_PORT" \
  --username="$TARGET_USER" --dbname="$TARGET_DB" \
  -c "select relname, n_live_tup from pg_stat_user_tables
      where schemaname = 'public' order by n_live_tup desc limit 20;"

echo ""
echo " Готово. Дампы лежат в:"
echo "   $AUTH_DUMP"
echo "   $STORAGE_DUMP"
echo "   $PUBLIC_DUMP"
echo ""
echo " Дальше:"
echo "   1) Перенести файлы Storage:  node deploy/main-db/migrate-storage-files.mjs"
echo "   2) Поднять Supabase-сервисы: docker compose -p main-supabase up -d"
echo "   3) Cutover Portal .env (см. RUNBOOK.md)"
