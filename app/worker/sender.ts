/**
 * Sender worker — собственная отправка писем инструмента «Рассылка».
 *
 * Один воркер = один адрес отправки (SENDER_EGRESS_IP). Контейнер сидит в
 * Docker-сети, чей исходящий NAT привязан к этому адресу, поэтому весь его
 * трафик выходит с него. Воркер обслуживает только ящики своего адреса:
 * проверка входа, отправка, ответы, проверочные и ручные письма.
 *
 * Общие задачи парка — раздача адресов новым ящикам, синк каталога Google,
 * планировщик, проверка доставки проб, монитор — выполняет один ведущий:
 * держатель аренды 'global' в БД.
 *
 * Прод: сервис worker-<ip> в compose, собранном deploy/sender/render-compose.sh
 * на каждом sender-хосте. Всё общение с порталом — через БД.
 */
import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop, startWorkerHeartbeat } from './_shared';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyPendingMailboxes } from '@/lib/sender/verifyWorker';
import { planSenderMessages } from '@/lib/sender/planner';
import { processSenderBatch } from '@/lib/sender/sendWorker';
import { processSenderReplies } from '@/lib/sender/repliesWorker';
import { checkDeliveredProbes, sendPendingProbes } from '@/lib/sender/probeWorker';
import { processManualMessages } from '@/lib/sender/manualWorker';
import { runSenderMonitor } from '@/lib/sender/monitorWorker';
import { syncGoogleWorkspaceMailboxes } from '@/lib/sender/googleSyncWorker';
import {
  checkEgress,
  egressIdentityFromEnv,
  GLOBAL_LEASE,
  LeaseKeeper,
  reportEgress,
  type EgressIdentity,
} from '@/lib/sender/egress';

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

/** Как часто перепроверять, с какого адреса нас видит интернет. */
const EGRESS_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** Пульс в реестр адресов — независимым таймером, как heartbeat-файл. */
const EGRESS_REPORT_INTERVAL_MS = 30_000;

/** null — успешной проверки ещё не было; до неё ящики не трогаем. */
let egressOk: boolean | null = null;
let egressError: string | null = null;
let lastEgressCheckAt = 0;
let registryReady = false;

async function refreshEgressVerdict(identity: EgressIdentity): Promise<void> {
  if (egressOk !== null && Date.now() - lastEgressCheckAt < EGRESS_CHECK_INTERVAL_MS) return;
  lastEgressCheckAt = Date.now();
  const verdict = await checkEgress(identity.ip);
  if (verdict.ok === true) {
    if (egressOk !== true) log('info', `Адрес отправки подтверждён: ${identity.ip}`);
    egressOk = true;
    egressError = null;
  } else if (verdict.ok === false) {
    if (egressOk !== false) log('error', verdict.error);
    egressOk = false;
    egressError = verdict.error;
  } else if (egressOk === null) {
    // Сеть сама по себе не меняется: прежний вердикт живёт, пока сервисы молчат.
    log('warn', 'Сервисы определения адреса не ответили — ящики не трогаю до первой успешной проверки');
  }
}

async function report(identity: EgressIdentity): Promise<void> {
  registryReady = await reportEgress(identity, egressOk === false ? egressError : null);
}

async function guarded(name: string, job: () => Promise<unknown>): Promise<void> {
  try {
    await job();
  } catch (e) {
    log('warn', `${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Общие задачи парка — только у держателя аренды. */
async function runFleetJobs(): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;

  await guarded('Раздача адресов новым ящикам', async () => {
    const { data, error } = await db.rpc('sender_assign_egress_ips');
    if (error) throw new Error(error.message);
    if (Number(data) > 0) log('info', `Новым ящикам выданы адреса: ${data}`);
  });

  if (Date.now() - lastGoogleSyncAt >= GOOGLE_SYNC_INTERVAL_MS) {
    lastGoogleSyncAt = Date.now();
    // Отказ Google не должен ронять отправку: без каталога портал работает по
    // тем ящикам, что уже подключены.
    await guarded('Каталог Google не синхронизировался', () => syncGoogleWorkspaceMailboxes({ log }));
  }

  await guarded('Планировщик не отработал', () => planSenderMessages({ log }));
  await guarded('Доставка проб не проверилась', () => checkDeliveredProbes(log));

  if (Date.now() - lastMonitorAt >= MONITOR_INTERVAL_MS) {
    lastMonitorAt = Date.now();
    await guarded('Монитор не отработал', () => runSenderMonitor({ log }));
  }
}

function makeTick(identity: EgressIdentity, lease: LeaseKeeper) {
  const egressIp = identity.ip;
  return async function tick(): Promise<boolean> {
    await refreshEgressVerdict(identity);
    await report(identity);
    // Реестра нет — миграция ещё не применена (sender-хосты выкатываются раньше
    // миграций портала) или БД недоступна: без реестра ящики не трогаем.
    if (!registryReady) {
      log('warn', 'Реестр адресов недоступен — жду');
      return false;
    }

    if (lease.isHeld()) await runFleetJobs();
    if (egressOk !== true) return false;

    await verifyPendingMailboxes({ log, egressIp });
    const sent = await processSenderBatch({ log, egressIp });

    // Входящие опрашиваем реже отправки: IMAP-опрос всех ящиков дорогой, а
    // новые ответы не требуют реакции в ту же секунду.
    if (Date.now() - lastRepliesAt >= REPLIES_INTERVAL_MS) {
      lastRepliesAt = Date.now();
      await processSenderReplies({ log, egressIp });
    }

    // Проверочные отправки и ручные ответы операторов — с ящиков своего адреса.
    await guarded('Проверочные отправки не обработались', () => sendPendingProbes({ log, egressIp }));
    await guarded('Ручные ответы не обработались', () => processManualMessages({ log, egressIp }));

    return sent;
  };
}

async function main() {
  requireSupabaseAdmin(log);
  const identity = egressIdentityFromEnv();
  if (!identity) {
    // Без адреса воркер не знает, чьи ящики его: работать «со всеми» значит
    // входить в чужие ящики с чужого адреса. Падение видно в docker ps.
    log('error', 'SENDER_EGRESS_IP не задан или не IPv4 — воркер не знает своего адреса');
    process.exit(1);
  }

  const shouldStop = setupGracefulShutdown(log);
  startWorkerHeartbeat(HEARTBEAT_PATH);
  log('info', `Heartbeat ticker started → ${HEARTBEAT_PATH} (every 30s)`);

  const reporter = setInterval(() => void report(identity), EGRESS_REPORT_INTERVAL_MS);
  if (typeof reporter.unref === 'function') reporter.unref();

  const lease = new LeaseKeeper(GLOBAL_LEASE, identity.holder, log, () => egressOk === true);
  lease.start();

  log('info', `Sender worker started: адрес ${identity.ip}${identity.host ? `, сервер ${identity.host}` : ''}, держатель ${identity.holder}`);

  await pollLoop({
    log,
    pollIntervalMs: 15_000,
    shouldStop,
    realtimeTables: ['sender_messages'],
    pollOnce: makeTick(identity, lease),
  });

  clearInterval(reporter);
  await lease.stop();
}

void main();
