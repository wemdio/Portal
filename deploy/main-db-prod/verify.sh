#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Проверка восстановленного main-supabase стека на прод-сервере.
# Usage: bash verify.sh   (из каталога с .env)
# Эталон с боевой базы на 144 (18.07.2026): auth.users=70, storage.objects=3020.
# ──────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"

ANON=$(grep '^MAIN_ANON_KEY=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
KONG=http://127.0.0.1:35480

echo "══ 1) Контейнеры ══"
docker ps --filter name=main- --format 'table {{.Names}}\t{{.Status}}'

echo ""
echo "══ 2) Данные в базе (эталон: auth.users=70, storage.objects=3020) ══"
docker exec main-postgres psql -U supabase_admin -d postgres -qAt -F' = ' -c "
  SELECT 'auth.users', count(*)::text FROM auth.users
  UNION ALL SELECT 'storage.objects', count(*)::text FROM storage.objects
  UNION ALL SELECT 'public tables', count(*)::text FROM pg_tables WHERE schemaname='public'
  UNION ALL SELECT 'db size', pg_size_pretty(pg_database_size('postgres'));"

echo ""
echo "══ 3) Крупнейшие таблицы (оценка строк) ══"
docker exec main-postgres psql -U supabase_admin -d postgres -qAt -F' ~ ' -c "
  SELECT relname, reltuples::bigint FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND relkind = 'r' AND reltuples > 0
  ORDER BY reltuples DESC LIMIT 5;"

echo ""
echo "══ 4) API через Kong (ожидаем HTTP 200 везде) ══"
curl -s -o /dev/null -w 'auth  /auth/v1/health:  HTTP %{http_code}\n' \
  -H "apikey: $ANON" "$KONG/auth/v1/health"
curl -s -o /dev/null -w 'rest  /rest/v1/:        HTTP %{http_code}\n' \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" "$KONG/rest/v1/"
curl -s -o /dev/null -w 'storage /storage/v1/version: HTTP %{http_code}\n' \
  -H "apikey: $ANON" "$KONG/storage/v1/version"

echo ""
echo "══ 5) Потребление памяти стеком ══"
# awk вместо head+grep: head -1 в пайпе съедает целый буфер, а не одну строку,
# и grep-у ничего не остаётся (пустая секция на репетиции 18.07.2026).
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | awk 'NR==1 || /main-/'
