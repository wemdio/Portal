#!/bin/bash
# Deploy sync.mjs to prod server. Run from project root.
#
# Reads SSH credentials from .env.servers (which is gitignored) — no hardcoded
# secrets in this script. Required vars:
#   PROD_SERVER_HOST       — e.g. 139.60.162.12
#   PROD_SERVER_PASSWORD   — root password
#   PROD_SERVER_HOST_KEY   — SHA256 fingerprint of the server's ssh-ed25519 key
#                            (get it once: ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -)
set -euo pipefail

if [ ! -f .env.servers ]; then
  echo "FATAL: .env.servers not found. Run from project root." >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; source .env.servers; set +a

: "${PROD_SERVER_HOST:?PROD_SERVER_HOST missing in .env.servers}"
: "${PROD_SERVER_PASSWORD:?PROD_SERVER_PASSWORD missing in .env.servers}"
: "${PROD_SERVER_HOST_KEY:?PROD_SERVER_HOST_KEY missing in .env.servers (SHA256 fingerprint)}"

PROD="root@${PROD_SERVER_HOST}"
PLINK="C:/Program Files/PuTTY/plink.exe"
PSCP="C:/Program Files/PuTTY/pscp.exe"
REMOTE=/opt/instantly-dataset-sync

"$PLINK" -batch -ssh -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" "$PROD" "mkdir -p $REMOTE && mkdir -p /var/log/instantly-dataset-sync"

# 1. sync.mjs
"$PSCP" -batch -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" \
  app/scripts/instantly-dataset/sync.mjs "$PROD:$REMOTE/sync.mjs"

# 2. package.json (just pg)
cat > /tmp/dataset-sync-package.json <<'EOF'
{
  "name": "instantly-dataset-sync",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "dependencies": { "pg": "^8.13.1" }
}
EOF
"$PSCP" -batch -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" \
  /tmp/dataset-sync-package.json "$PROD:$REMOTE/package.json"

# 3. .env with only the keys sync.mjs needs
grep -E '^(INSTANTLY_EXPORT_API_KEY|INSTANTLY_PORTAL_API_KEY|INSTANTLY_DATASET_DB_URL)=' .env > /tmp/dataset-sync.env
"$PSCP" -batch -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" \
  /tmp/dataset-sync.env "$PROD:$REMOTE/.env"

# 4. npm install via docker (host has no node)
"$PLINK" -batch -ssh -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" "$PROD" \
  "cd $REMOTE && docker run --rm -v \$PWD:/app -w /app node:22-alpine npm install --omit=dev --silent 2>&1 | tail -5"

# 5. cron entry — idempotent, uses docker to run node
"$PLINK" -batch -ssh -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" "$PROD" \
  "(crontab -l 2>/dev/null | grep -v instantly-dataset-sync; echo '0 0 * * * docker run --rm -v /opt/instantly-dataset-sync:/app -w /app --env-file /opt/instantly-dataset-sync/.env --name instantly-dataset-sync node:22-alpine node sync.mjs >> /var/log/instantly-dataset-sync/\$(date -u +\\%Y-\\%m-\\%d).log 2>&1') | crontab -"

# 6. Show final state
echo "=== installed files ==="
"$PLINK" -batch -ssh -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" "$PROD" "ls -la $REMOTE && echo && echo '=== cron ===' && crontab -l | grep instantly-dataset-sync && echo && echo '=== docker node test ===' && docker run --rm node:22-alpine node --version"

# Cleanup local temp files
rm -f /tmp/dataset-sync-package.json /tmp/dataset-sync.env
echo
echo "✓ deployed. Cron will fire next at 00:00 UTC. To test manually right now:"
echo "  ssh root@${PROD_SERVER_HOST} 'docker run --rm -v /opt/instantly-dataset-sync:/app -w /app --env-file /opt/instantly-dataset-sync/.env node:22-alpine node sync.mjs --dry-run'"
