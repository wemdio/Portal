#!/bin/sh
# Select production deploy targets from a newline-delimited list of changed files.
# The functions are sourced by scheduled-deploy.yml and by the shell tests.

ALL_CORE_SERVICES="portal yandexmaps googleparsers transcribe-worker guacd rdp-ws telegram-bot-api health-check loop-watchdog atmos-bot instantly-sync-bot portal-external-sync changelog-bot polza-reports autoheal"
ALL_WORKER_SERVICES="worker-hh worker-eng-hiring worker-search worker-enrich worker-enrich-2 worker-enrich-3 worker-enrich-4 worker-enrich-5 worker-enrich-6 worker-enrich-7 worker-enrich-8 worker-enrich-9 worker-enrich-coordinator worker-yandexmaps worker-googleparsers worker-emailvalidation worker-inn-enrich worker-website-inn-lookup worker-tg-outreach worker-aicaller worker-sales-copilot worker-sales-ai-analysis worker-leads-report worker-leads-report-bot worker-byo-send worker-byo-replies worker-sales-chat-logger worker-sales-chat-archive worker-tg-parser worker-tg-transcribe worker-instantly-leads worker-outreach worker-li-outreach worker-baseconstructor worker-baseconstructor-2 worker-baseconstructor-3 worker-baseconstructor-4 worker-baseconstructor-5 worker-baseconstructor-6 worker-baseconstructor-7 worker-baseconstructor-8 worker-baseconstructor-9 worker-baseconstructor-10 worker-baseconstructor-11 worker-baseconstructor-12 worker-client-report-exports worker-bob-scorer worker-manual-scoring worker-autopipeline worker-autorenew worker-hypothesis-engine worker-vertical-engine-v2"

add_core_service() {
  service="$1"
  case " ${CORE_SERVICES} " in
    *" ${service} "*) ;;
    *) CORE_SERVICES="${CORE_SERVICES}${CORE_SERVICES:+ }${service}" ;;
  esac
}

