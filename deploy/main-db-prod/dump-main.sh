#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Свежий дамп main-БД НА 144 (локально, без WAN) для боевого переключения.
# Запуск на 144: bash dump-main.sh   (только ПОСЛЕ заморозки приложения на проде)
#
# Тот же набор exclude-схем, что у services/backup/backup.sh. pg_dump — родной
# из main-postgres (PG 15, формат 1.15) — restore.sh на проде читает его
# pg_restore-ом 17-й версии, это совместимо (новый читает старые форматы).
# ──────────────────────────────────────────────────────────────────────────────
set -eu

OUT=/root/main-fresh-dump
mkdir -p "$OUT"
TS=$(date -u +%Y%m%d_%H%M%S)

echo "[dump] pg_dump main (25GB → ~3.7GB, локально на 144)..."
start=$(date +%s)
docker exec main-postgres pg_dump -U supabase_admin -d postgres \
  --format=custom --compress=6 --no-owner --no-privileges \
  --exclude-schema=_supavisor --exclude-schema=_realtime --exclude-schema=_analytics \
  --exclude-schema=pgsodium --exclude-schema=pgsodium_masks --exclude-schema=vault \
  --exclude-schema=supabase_functions --exclude-schema=supabase_migrations \
  --exclude-schema=pgbouncer --exclude-schema=net --exclude-schema=cron \
  --exclude-schema=graphql --exclude-schema=graphql_public --exclude-schema=extensions \
  -f /tmp/main-fresh.dump
docker cp main-postgres:/tmp/main-fresh.dump "$OUT/portal-main-fresh-$TS.dump"
docker exec main-postgres rm -f /tmp/main-fresh.dump
end=$(date +%s)
echo "[dump] занял $(( (end - start) / 60 ))m $(( (end - start) % 60 ))s"
ls -lh "$OUT"
