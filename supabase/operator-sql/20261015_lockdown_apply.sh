#!/usr/bin/env bash
# 20261015_lockdown_apply.sh — hand apply of the lockdown series 20261015_0030..0036 on the
# main DB, with the same semantics as the deploy runner (app/scripts/db/ensureDatabase.js):
#   * one session per file; `set lock_timeout = '30s'` for the session
#     (DB_MIGRATION_LOCK_TIMEOUT default);
#   * transactional file: begin; <file>; insert into public.portal_migrations (name); commit;
#   * a file with a `-- migrate:no-transaction` line: its statements one by one in
#     autocommit, then the ledger row (none of the seven has the marker today);
#   * files already in public.portal_migrations are skipped; stop on the first error;
#   * a lock error is retried like the runner does (55P03, 40P01, 57014 that cut a
#     `lock table` statement, a lost connection): LK_LOCK_RETRIES more attempts, 5 s apart;
#     a retry that finds the file's ledger row (the attempt cut off by a lost connection
#     committed after all) counts the file as applied and goes on;
#   * `notify pgrst, 'reload schema'` once at the end if anything was applied.
# Night runbook: docs/security/2026-10-15-lockdown-night-runbook.md
#
# Usage (from the repo root or anywhere; bash 3.2+ — runs on the Mac too):
#   bash supabase/operator-sql/20261015_lockdown_apply.sh            # plan only: checks + what would run
#   bash supabase/operator-sql/20261015_lockdown_apply.sh --yes      # apply
# Options:
#   --yes                    apply (without it nothing is written)
#   --skip-rehearsal-check   do not require a successful rehearsal of the same bytes
#                            (LK_LOG_DIR/rehearsal-ok, written by 20261015_lockdown_rehearsal.sh)
# Environment (defaults in brackets):
#   LK_PSQL       psql command  [docker exec -i main-postgres psql -U postgres -d postgres]
#                 from the Mac: "ssh -o BatchMode=yes -i KEY root@HOST docker exec -i main-postgres psql -U postgres -d postgres"
#   LK_DOCKER     docker command for `ps`  [docker]   (from the Mac: "ssh ... root@HOST docker")
#   LK_LOG_DIR    logs and the rehearsal stamp  [./lockdown-night-logs]
#   LK_MIGRATIONS_DIR  [<this dir>/../migrations]
#   LK_MAX_XACT_AGE    seconds; any other transaction older than this refuses  [3]
#   LK_LOCK_RETRIES    [5]   LK_RETRY_DELAY seconds [5]
#   LK_KEEP_WORKERS    portal-worker-* containers allowed to stay up (space separated) []
#   LK_REHEARSAL_MAX_AGE  seconds a rehearsal stamp stays valid  [21600]
#   LK_LEDGER_SINCE  the portal_migrations state the series was tested against: any other
#                    row applied after it (or named after 20261015_0036) is warned about
#                    [2026-10-15 13:03:00+00; the prod ledger tip then was 13:02:33Z]
# Exit codes: 0 done (or plan printed), 1 usage/environment, 2 preflight refused,
#             3 a file failed (everything before it is committed; rerun is safe).
#
# This file is also a library: 20261015_lockdown_rehearsal.sh sources it for the shared
# preflight. main() runs only when the file is executed, never when it is sourced.

if [ -z "${BASH_VERSION:-}" ]; then echo "run with bash" >&2; exit 1; fi

