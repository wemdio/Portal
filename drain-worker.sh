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

# Scheduled deploy passes the selected compose worker services. No arguments
# means an explicit/manual full drain for backward compatibility.
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

is_baseconstructor_worker() {
  case "$1" in
    worker-baseconstructor|worker-baseconstructor-*) return 0 ;;
    *) return 1 ;;
  esac
}

should_drain_baseconstructor_workers() {
  if [ -z "$requested_worker_targets" ]; then
    return 0
  fi
  for requested_target in $requested_worker_targets; do
    if is_baseconstructor_worker "$requested_target"; then
      return 0
    fi
  done
  return 1
}

should_drain_shared_worker_pool() {
  if [ -z "$requested_worker_targets" ]; then
    return 0
  fi
  for requested_target in $requested_worker_targets; do
    if is_baseconstructor_worker "$requested_target"; then
      continue
    fi
    # Manual scoring has its own fail-closed graceful drain below. A targeted
    # deploy must not pause queues or stop containers owned by other workers.
    if [ "$requested_target" = "worker-manual-scoring" ]; then
      continue
    fi
    return 0
  done
  return 1
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "[drain] python3 is required"
  exit 1
fi

# Bound Docker metadata reads without ever signalling the container. Python's
# timeout kills/waits only the local Docker CLI child if the daemon is stuck.
run_docker_readonly() {
  python3 - "$@" <<'PY'
import subprocess, sys

try:
    result = subprocess.run(
        sys.argv[1:],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
    )
except subprocess.TimeoutExpired:
    print('[drain] Docker metadata read timed out after 10s', file=sys.stderr)
    raise SystemExit(124)

if result.returncode != 0:
    sys.stderr.write(result.stderr)
    raise SystemExit(result.returncode)
sys.stdout.write(result.stdout)
PY
}

# .env is Docker configuration, not a shell script. In particular, unquoted
# PEM headers contain spaces; sourcing them aborts deployment before draining.
# Read only the two single-line settings used here, without evaluating values
# or exporting unrelated credentials into subprocesses. Compose reads its own
# complete environment separately.
read_drain_env() {
  python3 - "$1" <<'PY'
import os, re, sys
from pathlib import Path

key = sys.argv[1]
value = os.environ.get(key, '')
env_file = Path('.env')
if env_file.is_file():
    assignment = re.compile(r'^\s*(?:export\s+)?' + re.escape(key) + r'\s*=\s*(.*)$')
    for line in env_file.read_text(encoding='utf-8-sig').splitlines():
        match = assignment.match(line)
        if not match:
            continue
        value = match.group(1).strip()
        if value.startswith(('"', "'")):
            quoted = re.fullmatch(r'([\"\'])(.*?)\1\s*(?:#.*)?', value)
            if not quoted:
                sys.exit('[drain] Invalid single-line setting: ' + key)
            value = quoted.group(2)
        else:
            value = re.split(r'\s+#', value, maxsplit=1)[0].rstrip()
print(value)
PY
}

SUPABASE_URL="$(read_drain_env NEXT_PUBLIC_SUPABASE_URL)"
KEY="$(read_drain_env SUPABASE_SERVICE_ROLE_KEY)"

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

# Stop the VE2 coordinator before pausing/stopping any of its child workers.
# Do not add ve_jobs to the generic running->pending bulk update: a live parent
# must retain ownership until it saves its checkpoint and exits. Startup resumes
# its remaining running job. A failed stop aborts deployment before force_rm_svc.
if should_drain_worker "worker-vertical-engine-v2"; then
  echo "[drain] Gracefully stopping Vertical Engine v2 (up to 5m)..."
  COMPOSE_HTTP_TIMEOUT=360 DOCKER_CLIENT_TIMEOUT=360 \
    docker compose --env-file .env -p portal -f docker-compose.prod.yml stop worker-vertical-engine-v2
  echo "[drain] Vertical Engine v2 stopped"
fi

if should_drain_worker "worker-manual-scoring"; then
  manual_stop_timeout_seconds="${MANUAL_SCORING_DRAIN_TIMEOUT_SECONDS:-600}"
  if [[ ! "$manual_stop_timeout_seconds" =~ ^[0-9]+$ ]] \
      || [ "$manual_stop_timeout_seconds" -lt 1 ] \
      || [ "$manual_stop_timeout_seconds" -gt 600 ]; then
    echo "[drain] FATAL: MANUAL_SCORING_DRAIN_TIMEOUT_SECONDS must be 1..600" >&2
    exit 1
  fi
  echo "[drain] Gracefully stopping manual scoring (up to ${manual_stop_timeout_seconds}s)..."

  # Capture the exact running container before stopping it. Compose can return
  # success after its timeout has escalated SIGTERM to SIGKILL, so its status
  # alone is not proof that the worker persisted/released its owned lease.
  if ! manual_container_ids="$(
    run_docker_readonly docker compose --env-file .env -p portal -f docker-compose.prod.yml \
      ps -q worker-manual-scoring
  )"; then
    echo "[drain] FATAL: cannot inspect the running manual-scoring worker" >&2
    exit 1
  fi

  if [ -z "$manual_container_ids" ]; then
    echo "[drain] Manual scoring is not running; nothing to drain"
  elif [[ "$manual_container_ids" == *$'\n'* ]]; then
    echo "[drain] FATAL: expected one manual-scoring container, found multiple" >&2
    exit 1
  else
    # Docker's finite stop timeout escalates to SIGKILL itself. Use an
    # infinite daemon-side timeout and bound only this local waiting client;
    # timing out must leave the worker alive to finish/persist, then abort the
    # deploy before force_rm_svc.
    docker stop --timeout -1 "$manual_container_ids" &
    manual_stop_client_pid=$!
    manual_stopped_state=""
    manual_stop_verified=0
    manual_stop_deadline=$((SECONDS + manual_stop_timeout_seconds))

    while ((SECONDS < manual_stop_deadline)); do
      if ! manual_stopped_state="$(
        run_docker_readonly docker inspect --format '{{.State.Running}} {{.State.ExitCode}}' \
          "$manual_container_ids"
      )"; then
        kill "$manual_stop_client_pid" 2>/dev/null || true
        wait "$manual_stop_client_pid" 2>/dev/null || true
        echo "[drain] FATAL: cannot verify the manual-scoring worker; it was not force-killed" >&2
        exit 1
      fi

      if [[ "$manual_stopped_state" == false\ * ]]; then
        # A stopped container is not enough to make an unbounded `wait` safe:
        # the local Docker HTTP client can still hang while reading its reply.
        # Reap it only after it has exited; otherwise keep the same bounded poll.
        if kill -0 "$manual_stop_client_pid" 2>/dev/null; then
          sleep 1
          continue
        fi
        if wait "$manual_stop_client_pid"; then manual_stop_client_rc=0; else manual_stop_client_rc=$?; fi
        if [ "$manual_stop_client_rc" -ne 0 ]; then
          echo "[drain] FATAL: manual-scoring stop client failed (${manual_stop_client_rc}); aborting before forced removal" >&2
          exit 1
        fi
        manual_stop_verified=1
        break
      fi

      if ! kill -0 "$manual_stop_client_pid" 2>/dev/null; then
        if wait "$manual_stop_client_pid"; then
          manual_stop_client_rc=0
        else
          manual_stop_client_rc=$?
        fi
        echo "[drain] FATAL: manual-scoring stop client exited (${manual_stop_client_rc}) while the container is ${manual_stopped_state}; aborting before forced removal" >&2
        exit 1
      fi
      sleep 1
    done

    if [ "$manual_stop_verified" -ne 1 ]; then
      # This signal targets only the local `docker stop` CLI. The daemon was
      # told timeout=-1, so it never escalates the container to SIGKILL.
      kill "$manual_stop_client_pid" 2>/dev/null || true
      wait "$manual_stop_client_pid" 2>/dev/null || true
      if [[ "$manual_stopped_state" == false\ * ]]; then
        echo "[drain] FATAL: manual-scoring container exited but the stop client did not finish within ${manual_stop_timeout_seconds}s; deploy aborted before forced removal" >&2
      else
        echo "[drain] FATAL: manual-scoring did not stop within ${manual_stop_timeout_seconds}s; worker left running, deploy aborted before forced removal" >&2
      fi
      exit 1
    fi

    if [ "$manual_stopped_state" != "false 0" ]; then
      echo "[drain] FATAL: manual-scoring did not stop cleanly (${manual_stopped_state}); aborting before forced removal" >&2
      exit 1
    fi
    echo "[drain] Manual scoring stopped after its owned lease was persisted"
  fi
