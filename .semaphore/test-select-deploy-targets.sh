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
