#!/usr/bin/env bash
# 20261015_lockdown_rehearsal.sh — dress rehearsal of the lockdown series 20261015_0030..0036
# on the live main DB, rolled back. One psql session:
#   set lock_timeout = '30s';  begin;
#   for each file not yet in portal_migrations, in order:
#     reset what a fresh runner transaction starts with (role, lock_timeout 30s,
#     statement_timeout and search_path to their defaults), mark, <file>,
#     insert into public.portal_migrations, mark (time, AccessExclusive locks held);
#   20261015_lockdown_smoke.sql (its BEGIN/ROLLBACK lines left out), against the end state;
#   rollback.
# It writes nothing that survives (the ledger rows are rolled back too), but while it runs
# it HOLDS every lock of every file at once, until the ROLLBACK: about 270 tables are
# ACCESS EXCLUSIVE for the sum of the file times plus the smoke. Run it only in the
# window, with the workers stopped; the site waits (or times out) during that time.
# Night runbook: docs/security/2026-10-15-lockdown-night-runbook.md
#
# Usage (bash 3.2+; the Mac works):
#   bash supabase/operator-sql/20261015_lockdown_rehearsal.sh --check   # preflight only (read-only)
#   bash supabase/operator-sql/20261015_lockdown_rehearsal.sh           # rehearse
# Environment: as 20261015_lockdown_apply.sh (LK_PSQL, LK_DOCKER, LK_LOG_DIR, ...), plus
#   LK_SMOKE_FILE  [<this dir>/20261015_lockdown_smoke.sql]
#   LK_REHEARSAL_DEADLOCK_RETRIES  [1]  automatic reruns after a deadlock (40P01), LK_RETRY_DELAY
#                  seconds apart. Holding profiles and the 0033/0034 tables at once, the
#                  rehearsal can close a lock cycle with one live page request (an INSERT whose
#                  FK checks profiles, an embed or RLS sublink on profiles); PostgreSQL then
#                  aborts one side, sometimes the rehearsal. Harmless: it rolled back, rerun.
# On success it writes LK_LOG_DIR/rehearsal-ok (sha256 of every rehearsed file); the apply
# script requires it. Logs: LK_LOG_DIR/<UTC>-rehearsal.{sql,out,err} (a rerun after a
# deadlock: <UTC>-rehearsal-try2.{out,err}).
# Exit codes: 0 rehearsal passed (or --check passed), 1 usage/environment, 2 preflight
#             refused, 3 a file failed (all rolled back), 4 the smoke failed (all rolled back).

if [ -z "${BASH_VERSION:-}" ]; then echo "run with bash" >&2; exit 1; fi
LK_REHEARSAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Shared preflight and helpers; the apply script's main() does not run when sourced.
# shellcheck source=20261015_lockdown_apply.sh
. "$LK_REHEARSAL_DIR/20261015_lockdown_apply.sh"
LK_SMOKE_FILE="${LK_SMOKE_FILE:-$LK_REHEARSAL_DIR/20261015_lockdown_smoke.sql}"
LK_REHEARSAL_DEADLOCK_RETRIES="${LK_REHEARSAL_DEADLOCK_RETRIES:-1}"

