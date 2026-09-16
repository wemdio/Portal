/**
 * Sender worker — собственная отправка писем инструмента «Рассылка».
 *
 * Один проход: проверить новые ящики → разложить очередь по цепочке и окну
 * отправки → отправить готовые письма → прочитать входящие и оборвать цепочку
 * тем, кто ответил.
 *
 * Прод: контейнер portal-worker-sender (WORKER_KIND=sender). Отправка
 * вынесена на отдельный сервер, поэтому воркер не зависит от остального
 * портала: всё общение — через БД.
 */
import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop } from './_shared';
import { verifyPendingMailboxes } from '@/lib/sender/verifyWorker';
import { planSenderMessages } from '@/lib/sender/planner';
import { processSenderBatch } from '@/lib/sender/sendWorker';
import { processSenderReplies } from '@/lib/sender/repliesWorker';

const log = createWorkerLogger('sender');

const REPLIES_INTERVAL_MS = Number(process.env.SENDER_REPLIES_INTERVAL_MS ?? 60_000);
let lastRepliesAt = 0;

async function tick(): Promise<boolean> {
  await verifyPendingMailboxes({ log });
  await planSenderMessages({ log });
  const sent = await processSenderBatch({ log });

  // Входящие опрашиваем реже отправки: IMAP-опрос всех ящиков дорогой, а
  // новые ответы не требуют реакции в ту же секунду.
  if (Date.now() - lastRepliesAt >= REPLIES_INTERVAL_MS) {
    lastRepliesAt = Date.now();
    await processSenderReplies({ log });
  }

  return sent;
}

async function main() {
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);
  log('info', 'Sender worker started');

  await pollLoop({
    log,
    pollIntervalMs: 15_000,
    shouldStop,
    realtimeTables: ['sender_messages'],
    pollOnce: tick,
  });
}

void main();
