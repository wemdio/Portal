#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tests for services/backup/backup.sh
#
# Запуск (Linux / macOS / Git Bash на Windows):
#   bash services/backup/test_backup.sh
#
# Зачем самописный «фреймворк»:
#   bats — внешняя зависимость. Здесь хватает shim-ов на pg_dump/curl и
#   проверки контрактов через PATH. Никаких новых бинарников в Docker-образе.
#
# Контракт backup.sh (v2 — для Portal-сервера):
#   Аргументы: <main-supabase|instantly-prod|instantly-dev>
#
#   Каждая ветка читает ОДНУ переменную с URL подключения (то же значение,
#   что использует приложение в .env Portal-сервера — DRY):
#     main-supabase   ← MAIN_SUPABASE_DATABASE_URL (fallback: DATABASE_URL)
#     instantly-prod  ← INSTANTLY_DATABASE_URL
#     instantly-dev   ← INSTANTLY_DEV_DATABASE_URL
#
#   Storage layout (bucket BACKUP_SUPABASE_URL/BACKUP_SUPABASE_KEY):
#     deploy-backups/portal-main/portal-main-main-supabase-<TS>.dump
#     deploy-backups/instantly/prod/instantly-instantly-prod-<TS>.dump
#     deploy-backups/instantly/dev/instantly-instantly-dev-<TS>.dump
#
#   Все ветки: pg_dump --format=custom --no-owner --no-privileges.
#   Для main-supabase дополнительно: --exclude-schema=_supavisor / _realtime /
#     _analytics / pgsodium / vault и т.д. (чтобы дамп лёг на чистый PG).
#
#   На фейле pg_dump или non-2xx upload — Telegram-алерт через
#   TELEGRAM_HEALTH_BOT_TOKEN/CHAT_ID + exit 1.
#
#   Чистка старых объектов в Supabase Storage (только при успешном upload):
#     POST /storage/v1/object/list/deploy-backups → DELETE для объектов
#     старше BACKUP_REMOTE_RETENTION_DAYS (default 30).
# ──────────────────────────────────────────────────────────────────────────────

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SH="$SCRIPT_DIR/backup.sh"

if [ ! -f "$BACKUP_SH" ]; then
  echo "FATAL: backup.sh not found at $BACKUP_SH" >&2
  exit 2
fi

PASS=0
FAIL=0
FAILED_NAMES=""

assert_contains() {
  local file="$1" needle="$2" name="$3"
  if grep -Fq -- "$needle" "$file"; then
    PASS=$((PASS + 1)); echo "  ✔ $name"
  else
    FAIL=$((FAIL + 1)); FAILED_NAMES="$FAILED_NAMES\n    - $name (missing: $needle)"
    echo "  ✘ $name"; echo "    expected to find: $needle"
    echo "    actual content:"; sed 's/^/      /' "$file" >&2
  fi
}

assert_not_contains() {
  local file="$1" needle="$2" name="$3"
  if grep -Fq -- "$needle" "$file"; then
    FAIL=$((FAIL + 1)); FAILED_NAMES="$FAILED_NAMES\n    - $name (unexpected: $needle)"
    echo "  ✘ $name"; echo "    must NOT find: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✔ $name"
  fi
}

assert_exit_code() {
  local actual="$1" expected="$2" name="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✔ $name"
  else
    FAIL=$((FAIL + 1)); FAILED_NAMES="$FAILED_NAMES\n    - $name (exit ${actual} != ${expected})"
    echo "  ✘ $name (exit ${actual}, expected ${expected})"
  fi
}

# Шим-окружение: подменяем pg_dump и curl через PATH.
# pg_dump — пишет команду в лог, имитирует --file.
# curl    — пишет команду в лог; уважает -o <file> и -w '%{http_code}', т.е.
#           тело ответа уходит в файл, код — на stdout. Это критично, потому
#           что backup.sh использует `code=$(curl -o list.json -w '%{http_code}' ...)`.
make_sandbox() {
  local sandbox="$1"
  rm -rf "$sandbox"
  mkdir -p "$sandbox/bin" "$sandbox/backups"

  cat > "$sandbox/bin/pg_dump" <<'PGD'
#!/usr/bin/env bash
out=""
for arg in "$@"; do case "$arg" in --file=*) out="${arg#--file=}" ;; esac; done
{
  printf 'pg_dump'
  for a in "$@"; do printf ' %s' "$a"; done
  printf '\n'
} >> "$PGD_LOG"
[ -n "$out" ] && : > "$out"
exit "${PG_DUMP_FAKE_RC:-0}"
PGD
  chmod +x "$sandbox/bin/pg_dump"

  cat > "$sandbox/bin/curl" <<'CRL'
