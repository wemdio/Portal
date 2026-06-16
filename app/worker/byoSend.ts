/**
 * BYO send worker — рассылает письма кампаний из очереди client_byo_messages
 * через подключённые ящики клиентов (наш SMTP-движок), соблюдая дневной лимит.
 *
 * Запуск (dev): node --env-file ../.env dist/workers/byoSend.js
 * В проде — отдельный контейнер (portal-worker-byo-send), как остальные воркеры.
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
  setupGracefulShutdown,
  pollLoop,
} from './_shared';
import { processByoSendBatch } from '@/lib/byoMailbox/sender';

const log = createWorkerLogger('byo-send');

async function main() {
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);
  log('info', 'BYO send worker started');

  await pollLoop({
    log,
    pollIntervalMs: 15_000,
    shouldStop,
    realtimeTables: ['client_byo_messages'],
    pollOnce: () => processByoSendBatch({ log }),
  });
}

void main();
