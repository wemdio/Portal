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
  # Логируем keep-alive env vars, чтобы тесты могли проверить, что backup.sh
  # реально их экспортирует libpq'у (PGKEEPALIVES_* — стандартный контракт).
  printf ' env:PGKEEPALIVES=%s' "${PGKEEPALIVES:-}"
  printf ' env:PGKEEPALIVES_IDLE=%s' "${PGKEEPALIVES_IDLE:-}"
  printf ' env:PGKEEPALIVES_INTERVAL=%s' "${PGKEEPALIVES_INTERVAL:-}"
  printf ' env:PGKEEPALIVES_COUNT=%s' "${PGKEEPALIVES_COUNT:-}"
  printf '\n'
} >> "$PGD_LOG"
[ -n "$out" ] && : > "$out"

# Симуляция «первые N попыток фейл, дальше ok» — для тестов ретрая.
# PG_DUMP_FAIL_FIRST_N + PG_DUMP_ATTEMPT_FILE: счётчик в файле, чтобы
# сохранялся между запусками одного sandbox'а.
if [ -n "${PG_DUMP_FAIL_FIRST_N:-}" ] && [ -n "${PG_DUMP_ATTEMPT_FILE:-}" ]; then
  cur=$(cat "$PG_DUMP_ATTEMPT_FILE" 2>/dev/null || echo 0)
  cur=$((cur + 1))
  echo "$cur" > "$PG_DUMP_ATTEMPT_FILE"
  if [ "$cur" -le "$PG_DUMP_FAIL_FIRST_N" ]; then
    exit "${PG_DUMP_FAIL_RC:-1}"
  fi
fi

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

# Имитация SIGKILL (например OOM). Реальный curl, убитый -9, не успевает
# напечатать ничего: пустой stdout + ненулевой rc. Используется для теста,
# что алерт не показывает «HTTP » без диагностики.
# CURL_FAKE_KILL=1     — все запросы.
# CURL_UPLOAD_KILL=1   — только запросы upload (POST/PUT /storage/v1/object/<path>),
#                        не трогает list-/delete-эндпойнты, чтобы не ломать тесты cleanup.
is_upload_url=0
case "$url" in
  *"/storage/v1/object/list/"*) ;;
  *"/storage/v1/object/"*) is_upload_url=1 ;;
esac
if [ "${CURL_FAKE_KILL:-0}" = 1 ] || { [ "${CURL_UPLOAD_KILL:-0}" = 1 ] && [ "$is_upload_url" = 1 ]; }; then
  exit 137
fi

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
assert_contains "$SB/curl.log" "/storage/v1/object/db-backups/instantly/prod/" "instantly-prod upload path uses default db-backups bucket"
assert_contains "$SB/curl.log" "Authorization: Bearer svc" "instantly-prod sends bearer token"
assert_contains "$SB/curl.log" "x-upsert: true" "instantly-prod uses x-upsert header"
assert_contains "$SB/curl.log" "-T " "instantly-prod uses streaming upload (-T)"
assert_not_contains "$SB/curl.log" "--data-binary @" "instantly-prod no longer uses --data-binary @file (OOM-prone)"

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
assert_contains "$SB/curl.log" "/storage/v1/object/db-backups/instantly/dev/" "instantly-dev upload path uses default db-backups bucket"
assert_contains "$SB/curl.log" "-T " "instantly-dev uses streaming upload (-T)"

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
assert_contains "$SB/curl.log" "/storage/v1/object/db-backups/portal-main/" "main-supabase upload path uses default db-backups bucket"
assert_contains "$SB/curl.log" "-T " "main-supabase uses streaming upload (-T)"
assert_not_contains "$SB/curl.log" "--data-binary @" "main-supabase no longer uses --data-binary @file (OOM-prone)"

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
# После добавления ретрая: pg_dump всегда фейлится → 3 попытки → alert с
# "after 3 tries" (см. историю в services/backup/backup.sh — регулярные
# "connection to client lost" на COPY жирных таблиц через WAN, backup.sh
# теперь ретраит + шлёт TCP keep-alive).
SB="$TMP_ROOT/t8"; make_sandbox "$SB"
rc="$(INSTANTLY_DATABASE_URL='postgresql://i:p@h:5432/d' \
  PG_DUMP_FAKE_RC=42 \
  BACKUP_PG_DUMP_RETRY_PAUSE=0 \
  TELEGRAM_HEALTH_BOT_TOKEN=tok TELEGRAM_HEALTH_CHAT_ID=42 \
  BACKUP_SUPABASE_URL=https://x BACKUP_SUPABASE_KEY=k \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "1" "pg_dump failure → exit 1"
