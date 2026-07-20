#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Восстановление instantly-баз на прод-сервере из дампов, снятых dump-instantly.sh.
#
# Usage: bash restore-instantly.sh /root/instantly-dumps
#
# Предусловия:
#   - подняты ТОЛЬКО контейнеры баз (без migrator/postgrest — иначе migrator
#     успеет создать таблицы и restore ляжет в непустую базу):
#       cd /opt/instantly-db
#       docker compose up -d instantly-postgres-prod instantly-postgres-dev
#   - дампы скопированы с 144 в каталог из $1.
# После restore поднять весь стек: docker compose up -d  (migrator увидит
# перенесённую таблицу миграций и ничего не станет перекатывать).
# ──────────────────────────────────────────────────────────────────────────────
set -eu

D="${1:?Usage: restore-instantly.sh /root/instantly-dumps}"
[ -d "$D" ] || { echo "[restore] FATAL: каталог не найден: $D" >&2; exit 1; }

# Защита от налива в непустую базу (грабли main-репетиции 18.07.2026).
for c in instantly-postgres-prod instantly-postgres-dev; do
  cnt=$(docker exec "$c" psql -U instantly -d instantly -qAt \
    -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
  if [ "$cnt" != "0" ]; then
    echo "[restore] FATAL: $c уже содержит таблицы (count=$cnt) — это не пустая база." >&2
    echo "[restore] Сначала: docker compose down -v && docker compose up -d instantly-postgres-prod instantly-postgres-dev" >&2
    exit 1
  fi
done

echo "[restore] globals prod (ошибки 'role \"instantly\" already exists' — норма)..."
docker exec -i instantly-postgres-prod psql -U instantly -d postgres < "$D/globals-prod.sql" 2>&1 | grep -v 'already exists' || true
echo "[restore] globals dev..."
docker exec -i instantly-postgres-dev psql -U instantly -d postgres < "$D/globals-dev.sql" 2>&1 | grep -v 'already exists' || true

echo "[restore] instantly (prod)..."
docker cp "$D"/instantly-prod-*.dump instantly-postgres-prod:/tmp/i.dump
docker exec instantly-postgres-prod pg_restore -U instantly -d instantly -j 2 /tmp/i.dump
docker exec instantly-postgres-prod rm -f /tmp/i.dump

echo "[restore] instantly_dataset (самый долгий шаг)..."
start=$(date +%s)
docker exec instantly-postgres-prod createdb -U instantly instantly_dataset 2>/dev/null || true
docker cp "$D"/instantly-dataset-*.dump instantly-postgres-prod:/tmp/d.dump
docker exec instantly-postgres-prod pg_restore -U instantly -d instantly_dataset -j 4 /tmp/d.dump
docker exec instantly-postgres-prod rm -f /tmp/d.dump
end=$(date +%s)
echo "[restore] dataset занял $(( (end - start) / 60 ))m $(( (end - start) % 60 ))s"

echo "[restore] instantly (dev)..."
docker cp "$D"/instantly-dev-*.dump instantly-postgres-dev:/tmp/i.dump
docker exec instantly-postgres-dev pg_restore -U instantly -d instantly -j 2 /tmp/i.dump
docker exec instantly-postgres-dev rm -f /tmp/i.dump

echo "[restore] done. Дальше: docker compose up -d && bash verify-instantly.sh"
