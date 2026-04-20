#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# pg_dump → Supabase Storage backup
#
# Запускается на Portal-сервере, в контейнере portal-backup
# (image: ${DOCKER_USERNAME}/portal-backup:prod). cron задаёт расписание
# (см. crontab), bash вызывает этот скрипт по одному разу на instance.
#
# Usage: backup.sh <main-supabase|instantly-prod|instantly-dev>
#
#   main-supabase   Главная БД проекта (Supabase Cloud).
#                   Берёт MAIN_SUPABASE_DATABASE_URL, fallback DATABASE_URL.
#                   Дамп = ВСЕ схемы кроме супабейзовской инфраструктуры
#                   (auth+storage+public+пр. остаются), чтобы накатывался
#                   на чистый Postgres.
#   instantly-prod  Локальный Postgres Instantly prod (на DB-сервере, порт 35432).
#                   Берёт INSTANTLY_DATABASE_URL — ту же, что использует Portal.
#   instantly-dev   Аналогично, INSTANTLY_DEV_DATABASE_URL.
#
# DRY: используем те же переменные окружения, что уже есть в .env Portal-сервера
# для приложения; никаких параллельных PROD_PG_HOST / PROD_PG_PASSWORD.
#
# Все дампы: pg_dump --format=custom --compress=6 --no-owner --no-privileges
# Restore:   pg_restore --clean --if-exists --no-owner --no-privileges -d <db>
#
# Storage layout (bucket из BACKUP_SUPABASE_URL/BACKUP_SUPABASE_KEY):
#   deploy-backups/portal-main/portal-main-main-supabase-<TS>.dump
#   deploy-backups/instantly/prod/instantly-instantly-prod-<TS>.dump
#   deploy-backups/instantly/dev/instantly-instantly-dev-<TS>.dump
#
# При фейле pg_dump или non-2xx upload → Telegram-алерт через
# TELEGRAM_HEALTH_BOT_TOKEN/CHAT_ID + exit 1 (cron-логи зафиксируют как failed).
# Чистка старых объектов в Storage идёт ТОЛЬКО при успешном upload — иначе
# можно случайно остаться без копии.
# ──────────────────────────────────────────────────────────────────────────────

set -u

INSTANCE="${1:-}"
if [ -z "$INSTANCE" ]; then
  echo "Usage: backup.sh <main-supabase|instantly-prod|instantly-dev>" >&2
  exit 1
fi

TS=$(date -u +%Y%m%d_%H%M%S)
DUMP_DIR="${DUMP_DIR:-/backups}"
mkdir -p "$DUMP_DIR" 2>/dev/null || {
  echo "[backup] ERROR: cannot create DUMP_DIR=$DUMP_DIR" >&2
  exit 1
}

# ─── Telegram alerts ─────────────────────────────────────────────────────────
# Не валим скрипт если алерт не доставился — лучше тихо логировать,
# чем потерять основной exit code из-за curl-ошибки на api.telegram.org.

send_alert() {
  msg="$1"
  if [ -z "${TELEGRAM_HEALTH_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_HEALTH_CHAT_ID:-}" ]; then
    return 0
  fi
  curl -sS -o /dev/null --max-time 15 \
    "https://api.telegram.org/bot${TELEGRAM_HEALTH_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_HEALTH_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    --data-urlencode "parse_mode=HTML" \
    >/dev/null 2>&1 || true
}

# ─── Resolve URL + storage layout per instance ───────────────────────────────
# EXTRA_PG_DUMP_OPTS — флаги, специфичные для main-supabase (исключения схем).
# PREFIX и SUBPATH собирают имя файла и путь в Storage:
#   <PREFIX>-<INSTANCE>-<TS>.dump
#   deploy-backups/<SUBPATH>/<file>

PG_CONN_URL=""
EXTRA_PG_DUMP_OPTS=""
PREFIX=""
SUBPATH=""

