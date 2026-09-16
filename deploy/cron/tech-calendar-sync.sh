#!/bin/sh
# Синк «Календаря технички»: балансы Serper / proxy.market и даты продлений
# SpaceProxy. Дёргает HTTP-ручку приложения /api/cron/tech-calendar-sync.
#
# Секрет читается из прод-.env, а не лежит в /etc/cron.d: тот файл обязан быть
# читаемым всем (644), иначе cron его игнорирует.
#
# Установка на прод-сервере:
#   install -m 750 deploy/cron/tech-calendar-sync.sh /usr/local/bin/tech-calendar-sync.sh
#   install -m 644 deploy/cron/portal-tech-calendar /etc/cron.d/portal-tech-calendar
set -eu

ENV_FILE="${PORTAL_ENV_FILE:-/home/Portal/prod/.env}"
APP_URL="${PORTAL_APP_URL:-http://127.0.0.1:3000}"

# Читаем одну переменную, а не `. "$ENV_FILE"`: в .env есть значения с
# пробелами и кавычками, и sourcing целиком роняет скрипт на первой такой
# строке (или, хуже, молча выполняет её содержимое).
CRON_SECRET="$(sed -n 's/^CRON_SECRET=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r' \
  | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"

if [ -z "$CRON_SECRET" ]; then
  echo "$(date -Is) CRON_SECRET не найден в $ENV_FILE" >&2
  exit 1
fi

printf '%s ' "$(date -Is)"
curl -fsS -m 180 -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_URL/api/cron/tech-calendar-sync"
printf '\n'
