#!/bin/sh
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/select-deploy-targets.sh"

PASS=0
FAIL=0

assert_eq() {
  actual="$1"
  expected="$2"
  name="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    echo "  ✔ $name"
  else
    FAIL=$((FAIL + 1))
    echo "  ✘ $name (actual='$actual', expected='$expected')"
  fi
}

BASE_CONSTRUCTOR_WORKER_SERVICES="worker-baseconstructor worker-baseconstructor-2 worker-baseconstructor-3 worker-baseconstructor-4 worker-baseconstructor-5 worker-baseconstructor-6 worker-baseconstructor-7 worker-baseconstructor-8 worker-baseconstructor-9 worker-baseconstructor-10 worker-baseconstructor-11 worker-baseconstructor-12"

assert_base_constructor_selection() {
  expected_bc_services="$1"
  assertion_name="$2"
  selected_bc_services=""

  for bc_service in $BASE_CONSTRUCTOR_WORKER_SERVICES; do
    case " ${WORKER_SERVICES} " in
      *" ${bc_service} "*)
        selected_bc_services="${selected_bc_services}${selected_bc_services:+ }${bc_service}"
        ;;
    esac
  done

  assert_eq "$selected_bc_services" "$expected_bc_services" "$assertion_name"
}

select_deploy_targets_from_files 'services/backup/crontab
docs/instantly-local-pg-cutover.md'
assert_eq "$DEPLOY_BACKUP" 1 "backup change deploys backup"
assert_eq "$DEPLOY_IDB_STACK" 0 "backup change does not restart DB stack"
assert_eq "$DEPLOY_PORTAL_HOST" 0 "backup change does not restart Portal host"

select_deploy_targets_from_files 'services/yandexmaps/main.py'
assert_eq "$CORE_SERVICES" yandexmaps "one microservice change selects one service"
assert_eq "$DEPLOY_WORKERS" 0 "microservice change does not restart workers"

select_deploy_targets_from_files 'app/src/lib/example.ts'
assert_eq "$CORE_SERVICES" portal "app change selects Portal"
assert_eq "$DEPLOY_WORKERS" 1 "app change selects shared worker image"
assert_eq "$WORKER_SERVICES" "$ALL_WORKER_SERVICES" "app change selects every shared-image worker"
assert_eq "$DEPLOY_DATASET_SYNC" 0 "generic app change does not deploy dataset sync"

# UI/API-only releases must not recreate long-running Base Constructor workers.
# Those workers are selected only when their own runtime or persistence contract
# changes, so an unrelated Portal release cannot reset an in-flight validation.
select_deploy_targets_from_files 'app/src/components/projects/ProjectCard.tsx'
assert_eq "$DEPLOY_PORTAL" 1 "unrelated UI change still deploys Portal"
assert_eq "$DEPLOY_WORKERS" 0 "unrelated UI change does not schedule a worker drain"
assert_base_constructor_selection "" "unrelated UI change leaves Base Constructor replicas running"

select_deploy_targets_from_files 'app/src/app/api/projects/route.ts'
assert_eq "$DEPLOY_PORTAL" 1 "unrelated API change still deploys Portal"
assert_eq "$DEPLOY_WORKERS" 0 "unrelated API change does not schedule a worker drain"
assert_base_constructor_selection "" "unrelated API change leaves Base Constructor replicas running"

select_deploy_targets_from_files 'app/worker/baseConstructor.ts'
assert_base_constructor_selection "$BASE_CONSTRUCTOR_WORKER_SERVICES" "Base Constructor worker change selects every replica"

select_deploy_targets_from_files 'app/src/lib/tools/processingSteps.ts'
assert_base_constructor_selection "$BASE_CONSTRUCTOR_WORKER_SERVICES" "shared Base Constructor processing change selects every replica"
assert_eq "$WORKER_SERVICES" "$ALL_WORKER_SERVICES" "shared processingSteps change keeps the monolithic worker pool on one image revision"

