#!/usr/bin/env bash
# drain-worker.sh
#
# Ждёт пока воркер закончит текущую задачу, затем останавливает его.
# Используется в деплое: запускается перед обновлением образов.
#
# Переменные (берутся из .env):
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#   WORKER_DRAIN_TIMEOUT_MINUTES (default: 15)

set -euo pipefail

TIMEOUT_MIN="${WORKER_DRAIN_TIMEOUT_MINUTES:-15}"
POLL_INTERVAL=15  # секунд между проверками

# Загружаем env если не пришли снаружи
if [ -f .env ]; then
  set -o allexport
  # На сервере .env может быть с CRLF (Windows), тогда `source` падает на $'\r'.
  # Нормализуем окончания строк на лету.
  source <(tr -d '\r' < .env)
  set +o allexport
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

if [ -z "$SUPABASE_URL" ] || [ -z "$KEY" ]; then
  echo "[drain] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping drain wait"
  exit 0
fi

count_running() {
  local tables=(
    "parser_jobs:parser"
    "search_parser_jobs:search_parser"
    "website_enrichment_jobs:website_enrichment"
    "yandex_maps_jobs:yandex_maps"
  )
  local total=0
  local parts=()
  for item in "${tables[@]}"; do
    local table="${item%%:*}"
    local label="${item#*:}"
    local n
    n=$(curl -s \
      "${SUPABASE_URL}/rest/v1/${table}?status=eq.running&select=id" \
      -H "apikey: ${KEY}" \
      -H "Authorization: Bearer ${KEY}" \
      -H "Prefer: count=exact" \
      --write-out '%{header_json}' -o /dev/null 2>/dev/null \
      | python3 -c "import sys,json; h=json.load(sys.stdin); print(h.get('content-range',['0'])[0].split('/')[-1])" 2>/dev/null || echo 0)
    n="${n:-0}"
    case "$n" in
      ''|*[!0-9]*) n=0 ;;
    esac
    total=$((total + n))
    if [ "$n" -gt 0 ]; then
      parts+=("${label}=${n}")
    fi
  done
  # Важно: эту функцию вызываем через process substitution (см. ниже),
  # потому что $(count_running) выполнит её в subshell и "потеряет" детали.
  printf '%s\t%s\n' "$total" "${parts[*]:-}"
}

elapsed=0
max_seconds=$((TIMEOUT_MIN * 60))

echo "[drain] Waiting for worker to finish current jobs (timeout: ${TIMEOUT_MIN}m)..."

while true; do
  running_detail=""
  IFS=$'\t' read -r running running_detail < <(count_running)

  if [ "$running" -eq 0 ]; then
    echo "[drain] No running jobs — proceeding with worker restart"
    break
  fi

  if [ "$elapsed" -ge "$max_seconds" ]; then
    echo "[drain] Timeout reached (${TIMEOUT_MIN}m) — forcing worker restart anyway (${running} jobs still running)"
    break
  fi

  if [ -n "${running_detail:-}" ]; then
    echo "[drain] ${running} job(s) still running (${running_detail})... (${elapsed}s elapsed, timeout ${max_seconds}s)"
  else
    echo "[drain] ${running} job(s) still running... (${elapsed}s elapsed, timeout ${max_seconds}s)"
  fi
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done

# Останавливаем воркеры (SIGTERM → процесс должен уже выйти сам, docker stop просто убирает контейнер)
# Поддерживаем старое имя `portal-worker` и новые раздельные воркеры.
containers=(
  "portal-worker"
  "portal-worker-hh"
  "portal-worker-search"
  "portal-worker-enrich"
  "portal-worker-yandexmaps"
)

echo "[drain] Stopping worker containers..."
for c in "${containers[@]}"; do
  docker stop "$c" 2>/dev/null || true
done

echo "[drain] Workers stopped"
