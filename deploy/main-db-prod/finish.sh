#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Финальный шаг после restore: роли/права → права API-ролей (anon закрыт) →
# запуск стека → проверка.
# Usage: bash finish.sh   (из каталога с .env, fix-roles.sql,
#                          reapply-privileges.sql, verify.sh)
# Идемпотентен — можно запускать повторно. Предназначен для свежего restore:
# на живой базе fix-roles.sql вернёт authenticated права на таблицы, которые
# миграции у него забрали (RLS при этом остаётся).
# Деплой приложения этот скрипт не вызывает — только оператор руками.
# ──────────────────────────────────────────────────────────────────────────────
set -eu
cd "$(dirname "$0")"

for f in .env fix-roles.sql reapply-privileges.sql verify.sh; do
  if [ ! -f "$f" ]; then
    echo "[finish] FATAL: рядом с finish.sh нет $f. Возьми его из репозитория (deploy/main-db-prod/) и запусти снова." >&2
    exit 1
  fi
done

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

# Дамп снят с --no-privileges: GRANT/REVOKE миграций (в том числе lockdown
# 15.10.2026) он не несёт, а строки portal_migrations несёт — деплой их второй
# раз не применит. reapply-privileges.sql выставляет права по правилам из
# каталога (только GRANT/REVOKE/ALTER DEFAULT PRIVILEGES) и сам проверяет
# результат. Одна транзакция: при любой ошибке не меняется ничего, и стек не
# стартует.
echo "[finish] applying reapply-privileges.sql (права API-ролей, одна транзакция)..."
if ! docker exec -i main-postgres psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 -1 -q -f - < reapply-privileges.sql; then
  echo "[finish] FATAL: reapply-privileges.sql не применился и откатился целиком. Стек НЕ запущен:" >&2
  echo "[finish] без этого шага публичный anon-ключ снова вызывает SECURITY DEFINER-функции. Разберись с ошибкой выше и запусти finish.sh снова." >&2
  exit 1
fi

# Одно значение из базы; ошибка SQL роняет скрипт (set -e).
db_value() {
  docker exec main-postgres psql -X -U supabase_admin -d postgres -qAt \
    -v ON_ERROR_STOP=1 -c "$1"
}

lockdown=$(db_value "SELECT CASE
  WHEN to_regclass('public.portal_migrations') IS NULL THEN 'no-table'
  WHEN EXISTS (SELECT 1 FROM public.portal_migrations
               WHERE name = '20261015_0036_anon_definer_view_lockdown.sql') THEN 'yes'
  ELSE 'no' END")
if [ "$lockdown" != "yes" ]; then
  echo "[finish] WARNING: дамп снят до деплоя миграций 20261015_0030..0036 (portal_migrations: $lockdown)." >&2
  echo "[finish] anon закрыт, но политики и RLS такие, как в дампе: вошедший клиент видит чужие профили и открытые таблицы." >&2
  echo "[finish] Сразу после старта примени недостающие миграции раннером деплоя (README, «Права после restore»)." >&2
fi

echo "[finish] anon в public (ждём ровно: companies_directory: SELECT, database_review_row_marks: INSERT,SELECT, reglament_documents: SELECT):"
db_value "SELECT c.relname || ': ' || string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
          FROM pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'anon'::regrole
          GROUP BY c.relname ORDER BY 1"

echo "[finish] starting/restarting services..."
docker compose -p main-supabase --env-file .env up -d
docker restart main-auth main-rest main-storage main-realtime >/dev/null 2>&1 || true

echo "[finish] waiting 45s for services to settle..."
sleep 45
bash verify.sh

# Снаружи, как запрос из браузера с публичным ключом. Ждём HTTP 401 с кодом
# PostgreSQL 42501 (permission denied). HTTP 200 значит, что anon снова открыт.
ANON=$(grep '^MAIN_ANON_KEY=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
KONG=http://127.0.0.1:35480
anon_probe() {
  resp=$(curl -s -w '\nHTTP %{http_code}' -H "apikey: $ANON" -H "Authorization: Bearer $ANON" "$KONG$1" || true)
  verdict=""
  if printf '%s' "$resp" | grep -q '"42501"'; then verdict=" — 42501, закрыто"; fi
  echo "$1: $(printf '%s\n' "$resp" | tail -n 1)$verdict"
}
echo ""
echo "══ anon через Kong (ждём HTTP 401 и 42501 на обоих) ══"
if [ -z "$ANON" ]; then
  echo "[finish] нет MAIN_ANON_KEY в .env — проверку anon пропускаю, сделай её руками."
else
  anon_probe '/rest/v1/profiles?select=id&limit=1'
  anon_probe '/rest/v1/rpc/is_internal_staff'
fi
