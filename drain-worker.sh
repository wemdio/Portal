#!/usr/bin/env bash
# drain-worker.sh
#
# Что скрипт делает сейчас:
# 1) Снимает снимок активных задач (running) по legacy-таблицам очередей.
# 2) Переводит running -> pending, чтобы задачи возобновились после рестарта.
# 3) Ставит на паузу in-memory кампании (TG Outreach, AI Caller) и ставит им
#    job на автостарт после деплоя.
# 4) Отдельно и мягко тушит worker-autopipeline (его 20-минутный grace нужен,
#    чтобы прогон дописал свой префикс доменов).
#
# Чего скрипт намеренно НЕ делает:
# - не хранит списки контейнеров и не останавливает воркеры: SIGTERM всем
#   выбранным сервисам шлёт сам деплой (`docker compose stop --timeout 15`
#   в шаге 5 .semaphore/scheduled-deploy.yml), поэтому список не может
#   разъехаться с docker-compose.prod.yml;
# - не трогает таблицы воркеров, переехавших на общий жизненный цикл задач
#   (app/src/lib/jobs/lifecycle.ts): base_constructor_jobs, tg_parser_jobs,
#   search_parser_jobs и sales_chat_sync_runs.
#   Такие воркеры по SIGTERM сами отпускают аренду за ~2 секунды, а задача
#   продолжается с чекпоинта в соседней реплике — БД трогать не нужно.
#
# По мере переезда остальных воркеров на общий жизненный цикл скрипт
# сокращается до нуля и удаляется целиком.
#
# Важно: задача не должна уходить в failed из-за самого деплоя.

set -euo pipefail

# Scheduled deploy passes the selected compose worker services.
#
# Без аргументов скрипт ставит на паузу ВСЕ legacy-очереди и тушит
# worker-autopipeline, но контейнеры остальных воркеров он больше не трогает —
# они останутся живыми и в течение одного poll-интервала разберут обратно
# строки, которые скрипт только что вернул в pending. При ручном запуске
# остановку контейнеров обязан сделать сам вызывающий, например:
#   docker compose --env-file .env -p portal -f docker-compose.prod.yml \
#     stop --timeout 15 <сервисы>
# (именно это делает шаг 3 .semaphore/scheduled-deploy.yml сразу после вызова).
requested_worker_targets="$*"

should_drain_worker() {
  local service="$1"
  if [ -z "$requested_worker_targets" ]; then
    return 0
  fi
  case " $requested_worker_targets " in
    *" $service "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Воркеры на общем жизненном цикле задач (app/src/lib/jobs/lifecycle.ts)
# передают задачу сами: их таблицы и очереди не трогаем.
is_lifecycle_managed_worker() {
  case "$1" in
    worker-baseconstructor|worker-baseconstructor-*) return 0 ;;
    worker-tg-parser) return 0 ;;
    worker-search) return 0 ;;
    worker-sales-chat-logger) return 0 ;;
    *) return 1 ;;
  esac
}

# Пауза legacy-очередей нужна, только если деплой задевает хотя бы один воркер,
# который ещё не переехал на общий жизненный цикл.
should_pause_legacy_queues() {
  if [ -z "$requested_worker_targets" ]; then
    return 0
  fi
  for requested_target in $requested_worker_targets; do
    if ! is_lifecycle_managed_worker "$requested_target"; then
      return 0
    fi
  done
  return 1
}

if [ -f .env ]; then
  set -o allexport
  source <(tr -d '\r' < .env)
  set +o allexport
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[drain] python3 is required"
  exit 1
fi

auth_headers=(
  -H "apikey: ${KEY}"
  -H "Authorization: Bearer ${KEY}"
)

extract_ids_csv() {
  python3 -c "import json,sys
raw=sys.stdin.read().strip()
if not raw:
    print('')
    raise SystemExit(0)
try:
    data=json.loads(raw)
except Exception:
    print('')
    raise SystemExit(0)
ids=[str(row.get('id','')).strip() for row in data if isinstance(row,dict)]
ids=[x for x in ids if x]
print(','.join(ids))"
}

