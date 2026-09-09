#!/usr/bin/env bash
# This is deliberately separate from the read-only check. No deploy functions.
set +x
set -euo pipefail
fail() { printf '[ssh-key-install] %s\n' "$1" >&2; exit 1; }

[[ "${SEMAPHORE:-}" == true ]] || fail 'Run only in Semaphore.'
[[ "${SEMAPHORE_GIT_BRANCH:-}" == Sergey ]] || fail 'Only Sergey is allowed.'
[[ "${SEMAPHORE_WORKFLOW_TRIGGERED_BY_MANUAL_RUN:-}" == true ]] || fail 'Use the dedicated Task Run now action.'
[[ "${SSH_KEY_INSTALL_CONFIRM:-}" == INSTALL_MAC_KEY_33074 ]] || fail 'Explicit key-install approval is missing.'
[[ "${HOST:-}" == 139.60.162.24 ]] || fail 'Saved HOST does not match server 33074; stop.'
[[ "${USER:-}" == root ]] || fail 'Saved SSH user is not root; stop.'
[[ -n "${SERVER_PASSWORD:-}" ]] || fail 'Existing CI SSH password is unavailable.'
# Only an IPv4 literal can enter the remote command; range/global checks are remote.
[[ "${SSH_MAC_PUBLIC_IP:-}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail 'Supply the freshly checked Mac public IPv4 address.'
for recovery_command in ssh sshpass ssh-keygen timeout mktemp; do
  command -v "$recovery_command" >/dev/null || fail "Missing command: $recovery_command"
done
recovery_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -f "$recovery_script_dir/ssh-key-install-remote.py" ]] || fail 'Reviewed remote program is missing.'

umask 077
recovery_dir=$(mktemp -d "${TMPDIR:-/tmp}/portal-ssh-key-install.XXXXXXXX")
cleanup() {
  rm -f -- "$recovery_dir/known_hosts"
  rmdir -- "$recovery_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Public server identity, independently verified before the successful check.
printf '%s\n' '139.60.162.24 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJUxmzADhlR7c6L5exC+ED/RoGOHBsr2/88qiJwMg5M' > "$recovery_dir/known_hosts"
recovery_fingerprint=$(ssh-keygen -lf "$recovery_dir/known_hosts" -E sha256 | awk '{print $2}')
[[ "$recovery_fingerprint" == SHA256:dl0Kdm8qTiwQlu1DpBC3w77WIxjSPG0BhQJs2D/RW0o ]] || fail 'Pinned host fingerprint mismatch.'
recovery_ssh=(
  -F /dev/null -T -4
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$recovery_dir/known_hosts"
  -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no
  -o HostKeyAlgorithms=ssh-ed25519 -o VerifyHostKeyDNS=no
  -o ControlMaster=no -o ControlPath=none
  -o IdentityAgent=none -o PubkeyAuthentication=no
  -o PreferredAuthentications=password -o PasswordAuthentication=yes
  -o KbdInteractiveAuthentication=no -o NumberOfPasswordPrompts=1
  -o ForwardAgent=no -o ClearAllForwardings=yes
  -o ConnectTimeout=15 -o ConnectionAttempts=1
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -o LogLevel=ERROR
)
printf '[ssh-key-install] One connection; no automatic retries or rollback.\n'
if SSHPASS="$SERVER_PASSWORD" timeout --kill-after=5s 75s sshpass -e ssh "${recovery_ssh[@]}" \
  root@139.60.162.24 "/usr/bin/python3 -I -S -B - '$SSH_MAC_PUBLIC_IP'" \
  < "$recovery_script_dir/ssh-key-install-remote.py"; then
  printf '[ssh-key-install] Remote result received. Verify a fresh key-only login from the Mac.\n'
else
  fail 'Non-successful/uncertain result. Do NOT rerun or roll back automatically; inspect read-only first.'
fi