lk_rehearsal_main() {
  local check=0 a rc f base t0 t1 marks last_start attempt out err
  for a in "$@"; do
    case "$a" in
      --check) check=1 ;;
      -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}"; return 0 ;;
      *) lk_die "unknown argument: $a" ;;
    esac
  done
  set -euo pipefail
  lk_validate_env
  case "$LK_REHEARSAL_DEADLOCK_RETRIES" in ''|*[!0-9]*) lk_die "LK_REHEARSAL_DEADLOCK_RETRIES must be a number" ;; esac
  [ -s "$LK_SMOKE_FILE" ] || lk_die "smoke file not found: $LK_SMOKE_FILE"
  # The smoke runs inside this transaction: drop exactly its own BEGIN and ROLLBACK lines.
  if [ "$(grep -cE 'lockdown-smoke:(begin|end)$' "$LK_SMOKE_FILE")" != 2 ]; then
    lk_die "$LK_SMOKE_FILE must have exactly one lockdown-smoke:begin and one lockdown-smoke:end line"
  fi
  lk_say "$(lk_utc) rehearsal $([ "$check" -eq 1 ] && printf 'CHECK (preflight only)' || printf 'RUN'); logs: $LK_LOG_DIR"
  rc=0; lk_preflight || rc=$?
  [ "$rc" -eq 0 ] || exit "$rc"
  if [ "$check" -eq 1 ]; then lk_say "preflight passed"; exit 0; fi
  if [ -z "$LK_PENDING" ]; then lk_say "nothing to rehearse"; exit 0; fi
  # A no-transaction file (create index concurrently ...) cannot run inside the one
  # rehearsal transaction; none of the seven is one.
  for f in $(printf '%s' "$LK_PENDING"); do
    if lk_is_no_transaction "$LK_MIGRATIONS_DIR/$f"; then
      lk_die "$f is a no-transaction migration and cannot be rehearsed in one transaction"
    fi
  done

  base="$LK_LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-rehearsal"
  {
    printf "set lock_timeout = '%s';\n" "$LK_SESSION_LOCK_TIMEOUT"
    printf "set application_name = 'lockdown-rehearsal';\n"
    printf 'begin;\n'
    lk_mark_sql begin all
    for f in $(printf '%s' "$LK_PENDING"); do
      # What the deploy runner's next transaction would start with: no SET LOCAL left over
      # from the previous file (role, statement_timeout, lock_timeout, search_path).
      printf 'set local role none;\n'
      printf "set local lock_timeout = '%s';\n" "$LK_SESSION_LOCK_TIMEOUT"
      printf 'set local statement_timeout to default;\n'
      printf 'set local search_path to default;\n'
      lk_mark_sql start "$f"
      cat "$LK_MIGRATIONS_DIR/$f"; printf '\n'
      printf "insert into public.portal_migrations (name) values (%s);\n" "$(lk_sql_quote "$f")"
      lk_mark_sql end "$f" locks
    done
    printf 'set local role none;\n'
    printf "set local lock_timeout = '%s';\n" "$LK_SESSION_LOCK_TIMEOUT"
    printf "set local statement_timeout = '300s';\n"
    printf 'set local search_path to default;\n'
    lk_mark_sql start smoke
    grep -vE 'lockdown-smoke:(begin|end)$' "$LK_SMOKE_FILE"; printf '\n'
    lk_mark_sql end smoke locks
    printf 'rollback;\n'
    lk_mark_sql rolledback all
  } > "$base.sql"

  attempt=0
  while :; do
    attempt=$((attempt + 1))
    if [ "$attempt" -eq 1 ]; then out="$base.out"; err="$base.err"
    else out="$base-try$attempt.out"; err="$base-try$attempt.err"; fi
    lk_say "rehearsing $(printf '%s' "$LK_PENDING" | wc -l | tr -d ' ') file(s) in one transaction, then ROLLBACK (attempt $attempt; script: $base.sql)"
    t0="$(lk_now_ms)"
    set +e
    lk_psql -At < "$base.sql" > "$out" 2> "$err"
    rc=$?
    set -e
    t1="$(lk_now_ms)"
    marks="$(grep '^LKNIGHT|' "$out" || true)"

    # Per-file timing table from the marks.
    printf '\n%-48s %9s %9s %7s\n' step ms AExcl locks
    printf '%s\n' "$marks" | awk -F'|' '
      $2 == "start" { s[$3] = $4; order[++n] = $3 }
      $2 == "end"   { e[$3] = $4; ael[$3] = $5; lk[$3] = $6 }
      END {
        for (i = 1; i <= n; i++) {
          k = order[i]
          if (k in e) printf "%-48s %9d %9s %7s\n", k, e[k] - s[k], ael[k], lk[k]
          else printf "%-48s %9s\n", k, "FAILED"
        }
      }'
    lk_say "wall time $((t1 - t0)) ms: every lock above was held at once until the ROLLBACK"

    # Smoke verdict lines (NOTICEs go to stderr).
    grep -o 'SMOKE|.*' "$err" | grep -E '\|(FAIL|WARN)\||^SMOKE\|(summary|fingerprint)' | sed 's/^/    /' || true

    # A deadlock with live traffic: the server already rolled everything back. Rerun.
    if [ "$rc" -ne 0 ] && [ "$(lk_last_sqlstate "$err")" = 40P01 ] && [ "$attempt" -le "$LK_REHEARSAL_DEADLOCK_RETRIES" ]; then
      lk_error_tail "$err" | sed 's/^/    /' >&2 || true
      lk_warn "deadlock (40P01) with a live request while every lock was held; nothing kept (rolled back). Rerun in ${LK_RETRY_DELAY}s ($attempt/$LK_REHEARSAL_DEADLOCK_RETRIES)"
      sleep "$LK_RETRY_DELAY"
      continue
    fi
    break
  done

  if [ "$rc" -ne 0 ]; then
    last_start="$(printf '%s\n' "$marks" | awk -F'|' '$2 == "start" { k = $3 } END { print k }')"
    lk_error_tail "$err" | sed 's/^/    /' >&2 || true
    if [ "$last_start" = smoke ] && ! printf '%s\n' "$marks" | grep -q '^LKNIGHT|end|smoke|'; then
      lk_warn "REHEARSAL FAILED in the smoke (psql exit $rc); every file applied, nothing kept (rolled back). Log: $err"
      exit 4
    fi
    lk_warn "REHEARSAL FAILED in ${last_start:-<before the first file>} (psql exit $rc, SQLSTATE $(lk_last_sqlstate "$err")); nothing kept (rolled back). Log: $err"
    lk_is_retryable "$rc" "$err" && { lk_print_blockers; lk_warn "a lock/connection error (55P03, 40P01, 57014 in a lock phase, lost connection): find the holder and rehearse again"; }
    exit 3
  fi
  if ! printf '%s\n' "$marks" | grep -q '^LKNIGHT|rolledback|'; then
    lk_warn "psql exited 0 but the rollback mark is missing; check $out"; exit 3
  fi

  # Nothing may survive: the ledger must look exactly as before.
  local after
  after="$(lk_ro "select m.name from public.portal_migrations m where m.name = any (array[$(for f in $LK_FILES; do printf "%s," "$(lk_sql_quote "$f")"; done | sed 's/,$//')]) order by 1;")"
  if [ "$after" != "$(printf '%s' "$LK_APPLIED" | sed '/^$/d')" ]; then
    lk_warn "portal_migrations changed during the rehearsal (before: $(printf '%s' "$LK_APPLIED" | tr '\n' ' ') now: $(printf '%s' "$after" | tr '\n' ' '))"
    exit 3
  fi

  {
    printf 'at %s\n' "$(lk_utc)"
    printf 'epoch %s\n' "$(date +%s)"
    for f in $(printf '%s' "$LK_PENDING"); do printf '%s  %s\n' "$(lk_sha256 "$LK_MIGRATIONS_DIR/$f")" "$f"; done
  } > "$(lk_rehearsal_stamp)"
  grep -E '^(POLICIES|ACL|FN)\|' "$out" > "$base.fingerprint" || true
  lk_say "REHEARSAL PASSED and rolled back; stamp $(lk_rehearsal_stamp); end-state fingerprint $base.fingerprint ($(wc -l < "$base.fingerprint" | tr -d ' ') lines)"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  lk_rehearsal_main "$@"
fi