#!/usr/bin/env bash
{
  printf 'curl'
  for a in "$@"; do printf ' %s' "$a"; done
  printf '\n'
} >> "$CURL_LOG"

want_code=0; url=""; out_file=""; prev=""
for a in "$@"; do
  case "$prev" in
    -w) [ "$a" = '%{http_code}' ] && want_code=1 ;;
    -o) out_file="$a" ;;
  esac
  case "$a" in http*://*) url="$a" ;; esac
  prev="$a"
done

body=""
case "$url" in
  *"/storage/v1/object/list/"*)
    if [ -n "${LIST_RESPONSE_FILE:-}" ] && [ -f "$LIST_RESPONSE_FILE" ]; then
      body="$(cat "$LIST_RESPONSE_FILE")"
    else
      body='[]'
    fi
    ;;
esac

if [ -n "$out_file" ]; then printf '%s' "$body" > "$out_file"
else printf '%s' "$body"; fi

[ "$want_code" = 1 ] && printf '%s' "${CURL_FAKE_CODE:-200}"
exit "${CURL_FAKE_RC:-0}"
CRL
  chmod +x "$sandbox/bin/curl"
}

run_backup() {
  local sandbox="$1"; shift
  local out_file="$sandbox/run.out"
  PATH="$sandbox/bin:$PATH" \
    PGD_LOG="$sandbox/pg_dump.log" \
    CURL_LOG="$sandbox/curl.log" \
    DUMP_DIR="$sandbox/backups" \
    bash "$BACKUP_SH" "$@" >"$out_file" 2>&1
  echo $?
}

cleanup() { rm -rf "$TMP_ROOT" 2>/dev/null || true; }
trap cleanup EXIT
TMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t backup-tests)"

echo ""
echo "── 1) usage and validation ──"
SB="$TMP_ROOT/t1"; make_sandbox "$SB"
rc="$(run_backup "$SB" 2>/dev/null || true)"
assert_exit_code "$rc" "1" "no argument exits 1"
assert_contains "$SB/run.out" "Usage" "no-arg prints Usage"

SB="$TMP_ROOT/t1b"; make_sandbox "$SB"
rc="$(run_backup "$SB" "weirdthing")"
assert_exit_code "$rc" "1" "unknown instance exits 1"
assert_contains "$SB/run.out" "Unknown instance" "unknown instance error message"

echo ""
echo "── 2) instantly-prod: INSTANTLY_DATABASE_URL → pg_dump + correct path ──"
SB="$TMP_ROOT/t2"; make_sandbox "$SB"
rc="$(INSTANTLY_DATABASE_URL='postgresql://instantly:secret@db.example.com:35432/instantly' \
  BACKUP_SUPABASE_URL=https://example.supabase.co BACKUP_SUPABASE_KEY=svc \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "0" "instantly-prod exits 0"
assert_contains "$SB/pg_dump.log" "--dbname=postgresql://instantly:secret@db.example.com:35432/instantly" "instantly-prod uses INSTANTLY_DATABASE_URL"
assert_contains "$SB/pg_dump.log" "--format=custom" "instantly-prod uses --format=custom"
assert_contains "$SB/pg_dump.log" "--no-owner" "instantly-prod uses --no-owner"
assert_contains "$SB/curl.log" "/storage/v1/object/deploy-backups/instantly/prod/" "instantly-prod upload path"
assert_contains "$SB/curl.log" "Authorization: Bearer svc" "instantly-prod sends bearer token"
assert_contains "$SB/curl.log" "x-upsert: true" "instantly-prod uses x-upsert header"