case "$INSTANCE" in
  main-supabase)
    PG_CONN_URL="${MAIN_SUPABASE_DATABASE_URL:-${DATABASE_URL:-}}"
    if [ -z "$PG_CONN_URL" ]; then
      echo "[backup] MAIN_SUPABASE_DATABASE_URL/DATABASE_URL is empty, skipping main-supabase backup."
      exit 0
    fi
    PREFIX="portal-main"
    SUBPATH="portal-main"
    # Исключаем супабейзовую инфраструктуру: эти схемы привязаны к managed-стэку
    # и не нужны для воссоздания приложения. public/auth/storage ОСТАЮТСЯ.
    # auth.users + storage.{buckets,objects} критичны для восстановления.
    # Дамп создаст auth/storage схемы; для рестора на чистый PG может потребоваться
    # `CREATE EXTENSION pgcrypto, "uuid-ossp", vector` (см. RUNBOOK).
    EXTRA_PG_DUMP_OPTS="\
      --exclude-schema=_supavisor \
      --exclude-schema=_realtime \
      --exclude-schema=_analytics \
      --exclude-schema=pgsodium \
      --exclude-schema=pgsodium_masks \
      --exclude-schema=vault \
      --exclude-schema=supabase_functions \
      --exclude-schema=supabase_migrations \
      --exclude-schema=pgbouncer \
      --exclude-schema=net \
      --exclude-schema=cron \
      --exclude-schema=graphql \
      --exclude-schema=graphql_public \
      --exclude-schema=extensions"
    ;;
  instantly-prod)
    PG_CONN_URL="${INSTANTLY_DATABASE_URL:-}"
    if [ -z "$PG_CONN_URL" ]; then
      echo "[backup] INSTANTLY_DATABASE_URL is empty, skipping instantly-prod backup."
      exit 0
    fi
    PREFIX="instantly"
    SUBPATH="instantly/prod"
    ;;
  instantly-dev)
    PG_CONN_URL="${INSTANTLY_DEV_DATABASE_URL:-}"
    if [ -z "$PG_CONN_URL" ]; then
      echo "[backup] INSTANTLY_DEV_DATABASE_URL is empty, skipping instantly-dev backup."
      exit 0
    fi
    PREFIX="instantly"
    SUBPATH="instantly/dev"
    ;;
  *)
    echo "[backup] Unknown instance: $INSTANCE (expected main-supabase, instantly-prod, instantly-dev)" >&2
    exit 1
    ;;
esac

DUMP_FILE="${DUMP_DIR}/${PREFIX}-${INSTANCE}-${TS}.dump"
echo "[backup] Starting pg_dump for ${INSTANCE} -> ${DUMP_FILE}"

# --no-owner / --no-privileges: дамп переносим, без привязки к owner-роли.
# --format=custom: бинарный формат, восстанавливается через pg_restore.
# --compress=6: разумный баланс между размером и временем.
# shellcheck disable=SC2086 # EXTRA_PG_DUMP_OPTS — список флагов, без кавычек намеренно
pg_dump \
  --dbname="$PG_CONN_URL" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  $EXTRA_PG_DUMP_OPTS \
  --file="$DUMP_FILE"
PG_DUMP_RC=$?

if [ "$PG_DUMP_RC" -ne 0 ]; then
  msg="🚨 [backup ${INSTANCE}] pg_dump FAILED (rc=${PG_DUMP_RC})"
  echo "$msg" >&2
  send_alert "$msg"
  exit 1
fi

DUMP_SIZE=$(stat -c '%s' "$DUMP_FILE" 2>/dev/null || stat -f '%z' "$DUMP_FILE" 2>/dev/null || echo '?')
echo "[backup] Dump complete: ${DUMP_FILE} (${DUMP_SIZE} bytes)"

# ─── Upload to Supabase Storage ──────────────────────────────────────────────

upload_failed=0
if [ -n "${BACKUP_SUPABASE_URL:-}" ] && [ -n "${BACKUP_SUPABASE_KEY:-}" ]; then
  REMOTE_PATH="deploy-backups/${SUBPATH}/${PREFIX}-${INSTANCE}-${TS}.dump"
  echo "[backup] Uploading to ${REMOTE_PATH}..."

  # ВАЖНО: используем -T (--upload-file) вместо --data-binary @file.
  # `--data-binary @file` грузит ВЕСЬ файл в RAM (см. curl/curl#18300), что
  # на портал-бэкапе (256 МБ memory limit) приводит к OOM-kill curl-а через
  # SIGKILL: stdout пустой → %{http_code} пустой → алерт «Upload FAILED (HTTP )».
  # `-T` стримит с диска чанками, память плоская независимо от размера дампа.
  # `-X POST` оставляем явно: Supabase Storage REST принимает POST + x-upsert
  # для апсерта (это же делает supabase-js клиент).
  curl_rc=0
  HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 600 \
    -X POST "${BACKUP_SUPABASE_URL}/storage/v1/object/${REMOTE_PATH}" \
    -H "Authorization: Bearer ${BACKUP_SUPABASE_KEY}" \
    -H 'Content-Type: application/octet-stream' \
    -H 'x-upsert: true' \
    -T "${DUMP_FILE}") || curl_rc=$?

  case "$HTTP_CODE" in
    200|201)
      echo "[backup] Upload OK (HTTP ${HTTP_CODE})"
      ;;
    *)
      # Включаем curl_rc и size в текст: rc=137 → OOM/SIGKILL,
      # rc=28 → таймаут, rc=7 → connect refused, rc=0+code 4xx → серверная
      # ошибка. Без этого пустой HTTP_CODE не даёт никаких подсказок.
      msg="🚨 [backup ${INSTANCE}] Upload FAILED (HTTP ${HTTP_CODE} rc=${curl_rc} size=${DUMP_SIZE}) for ${REMOTE_PATH}"
      echo "$msg" >&2
      send_alert "$msg"
      upload_failed=1
      ;;
  esac
