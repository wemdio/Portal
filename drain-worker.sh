#!/usr/bin/env bash
# drain-worker.sh
#
# Ждёт пока воркер закончит текущую задачу, затем останавливает его.
# Используется в деплое: запускается перед обновлением образов.
#
# Переменные (берутся из .env):
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#   WORKER_DRAIN_TIMEOUT_MINUTES (default: 60)

set -euo pipefail

TIMEOUT_MIN="${WORKER_DRAIN_TIMEOUT_MINUTES:-60}"
POLL_INTERVAL=15  # секунд между проверками

# Загружаем env если не пришли снаружи
if [ -f .env ]; then
  set -o allexport
  source .env
  set +o allexport
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

if [ -z "$SUPABASE_URL" ] || [ -z "$KEY" ]; then
  echo "[drain] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping drain wait"
  exit 0
fi

count_running() {
  local tables=("parser_jobs" "search_parser_jobs" "website_enrichment_jobs" "yandex_maps_jobs")
  local total=0
  for table in "${tables[@]}"; do
    local n
    n=$(curl -s \
      "${SUPABASE_URL}/rest/v1/${table}?status=eq.running&select=id" \
      -H "apikey: ${KEY}" \
      -H "Authorization: Bearer ${KEY}" \
      -H "Prefer: count=exact" \
      --write-out '%{header_json}' -o /dev/null 2>/dev/null \
      | python3 -c "import sys,json; h=json.load(sys.stdin); print(h.get('content-range',['0'])[0].split('/')[-1])" 2>/dev/null || echo 0)
    total=$((total + ${n:-0}))
  done
  echo "$total"
}

elapsed=0
max_seconds=$((TIMEOUT_MIN * 60))

echo "[drain] Waiting for worker to finish current jobs (timeout: ${TIMEOUT_MIN}m)..."

while true; do
  running=$(count_running)

  if [ "$running" -eq 0 ]; then
    echo "[drain] No running jobs — proceeding with worker restart"
    break
  fi

  if [ "$elapsed" -ge "$max_seconds" ]; then
    echo "[drain] Timeout reached (${TIMEOUT_MIN}m) — forcing worker restart anyway (${running} jobs still running)"
    break
  fi

  echo "[drain] ${running} job(s) still running... (${elapsed}s elapsed, timeout ${max_seconds}s)"
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done

# Останавливаем воркер (SIGTERM → процесс должен уже выйти сам, docker stop просто убирает контейнер)
echo "[drain] Stopping portal-worker container..."
docker stop portal-worker 2>/dev/null || true

echo "[drain] Worker stopped"
