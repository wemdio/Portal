#!/bin/sh
set -e

if [ -f /app/host.env ]; then
  chown nextjs:nodejs /app/host.env 2>/dev/null || chmod 666 /app/host.env 2>/dev/null || true
fi

exec su-exec nextjs "$@"
