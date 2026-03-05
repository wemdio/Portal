/* eslint-disable @typescript-eslint/no-require-imports */
const { execSync } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const CONTAINER = 'portal-telegram-bot-api';
const IMAGE = 'aiogram/telegram-bot-api:latest';

const apiId = process.env.TELEGRAM_API_ID;
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.log('[tg-bot-api] TELEGRAM_API_ID / TELEGRAM_API_HASH not set — skipping local API server');
  process.exit(0);
}

function run(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

if (run('docker info') === null) {
  console.warn('[tg-bot-api] Docker не запущен — пропускаем. Транскрибация больших видео (>20 МБ) не будет работать.');
  process.exit(0);
}

const inspect = run(`docker inspect -f "{{.State.Running}}" ${CONTAINER}`);

if (inspect === 'true') {
  console.log(`[tg-bot-api] Container ${CONTAINER} already running`);
  process.exit(0);
}

if (inspect !== null) {
  console.log(`[tg-bot-api] Starting existing container ${CONTAINER}...`);
  run(`docker start ${CONTAINER}`);
  console.log(`[tg-bot-api] Started`);
  process.exit(0);
}

console.log(`[tg-bot-api] Creating container ${CONTAINER}...`);
const result = run(
  `docker run -d --name ${CONTAINER}` +
  ` -p 8081:8081` +
  ` -e TELEGRAM_API_ID=${apiId}` +
  ` -e TELEGRAM_API_HASH=${apiHash}` +
  ` -e TELEGRAM_LOCAL=true` +
  ` -v telegram-bot-api-data:/var/lib/telegram-bot-api` +
  ` ${IMAGE}`
);

if (result) {
  console.log(`[tg-bot-api] Container created: ${result.slice(0, 12)}`);
} else {
  console.warn(`[tg-bot-api] Не удалось создать контейнер. Транскрибация больших видео (>20 МБ) не будет работать.`);
  process.exit(0);
}