count_json_rows() {
  python3 -c "import json,sys
raw=sys.stdin.read().strip()
if not raw:
    print(0)
    raise SystemExit(0)
try:
    data=json.loads(raw)
except Exception:
    print(0)
    raise SystemExit(0)
print(len(data) if isinstance(data,list) else 0)"
}

fetch_running_rows() {
  local table="$1"
  local select_clause="$2"
  curl -sS "${SUPABASE_URL}/rest/v1/${table}?status=eq.running&select=${select_clause}" "${auth_headers[@]}"
}

patch_rows() {
  local table="$1"
  local filter="$2"
  local body="$3"
  curl -sS -X PATCH \
    "${SUPABASE_URL}/rest/v1/${table}?${filter}" \
    "${auth_headers[@]}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=minimal" \
    -d "${body}" \
    --write-out '%{http_code}' -o /dev/null 2>/dev/null || echo "000"
}

patch_running_to_pending() {
  local table="$1"
  local body="${2:-{\"status\":\"pending\"}}"
  patch_rows "$table" "status=eq.running" "$body"
}

if should_pause_legacy_queues && [ -n "$SUPABASE_URL" ] && [ -n "$KEY" ]; then
  echo "[drain] Checking active running tasks before deploy..."

  total_running=0
  tracked_tables=(
    "parser_jobs"
    "website_enrichment_jobs"
    "brief_scoring_jobs"
    "yandex_maps_jobs"
    "email_validation_jobs"
    "lead_import_jobs"
    "tg_outreach_jobs"
    "ai_caller_jobs"
    "tg_scan_jobs"
    "tg_transcribe_jobs"
  )

  for table in "${tracked_tables[@]}"; do
    rows="$(fetch_running_rows "$table" "id" 2>/dev/null || true)"
    count="$(printf '%s' "$rows" | count_json_rows)"
    total_running=$((total_running + count))
    ids="$(printf '%s' "$rows" | extract_ids_csv)"
    if [ "$count" -gt 0 ]; then
      echo "[drain] ${table}: running=${count}; ids=${ids}"
    else
      echo "[drain] ${table}: running=0"
    fi
  done
  echo "[drain] Total running jobs before pause: ${total_running}"

  echo "[drain] Marking running trace spans as cancelled..."
  ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  if [ -z "$ended_at" ]; then
    trace_patch='{"status":"cancelled"}'
  else
    trace_patch="{\"status\":\"cancelled\",\"ended_at\":\"${ended_at}\"}"
  fi
  trace_code="$(curl -sS -X PATCH \
    "${SUPABASE_URL}/rest/v1/trace_spans?status=eq.running" \
    "${auth_headers[@]}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=minimal" \
    -d "$trace_patch" \
    --write-out '%{http_code}' -o /dev/null 2>/dev/null || echo "000")"
  if [[ "$trace_code" =~ ^(200|204)$ ]]; then
    echo "[drain] trace_spans: running -> cancelled"
  fi

  echo "[drain] Pausing running jobs (running -> pending)..."
  for table in "${tracked_tables[@]}"; do
    code="$(patch_running_to_pending "$table")"
    if [[ "$code" =~ ^(200|204)$ ]]; then
      echo "[drain] ${table}: paused to pending"
    else
      echo "[drain] ${table}: pause request returned http ${code}"
    fi
  done

  # TG Outreach campaign loops run in-memory, so we explicitly:
  # running campaign -> paused, then queue "start" job for auto-resume.
  tg_rows="$(fetch_running_rows "tg_outreach_campaigns" "id,user_id" 2>/dev/null || true)"
  tg_count="$(printf '%s' "$tg_rows" | count_json_rows)"
  if [ "$tg_count" -gt 0 ]; then
    echo "[drain] tg_outreach_campaigns: running=${tg_count}; scheduling auto-resume"
    tg_pause_code="$(patch_running_to_pending "tg_outreach_campaigns" "{\"status\":\"paused\",\"updated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}")"
    if [[ "$tg_pause_code" =~ ^(200|204)$ ]]; then
      echo "[drain] tg_outreach_campaigns: running -> paused"
    fi

    export TG_RUNNING_ROWS="$tg_rows"
    python3 - <<'PY' > /tmp/portal_tg_resume_jobs.json
import json, os, sys
raw = os.environ.get("TG_RUNNING_ROWS", "")
out = []
try:
    data = json.loads(raw) if raw else []
