/**
 * BYO replies worker — раз в минуту опрашивает IMAP подключённых ящиков клиентов
 * и складывает новые ответы в client_byo_replies.
 *
 * Прод: контейнер portal-worker-byo-replies (WORKER_KIND=byoreplies).
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
  setupGracefulShutdown,
  pollLoop,
} from './_shared';
import { processByoRepliesBatch } from '@/lib/byoMailbox/repliesSync';

const log = createWorkerLogger('byo-replies');

async function main() {
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);
  log('info', 'BYO replies worker started');

  await pollLoop({
    log,
    pollIntervalMs: 60_000, // опрашиваем IMAP раз в минуту (нет realtime-триггера)
    shouldStop,
    pollOnce: () => processByoRepliesBatch({ log }),
  });
}

void main();
