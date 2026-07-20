#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Восстановление дампа main-supabase в свежий main-postgres на прод-сервере.
#
# Usage: bash restore.sh /path/to/portal-main-*.dump
#
# Предусловия:
#   - main-postgres поднят (docker compose ... up -d main-postgres) и healthy;
#   - остальной стек (auth/rest/realtime/storage) ЕЩЁ НЕ запускался — их
#     сервисы должны увидеть уже восстановленные auth/storage таблицы и
#     не гонять свои миграции по пустой базе.
#
# Ожидаемые ошибки restore: "schema ... already exists" и подобные — образ
# supabase/postgres создаёт схемы auth/storage/realtime при инициализации,
# дамп их тоже содержит. Скрипт считает их отдельно от настоящих ошибок.
# ──────────────────────────────────────────────────────────────────────────────
set -eu

DUMP="${1:?Usage: restore.sh /path/to/portal-main-*.dump}"
[ -f "$DUMP" ] || { echo "[restore] FATAL: dump not found: $DUMP" >&2; exit 1; }

echo "[restore] dump: $DUMP ($(du -h "$DUMP" | cut -f1))"

echo "[restore] waiting for main-postgres to be healthy..."
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' main-postgres 2>/dev/null)" = "healthy" ]; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[restore] FATAL: main-postgres not healthy after 5 min" >&2
    exit 1
  fi
  sleep 5
done

PGPASS=$(grep '^MAIN_PG_PASSWORD=' "$(dirname "$0")/.env" | cut -d= -f2- | tr -d '"' | tr -d "'")

# Защита от повторного налива (грабли репетиции 18.07.2026: два параллельных
# restore задвоили данные — pdl_companies 39M строк вместо 19.6M). Restore
# работает ТОЛЬКО в свежую базу; иначе — сначала down -v и заново up.
existing=$(docker exec main-postgres psql -U supabase_admin -d postgres -qAt \
  -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'" 2>/dev/null || echo "?")
if [ "$existing" != "0" ]; then
  echo "[restore] FATAL: в базе уже есть таблицы public (count=$existing) — это не пустая база." >&2
  echo "[restore] Сначала пересоздай её:" >&2
  echo "[restore]   docker compose -p main-supabase --env-file .env down -v" >&2
  echo "[restore]   docker compose -p main-supabase --env-file .env up -d main-postgres" >&2
  exit 1
fi

# Пароли внутренних служебных ролей. Свежий initdb supabase/postgres создаёт
# роли authenticator / supabase_auth_admin / supabase_storage_admin БЕЗ наших
# паролей — их выставляют отдельно (на 144 это делали руками при переезде из
# облака в апреле 2026). Без этого auth/rest/storage крутятся в рестарт-цикле
# с "password authentication failed" (грабли репетиции 18.07.2026).
# Dollar-quoting ($pw$...$pw$) — чтобы спецсимволы пароля не ломали SQL.
echo "[restore] syncing internal role passwords..."
docker exec main-postgres psql -U supabase_admin -d postgres -qAt -c "
  ALTER USER authenticator          WITH PASSWORD \$pw\$${PGPASS}\$pw\$;
  ALTER USER supabase_auth_admin    WITH PASSWORD \$pw\$${PGPASS}\$pw\$;
  ALTER USER supabase_storage_admin WITH PASSWORD \$pw\$${PGPASS}\$pw\$;
  ALTER USER postgres               WITH PASSWORD \$pw\$${PGPASS}\$pw\$;"

# Образ качаем заранее и с видимым прогрессом — иначе restore выглядит
# зависшим (stderr docker run уходит в лог ошибок вместе с прогрессом pull).
echo "[restore] pulling postgres:17-alpine (пара минут при первом запуске)..."
docker pull postgres:17-alpine

echo "[restore] pg_restore started: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
start=$(date +%s)

# Heartbeat: раз в минуту печатаем размер базы, чтобы было видно, что процесс
# жив (restore 25 GB идёт ~50 минут и сам по себе молчит).
(
  while :; do
    sleep 60
    sz=$(docker exec main-postgres psql -U supabase_admin -d postgres -qAt \
      -c "SELECT pg_size_pretty(pg_database_size('postgres'))" 2>/dev/null) || break
    echo "[restore] progress: db size = $sz (цель ~25 GB)"
  done
) &
HB_PID=$!
# pg_restore запускаем из postgres:17-alpine, а НЕ из main-postgres (PG 15):
# дампы делает portal-backup (postgres:17-alpine, формат архива 1.16), pg_restore
# 15-й версии его не открывает — "unsupported version (1.16) in file header"
# (грабли репетиции 18.07.2026). Клиент 17 → сервер 15 работает штатно.
# -j 4: параллельное восстановление. Ошибки не фатальны (|| true) — ниже разбор.
docker run --rm --network main-supabase_main-db-net \
  -v "$DUMP":/restore.dump:ro \
  -e PGPASSWORD="$PGPASS" \
  postgres:17-alpine \
  pg_restore -h main-postgres -p 5432 -U supabase_admin -d postgres -j 4 \
  --no-owner --no-privileges /restore.dump 2>/tmp/main-restore-errors.log || true
kill "$HB_PID" 2>/dev/null || true
end=$(date +%s)
dur=$((end - start))
echo "[restore] pg_restore finished: $(date -u '+%Y-%m-%d %H:%M:%S UTC') — заняло $((dur / 60))m $((dur % 60))s"

total=$(grep -c 'pg_restore: error' /tmp/main-restore-errors.log 2>/dev/null || true)
benign=$(grep 'pg_restore: error' /tmp/main-restore-errors.log 2>/dev/null | grep -c 'already exists' || true)
echo "[restore] errors: total=${total:-0}, of which 'already exists' (ожидаемые): ${benign:-0}"
real_errors=$(grep 'pg_restore: error' /tmp/main-restore-errors.log 2>/dev/null | grep -v 'already exists' | head -30 || true)
if [ -n "$real_errors" ]; then
  echo "[restore] ⚠️ НЕожидаемые ошибки (первые 30) — прислать Клоду целиком /tmp/main-restore-errors.log:"
  echo "$real_errors"
else
  echo "[restore] ✅ неожиданных ошибок нет"
fi

echo "[restore] done. Дальше: docker compose -p main-supabase --env-file .env up -d && bash verify.sh"