LK_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LK_PSQL="${LK_PSQL:-docker exec -i main-postgres psql -U postgres -d postgres}"
LK_DOCKER="${LK_DOCKER:-docker}"
LK_LOG_DIR="${LK_LOG_DIR:-./lockdown-night-logs}"
LK_MIGRATIONS_DIR="${LK_MIGRATIONS_DIR:-$LK_SELF_DIR/../migrations}"
LK_MAX_XACT_AGE="${LK_MAX_XACT_AGE:-3}"
LK_LOCK_RETRIES="${LK_LOCK_RETRIES:-5}"
LK_RETRY_DELAY="${LK_RETRY_DELAY:-5}"
LK_KEEP_WORKERS="${LK_KEEP_WORKERS:-}"
LK_REHEARSAL_MAX_AGE="${LK_REHEARSAL_MAX_AGE:-21600}"
LK_LEDGER_SINCE="${LK_LEDGER_SINCE:-2026-10-15 13:03:00+00}"
# Session lock_timeout of the deploy runner (ensureDatabase.js, DB_MIGRATION_LOCK_TIMEOUT).
LK_SESSION_LOCK_TIMEOUT='30s'
# The series, in the order the runner applies it (name order; the VE 20261015_0030/0031
# files are already in portal_migrations on prod).
LK_DEFAULT_FILES="20261015_0030_profiles_read_lockdown.sql
20261015_0031_staff_gate_helpers.sql
20261015_0032_no_rls_tables_lockdown.sql
20261015_0033_open_policies_staff_gate.sql
20261015_0034_rls_tables_staff_or_own_gate.sql
20261015_0035_storage_private_buckets_gate.sql
20261015_0036_anon_definer_view_lockdown.sql"
LK_FILES="${LK_FILES:-$LK_DEFAULT_FILES}"

lk_say() { printf '[lockdown] %s\n' "$*"; }
lk_warn() { printf '[lockdown] WARNING: %s\n' "$*" >&2; }
lk_die() { printf '[lockdown] FATAL: %s\n' "$*" >&2; exit "${2:-1}"; }
lk_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
lk_now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

lk_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# psql with the runner's error behaviour; stdin is the script. Extra args are appended
# (no spaces or quotes in them: over ssh they become one remote command line).
lk_psql() {
  # shellcheck disable=SC2086
  $LK_PSQL -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose "$@"
}

# Read-only query: the statements run inside BEGIN READ ONLY ... ROLLBACK.
lk_ro() {
  { printf 'begin read only;\n'; printf '%s\n' "$1"; printf 'rollback;\n'; } | lk_psql -At
}

lk_sql_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

lk_validate_env() {
  command -v python3 >/dev/null 2>&1 || lk_die "python3 is required (timings)"
  case "$LK_MAX_XACT_AGE" in ''|*[!0-9]*) lk_die "LK_MAX_XACT_AGE must be whole seconds" ;; esac
  case "$LK_LOCK_RETRIES" in ''|*[!0-9]*) lk_die "LK_LOCK_RETRIES must be a number" ;; esac
  case "$LK_RETRY_DELAY" in ''|*[!0-9]*) lk_die "LK_RETRY_DELAY must be a number" ;; esac
  case "$LK_REHEARSAL_MAX_AGE" in ''|*[!0-9]*) lk_die "LK_REHEARSAL_MAX_AGE must be a number" ;; esac
  case "$LK_LEDGER_SINCE" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*) ;;
    *) lk_die "LK_LEDGER_SINCE must be a timestamp like '2026-10-15 13:03:00+00'" ;;
  esac
  case "$LK_LEDGER_SINCE" in *[!0-9T:.+\ Z-]*) lk_die "LK_LEDGER_SINCE must be a timestamp like '2026-10-15 13:03:00+00'" ;; esac
  [ -d "$LK_MIGRATIONS_DIR" ] || lk_die "migrations dir not found: $LK_MIGRATIONS_DIR"
  local f last
  for f in $LK_FILES; do
    case "$f" in *[!A-Za-z0-9_.-]*) lk_die "bad file name: $f" ;; esac
    [ -s "$LK_MIGRATIONS_DIR/$f" ] || lk_die "missing or empty: $LK_MIGRATIONS_DIR/$f"
    # The scripts append SQL after each file; a last statement without ';' would swallow it.
    last="$(grep -v '^[[:space:]]*--' "$LK_MIGRATIONS_DIR/$f" | grep -v '^[[:space:]]*$' | tail -n 1 \
      | sed -e 's/[[:space:]]--.*$//' -e 's/[[:space:]]*$//')"
    case "$last" in *';') ;; *) lk_die "$f: the last statement does not end with ';' ($last)" ;; esac
  done
  mkdir -p "$LK_LOG_DIR" || lk_die "cannot create $LK_LOG_DIR"
}

