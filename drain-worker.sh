#!/usr/bin/env bash
# drain-worker.sh
#
# При деплое принудительно завершает текущие задачи:
#   - trace_spans: running → cancelled (в Трассировках задач не висят как «Выполняется»);
#   - parser_jobs и др.: running → failed.
# Затем останавливает воркеры. Ожидания завершения задач нет.
#
# Переменные (берутся из .env):
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

set -euo pipefail

# Загружаем env если не пришли снаружи
if [ -f .env ]; then
  set -o allexport
  source <(tr -d '\r' < .env)
  set +o allexport
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

if [ -n "$SUPABASE_URL" ] && [ -n "$KEY" ]; then
  echo "[drain] Marking running trace spans as cancelled (so Трассировки задач show correct status)..."
  ENDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
  if [ -z "$ENDED_AT" ]; then
    PATCH_BODY='{"status":"cancelled"}'
  else
    PATCH_BODY="{\"status\":\"cancelled\",\"ended_at\":\"$ENDED_AT\"}"
  fi
  n=$(curl -s -X PATCH \
    "${SUPABASE_URL}/rest/v1/trace_spans?status=eq.running" \
    -H "apikey: ${KEY}" \
    -H "Authorization: Bearer ${KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=minimal" \
    -d "$PATCH_BODY" \
    --write-out '%{http_code}' -o /dev/null 2>/dev/null || echo "000")
  if [[ "$n" =~ ^(200|204)$ ]]; then
    echo "[drain] trace_spans: running spans marked as cancelled"
  fi

  echo "[drain] Marking running jobs as failed and stopping workers..."
  for table in parser_jobs search_parser_jobs website_enrichment_jobs yandex_maps_jobs email_validation_jobs; do
    n=$(curl -s -X PATCH \
      "${SUPABASE_URL}/rest/v1/${table}?status=eq.running" \
      -H "apikey: ${KEY}" \
      -H "Authorization: Bearer ${KEY}" \
      -H "Content-Type: application/json" \
      -H "Prefer: return=minimal" \
      -d '{"status":"failed"}' \
      --write-out '%{http_code}' -o /dev/null 2>/dev/null || echo "000")
    # PATCH returns 204 or 200; we don't need count
    if [[ "$n" =~ ^(200|204)$ ]]; then
      echo "[drain] ${table}: running jobs marked as failed"
    fi
  done
else
  echo "[drain] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping mark-as-failed"
fi

# Останавливаем воркеры (SIGTERM → контейнеры останавливаются сразу)
# Поддерживаем старое имя `portal-worker` и новые раздельные воркеры.
containers=(
  "portal-worker"
  "portal-worker-hh"
  "portal-worker-search"
  "portal-worker-enrich"
  "portal-worker-yandexmaps"
  "portal-worker-emailvalidation"
)

echo "[drain] Stopping worker containers..."
for c in "${containers[@]}"; do
  docker stop "$c" 2>/dev/null || true
done

echo "[drain] Workers stopped"