assert_contains "$SB/curl.log" "api.telegram.org/bottok/sendMessage" "pg_dump failure → Telegram sendMessage"
assert_contains "$SB/curl.log" "chat_id=42" "Telegram alert uses TELEGRAM_HEALTH_CHAT_ID"
pgd_calls="$(grep -c '^pg_dump' "$SB/pg_dump.log" 2>/dev/null || echo 0)"
assert_exit_code "$pgd_calls" "3" "pg_dump failure → 3 attempts (default retry budget)"
assert_contains "$SB/curl.log" "after 3 tries" "Telegram alert mentions retry count ('after 3 tries')"

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
assert_contains "$SB/curl.log" "/storage/v1/object/list/db-backups" "cleanup uses Storage list endpoint with default bucket"
assert_contains "$SB/curl.log" "-X DELETE" "cleanup issues DELETE request"
assert_contains "$SB/curl.log" "instantly-instantly-prod-19990101_000000.dump" "cleanup deletes 100-day-old object"
assert_not_contains "$SB/curl.log" "-X DELETE https://example.supabase.co/storage/v1/object/db-backups/instantly/prod/instantly-instantly-prod-29990101" "cleanup keeps fresh object"

echo ""
echo "── 11) upload OOM (SIGKILL) → alert содержит rc и size, а не пустой HTTP ──"
# Регрессия: «🚨 [backup main-supabase] Upload FAILED (HTTP )» — пустой код,
# потому что curl --data-binary @file OOM-killed -9 и не успел напечатать
# %{http_code}. После фикса алерт должен содержать rc=137 и size=<байты>.
SB="$TMP_ROOT/t11"; make_sandbox "$SB"
rc="$(INSTANTLY_DATABASE_URL='postgresql://i:p@h:5432/d' \
  CURL_UPLOAD_KILL=1 \
  TELEGRAM_HEALTH_BOT_TOKEN=tok TELEGRAM_HEALTH_CHAT_ID=42 \
  BACKUP_SUPABASE_URL=https://x BACKUP_SUPABASE_KEY=k \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "1" "upload OOM (rc=137) → exit 1"
assert_contains "$SB/curl.log" "api.telegram.org/bottok/sendMessage" "upload OOM → Telegram alert"
assert_contains "$SB/curl.log" "rc=137" "alert text contains curl rc"
assert_contains "$SB/curl.log" "size=" "alert text contains dump size"

echo ""
echo "── 12) BACKUP_BUCKET override → upload + list используют кастомное имя ──"
# Bucket конфигурируется через env. Дефолт db-backups (см. тесты 2/4/5);
# здесь — что переопределение работает И для upload, И для list-эндпойнта,
# И не остаётся хардкода старого имени deploy-backups.
SB="$TMP_ROOT/t12"; make_sandbox "$SB"
rc="$(INSTANTLY_DATABASE_URL='postgresql://i:p@h:5432/d' \
  BACKUP_SUPABASE_URL=https://example.supabase.co BACKUP_SUPABASE_KEY=svc \
  BACKUP_BUCKET=my-custom-bucket \
  LIST_RESPONSE_FILE="$SB/list.json" \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "0" "BACKUP_BUCKET override exits 0"