echo ""
echo "── 3) instantly-prod: skipped when INSTANTLY_DATABASE_URL is empty ──"
SB="$TMP_ROOT/t3"; make_sandbox "$SB"
rc="$(BACKUP_SUPABASE_URL=https://x BACKUP_SUPABASE_KEY=k \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "0" "instantly-prod no-URL → exit 0 (skip)"
assert_contains "$SB/run.out" "skipping" "instantly-prod no-URL → skip message"
test ! -s "$SB/pg_dump.log" && { PASS=$((PASS + 1)); echo "  ✔ instantly-prod no-URL → no pg_dump call"; } || \
  { FAIL=$((FAIL + 1)); echo "  ✘ instantly-prod no-URL → pg_dump was called"; }

echo ""
echo "── 4) instantly-dev: INSTANTLY_DEV_DATABASE_URL → correct path ──"
SB="$TMP_ROOT/t4"; make_sandbox "$SB"
rc="$(INSTANTLY_DEV_DATABASE_URL='postgresql://instantly:dev@db.example.com:35433/instantly' \
  BACKUP_SUPABASE_URL=https://example.supabase.co BACKUP_SUPABASE_KEY=svc \
  run_backup "$SB" instantly-dev)"
assert_exit_code "$rc" "0" "instantly-dev exits 0"
assert_contains "$SB/pg_dump.log" "35433/instantly" "instantly-dev uses INSTANTLY_DEV_DATABASE_URL"
assert_contains "$SB/curl.log" "/storage/v1/object/deploy-backups/instantly/dev/" "instantly-dev upload path"

echo ""
echo "── 5) main-supabase: MAIN_SUPABASE_DATABASE_URL + schema filters + portal-main path ──"
SB="$TMP_ROOT/t5"; make_sandbox "$SB"
rc="$(MAIN_SUPABASE_DATABASE_URL='postgresql://postgres.acme:secret@aws-1-eu-west-1.pooler.supabase.com:5432/postgres' \
  BACKUP_SUPABASE_URL=https://example.supabase.co BACKUP_SUPABASE_KEY=svc \
  run_backup "$SB" main-supabase)"
assert_exit_code "$rc" "0" "main-supabase exits 0 when URL set"
assert_contains "$SB/pg_dump.log" "postgres.acme" "main-supabase passes URL to pg_dump"
assert_contains "$SB/pg_dump.log" "--format=custom" "main-supabase --format=custom"
assert_contains "$SB/pg_dump.log" "--exclude-schema=_supavisor" "main-supabase excludes _supavisor"
assert_contains "$SB/pg_dump.log" "--exclude-schema=_realtime" "main-supabase excludes _realtime"
assert_contains "$SB/pg_dump.log" "--exclude-schema=_analytics" "main-supabase excludes _analytics"
assert_contains "$SB/pg_dump.log" "--exclude-schema=pgsodium" "main-supabase excludes pgsodium"
assert_contains "$SB/pg_dump.log" "--exclude-schema=vault" "main-supabase excludes vault"
assert_not_contains "$SB/pg_dump.log" "--exclude-schema=public" "main-supabase keeps public"
assert_not_contains "$SB/pg_dump.log" "--exclude-schema=auth" "main-supabase keeps auth"
assert_not_contains "$SB/pg_dump.log" "--exclude-schema=storage" "main-supabase keeps storage"
assert_contains "$SB/curl.log" "/storage/v1/object/deploy-backups/portal-main/" "main-supabase upload path"

echo ""
echo "── 6) main-supabase: fallback to DATABASE_URL when MAIN_SUPABASE_DATABASE_URL is empty ──"
SB="$TMP_ROOT/t6"; make_sandbox "$SB"
rc="$(DATABASE_URL='postgresql://postgres.fallback:secret@pooler:5432/postgres' \
  BACKUP_SUPABASE_URL=https://example.supabase.co BACKUP_SUPABASE_KEY=svc \
  run_backup "$SB" main-supabase)"
assert_exit_code "$rc" "0" "main-supabase falls back to DATABASE_URL"
assert_contains "$SB/pg_dump.log" "postgres.fallback" "main-supabase used DATABASE_URL fallback"

echo ""
echo "── 7) main-supabase: skip when both URLs empty ──"
SB="$TMP_ROOT/t7"; make_sandbox "$SB"
rc="$(BACKUP_SUPABASE_URL=https://x BACKUP_SUPABASE_KEY=k \
  run_backup "$SB" main-supabase)"