select_deploy_targets_from_files 'supabase/migrations/20260901000000_base_constructor_resume_guard.sql'
assert_base_constructor_selection "$BASE_CONSTRUCTOR_WORKER_SERVICES" "Base Constructor migration selects every replica"

select_deploy_targets_from_files 'app/src/middleware.ts'
assert_eq "$CORE_SERVICES" portal "Next middleware change selects Portal"
assert_eq "$DEPLOY_WORKERS" 0 "Next middleware change does not restart workers"
assert_eq "$WORKER_SERVICES" "" "Next middleware change selects no worker services"

select_deploy_targets_from_files 'app/public/favicon.ico'
assert_eq "$CORE_SERVICES" portal "public asset change selects Portal"
assert_eq "$DEPLOY_WORKERS" 0 "public asset change does not restart workers"
assert_eq "$WORKER_SERVICES" "" "public asset change selects no worker services"

select_deploy_targets_from_files 'app/scripts/instantly-dataset/sync.mjs
app/scripts/instantly-dataset/022_leads_capture.sql'
assert_eq "$DEPLOY_DATASET_SYNC" 1 "dataset sync script change deploys dataset sync"
assert_eq "$DEPLOY_PORTAL" 1 "dataset sync change still rebuilds Portal (app/ is copied into images)"
assert_eq "$DEPLOY_WORKERS" 1 "dataset sync change still rebuilds shared worker image"
assert_eq "$DEPLOY_ALL" 0 "dataset sync change is not a full deploy"

select_deploy_targets_from_files 'app/scripts/instantly-dataset/wiki/dataset-schema.md'
assert_eq "$DEPLOY_DATASET_SYNC" 0 "dataset wiki doc (agent_wiki, loaded manually) does not deploy dataset sync"
assert_eq "$DEPLOY_PORTAL" 1 "dataset wiki doc keeps the old app/* behaviour"

select_deploy_targets_from_files 'docker-compose.prod.yml'
assert_eq "$DEPLOY_DATASET_SYNC" 0 "full deploy does not blindly re-copy dataset sync (explicit-change-only)"

select_deploy_targets_from_files 'Dockerfile.worker'
assert_eq "$DEPLOY_PORTAL" 0 "worker Dockerfile does not restart Portal"
assert_eq "$DEPLOY_WORKERS" 1 "worker Dockerfile restarts the shared worker pool"

select_deploy_targets_from_files 'supabase/instantly-migrations/999_test.sql'
assert_eq "$DEPLOY_PORTAL" 1 "Instantly migration rebuilds Portal migration image"
assert_eq "$DEPLOY_IDB_STACK" 1 "Instantly migration runs DB migrator"
assert_eq "$DEPLOY_BACKUP" 0 "Instantly migration does not restart backup"

select_deploy_targets_from_files '.semaphore/scheduled-deploy.yml
docs/runbook.md'
assert_eq "$DEPLOY_PORTAL_HOST" 0 "CI/docs-only change restarts no Portal service"
assert_eq "$DEPLOY_IDB_STACK" 0 "CI/docs-only change restarts no DB service"
assert_eq "$DEPLOY_BACKUP" 0 "CI/docs-only change restarts no backup"

select_deploy_targets_from_files 'new-production-area/config.yml'
assert_eq "$DEPLOY_ALL" 1 "unknown production path falls back to full deploy"

select_deploy_targets_from_files 'docker-compose.prod.yml'
assert_eq "$DEPLOY_ALL" 1 "production Compose change triggers safe full deploy"
assert_eq "$CORE_SERVICES" "$ALL_CORE_SERVICES" "full deploy selects every core service"
assert_eq "$WORKER_SERVICES" "$ALL_WORKER_SERVICES" "full deploy selects every worker"
assert_eq "$DEPLOY_BACKUP" 1 "full deploy includes backup"

echo "TESTS: passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
