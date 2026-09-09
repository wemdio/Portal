#!/usr/bin/env bash
# No remote writes: stream a fixed diagnostic program, never deploy scripts.
set +x
set -euo pipefail

fail() { printf '[ssh-check] %s\n' "$1" >&2; exit 1; }

# These are guardrails against accidental execution, not an authorization system.
[[ "${SEMAPHORE:-}" == true ]] || fail 'Run only in Semaphore.'
[[ "${SEMAPHORE_GIT_BRANCH:-}" == Sergey ]] || fail 'Only the Sergey branch is allowed.'
# Tasks -> Run now is MANUAL_RUN, not SCHEDULE (which means the cron path).
[[ "${SEMAPHORE_WORKFLOW_TRIGGERED_BY_MANUAL_RUN:-}" == true ]] || fail 'Run only through the dedicated Task Run now action.'
[[ "${SSH_ACCESS_CHECK_CONFIRM:-}" == CHECK_ONLY_33074 ]] || fail 'Explicit read-only confirmation is missing.'

# Verified in Hostkey server 33074 on 2026-09-09; older repository docs say .12.
# Never override a conflicting secret, even if another address accepts SSH.
[[ "${HOST:-}" == 139.60.162.24 ]] || fail 'HOST does not match verified server 33074 (139.60.162.24); stop and investigate.'
[[ "${USER:-}" == root ]] || fail 'The saved SSH user is not root; stop and investigate.'
[[ -n "${SERVER_PASSWORD:-}" ]] || fail 'The existing CI SSH password is unavailable.'
for recovery_command in ssh sshpass ssh-keygen timeout mktemp; do
  command -v "$recovery_command" >/dev/null || fail "Missing command: $recovery_command"
done

umask 077
recovery_dir=$(mktemp -d "${TMPDIR:-/tmp}/portal-ssh-check.XXXXXXXX")
cleanup() {
  # Exact files in this invocation's mktemp directory; no recursive deletion.
  rm -f -- "$recovery_dir/known_hosts"
  rmdir -- "$recovery_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Public host key, NOT a login credential. Pinned before any password is sent.
printf '%s\n' '139.60.162.24 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJUxmzADhlR7c6L5exC+ED/RoGOHBsr2/88qiJwMg5M' > "$recovery_dir/known_hosts"
recovery_fingerprint=$(ssh-keygen -lf "$recovery_dir/known_hosts" -E sha256 | awk '{print $2}')
[[ "$recovery_fingerprint" == SHA256:dl0Kdm8qTiwQlu1DpBC3w77WIxjSPG0BhQJs2D/RW0o ]] || fail 'Pinned host key fingerprint mismatch.'

recovery_ssh=(
  -F /dev/null -T
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$recovery_dir/known_hosts"
  -o GlobalKnownHostsFile=/dev/null
  -o UpdateHostKeys=no
  -o HostKeyAlgorithms=ssh-ed25519
  -o VerifyHostKeyDNS=no
  -o ControlMaster=no -o ControlPath=none
  -o IdentityAgent=none -o PubkeyAuthentication=no
  -o PreferredAuthentications=password -o PasswordAuthentication=yes
  -o KbdInteractiveAuthentication=no -o NumberOfPasswordPrompts=1
  -o ForwardAgent=no -o ClearAllForwardings=yes
  -o ConnectTimeout=15 -o ConnectionAttempts=1
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2
  -o LogLevel=ERROR
)

printf '[ssh-check] One read-only connection to verified root@139.60.162.24; no retries.\n'
# Password lives only in the child process environment, not argv or a file.
# No xtrace, verbose SSH, environment dumps or artifacts containing credentials.
SSHPASS="$SERVER_PASSWORD" timeout --kill-after=5s 75s sshpass -e ssh "${recovery_ssh[@]}" \
  root@139.60.162.24 'bash --noprofile --norc -s' <<'REMOTE_CHECK'
set +x
set -euo pipefail
[[ "$(id -u)" == 0 ]] || { printf 'Unexpected remote UID; stopping.\n' >&2; exit 1; }
read -r recovery_source recovery_source_port recovery_address recovery_port <<< "${SSH_CONNECTION:-}"
[[ "$recovery_address" == 139.60.162.24 && "$recovery_port" == 22 ]] || {
  printf 'Unexpected remote SSH endpoint; stopping.\n' >&2; exit 1;
}

printf '\nIdentity and connection (not credentials):\n'
hostname
id -u
printf 'SSH source=%s destination=%s port=%s\n' "$recovery_source" "$recovery_address" "$recovery_port"
getent passwd root | awk -F: '{printf "root uid=%s home=%s shell=%s\n", $3, $6, $7}'

printf '\nsshd process arguments (check for custom -f / -o settings):\n'
ps -C sshd -o pid=,ppid=,args=

printf '\nDefault on-disk sshd configuration for this CI connection:\n'
printf 'NOT proof of the live daemon or Mac rules: review process overrides and Match blocks first.\n'
/usr/sbin/sshd -T -C "user=root,addr=$recovery_source,laddr=$recovery_address,lport=$recovery_port" |
  awk '$1 ~ /^(pubkeyauthentication|permitrootlogin|authenticationmethods|authorizedkeysfile|authorizedkeyscommand|authorizedkeyscommanduser|strictmodes|forcecommand|allowusers|denyusers|allowgroups|denygroups|usedns)$/ {print}'

printf '\nConventional root key path metadata only (no key contents):\n'
for recovery_path in /root /root/.ssh /root/.ssh/authorized_keys; do
  if [[ -e "$recovery_path" || -L "$recovery_path" ]]; then
    stat --printf='%F mode=%a uid=%u gid=%g links=%h path=%n\n' -- "$recovery_path"
  else
    printf 'Absent: %s\n' "$recovery_path"
  fi
done
printf '\nCHECK_COMPLETE: no keys, permissions, services, databases or application files changed.\n'
REMOTE_CHECK
