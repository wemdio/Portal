#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Проверка instantly-стека на прод-сервере после restore.
# Usage: bash verify-instantly.sh
# Эталон с 144 на 18.07.2026: dataset=12GB, instantly(prod)=79MB, dev=8.9MB;
# роли instantly + dataset_ro; в датасете 2.1M+ писем, 167K лидов.
# ──────────────────────────────────────────────────────────────────────────────
set -u

echo "══ 1) Контейнеры ══"
docker ps --filter name=instantly- --format 'table {{.Names}}\t{{.Status}}'

echo ""
echo "══ 2) Размеры БД (эталон: dataset=12GB, instantly=79MB, dev=8.9MB) ══"
docker exec instantly-postgres-prod psql -U instantly -d instantly \
  -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE NOT datistemplate"
docker exec instantly-postgres-dev psql -U instantly -d instantly \
  -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE NOT datistemplate"

echo ""
echo "══ 3) Роли (ждём instantly + dataset_ro) ══"
docker exec instantly-postgres-prod psql -U instantly -d instantly -c '\du'

echo ""
echo "══ 4) Крупнейшие таблицы датасета + точный счётчик самой большой ══"
top=$(docker exec instantly-postgres-prod psql -U instantly -d instantly_dataset -qAt -c "
  SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND relkind = 'r'
  ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 1")
docker exec instantly-postgres-prod psql -U instantly -d instantly_dataset -c "
  SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND relkind = 'r'
  ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 6"
echo "count(*) в $top:"
docker exec instantly-postgres-prod psql -U instantly -d instantly_dataset -qAt -c "SELECT count(*) FROM \"$top\""

echo ""
echo "══ 5) PostgREST (ждём HTTP 200) ══"
curl -s -o /dev/null -w 'prod 35401: HTTP %{http_code}\n' http://127.0.0.1:35401/
curl -s -o /dev/null -w 'dev  35402: HTTP %{http_code}\n' http://127.0.0.1:35402/

echo ""
echo "══ 6) Память ══"
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | awk 'NR==1 || /instantly-/'