assert_contains "$SB/curl.log" "/storage/v1/object/my-custom-bucket/instantly/prod/" "upload path uses BACKUP_BUCKET"
assert_contains "$SB/curl.log" "/storage/v1/object/list/my-custom-bucket" "cleanup list uses BACKUP_BUCKET"
assert_not_contains "$SB/curl.log" "/storage/v1/object/db-backups/" "no leak of default bucket when overridden"
assert_not_contains "$SB/curl.log" "/storage/v1/object/deploy-backups/" "no leak of legacy bucket name"

echo ""
echo "── 13) dump_env.awk: roundtrip env через snapshot-файл ──"
# Регрессия: cron-job /backup.sh main-supabase падал с rc=1 без причины,
# потому что BusyBox crond передаёт ребёнку только базовый env. /entrypoint.sh
# снапшотит env через dump_env.awk в /etc/backup.env, cron-job делает
# `. /etc/backup.env` перед /backup.sh. Тест проверяет, что снапшот корректно
# воспроизводит значения с одинарными кавычками, $, &, |, бэкслэшами.
DUMP_AWK="$SCRIPT_DIR/dump_env.awk"
if [ -f "$DUMP_AWK" ] && command -v awk >/dev/null 2>&1; then
  SB="$TMP_ROOT/t13"; mkdir -p "$SB"
  SNAP="$SB/snap.env"
  ROUNDTRIP="$SB/roundtrip.txt"
  EXPECTED="$SB/expected.txt"

  TEST_SIMPLE='hello' \
  TEST_QUOTED="hi 'world' end" \
  TEST_DOLLAR='a$b=c d' \
  TEST_AMP='x&y|z' \
  TEST_BACKSLASH='a\b\\c' \
  TEST_QUOTES_MULTI="''both''" \
    awk -f "$DUMP_AWK" < /dev/null | grep -E '^export TEST_' > "$SNAP"
  assert_contains "$SNAP" "TEST_SIMPLE=" "snapshot writes TEST_SIMPLE"
  assert_contains "$SNAP" "TEST_DOLLAR=" "snapshot writes TEST_DOLLAR"
  assert_contains "$SNAP" "TEST_QUOTED=" "snapshot writes TEST_QUOTED"

  bash -c '
    unset TEST_SIMPLE TEST_QUOTED TEST_DOLLAR TEST_AMP TEST_BACKSLASH TEST_QUOTES_MULTI
    . "'"$SNAP"'"
    for v in TEST_SIMPLE TEST_QUOTED TEST_DOLLAR TEST_AMP TEST_BACKSLASH TEST_QUOTES_MULTI; do
      eval "echo \"$v=[\${$v}]\""
    done
  ' > "$ROUNDTRIP"

  cat > "$EXPECTED" <<EOF
TEST_SIMPLE=[hello]
TEST_QUOTED=[hi 'world' end]
TEST_DOLLAR=[a\$b=c d]
TEST_AMP=[x&y|z]
TEST_BACKSLASH=[a\\b\\\\c]
TEST_QUOTES_MULTI=[''both'']
EOF

  if diff -u "$EXPECTED" "$ROUNDTRIP" >/dev/null 2>&1; then
    PASS=$((PASS + 1)); echo "  ✔ env roundtrip exact-match (quotes / \$ / & / | / \\)"
  else
    FAIL=$((FAIL + 1))
    FAILED_NAMES="$FAILED_NAMES\n    - env roundtrip mismatch"
    echo "  ✘ env roundtrip mismatch:"
    diff -u "$EXPECTED" "$ROUNDTRIP" | sed 's/^/      /' >&2 || true
  fi
else
  echo "  (skipped: dump_env.awk not found or awk missing)"
fi