assert_exit_code "$rc" "0" "main-supabase no-URL → exit 0"
assert_contains "$SB/run.out" "skipping" "main-supabase no-URL → skip message"
test ! -s "$SB/pg_dump.log" && { PASS=$((PASS + 1)); echo "  ✔ main-supabase no-URL → no pg_dump call"; } || \
  { FAIL=$((FAIL + 1)); echo "  ✘ main-supabase no-URL → pg_dump was called"; }

echo ""
echo "── 8) Telegram alert on pg_dump failure ──"
SB="$TMP_ROOT/t8"; make_sandbox "$SB"
rc="$(INSTANTLY_DATABASE_URL='postgresql://i:p@h:5432/d' \
  PG_DUMP_FAKE_RC=42 \
  TELEGRAM_HEALTH_BOT_TOKEN=tok TELEGRAM_HEALTH_CHAT_ID=42 \
  BACKUP_SUPABASE_URL=https://x BACKUP_SUPABASE_KEY=k \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "1" "pg_dump failure → exit 1"
assert_contains "$SB/curl.log" "api.telegram.org/bottok/sendMessage" "pg_dump failure → Telegram sendMessage"
assert_contains "$SB/curl.log" "chat_id=42" "Telegram alert uses TELEGRAM_HEALTH_CHAT_ID"

echo ""
echo "── 9) Telegram alert on upload non-2xx ──"
SB="$TMP_ROOT/t9"; make_sandbox "$SB"
rc="$(INSTANTLY_DATABASE_URL='postgresql://i:p@h:5432/d' \
  CURL_FAKE_CODE=500 \
  TELEGRAM_HEALTH_BOT_TOKEN=tok TELEGRAM_HEALTH_CHAT_ID=42 \
  BACKUP_SUPABASE_URL=https://x BACKUP_SUPABASE_KEY=k \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "1" "upload 5xx → exit 1"
assert_contains "$SB/curl.log" "api.telegram.org/bottok/sendMessage" "upload 5xx → Telegram alert"
assert_contains "$SB/run.out" "FAILED" "upload 5xx → log says FAILED"

echo ""
echo "── 10) cleanup of old objects in Supabase Storage ──"
SB="$TMP_ROOT/t10"; make_sandbox "$SB"
LIST_RESPONSE_FILE="$SB/list.json"
old_iso="$(date -u -d '100 days ago' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v-100d '+%Y-%m-%dT%H:%M:%SZ')"
fresh_iso="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
cat > "$LIST_RESPONSE_FILE" <<EOF
[
  {"name":"instantly-instantly-prod-19990101_000000.dump","created_at":"$old_iso","updated_at":"$old_iso"},
  {"name":"instantly-instantly-prod-29990101_000000.dump","created_at":"$fresh_iso","updated_at":"$fresh_iso"}
]
EOF
rc="$(INSTANTLY_DATABASE_URL='postgresql://i:p@h:5432/d' \
  BACKUP_SUPABASE_URL=https://example.supabase.co BACKUP_SUPABASE_KEY=svc \
  BACKUP_REMOTE_RETENTION_DAYS=30 \
  LIST_RESPONSE_FILE="$LIST_RESPONSE_FILE" \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "0" "cleanup branch exits 0"
assert_contains "$SB/curl.log" "/storage/v1/object/list/deploy-backups" "cleanup uses Storage list endpoint"
assert_contains "$SB/curl.log" "-X DELETE" "cleanup issues DELETE request"
assert_contains "$SB/curl.log" "instantly-instantly-prod-19990101_000000.dump" "cleanup deletes 100-day-old object"
assert_not_contains "$SB/curl.log" "-X DELETE https://example.supabase.co/storage/v1/object/deploy-backups/instantly/prod/instantly-instantly-prod-29990101" "cleanup keeps fresh object"

echo ""
echo "═══════════════════════════════════════"
echo "  TESTS:   passed=$PASS  failed=$FAIL"
echo "═══════════════════════════════════════"

if [ "$FAIL" -ne 0 ]; then
  printf '\nFAILED tests:%b\n' "$FAILED_NAMES"
  exit 1
fi
exit 0
