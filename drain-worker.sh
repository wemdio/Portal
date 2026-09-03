#!/usr/bin/env bash
# drain-worker.sh
#
# Что скрипт делает сейчас:
# 1) Снимает снимок активных задач (running) по legacy-таблицам очередей.
# 2) Переводит running -> pending, чтобы задачи возобновились после рестарта.
# 3) Отдельно и мягко тушит worker-autopipeline (его 20-минутный grace нужен,
#    чтобы прогон дописал свой префикс доменов).
#
# Чего скрипт намеренно НЕ делает:
# - не хранит списки контейнеров и не останавливает воркеры: SIGTERM всем
#   выбранным сервисам шлёт сам деплой (`docker compose stop --timeout 15`
#   в шаге 5 .semaphore/scheduled-deploy.yml), поэтому список не может
#   разъехаться с docker-compose.prod.yml;
# - не трогает таблицы воркеров, переехавших на общий жизненный цикл задач
#   (app/src/lib/jobs/lifecycle.ts): base_constructor_jobs, tg_parser_jobs,
#   search_parser_jobs, yandex_maps_jobs, parser_jobs (HH/ATS/ENG-найм),
#   ai_campaigns с ai_caller_jobs (обзвон), tg_outreach_campaigns с
#   tg_outreach_warmup_runs и tg_outreach_jobs (TG-аутрич и прогрев) и
#   email_validation_jobs (валидация почт).
#   Очередь sales_chat_sync_runs в списке ниже не значилась
#   и не значится — искать, откуда её убрали, не нужно; воркер этой очереди
#   просто добавлен в is_lifecycle_managed_worker, чтобы деплой одного его не
#   ставил на паузу чужие legacy-очереди.
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
    worker-yandexmaps) return 0 ;;
    worker-hh) return 0 ;;
    worker-eng-hiring) return 0 ;;
    worker-aicaller) return 0 ;;
    worker-tg-outreach) return 0 ;;
    worker-emailvalidation) return 0 ;;
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
    # parser_jobs убран: HH-, ATS- и ENG-парсеры на едином жизненном цикле,
    # захват идёт с фильтром по parser_type. Сброс всех running в pending
    # отсюда отбирал бы строку у ещё живого исполнителя — в том числе у
    # соседнего воркера, которого этот деплой не касается.
    "website_enrichment_jobs"
    "brief_scoring_jobs"
    # yandex_maps_jobs убран: воркер Яндекс.Карт на едином жизненном цикле сам
    # отпускает аренду по SIGTERM, а задача продолжается с сохранённых ссылок и
    # карточек в следующей реплике. Сброс её в pending отсюда только отбирал бы
    # строку у ещё живого исполнителя.
    # email_validation_jobs убран: воркер валидации почт на едином жизненном
    # цикле. Задача продолжается с оставшихся строк email_validation_queue —
    # проверенные адреса не переигрываются и не оплачиваются заново. Сброс в
    # pending отсюда отбирал бы строку у живого исполнителя (реплика одна, но
    # одиночный рестарт оставляет рядом работающий контейнер) и обнулял бы
    # владение под ним.
    "lead_import_jobs"
    # tg_outreach_jobs убран: очередь стала каналом мгновенных команд оператора
    # («старт», «стоп», «обновить переписки»), а сама кампания живёт своей
    # строкой под арендой. Команда «старт» больше не висит в running всё время
    # работы кампании — сбрасывать здесь нечего.
    # ai_caller_jobs убран: очередь стала каналом мгновенных команд оператора
    # («старт», «стоп»), которые закрываются тем же запросом, что их берёт.
    # Строки в `running` в ней больше не задерживаются, а сама кампания живёт
    # своей строкой под арендой — сбрасывать здесь нечего.
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

  # Кампании TG-аутрича (tg_outreach_campaigns) здесь БОЛЬШЕ НЕ ТРОГАЮТСЯ.
  #
  # Раньше на этом месте был блок «running -> paused + положить команду старт»:
  # цикл кампании жил в памяти процесса, и без него кампания после деплоя просто
  # не возобновлялась. Воркер portal-worker-tg-outreach переехал на общий
  # жизненный цикл задач — строка кампании арендуется, по SIGTERM воркер сначала
  # закрывает клиенты Telegram, потом отпускает аренду, и кампанию подхватывает
  # следующая реплика с чекпойнта. Пауза здесь теперь была бы вредна дважды: она
  # останавливала бы кампанию, которую никто не просил останавливать, а команда
  # «старт» ещё и воскрешала бы ту, которую оператор остановил руками.

  # Кампании обзвона (ai_campaigns) здесь БОЛЬШЕ НЕ ТРОГАЮТСЯ.
  #
  # Раньше на этом месте был блок «running -> paused + положить команду старт»:
  # цикл кампании жил в памяти процесса, и без него кампания после деплоя просто
  # не возобновлялась. Воркер portal-worker-aicaller переехал на общий
  # жизненный цикл задач — строка кампании арендуется, по SIGTERM аренда
  # отпускается за пару секунд, и кампанию подхватывает следующая реплика сама.
  # Пауза здесь теперь была бы вредна дважды: она останавливала бы кампанию,
  # которую никто не просил останавливать, а команда «старт» ещё и воскрешала бы
  # ту, которую оператор остановил руками.
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
