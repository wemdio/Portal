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
import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop, startWorkerHeartbeat } from './_shared';
import { verifyPendingMailboxes } from '@/lib/sender/verifyWorker';
import { planSenderMessages } from '@/lib/sender/planner';
import { processSenderBatch } from '@/lib/sender/sendWorker';
import { processSenderReplies } from '@/lib/sender/repliesWorker';
import { processSendProbes } from '@/lib/sender/probeWorker';
import { processManualMessages } from '@/lib/sender/manualWorker';
import { runSenderMonitor } from '@/lib/sender/monitorWorker';
import { syncGoogleWorkspaceMailboxes } from '@/lib/sender/googleSyncWorker';

const log = createWorkerLogger('sender');

/**
 * Heartbeat-файл: обновляется независимым setInterval-тиком, docker
 * healthcheck на sender-хосте читает mtime и с autoheal перезапускает
 * контейнер при event-loop hang (см. инциденты tgOutreach 35ч и yandexmaps
 * 27.07.2026 — процесс жив, письма не идут).
 */
const HEARTBEAT_PATH = '/tmp/sender-worker-heartbeat';

const REPLIES_INTERVAL_MS = Number(process.env.SENDER_REPLIES_INTERVAL_MS ?? 60_000);
let lastRepliesAt = 0;

// Каталог Workspace меняется редко — раз в час достаточно, чтобы новый ящик
// появился на экране в тот же рабочий час, а домен на сотню ящиков не дёргал
// Google каждую минуту.
const GOOGLE_SYNC_INTERVAL_MS = Number(process.env.SENDER_GOOGLE_SYNC_INTERVAL_MS ?? 3_600_000);
let lastGoogleSyncAt = 0;

// Монитор (5.7/5.8): метрики, TG-алерты и автопауза доменов. Реже отправки —
// метрики скользящие, чаще незачем, а TG не должен шуметь.
const MONITOR_INTERVAL_MS = Number(process.env.SENDER_MONITOR_INTERVAL_MS ?? 300_000);
let lastMonitorAt = 0;

async function tick(): Promise<boolean> {
  if (Date.now() - lastGoogleSyncAt >= GOOGLE_SYNC_INTERVAL_MS) {
    lastGoogleSyncAt = Date.now();
    // Отказ Google не должен ронять отправку: без каталога портал работает по
    // тем ящикам, что уже подключены.
    try {
      await syncGoogleWorkspaceMailboxes({ log });
    } catch (e) {
      log('warn', `Каталог Google не синхронизировался: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await verifyPendingMailboxes({ log });
  await planSenderMessages({ log });
  const sent = await processSenderBatch({ log });

  // Входящие опрашиваем реже отправки: IMAP-опрос всех ящиков дорогой, а
  // новые ответы не требуют реакции в ту же секунду.
  if (Date.now() - lastRepliesAt >= REPLIES_INTERVAL_MS) {
    lastRepliesAt = Date.now();
    await processSenderReplies({ log });
  }

  // Проверочные отправки (кнопка «Проверить отправку»): по одной попытке за
  // тик, отправку не блокируют.
  try {
    await processSendProbes({ log });
  } catch (e) {
    log('warn', `Проверочные отправки не обработались: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Ручные ответы операторов: очередью через БД, SMTP только с этого хоста.
  try {
    await processManualMessages({ log });
  } catch (e) {
    log('warn', `Ручные ответы не обработались: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (Date.now() - lastMonitorAt >= MONITOR_INTERVAL_MS) {
    lastMonitorAt = Date.now();
    try {
      await runSenderMonitor({ log });
    } catch (e) {
      log('warn', `Монитор не отработал: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return sent;
}

async function main() {
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);
  startWorkerHeartbeat(HEARTBEAT_PATH);
  log('info', `Heartbeat ticker started → ${HEARTBEAT_PATH} (every 30s)`);
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
