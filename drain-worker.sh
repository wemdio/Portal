#!/usr/bin/env bash
# drain-worker.sh
#
# Мягкая "пауза перед деплоем":
# 1) Снимаем снимок активных задач (running) по таблицам очередей.
# 2) Переводим running -> pending, чтобы задачи автоматически возобновились после рестарта.
# 3) Сигнализируем и останавливаем worker-контейнеры.
# 4) Для BaseConstructor помечаем processing-задачи для немедленного resume.
#
# Важно: задача не должна уходить в failed из-за самого деплоя.

set -euo pipefail

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

if [ -n "$SUPABASE_URL" ] && [ -n "$KEY" ]; then
  echo "[drain] Checking active running tasks before deploy..."

  total_running=0
  tracked_tables=(
    "parser_jobs"
    "search_parser_jobs"
    "website_enrichment_jobs"
    "brief_scoring_jobs"
    "yandex_maps_jobs"
    "email_validation_jobs"
    "lead_import_jobs"
    "tg_outreach_jobs"
    "ai_caller_jobs"
    "tg_parser_jobs"
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
else
  echo "[drain] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase pause flow"
fi

containers=(
  "portal-worker"
  "portal-worker-hh"
  "portal-worker-eng-hiring"
  "portal-worker-search"
  "portal-worker-enrich"
  "portal-worker-yandexmaps"
  "portal-worker-emailvalidation"
  "portal-worker-tg-outreach"
  "portal-worker-aicaller"
  "portal-worker-tg-transcribe"
  "portal-worker-outreach"
)

echo "[drain] Stopping worker containers (timeout 15s each)..."
for c in "${containers[@]}"; do
  sudo -n docker stop -t 15 "$c" 2>/dev/null || true
done

# BaseConstructor-реплики останавливаем отдельно и с коротким таймаутом.
#
# Зачем вообще (инцидент 11.08.2026, деплой 15:10): всё, чего нет в этом
# скрипте, деплой убивает через force_rm_svc → `docker rm -f`, то есть
# SIGKILL'ом без сигнала. Обработчик SIGTERM в app/worker/baseConstructor.ts
# (ageRunningJobsForFastHandoff) при этом не выполняется, in-flight job'ы не
# помечаются осиротевшими, и соседняя реплика подбирает их только по
# BASE_CONSTRUCTOR_STALE_MINUTES — 15 минут простоя на ровном месте плюс
# ложная тревога «Долго висит» в мониторе.
#
# Почему не в общий список выше: 15-секундный таймаут × 3 реплики = +45с к
# каждому деплою, а ждать тут нечего. Задача НЕ должна доиграть до конца —
# она резюмится с чекпоинта в другой реплике; хэндлеру нужно ~2 секунды
# (UPDATE + повторный UPDATE через секунду). Останавливаем параллельно,
# так весь шаг стоит ~5 секунд.
bc_containers=(
  "portal-worker-baseconstructor"
  "portal-worker-baseconstructor-2"
  "portal-worker-baseconstructor-3"
)

echo "[drain] Stopping base-constructor replicas (timeout 5s, in parallel)..."
for c in "${bc_containers[@]}"; do
  sudo -n docker stop -t 5 "$c" 2>/dev/null || true &
done
wait

# The worker-side shutdown guard normally ages each processing job before exit.
# Keep a deployment-side backstop after every replica has stopped so a failed
# signal handler or database request cannot leave a fresh heartbeat behind.
if [ -n "$SUPABASE_URL" ] && [ -n "$KEY" ]; then
  base_constructor_handoff_code="$(patch_rows "base_constructor_jobs" "status=eq.processing" '{"started_at":"1970-01-01T00:00:00Z"}')"
  if [[ "$base_constructor_handoff_code" =~ ^(200|204)$ ]]; then
    echo "[drain] base_constructor_jobs: processing jobs marked for immediate resume"
  else
    echo "[drain] base_constructor_jobs: handoff request returned http ${base_constructor_handoff_code}"
  fi
fi

echo "[drain] Workers stopped (jobs are paused or marked for immediate resume)"
