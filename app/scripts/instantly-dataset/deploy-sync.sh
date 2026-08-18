#!/bin/bash
# Deploy sync.mjs to prod server. Run from project root.
#
# РАЗДЕЛЕНИЕ ОТВЕТСТВЕННОСТИ (с 2026-08-18):
#   * КОД (*.mjs, *.sql из списка ниже) на прод катит и scheduled-deploy из main
#     (.semaphore/scheduled-deploy.yml, шаг «Dataset sync»; цель dataset_sync
#     в .semaphore/select-deploy-targets.sh срабатывает на изменения в
#     app/scripts/instantly-dataset/*). Список файлов там ДОЛЖЕН совпадать с шагами 1–1d ниже.
#   * ЭТОТ скрипт остаётся для того, чего CI не трогает: прод-.env синка (собирается из
#     ЛОКАЛЬНОГО .env — перед запуском сверь INSTANTLY_DATASET_DB_URL: стейл-хост 144
#     откатит прод), crontab, npm install (package.json), а также для хотфиксов до мержа.
#   ВНИМАНИЕ (Windows): pscp копирует байты как есть — CRLF-чекаут уедет на прод как CRLF.
#   Работает, но CI (Linux, LF) при следующем деплое перепишет файлы; прежняя версия
#   остаётся в /opt/instantly-dataset-sync/.prev/.
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

# 1. sync.mjs + 022 DDL (ночной захват карточек лидов — sync.mjs применяет идемпотентно при старте)
"$PSCP" -batch -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" \
  app/scripts/instantly-dataset/sync.mjs "$PROD:$REMOTE/sync.mjs"
"$PSCP" -batch -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" \
  app/scripts/instantly-dataset/022_leads_capture.sql "$PROD:$REMOTE/022_leads_capture.sql"

# 1b. label-new-replies.mjs (ночная авто-разметка исходов: правила + Requesty LLM)
"$PSCP" -batch -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" \
  app/scripts/instantly-dataset/label-new-replies.mjs "$PROD:$REMOTE/label-new-replies.mjs"

# 1c. label-new-segments.mjs (ночная авто-разметка НИШ кампаний: правила + Requesty LLM)
"$PSCP" -batch -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" \
  app/scripts/instantly-dataset/label-new-segments.mjs "$PROD:$REMOTE/label-new-segments.mjs"

# 1d. sync-portal-mirror.mjs + 018 DDL (ночное зеркало портальных данных — управленческий контур)
"$PSCP" -batch -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" \
  app/scripts/instantly-dataset/sync-portal-mirror.mjs "$PROD:$REMOTE/sync-portal-mirror.mjs"
"$PSCP" -batch -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" \
  app/scripts/instantly-dataset/018_portal_mirror.sql "$PROD:$REMOTE/018_portal_mirror.sql"

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

# 3. .env with only the keys sync.mjs + label-new-replies.mjs + label-new-segments.mjs need
#    (INSTANTLY_SEGMENT_MODEL опционален — если не задан, скрипт берёт policy/INSTANTLY_LEAD_QUAL_MODEL)
grep -E '^(INSTANTLY_EXPORT_API_KEY|INSTANTLY_PORTAL_API_KEY|INSTANTLY_DATASET_DB_URL|REQUESTY_API_KEY|REQUESTY_MODEL|REQUESTY_ENDPOINT|LABEL_WINDOW_DAYS|LABEL_NIGHTLY_CAP|LABEL_BATCH_SIZE|INSTANTLY_SEGMENT_MODEL|SEGMENT_BATCH_SIZE|SEGMENT_CAP)=' .env > /tmp/dataset-sync.env
"$PSCP" -batch -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" \
  /tmp/dataset-sync.env "$PROD:$REMOTE/.env"
# 3b. MAIN_DB_URL для зеркала Портала — берём НА СЕРВЕРЕ из прод-.env приложения
#     (локальный DATABASE_URL — это облачный dev, его в прод-крон нельзя) + ужимаем права файла
"$PLINK" -batch -ssh -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" "$PROD" \
  "grep '^DATABASE_URL=' /home/Portal/prod/.env | sed 's/^DATABASE_URL=/MAIN_DB_URL=/' >> $REMOTE/.env && chmod 600 $REMOTE/.env"

# 4. npm install via docker (host has no node)
"$PLINK" -batch -ssh -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" "$PROD" \
  "cd $REMOTE && docker run --rm -v \$PWD:/app -w /app node:22-alpine npm install --omit=dev --silent 2>&1 | tail -5"

# 5. cron entries — idempotent. Время в crontab — ЛОКАЛЬНОЕ время сервера (МСК): sync 00:00, portal-mirror 01:00, reply-labeler 02:00, segment-labeler 02:30.
"$PLINK" -batch -ssh -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" "$PROD" \
  "(crontab -l 2>/dev/null | grep -v instantly-dataset-sync | grep -v instantly-reply-labeler | grep -v instantly-segment-labeler | grep -v instantly-portal-mirror; echo '0 0 * * * docker run --rm -v /opt/instantly-dataset-sync:/app -w /app --env-file /opt/instantly-dataset-sync/.env --name instantly-dataset-sync node:22-alpine node sync.mjs >> /var/log/instantly-dataset-sync/\$(date -u +\\%Y-\\%m-\\%d).log 2>&1'; echo '0 1 * * * docker run --rm -v /opt/instantly-dataset-sync:/app -w /app --env-file /opt/instantly-dataset-sync/.env --name instantly-portal-mirror node:22-alpine node sync-portal-mirror.mjs >> /var/log/instantly-dataset-sync/portal-mirror-\$(date -u +\\%Y-\\%m-\\%d).log 2>&1'; echo '0 2 * * * docker run --rm -v /opt/instantly-dataset-sync:/app -w /app --env-file /opt/instantly-dataset-sync/.env --name instantly-reply-labeler node:22-alpine node label-new-replies.mjs >> /var/log/instantly-dataset-sync/labeler-\$(date -u +\\%Y-\\%m-\\%d).log 2>&1'; echo '30 2 * * * docker run --rm -v /opt/instantly-dataset-sync:/app -w /app --env-file /opt/instantly-dataset-sync/.env --name instantly-segment-labeler node:22-alpine node label-new-segments.mjs >> /var/log/instantly-dataset-sync/segments-\$(date -u +\\%Y-\\%m-\\%d).log 2>&1') | crontab -"

# 6. Show final state
echo "=== installed files ==="
"$PLINK" -batch -ssh -hostkey "$PROD_SERVER_HOST_KEY" -pw "$PROD_SERVER_PASSWORD" "$PROD" "ls -la $REMOTE && echo && echo '=== cron ===' && crontab -l | grep -E 'instantly-dataset-sync|instantly-reply-labeler|instantly-segment-labeler|instantly-portal-mirror' && echo && echo '=== docker node test ===' && docker run --rm node:22-alpine node --version"

# Cleanup local temp files
rm -f /tmp/dataset-sync-package.json /tmp/dataset-sync.env
echo
echo "✓ deployed. Cron will fire next at 00:00 МСК (21:00 UTC). To test manually right now:"
echo "  ssh root@${PROD_SERVER_HOST} 'docker run --rm -v /opt/instantly-dataset-sync:/app -w /app --env-file /opt/instantly-dataset-sync/.env node:22-alpine node sync.mjs --dry-run'"
