#!/bin/sh
set -e

if [ -f /app/host.env ]; then
  chown nextjs:nodejs /app/host.env 2>/dev/null || chmod 666 /app/host.env 2>/dev/null || true
fi

# su-exec calls initgroups() which only reads /etc/group — supplementary GIDs
# from docker-compose group_add are lost. Fix: register the Docker socket's
# owning group in /etc/group and add nextjs to it so initgroups() picks it up.
if [ -S /var/run/docker.sock ]; then
  SOCK_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)
  if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "0" ]; then
    if ! awk -F: -v g="$SOCK_GID" '$3 == g { found=1 } END { exit !found }' /etc/group 2>/dev/null; then
      addgroup -S -g "$SOCK_GID" dockersock 2>/dev/null || true
    fi
    GROUP_NAME=$(awk -F: -v g="$SOCK_GID" '$3 == g { print $1; exit }' /etc/group)
    if [ -n "$GROUP_NAME" ]; then
      addgroup nextjs "$GROUP_NAME" 2>/dev/null || true
    fi
  fi
fi

exec su-exec nextjs "$@"
