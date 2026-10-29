#!/usr/bin/env bash
# One owner-checked attempt; the workflow handles retries and SSH failures.
set -eu

owner_id=${1:?Workflow lock owner is required}
lock=/home/Portal/prod/.scheduled-deploy-lock
case "$owner_id" in *[!a-zA-Z0-9_-]*|'') echo 'Invalid lock owner' >&2; exit 1;; esac

if [ ! -e "$lock" ] && [ ! -L "$lock" ]; then
  echo '[scheduled] Workflow lock absence verified.'
  exit 0
fi
[ -d "$lock" ] && [ ! -L "$lock" ] && [ ! -L "$lock/owner" ] || {
  echo '[scheduled] Unexpected workflow lock type; refusing cleanup.' >&2
  exit 1
}
[ "$(cat "$lock/owner" 2>/dev/null)" = "$owner_id" ] || {
  echo '[scheduled] Workflow lock belongs to another owner; refusing cleanup.' >&2
  exit 1
}

lock_identity=$(stat -c '%d:%i' "$lock")
rm -- "$lock/owner"
if ! rmdir -- "$lock"; then
  # Retain proof of ownership for the next attempt if directory removal fails.
  # Never overwrite a marker or restore it into a replacement directory.
  if [ ! -L "$lock" ] && [ "$(stat -c '%d:%i' "$lock" 2>/dev/null)" = "$lock_identity" ]; then
    (set -C; printf '%s' "$owner_id" > "$lock/owner") || true
  fi
  echo '[scheduled] Workflow lock directory removal failed.' >&2
  exit 1
fi

[ ! -e "$lock" ] && [ ! -L "$lock" ] || {
  echo '[scheduled] Workflow lock absence could not be verified.' >&2
  exit 1
}
echo '[scheduled] Workflow lock removal verified.'
