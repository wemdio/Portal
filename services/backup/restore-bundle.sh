#!/bin/sh
# Restore a one-file backup bundle produced by /backup.sh.
#
# Extract the .tar first, then run:
#   ./restore-bundle.sh main [main-postgres]
#   ./restore-bundle.sh instantly [instantly-postgres-prod]
#
# The target must be a fresh container from the same compose stack. Main uses
# the Supabase Postgres image because the dump may reference Supabase extensions.

set -eu

MODE="${1:-}"
TARGET_CONTAINER="${2:-}"
RESTORE_IMAGE="${RESTORE_IMAGE:-postgres:17-alpine}"
RESTORE_JOBS="${RESTORE_JOBS:-4}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

usage() {
  echo "Usage: $0 <main|instantly> [target-container]" >&2
  exit 1
}

[ -n "$MODE" ] || usage

case "$MODE" in
  main)
    TARGET_CONTAINER="${TARGET_CONTAINER:-main-postgres}"
    DB_USER="supabase_admin"
    ;;
  instantly)
    TARGET_CONTAINER="${TARGET_CONTAINER:-instantly-postgres-prod}"
    DB_USER="instantly"
    ;;
  *) usage ;;
esac

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]
}

container_password() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" |
    sed -n 's/^POSTGRES_PASSWORD=//p' | head -1
}

assert_fresh_database() {
  container="$1"
  user="$2"
  database="$3"

  public_tables=$(docker exec "$container" psql -U "$user" -d "$database" -qAt \
    -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" 2>/dev/null || echo unknown)
  if [ "$public_tables" != "0" ] && [ "${RESTORE_FORCE:-0}" != "1" ]; then
    echo "[restore] FATAL: $database is not fresh (public tables: $public_tables)." >&2
    echo "[restore] Recreate its volume first, or set RESTORE_FORCE=1 explicitly." >&2
    exit 1
  fi
}

database_exists() {
  container="$1"
  user="$2"
  database="$3"

  docker exec "$container" psql -U "$user" -d postgres -qAt \
    -v dbname="$database" \
    -c "SELECT 1 FROM pg_database WHERE datname = :'dbname'" | grep -qx 1
}

apply_globals() {
  container="$1"
  user="$2"
  file="$3"

  [ -f "$file" ] || {
    echo "[restore] FATAL: missing globals file: $file" >&2
    exit 1
  }

  password=$(container_password "$container")
  [ -n "$password" ] || {
    echo "[restore] FATAL: POSTGRES_PASSWORD not found in $container" >&2
    exit 1
  }

  absolute_file=$(CDPATH= cd -- "$(dirname -- "$file")" && pwd)/$(basename "$file")
  globals_log=$(mktemp) || exit 1
  echo "[restore] applying $(basename "$file") with PostgreSQL 17 client..."
  # Fresh postgres images already contain their bootstrap superuser. CREATE
  # ROLE for that one role can report "already exists"; psql must continue so
  # the following ALTER ROLE / grants are still applied.
  if ! docker run --rm \
      --network "container:${container}" \
      -v "${absolute_file}:/globals.sql:ro" \
      -e PGPASSWORD="$password" \
      "$RESTORE_IMAGE" \
      psql \
        --host=127.0.0.1 \
        --username="$user" \
        --dbname=postgres \
        --set=ON_ERROR_STOP=0 \
        --file=/globals.sql >"$globals_log" 2>&1; then
    cat "$globals_log" >&2
    rm -f "$globals_log"
    echo "[restore] FATAL: psql could not apply $(basename "$file")" >&2
    exit 1
  fi

  cat "$globals_log"
  unexpected_errors=$(grep 'ERROR:' "$globals_log" | grep -Ev 'role ".*" already exists' || true)
  rm -f "$globals_log"
  if [ -n "$unexpected_errors" ]; then
    echo "[restore] FATAL: unexpected error while applying $(basename "$file"):" >&2
    echo "$unexpected_errors" >&2
    exit 1
  fi
}

restore_custom_dump() {
  container="$1"
  user="$2"
  database="$3"
  file="$4"

  [ -f "$file" ] || {
    echo "[restore] FATAL: missing database dump: $file" >&2
    exit 1
  }

  password=$(container_password "$container")
  [ -n "$password" ] || {
    echo "[restore] FATAL: POSTGRES_PASSWORD not found in $container" >&2
    exit 1
  }

  absolute_file=$(CDPATH= cd -- "$(dirname -- "$file")" && pwd)/$(basename "$file")
  echo "[restore] restoring $database from $(basename "$file") with ${RESTORE_JOBS} jobs..."
  docker run --rm \
    --network "container:${container}" \
    -v "${absolute_file}:/restore.dump:ro" \
    -e PGPASSWORD="$password" \
    "$RESTORE_IMAGE" \
    pg_restore \
      --host=127.0.0.1 \
      --username="$user" \
      --dbname=template1 \
      --create \
      --exit-on-error \
      --jobs="$RESTORE_JOBS" \
      /restore.dump
}

drop_target_database() {
  container="$1"
  user="$2"
  database="$3"

  password=$(container_password "$container")
  [ -n "$password" ] || {
    echo "[restore] FATAL: POSTGRES_PASSWORD not found in $container" >&2
    exit 1
  }

  echo "[restore] dropping fresh target database $database before --create restore..."
  docker run --rm \
    --network "container:${container}" \
    -e PGPASSWORD="$password" \
    "$RESTORE_IMAGE" \
    dropdb \
      --host=127.0.0.1 \
      --username="$user" \
      --maintenance-db=template1 \
      --force \
      --if-exists \
      "$database"
}

container_running "$TARGET_CONTAINER" || {
  echo "[restore] FATAL: container is not running: $TARGET_CONTAINER" >&2
  exit 1
}

case "$MODE" in
  main)
    assert_fresh_database "$TARGET_CONTAINER" "$DB_USER" postgres
    apply_globals "$TARGET_CONTAINER" "$DB_USER" "$SCRIPT_DIR/main-globals-pre.sql"
    drop_target_database "$TARGET_CONTAINER" "$DB_USER" postgres
    restore_custom_dump "$TARGET_CONTAINER" "$DB_USER" postgres "$SCRIPT_DIR/main-postgres.dump"
    apply_globals "$TARGET_CONTAINER" "$DB_USER" "$SCRIPT_DIR/main-globals.sql"
    ;;
  instantly)
    assert_fresh_database "$TARGET_CONTAINER" "$DB_USER" instantly
    if database_exists "$TARGET_CONTAINER" "$DB_USER" instantly_dataset; then
      assert_fresh_database "$TARGET_CONTAINER" "$DB_USER" instantly_dataset
    fi
    apply_globals "$TARGET_CONTAINER" "$DB_USER" "$SCRIPT_DIR/instantly-globals-pre.sql"
    drop_target_database "$TARGET_CONTAINER" "$DB_USER" instantly
    restore_custom_dump "$TARGET_CONTAINER" "$DB_USER" instantly "$SCRIPT_DIR/instantly.dump"

    drop_target_database "$TARGET_CONTAINER" "$DB_USER" instantly_dataset
    restore_custom_dump "$TARGET_CONTAINER" "$DB_USER" instantly_dataset "$SCRIPT_DIR/instantly_dataset.dump"
    apply_globals "$TARGET_CONTAINER" "$DB_USER" "$SCRIPT_DIR/instantly-globals.sql"
    ;;
esac

echo "[restore] bundle restore completed successfully"