fi

if should_drain_shared_worker_pool && [ -n "$SUPABASE_URL" ] && [ -n "$KEY" ]; then
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
elif should_drain_shared_worker_pool; then
  echo "[drain] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase pause flow"
else
  echo "[drain] Dedicated-worker-only deploy — unrelated queues stay running"
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

if should_drain_shared_worker_pool; then
  containers=(
    "portal-worker"
    "portal-worker-hh"
    "portal-worker-eng-hiring"
    "portal-worker-polza-outreach"
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
    sudo -n docker stop -t 15 "$c" 2>/dev/null || true &
  done
  wait
fi

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
# Почему не в общий список выше: 15-секундный таймаут × 12 реплик = +180с к
# каждому деплою, а ждать тут нечего. Задача НЕ должна доиграть до конца —
# она резюмится с чекпоинта в другой реплике; хэндлеру нужно ~2 секунды
# (UPDATE + повторный UPDATE через секунду). Останавливаем параллельно,
# так весь шаг стоит ~5 секунд.
if should_drain_baseconstructor_workers; then
  bc_containers=(
    "portal-worker-baseconstructor"
    "portal-worker-baseconstructor-2"
    "portal-worker-baseconstructor-3"
    "portal-worker-baseconstructor-4"
    "portal-worker-baseconstructor-5"
    "portal-worker-baseconstructor-6"
    "portal-worker-baseconstructor-7"
    "portal-worker-baseconstructor-8"
    "portal-worker-baseconstructor-9"
    "portal-worker-baseconstructor-10"
    "portal-worker-baseconstructor-11"
    "portal-worker-baseconstructor-12"
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
fi

echo "[drain] Workers stopped (jobs are paused or marked for immediate resume)"