lk_is_no_transaction() { grep -Eiq '^[[:space:]]*--[[:space:]]*migrate:no-transaction[[:space:]]*$' "$1"; }

# ── Preflight (shared with the rehearsal) ───────────────────────────────────────
# Prints findings; sets LK_PENDING (files not yet in portal_migrations, in order) and
# LK_APPLIED. Returns 0 when it is safe to proceed, 2 when it must refuse.
lk_preflight() {
  local refuse=0 f names running kept line

  lk_say "files ($LK_MIGRATIONS_DIR):"
  for f in $LK_FILES; do
    printf '    %s  %s%s\n' "$(lk_sha256 "$LK_MIGRATIONS_DIR/$f")" "$f" \
      "$(lk_is_no_transaction "$LK_MIGRATIONS_DIR/$f" && printf ' [no-transaction]')"
  done

  # 1. Workers. Every portal-worker-* container must be stopped (runbook step 2).
  # </dev/null: over ssh, LK_DOCKER would otherwise read this script's stdin.
  if ! names="$($LK_DOCKER ps --format '{{.Names}}' 2>&1 < /dev/null)"; then
    lk_warn "cannot list containers ($LK_DOCKER ps): $names"
    refuse=1
  else
    running="$(printf '%s\n' "$names" | grep -E '^portal-worker(-|$)' | sort || true)"
    kept=""
    if [ -n "$LK_KEEP_WORKERS" ] && [ -n "$running" ]; then
      for f in $LK_KEEP_WORKERS; do
        if printf '%s\n' "$running" | grep -qx "$f"; then kept="$kept $f"; fi
      done
      for f in $kept; do running="$(printf '%s\n' "$running" | grep -vx "$f" || true)"; done
      lk_warn "allowed to stay up (LK_KEEP_WORKERS):$kept"
    fi
    if [ -n "$running" ]; then
      lk_warn "workers still running ($(printf '%s\n' "$running" | wc -l | tr -d ' ')): $(printf '%s ' $running)"
      refuse=1
    else
      lk_say "workers: no portal-worker-* container is running"
    fi
  fi

  # 2. Database: identity, long transactions, lock queues, vacuum, dumps, ledger.
  local in_list="" names_sql="" local_names=""
  for f in $LK_FILES; do in_list="$in_list${in_list:+,}$(lk_sql_quote "$f")"; done
  for f in "$LK_MIGRATIONS_DIR"/*.sql; do
    f="$(basename "$f")"
    case "$f" in *[!A-Za-z0-9_.-]*) continue ;; esac
    local_names="$local_names${local_names:+,}'$f'"
  done
  names_sql="array[$local_names]::text[]"
  local out
  if ! out="$(lk_ro "
select 'who|' || current_user || '|' || r.rolsuper::text || '|' || current_setting('server_version')
  from pg_roles r where r.rolname = current_user;
select 'xact|' || a.pid || '|' || coalesce(a.usename, '') || '|' || coalesce(a.application_name, '') || '|'
       || coalesce(a.backend_type, '') || '|' || coalesce(a.state, '') || '|'
       || round(extract(epoch from now() - a.xact_start))::int || 's|'
       || left(regexp_replace(coalesce(a.query, ''), '\\s+', ' ', 'g'), 100)
  from pg_stat_activity a
 where a.xact_start < now() - interval '$LK_MAX_XACT_AGE seconds' and a.pid <> pg_backend_pid()
 order by a.xact_start;
select 'lockq|' || l.pid || '|' || l.mode || '|' || case when l.granted then 'held' else 'WAITING' end || '|'
       || n.nspname || '.' || c.relname || '|' || coalesce(a.application_name, '') || '|' || coalesce(a.backend_type, '')
  from pg_locks l
  join pg_class c on c.oid = l.relation
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_activity a on a.pid = l.pid
 where l.locktype = 'relation' and l.pid is distinct from pg_backend_pid()
   and n.nspname in ('public', 'storage')
   and (not l.granted
        or l.mode in ('ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'))
 order by l.granted, l.pid;
select 'vacuum|' || p.pid || '|' || p.relid::regclass || '|' || p.phase || '|'
       || case when a.query ilike '%wraparound%' then 'wraparound' when a.backend_type = 'autovacuum worker' then 'autovacuum' else 'manual' end
  from pg_stat_progress_vacuum p join pg_stat_activity a using (pid);
select 'dump|' || a.pid || '|' || coalesce(a.application_name, '') || '|' || coalesce(a.usename, '')
  from pg_stat_activity a where a.application_name ilike 'pg_dump%' or a.query ilike 'copy % to stdout%';
select 'ledger|' || m.name from public.portal_migrations m where m.name = any (array[$in_list]) order by m.name;
select 'newer|' || m.name || '|' || m.applied_at from public.portal_migrations m
 where m.name <> all (array[$in_list])
   and (m.name > '20261015_0036_anon_definer_view_lockdown.sql'
        or m.applied_at > timestamptz '$LK_LEDGER_SINCE')
 order by m.applied_at, m.name;
select 'unapplied|' || x from unnest($names_sql) x
 where x <> all (array[$in_list]) and not exists (select 1 from public.portal_migrations m where m.name = x) order by x;
" 2>&1)"; then
    lk_warn "read-only preflight query failed:"
    printf '%s\n' "$out" | sed 's/^/    /' >&2
    return 2
  fi

  LK_APPLIED=""
  local who="" xacts="" lockq_refuse="" lockq_warn="" vac_refuse="" vac_warn="" dumps="" newer="" unapplied=""
  while IFS= read -r line; do
    case "$line" in
      who\|*) who="${line#who|}" ;;
      xact\|*) xacts="$xacts${line#xact|}"$'\n' ;;
      lockq\|*)
        case "$line" in
          *'|autovacuum worker') lockq_warn="$lockq_warn${line#lockq|}"$'\n' ;;
          *) lockq_refuse="$lockq_refuse${line#lockq|}"$'\n' ;;
        esac ;;
      vacuum\|*)
        case "$line" in
          *'|autovacuum') vac_warn="$vac_warn${line#vacuum|}"$'\n' ;;
          *) vac_refuse="$vac_refuse${line#vacuum|}"$'\n' ;;
        esac ;;
      dump\|*) dumps="$dumps${line#dump|}"$'\n' ;;
      ledger\|*) LK_APPLIED="$LK_APPLIED${line#ledger|}"$'\n' ;;
      newer\|*) newer="$newer${line#newer|}"$'\n' ;;
      unapplied\|*) unapplied="$unapplied${line#unapplied|}"$'\n' ;;
    esac
  done <<EOF
$out
EOF

  case "$who" in
    'postgres|true|15.'*) lk_say "db: $who (user|superuser|version)" ;;
    *'|true|'*) lk_warn "db: connected as $who (expected postgres on PostgreSQL 15.x)" ;;
    *) lk_warn "db: connected as '$who'; a superuser (postgres) is required"; refuse=1 ;;
  esac
  # A regular autovacuum yields to the lock request (it is cancelled after deadlock_timeout);
  # an anti-wraparound one does not, and neither does a manual VACUUM/ANALYZE.
  if [ -n "$xacts" ]; then
    local xr="" xw="" x
    while IFS= read -r x; do
      [ -n "$x" ] || continue
      case "$x" in
        *'|autovacuum worker|'*) case "$x" in *wraparound*) xr="$xr    $x"$'\n' ;; *) xw="$xw    $x"$'\n' ;; esac ;;
        *) xr="$xr    $x"$'\n' ;;
      esac
    done <<EOF
$xacts
EOF
    if [ -n "$xr" ]; then
      lk_warn "transactions older than ${LK_MAX_XACT_AGE}s (pid|user|app|backend|state|age|query):"
      printf '%s' "$xr" >&2; refuse=1
    fi
    [ -n "$xw" ] && { lk_warn "regular autovacuum running (yields to the migration's lock requests):"; printf '%s' "$xw" >&2; }
  else
    lk_say "db: no other transaction older than ${LK_MAX_XACT_AGE}s"
  fi
  if [ -n "$lockq_refuse" ]; then
    lk_warn "lock queue / strong locks on public|storage tables (pid|mode|state|table|app|backend):"
    printf '%s' "$lockq_refuse" | sed 's/^/    /' >&2; refuse=1
  fi
  [ -n "$lockq_warn" ] && { lk_warn "autovacuum locks (yield to the migration):"; printf '%s' "$lockq_warn" | sed 's/^/    /' >&2; }
  if [ -n "$vac_refuse" ]; then
    lk_warn "VACUUM that will not yield (anti-wraparound or manual): $vac_refuse"; refuse=1
  fi
  [ -n "$vac_warn" ] && lk_warn "regular autovacuum in progress (yields): $(printf '%s' "$vac_warn" | tr '\n' ' ')"
  if [ -n "$dumps" ]; then
    lk_warn "pg_dump / COPY TO in progress (holds ACCESS SHARE on every table): $(printf '%s' "$dumps" | tr '\n' ' ')"; refuse=1
  fi
  if [ -n "$newer" ]; then
    lk_warn "portal_migrations has files newer than the series (named after 20261015_0036, or applied after LK_LEDGER_SINCE=$LK_LEDGER_SINCE): prod changed after the series was tested; re-check before applying:"
    printf '%s' "$newer" | sed 's/^/    /' >&2
  fi
  if [ -n "$unapplied" ]; then
    lk_warn "other repo migrations are not in portal_migrations; the deploy runner would apply them, this script does not:"
    printf '%s' "$unapplied" | sed 's/^/    /' >&2
  fi

  LK_PENDING=""
  for f in $LK_FILES; do
    if printf '%s' "$LK_APPLIED" | grep -qx "$f"; then lk_say "already applied: $f"
    else LK_PENDING="$LK_PENDING$f"$'\n'; fi
  done
  if [ -n "$LK_PENDING" ]; then
    lk_say "to apply, in this order: $(printf '%s' "$LK_PENDING" | tr '\n' ' ')"
  else
    lk_say "every file of the series is already in portal_migrations"
  fi

  [ "$refuse" -eq 0 ] && return 0
  lk_warn "REFUSED: fix the items above and run again"
  return 2
}

# Blockers right now (read-only), printed after a lock error.
lk_print_blockers() {
  lk_ro "
select '    ' || a.pid || '|' || coalesce(a.usename, '') || '|' || coalesce(a.application_name, '') || '|'
       || coalesce(a.state, '') || '|' || coalesce(round(extract(epoch from now() - a.xact_start))::int, -1) || 's|'
       || left(regexp_replace(coalesce(a.query, ''), '\\s+', ' ', 'g'), 120)
  from pg_stat_activity a
 where a.pid <> pg_backend_pid() and a.xact_start < now() - interval '1 second'
 order by a.xact_start;" 2>&1 | sed 's/^/[lockdown]   blocker? /' >&2 || true
}

# The last error of a psql stderr log with its DETAIL/HINT/CONTEXT lines.
lk_error_tail() {
  awk '/(ERROR|FATAL):  / { buf = ""; on = 1 } on { buf = buf $0 "\n" } END { printf "%s", buf }' "$1" | head -n 14
}

# SQL that prints a progress mark: LKNIGHT|<what>|<file>|<epoch ms>[|<AccessExclusive>|<locks>]
lk_mark_sql() {
  if [ "${3:-}" = locks ]; then
    printf "select 'LKNIGHT|%s|%s|' || (extract(epoch from clock_timestamp()) * 1000)::bigint || '|' || (select count(*) from pg_catalog.pg_locks where pid = pg_backend_pid() and locktype = 'relation' and mode = 'AccessExclusiveLock') || '|' || (select count(*) from pg_catalog.pg_locks where pid = pg_backend_pid());\n" "$1" "$2"
  else
    printf "select 'LKNIGHT|%s|%s|' || (extract(epoch from clock_timestamp()) * 1000)::bigint;\n" "$1" "$2"
  fi
}

# The SQLSTATE of the last error in a psql (VERBOSITY=verbose) stderr log, or empty.
lk_last_sqlstate() {
  grep -Eo 'ERROR:  [0-9A-Z]{5}:' "$1" | tail -n 1 | sed -E 's/ERROR:  ([0-9A-Z]{5}):/\1/' || true
}

# ensureDatabase.js isRetryableDbError(): lock waits only.
lk_is_retryable() {  # $1 = psql exit code, $2 = stderr log
  local code
  # psql: 2 = connection lost or refused; ssh (LK_PSQL over ssh): 255 = ssh failed.
  if [ "$1" -eq 2 ] || [ "$1" -eq 255 ]; then return 0; fi
  code="$(lk_last_sqlstate "$2")"
  case "$code" in
    55P03|40P01) return 0 ;;
    57014)
      # Only a statement_timeout that cut a `lock table` (the lock phase); the innermost
      # CONTEXT line names it. A manual cancel is not a timeout.
      grep -q 'canceling statement due to statement timeout' "$2" || return 1
      awk '/ERROR:  57014:/ { want = 1; next } want && /^CONTEXT:  / { print; exit }' "$2" \
        | grep -Eiq '^CONTEXT:  SQL statement "lock table .+ in [a-z ]+ mode"$' ;;
    *) return 1 ;;
  esac
}

lk_rehearsal_stamp() { printf '%s/rehearsal-ok' "$LK_LOG_DIR"; }

# The rehearsal must have passed on these exact bytes, recently.
lk_check_rehearsal() {
  local stamp f h ts now
  stamp="$(lk_rehearsal_stamp)"
  [ -f "$stamp" ] || { lk_warn "no successful rehearsal recorded in $stamp (run 20261015_lockdown_rehearsal.sh first)"; return 1; }
  ts="$(sed -n 's/^epoch \([0-9][0-9]*\)$/\1/p' "$stamp" | head -n 1)"
  now="$(date +%s)"
  if [ -z "$ts" ] || [ $((now - ts)) -gt "$LK_REHEARSAL_MAX_AGE" ]; then
    lk_warn "the recorded rehearsal is older than ${LK_REHEARSAL_MAX_AGE}s ($stamp); rehearse again"; return 1
  fi
  for f in $(printf '%s' "$LK_PENDING"); do
    h="$(lk_sha256 "$LK_MIGRATIONS_DIR/$f")"
    grep -qx "$h  $f" "$stamp" || { lk_warn "$f was not rehearsed with these bytes ($h)"; return 1; }
  done
  lk_say "rehearsal stamp ok: $(sed -n 's/^at //p' "$stamp" | head -n 1)"
  return 0
}

lk_apply_one() {  # $1 = file name; returns 0 applied, 3 failed
  local f="$1" path="$LK_MIGRATIONS_DIR/$1" attempt=0 rc base t0 t1 marks st en cm ael locks
  local no_tx=0
  lk_is_no_transaction "$path" && no_tx=1
  if [ "$no_tx" -eq 1 ] && grep -Eq '\$[A-Za-z_0-9]*\$' "$path"; then
    lk_warn "$f: a no-transaction migration cannot contain dollar quotes (the runner refuses it too)"; return 3
  fi
  while :; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 1 ]; then
      # The previous attempt may have committed before the connection dropped.
      if lk_ro "select 1 from public.portal_migrations where name = $(lk_sql_quote "$f");" 2>/dev/null | grep -qx 1; then
        lk_say "$f is in portal_migrations now (committed by the previous attempt); continuing"
        LK_TIMINGS="$LK_TIMINGS$f|earlier|-|-|-|-|$((attempt - 1))"$'\n'
        return 0
      fi
    fi
    base="$LK_LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-apply-$f-try$attempt"
    {
      printf "set lock_timeout = '%s';\n" "$LK_SESSION_LOCK_TIMEOUT"
      printf "set application_name = 'lockdown-apply';\n"
      if [ "$no_tx" -eq 1 ]; then
        lk_mark_sql start "$f"
        cat "$path"; printf '\n'
        printf "insert into public.portal_migrations (name) values (%s);\n" "$(lk_sql_quote "$f")"
        lk_mark_sql end "$f"
        lk_mark_sql committed "$f"
      else
        printf 'begin;\n'
        lk_mark_sql start "$f"
        cat "$path"; printf '\n'
        printf "insert into public.portal_migrations (name) values (%s);\n" "$(lk_sql_quote "$f")"
        lk_mark_sql end "$f" locks
        printf 'commit;\n'
        lk_mark_sql committed "$f"
      fi
    } > "$base.sql"
    lk_say "applying $f (attempt $attempt)$([ "$no_tx" -eq 1 ] && printf ' [no-transaction]')"
    t0="$(lk_now_ms)"
    set +e
    lk_psql -At < "$base.sql" > "$base.out" 2> "$base.err"
    rc=$?
    set -e
    t1="$(lk_now_ms)"
    marks="$(grep '^LKNIGHT|' "$base.out" || true)"
    st="$(printf '%s\n' "$marks" | awk -F'|' '$2 == "start" { print $4 }')"
    en="$(printf '%s\n' "$marks" | awk -F'|' '$2 == "end" { print $4 }')"
    cm="$(printf '%s\n' "$marks" | awk -F'|' '$2 == "committed" { print $4 }')"
    ael="$(printf '%s\n' "$marks" | awk -F'|' '$2 == "end" { print $5 }')"
    locks="$(printf '%s\n' "$marks" | awk -F'|' '$2 == "end" { print $6 }')"
    if [ "$rc" -eq 0 ] && [ -n "$cm" ]; then
      LK_TIMINGS="$LK_TIMINGS$f|$((en - st))|$((cm - en))|$((t1 - t0))|${ael:-}|${locks:-}|$attempt"$'\n'
      lk_say "  done: file $((en - st)) ms, commit $((cm - en)) ms, wall $((t1 - t0)) ms, AccessExclusive ${ael:--} / locks ${locks:--}"
      return 0
    fi
    if [ "$rc" -eq 0 ]; then
      lk_warn "$f: psql exited 0 without the commit mark; see $base.out / $base.err"; return 3
    fi
    lk_warn "$f failed (psql exit $rc, SQLSTATE $(lk_last_sqlstate "$base.err"), after $((t1 - t0)) ms):"
    lk_error_tail "$base.err" | sed 's/^/    /' >&2 || true
    # Lost-connection race: the earlier attempt's server session outlived the dropped ssh
    # and committed after the ledger check above; this attempt then re-ran the (idempotent)
    # file and failed on its ledger row (23505 portal_migrations_pkey) and rolled back. Any
    # failure of a retry while the ledger row is there means the file is applied once.
    if [ "$attempt" -gt 1 ] \
       && lk_ro "select 1 from public.portal_migrations where name = $(lk_sql_quote "$f");" 2>/dev/null | grep -qx 1; then
      lk_say "$f: its ledger row exists: an earlier attempt (cut off by the lost connection) committed it; this attempt (SQLSTATE $(lk_last_sqlstate "$base.err")) changed nothing; continuing"
      LK_TIMINGS="$LK_TIMINGS$f|earlier|-|-|-|-|$((attempt - 1))"$'\n'
      return 0
    fi
    if lk_is_retryable "$rc" "$base.err" && [ "$attempt" -le "$LK_LOCK_RETRIES" ]; then
      lk_print_blockers
      lk_say "lock/connection error: the file rolled back as a whole; retry in ${LK_RETRY_DELAY}s ($attempt/$LK_LOCK_RETRIES)"
      sleep "$LK_RETRY_DELAY"
      continue
    fi
    lk_is_retryable "$rc" "$base.err" && lk_print_blockers
    return 3
  done
}

lk_print_timings() {
  [ -n "$LK_TIMINGS" ] || return 0
  printf '\n%-48s %9s %9s %9s %6s %7s %5s\n' file file_ms commit_ms wall_ms AExcl locks tries
  printf '%s' "$LK_TIMINGS" | awk -F'|' 'NF >= 7 { printf "%-48s %9s %9s %9s %6s %7s %5s\n", $1, $2, $3, $4, $5, $6, $7 }'
}

lk_apply_main() {
  local yes=0 skip_rehearsal=0 a f applied_now=0 rc
  for a in "$@"; do
    case "$a" in
      --yes) yes=1 ;;
      --skip-rehearsal-check) skip_rehearsal=1 ;;
      -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}"; return 0 ;;
      *) lk_die "unknown argument: $a" ;;
    esac
  done
  set -euo pipefail
  lk_validate_env
  lk_say "$(lk_utc) apply $([ "$yes" -eq 1 ] && printf 'RUN' || printf 'PLAN (no --yes: nothing is written)'); logs: $LK_LOG_DIR"
  rc=0; lk_preflight || rc=$?
  [ "$rc" -eq 0 ] || exit "$rc"
  if [ -z "$LK_PENDING" ]; then lk_say "nothing to apply"; exit 0; fi
  if [ "$yes" -ne 1 ]; then
    lk_say "plan only; add --yes to apply"
    exit 0
  fi
  if [ "$skip_rehearsal" -ne 1 ]; then
    lk_check_rehearsal || lk_die "refusing without a matching rehearsal (or pass --skip-rehearsal-check)" 2
  fi
  LK_TIMINGS=""
  for f in $(printf '%s' "$LK_PENDING"); do
    rc=0; lk_apply_one "$f" || rc=$?
    if [ "$rc" -ne 0 ]; then
      lk_print_timings
      lk_warn "STOPPED at $f. Files before it are committed; $f and the rest are not (a no-transaction file keeps the statements that already ran)."
      lk_warn "Rerun is safe (applied files are skipped). Rollback order is in the runbook."
      if [ "$applied_now" -gt 0 ]; then
        if printf "notify pgrst, 'reload schema';\n" | lk_psql >/dev/null 2>&1; then
          lk_say "PostgREST schema cache reload requested ($applied_now file(s) committed before the stop)"
        else
          lk_warn "notify pgrst failed"
        fi
      fi
      exit 3
    fi
    applied_now=$((applied_now + 1))
  done
  # Like the runner: PostgREST re-reads its schema cache once something was applied.
  if printf "notify pgrst, 'reload schema';\n" | lk_psql; then
    lk_say "PostgREST schema cache reload requested ($applied_now file(s))"
  else
    lk_warn "notify pgrst failed; restart main-rest if the API misbehaves"
  fi
  lk_print_timings
  lk_say "$(lk_utc) applied $applied_now file(s). Next: 20261015_lockdown_smoke.sql"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  lk_apply_main "$@"
fi