select_deploy_targets_from_files() {
  CHANGED_FILES="$1"
  DEPLOY_ALL=0
  DEPLOY_PORTAL=0
  DEPLOY_WORKERS=0
  DEPLOY_IDB_STACK=0
  DEPLOY_BACKUP=0
  DEPLOY_DATASET_SYNC=0
  CORE_SERVICES=""
  WORKER_SERVICES=""

  while IFS= read -r changed_path; do
    [ -n "$changed_path" ] || continue
    case "$changed_path" in
      docker-compose.prod.yml)
        DEPLOY_ALL=1
        ;;
      app/scripts/instantly-dataset/wiki/*)
        # Доки agent_wiki грузятся в БД вручную (load-agent-wiki.mjs), CI-шаг синка
        # их не копирует → для них прежнее поведение app/* без цели dataset_sync.
        DEPLOY_PORTAL=1
        DEPLOY_WORKERS=1
        ;;
      app/scripts/instantly-dataset/*)
        # Ночной синк instantly_dataset живёт ВНЕ compose: /opt/instantly-dataset-sync
        # на portal host, крон запускает docker run node:22-alpine с этой папкой.
        # До 2026-08 туда попадал только ручной deploy-sync.sh — мерж в main синк
        # не обновлял. Теперь scheduled-deploy копирует код (*.mjs, *.sql) сам.
        # Образы приложения тоже копируют app/, поэтому поведение app/* сохраняем.
        # Полный деплой (DEPLOY_ALL) синк НЕ трогает: он деплоится только по
        # явному изменению своих файлов, чтобы слепая копия не откатила хотфикс,
        # выкаченный deploy-sync.sh раньше мержа.
        DEPLOY_PORTAL=1
        DEPLOY_WORKERS=1
        DEPLOY_DATASET_SYNC=1
        ;;
      app/src/app/*|app/src/components/*|app/src/middleware.ts|app/public/*)
        # Next.js-only surface: routes, UI components, middleware and public
        # assets are served by the Portal container. Worker bundles are built
        # from app/worker/* plus the shared runtime code under app/src/lib/*.
        DEPLOY_PORTAL=1
        ;;
      app/*)
        # Both production images copy app/. A shared app change can affect any
        # worker bundle, so the monolithic worker image is deployed as a unit.
        DEPLOY_PORTAL=1
        DEPLOY_WORKERS=1
        ;;
      Dockerfile.worker)
        DEPLOY_WORKERS=1
        ;;
      Dockerfile|entrypoint.sh|supabase/migrations/*)
        DEPLOY_PORTAL=1
        ;;
      supabase/instantly-migrations/*)
        DEPLOY_PORTAL=1
        DEPLOY_IDB_STACK=1
        ;;
      services/backup/*)
        DEPLOY_BACKUP=1
        ;;
      deploy/instantly-db/docker-compose.yml)
        DEPLOY_IDB_STACK=1
        DEPLOY_BACKUP=1
        ;;
      deploy/instantly-db/scripts/*|deploy/instantly-db/main-init/*)
        DEPLOY_IDB_STACK=1
        ;;
      services/yandexmaps/*) add_core_service yandexmaps ;;
      services/googleparsers/*) add_core_service googleparsers ;;
      services/transcribe-worker/*) add_core_service transcribe-worker ;;
      services/rdp-ws/*) add_core_service rdp-ws ;;
      services/health-check/*) add_core_service health-check ;;
      services/loop-watchdog/*) add_core_service loop-watchdog ;;
      services/atmos-bot/*) add_core_service atmos-bot ;;
      services/instantly-sync-bot/*) add_core_service instantly-sync-bot ;;
      services/portal-external-sync/*) add_core_service portal-external-sync ;;
      services/changelog-bot/*) add_core_service changelog-bot ;;
      services/polza-reports/*) add_core_service polza-reports ;;

      # Repository/CI/docs/ops-only changes do not require container restarts.
      .semaphore/*|.claude/*|.impeccable/*|docs/*|wiki/*|scripts/*|deploy/nginx/*|deploy/main-db/*|deploy/main-db-prod/*|deploy/instantly-db-prod/*|services/smtp-proxy/*|drain-worker.sh|docker-compose.yml|docker-compose.rdp.yml|README.md|CLAUDE.md|DESIGN.md|PRODUCT.md|*.md|.gitignore|.dockerignore|test_*.py|tmp_*.py|package-lock.json)
        ;;
      *)
        # Unknown production-impacting paths fail safe: deploy everything until
        # the new path gets an explicit mapping above.
        DEPLOY_ALL=1
        ;;
    esac
  done <<EOF
${CHANGED_FILES}
EOF

  if [ "$DEPLOY_ALL" = 1 ]; then
    DEPLOY_PORTAL=1
    DEPLOY_WORKERS=1
    DEPLOY_IDB_STACK=1
    DEPLOY_BACKUP=1
    CORE_SERVICES="$ALL_CORE_SERVICES"
    WORKER_SERVICES="$ALL_WORKER_SERVICES"
  else
    if [ "$DEPLOY_PORTAL" = 1 ]; then
      add_core_service portal
    fi
    if [ "$DEPLOY_WORKERS" = 1 ]; then
      WORKER_SERVICES="$ALL_WORKER_SERVICES"
    fi
  fi

  if [ -n "$CORE_SERVICES" ] || [ -n "$WORKER_SERVICES" ]; then
    DEPLOY_PORTAL_HOST=1
  else
    DEPLOY_PORTAL_HOST=0
  fi
}

select_deploy_targets() {
  base_sha="$1"
  head_sha="$2"

  if [ -z "$base_sha" ] || ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
    echo "[deploy-plan] Last deployed commit is unavailable; using safe full deploy." >&2
    select_deploy_targets_from_files docker-compose.prod.yml
    return
  fi

  changed_files=$(git diff --name-only "$base_sha" "$head_sha")
  select_deploy_targets_from_files "$changed_files"
}

print_deploy_plan() {
  echo "[deploy-plan] changed files:"
  if [ -n "$CHANGED_FILES" ]; then
    printf '%s\n' "$CHANGED_FILES" | sed 's/^/  - /'
  else
    echo "  - <none>"
  fi
  echo "[deploy-plan] full=${DEPLOY_ALL} portal=${DEPLOY_PORTAL} workers=${DEPLOY_WORKERS} idb=${DEPLOY_IDB_STACK} backup=${DEPLOY_BACKUP} dataset_sync=${DEPLOY_DATASET_SYNC}"
  echo "[deploy-plan] core services: ${CORE_SERVICES:-<none>}"
  echo "[deploy-plan] worker services: ${WORKER_SERVICES:-<none>}"
}
