#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# Дамп instantly-баз НА 144 (локально, без WAN): globals (роли, вкл. dataset_ro
# с паролем) + instantly (prod, ~79MB) + instantly_dataset (~12GB) + instantly
# (dev, ~9MB). Результат в /root/instantly-dumps/.
#
# Запуск на 144: bash dump-instantly.sh   (~15-25 мин, онлайн, никому не мешает)
#
# Дамп и restore делаются одним и тем же образом postgres:16-alpine —
# конфликт версий формата (грабли main-репетиции 18.07.2026) здесь исключён.
# ──────────────────────────────────────────────────────────────────────────────
set -eu

OUT=/root/instantly-dumps
mkdir -p "$OUT"
TS=$(date -u +%Y%m%d_%H%M%S)

echo "[dump] globals prod (роли: instantly, dataset_ro — с хэшами паролей)..."
docker exec instantly-postgres-prod pg_dumpall -U instantly --globals-only > "$OUT/globals-prod.sql"
echo "[dump] globals dev..."
docker exec instantly-postgres-dev pg_dumpall -U instantly --globals-only > "$OUT/globals-dev.sql"

echo "[dump] instantly (prod, ~79MB)..."
docker exec instantly-postgres-prod pg_dump -U instantly -d instantly -Fc -Z6 -f /tmp/i.dump
docker cp instantly-postgres-prod:/tmp/i.dump "$OUT/instantly-prod-$TS.dump"
docker exec instantly-postgres-prod rm -f /tmp/i.dump

echo "[dump] instantly_dataset (~12GB, это самый долгий шаг)..."
start=$(date +%s)
docker exec instantly-postgres-prod pg_dump -U instantly -d instantly_dataset -Fc -Z6 -f /tmp/d.dump
docker cp instantly-postgres-prod:/tmp/d.dump "$OUT/instantly-dataset-$TS.dump"
docker exec instantly-postgres-prod rm -f /tmp/d.dump
end=$(date +%s)
echo "[dump] dataset занял $(( (end - start) / 60 ))m $(( (end - start) % 60 ))s"

echo "[dump] instantly (dev, ~9MB)..."
docker exec instantly-postgres-dev pg_dump -U instantly -d instantly -Fc -Z6 -f /tmp/i.dump
docker cp instantly-postgres-dev:/tmp/i.dump "$OUT/instantly-dev-$TS.dump"
docker exec instantly-postgres-dev rm -f /tmp/i.dump

echo "[dump] готово:"
ls -lh "$OUT"