else
  echo "[backup] BACKUP_SUPABASE_URL or BACKUP_SUPABASE_KEY not set, skipping upload."
fi

# ─── Cleanup of old objects in Supabase Storage ──────────────────────────────
# Делаем только если был успешный upload (иначе потенциально удалим единственную
# свежую копию из-за ложного срабатывания). Скип также если креды отсутствуют.
#
# Storage REST: POST /storage/v1/object/list/<bucket> с body {"prefix":"<dir>","limit":1000}
# возвращает массив [{name, created_at, ...}]. Удаление: DELETE /object/<bucket>/<path>.

cleanup_remote() {
  if [ -z "${BACKUP_SUPABASE_URL:-}" ] || [ -z "${BACKUP_SUPABASE_KEY:-}" ]; then
    return 0
  fi
  if [ "$upload_failed" = 1 ]; then
    echo "[backup] Skipping remote cleanup because upload failed"
    return 0
  fi

  retention_days="${BACKUP_REMOTE_RETENTION_DAYS:-30}"
  echo "[backup] Cleaning remote dumps older than ${retention_days} days in ${SUBPATH}/..."

  list_response=$(mktemp)
  list_code=$(curl -sS -o "$list_response" -w '%{http_code}' --max-time 30 \
    -X POST "${BACKUP_SUPABASE_URL}/storage/v1/object/list/deploy-backups" \
    -H "Authorization: Bearer ${BACKUP_SUPABASE_KEY}" \
    -H 'Content-Type: application/json' \
    --data "{\"prefix\":\"${SUBPATH}\",\"limit\":1000,\"sortBy\":{\"column\":\"created_at\",\"order\":\"asc\"}}")

  if [ "$list_code" != "200" ]; then
    msg="⚠️ [backup ${INSTANCE}] list FAILED (HTTP ${list_code}); skipping cleanup"
    echo "$msg" >&2
    send_alert "$msg"
    rm -f "$list_response"
    return 0
  fi

  # Парсим JSON без jq (его нет в postgres:17-alpine) — простой regex по полям
  # name + created_at. JSON от Supabase Storage предсказуемый, всегда плоский.
  cutoff=$(date -u -d "${retention_days} days ago" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || \
           date -u -v-"${retention_days}"d '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo '')
  if [ -z "$cutoff" ]; then
    echo "[backup] WARNING: cannot compute cutoff date, skipping remote cleanup"
    rm -f "$list_response"
    return 0
  fi

  # tr делает по одному объекту на строку; затем sed выдёргивает name + created_at
  tr '}' '\n' < "$list_response" | while IFS= read -r line; do
    name=$(echo "$line" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
    created=$(echo "$line" | sed -n 's/.*"created_at":"\([^"]*\)".*/\1/p')
    if [ -z "$name" ] || [ -z "$created" ]; then
      continue
    fi
    # Лексикографическое сравнение ISO-8601 в UTC = сравнение по времени.
    if [ "$created" \< "$cutoff" ]; then
      remote="deploy-backups/${SUBPATH}/${name}"
      echo "[backup] Removing old object: ${remote} (created=${created})"
      del_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
        -X DELETE "${BACKUP_SUPABASE_URL}/storage/v1/object/${remote}" \
        -H "Authorization: Bearer ${BACKUP_SUPABASE_KEY}")
      case "$del_code" in
        200|204) ;;
        *) echo "[backup] WARNING: DELETE returned HTTP ${del_code} for ${remote}" >&2 ;;
      esac
    fi
  done

  rm -f "$list_response"
  echo "[backup] Remote cleanup done"
}

cleanup_remote

# ─── Local rotation ──────────────────────────────────────────────────────────

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
echo "[backup] Cleaning local dumps older than ${RETENTION_DAYS} days..."
find "$DUMP_DIR" -name "${PREFIX}-${INSTANCE}-*.dump" -type f -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true

REMAINING=$(find "$DUMP_DIR" -name "${PREFIX}-${INSTANCE}-*.dump" -type f 2>/dev/null | wc -l)
echo "[backup] Done. ${REMAINING} local dump(s) for ${INSTANCE} retained."

# Если upload упал — exit 1, чтобы cron-логи и алерт-системы корректно
# отметили запуск как failed. Локальный дамп при этом всё равно сохранён.
if [ "$upload_failed" = 1 ]; then
  exit 1
fi

exit 0
