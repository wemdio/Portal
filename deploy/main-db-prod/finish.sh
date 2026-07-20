#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Финальный шаг после restore: роли/права → запуск стека → проверка.
# Usage: bash finish.sh   (из каталога с .env, fix-roles.sql, verify.sh)
# Идемпотентен — можно запускать повторно.
# ──────────────────────────────────────────────────────────────────────────────
set -eu
cd "$(dirname "$0")"

PGPASS=$(grep '^MAIN_PG_PASSWORD=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")

active=$(docker exec main-postgres psql -U supabase_admin -d postgres -qAt \
  -c "SELECT count(*) FROM pg_stat_activity WHERE query ILIKE 'COPY %' OR application_name ILIKE 'pg_restore%'")
if [ "$active" != "0" ]; then
  echo "[finish] FATAL: восстановление ещё идёт (активных потоков: $active). Дождись окончания и запусти снова." >&2
  exit 1
fi

echo "[finish] applying fix-roles.sql..."
docker exec -i main-postgres psql -U supabase_admin -d postgres \
  -v pgpass="$PGPASS" -v ON_ERROR_STOP=0 -q -f - < fix-roles.sql

echo "[finish] starting/restarting services..."
docker compose -p main-supabase --env-file .env up -d
docker restart main-auth main-rest main-storage main-realtime >/dev/null 2>&1 || true

echo "[finish] waiting 45s for services to settle..."
sleep 45
bash verify.sh