except Exception:
    data = []
for row in data:
    if not isinstance(row, dict):
        continue
    cid = str(row.get("id", "")).strip()
    uid = str(row.get("user_id", "")).strip()
    if cid and uid:
        out.append({"campaign_id": cid, "user_id": uid, "action": "start", "status": "pending"})
print(json.dumps(out, ensure_ascii=True))
PY

    if [ -s /tmp/portal_tg_resume_jobs.json ]; then
      resume_payload="$(cat /tmp/portal_tg_resume_jobs.json)"
      if [ "${resume_payload}" != "[]" ]; then
        curl -sS -X POST \
          "${SUPABASE_URL}/rest/v1/tg_outreach_jobs" \
          "${auth_headers[@]}" \
          -H "Content-Type: application/json" \
          -H "Prefer: return=minimal" \
          -d "${resume_payload}" >/dev/null 2>&1 || true
        echo "[drain] tg_outreach_jobs: queued start jobs for paused campaigns"
      fi
    fi
    rm -f /tmp/portal_tg_resume_jobs.json || true
  else
    echo "[drain] tg_outreach_campaigns: running=0"
  fi

  # AI Caller campaigns: running -> paused, then queue "start" job for auto-resume.
  ai_rows="$(fetch_running_rows "ai_campaigns" "id,created_by" 2>/dev/null || true)"
  ai_count="$(printf '%s' "$ai_rows" | count_json_rows)"
  if [ "$ai_count" -gt 0 ]; then
    echo "[drain] ai_campaigns: running=${ai_count}; scheduling auto-resume"
    ai_pause_code="$(patch_running_to_pending "ai_campaigns" "{\"status\":\"paused\",\"updated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}")"
    if [[ "$ai_pause_code" =~ ^(200|204)$ ]]; then
      echo "[drain] ai_campaigns: running -> paused"
    fi

    export AI_RUNNING_ROWS="$ai_rows"
    python3 - <<'PY' > /tmp/portal_ai_resume_jobs.json
import json, os
raw = os.environ.get("AI_RUNNING_ROWS", "")
out = []
try:
    data = json.loads(raw) if raw else []
except Exception:
    data = []
for row in data:
    if not isinstance(row, dict):
        continue
    cid = str(row.get("id", "")).strip()
    uid = str(row.get("created_by", "")).strip()
    if cid and uid:
        out.append({"campaign_id": cid, "user_id": uid, "action": "start", "status": "pending"})
print(json.dumps(out, ensure_ascii=True))
PY

    if [ -s /tmp/portal_ai_resume_jobs.json ]; then
      resume_payload="$(cat /tmp/portal_ai_resume_jobs.json)"
      if [ "${resume_payload}" != "[]" ]; then
        curl -sS -X POST \
          "${SUPABASE_URL}/rest/v1/ai_caller_jobs" \
          "${auth_headers[@]}" \
          -H "Content-Type: application/json" \
          -H "Prefer: return=minimal" \
          -d "${resume_payload}" >/dev/null 2>&1 || true
        echo "[drain] ai_caller_jobs: queued start jobs for paused campaigns"
      fi
    fi
    rm -f /tmp/portal_ai_resume_jobs.json || true
  else
    echo "[drain] ai_campaigns: running=0"
  fi
elif should_pause_legacy_queues; then
  echo "[drain] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase pause flow"
else
  echo "[drain] Deploy touches only lifecycle-managed workers — legacy queues stay running"
fi

if should_drain_worker "worker-autopipeline"; then
  echo "[drain] Gracefully stopping auto-pipeline (Compose grace period: 20m)..."
  # The worker stops assigning new domains after SIGTERM, persists its
  # completed prefix, and marks the run for resume. Override the generic
  # five-minute Docker client timeout so Compose can honor stop_grace_period.
  COMPOSE_HTTP_TIMEOUT=1500 DOCKER_CLIENT_TIMEOUT=1500 \
    docker compose --env-file .env -p portal -f docker-compose.prod.yml stop worker-autopipeline
  echo "[drain] Auto-pipeline stopped cleanly"
fi

echo "[drain] Legacy job queues paused; stopping containers is the deploy's job now"