echo ""
echo "── 14) pg_dump retry: 2 фейла + 3-я успех → exit 0 ──"
# Регрессия под инцидент 18.07.2026: pg_dump рвётся по сети на COPY жирной
# public.pdl_companies через WAN. Скрипт должен ретраить и восстанавливаться.
SB="$TMP_ROOT/t14"; make_sandbox "$SB"
rc="$(INSTANTLY_DATABASE_URL='postgresql://i:p@h:5432/d' \
  PG_DUMP_FAIL_FIRST_N=2 PG_DUMP_FAIL_RC=1 \
  PG_DUMP_ATTEMPT_FILE="$SB/pgd.count" \
  BACKUP_PG_DUMP_RETRY_PAUSE=0 \
  BACKUP_SUPABASE_URL=https://example.supabase.co BACKUP_SUPABASE_KEY=svc \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "0" "flaky pg_dump (2 fails, then ok) → exit 0"
pgd_calls="$(grep -c '^pg_dump' "$SB/pg_dump.log" 2>/dev/null || echo 0)"
assert_exit_code "$pgd_calls" "3" "pg_dump called exactly 3 times (2 retries + success)"
assert_contains "$SB/run.out" "pg_dump attempt 2/3" "log announces attempt 2/3"
assert_contains "$SB/run.out" "pg_dump attempt 3/3" "log announces attempt 3/3"
assert_contains "$SB/curl.log" "/storage/v1/object/db-backups/instantly/prod/" "successful retry still uploads"

echo ""
echo "── 15) TCP keep-alive: PGKEEPALIVES экспортирован для pg_dump ──"
# Регрессия под инцидент 18.07.2026: postgres логировал "connection to client
# lost" на COPY public.pdl_companies, потому что WAN-соединение простаивало
# без keep-alive и провайдерский NAT его рубил. backup.sh обязан выставлять
# PGKEEPALIVES_* до вызова pg_dump — libpq подхватит из env.
SB="$TMP_ROOT/t15"; make_sandbox "$SB"
rc="$(INSTANTLY_DATABASE_URL='postgresql://i:p@h:5432/d' \
  BACKUP_SUPABASE_URL=https://x BACKUP_SUPABASE_KEY=k \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "0" "keep-alive test exits 0"
assert_contains "$SB/pg_dump.log" "env:PGKEEPALIVES=1" "PGKEEPALIVES=1 exported to pg_dump"
assert_contains "$SB/pg_dump.log" "env:PGKEEPALIVES_IDLE=60" "PGKEEPALIVES_IDLE=60 exported"
assert_contains "$SB/pg_dump.log" "env:PGKEEPALIVES_INTERVAL=10" "PGKEEPALIVES_INTERVAL=10 exported"
assert_contains "$SB/pg_dump.log" "env:PGKEEPALIVES_COUNT=6" "PGKEEPALIVES_COUNT=6 exported"

echo ""
echo "── 16) TCP keep-alive: внешние значения PGKEEPALIVES_* переопределяют дефолты ──"
# Операционная гибкость: если провайдер требует более агрессивный keep-alive,
# админ может выставить PGKEEPALIVES_IDLE=30 в env — скрипт не должен его
# затирать своим 60.
SB="$TMP_ROOT/t16"; make_sandbox "$SB"
rc="$(INSTANTLY_DATABASE_URL='postgresql://i:p@h:5432/d' \
  PGKEEPALIVES_IDLE=30 PGKEEPALIVES_INTERVAL=5 \
  BACKUP_SUPABASE_URL=https://x BACKUP_SUPABASE_KEY=k \
  run_backup "$SB" instantly-prod)"
assert_exit_code "$rc" "0" "keep-alive override exits 0"
assert_contains "$SB/pg_dump.log" "env:PGKEEPALIVES_IDLE=30" "external PGKEEPALIVES_IDLE preserved"
assert_contains "$SB/pg_dump.log" "env:PGKEEPALIVES_INTERVAL=5" "external PGKEEPALIVES_INTERVAL preserved"

echo ""
echo "═══════════════════════════════════════"
echo "  TESTS:   passed=$PASS  failed=$FAIL"
echo "═══════════════════════════════════════"

if [ "$FAIL" -ne 0 ]; then
  printf '\nFAILED tests:%b\n' "$FAILED_NAMES"
  exit 1
fi
exit 0
