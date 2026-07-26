import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { pollAndQualifyReplies, drainWebhookQueue } from '@/lib/instantly/leadQualificationWorker';
import { pollOthersOnce } from '@/lib/instantly/othersWatchdog';
import { createWorkerLogger, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '30000');
const DRAIN_INTERVAL_MS = Number(process.env.INSTANTLY_WEBHOOK_DRAIN_INTERVAL_MS ?? '7000');
const DRAIN_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  (process.env.INSTANTLY_WEBHOOK_DRAIN_ENABLED ?? '').toLowerCase(),
);
// Others-watchdog: ВЫКЛЮЧЕН по умолчанию, включается INSTANTLY_OTHERS_ENABLED=1 —
// та же полярность, что у DRAIN_ENABLED выше. Оба _ENABLED-флага обязаны читаться
// одинаково: одинаковое имя с противоположной логикой (=0 чтобы выключить против
// =1 чтобы включить) — мина для того, кто правит env через месяц. Плюс деплой не
// должен молча включать новое поведение: код едет dormant, флаг щёлкаем осознанно.
const OTHERS_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  (process.env.INSTANTLY_OTHERS_ENABLED ?? '').toLowerCase(),
);
// Интервал НЕ ужимать бездумно: воркспейс-лимит Instantly ~10 RPM почти целиком
// съедает основной поллер (5 страниц × тик 30с); 15 мин = ~0.07 RPM сверху.
// Нижний порог обязателен: пустая env ('' → Number('')=0) или '15m' (NaN)
// превратили бы sleep в ноль — горячий цикл по Instantly API = 429-шторм
// всему воркспейсу (класс инцидента 22.05).
// Пустая/отсутствующая env = «не задано» (NaN → fallback), а не 0: Number('')=0
// проходил бы порог min:0 у стартовой задержки и молча отменял её — первый тик
// вотчдога стартовал бы синхронно с первым тиком поллера (находка ревью 25.07).
function envMs(name: string, fallback: number, min: number): number {
  const env = process.env[name];
  const raw = env === undefined || env === '' ? NaN : Number(env);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}
const OTHERS_INTERVAL_MS = envMs('INSTANTLY_OTHERS_POLL_INTERVAL_MS', 900_000, 60_000);
// Первый тик — с задержкой: на старте воркера pollLoop сразу тянет до 5 страниц
// /emails, а холодный вотчдог — ещё ~11 страниц /accounts; вместе это пробивает
// минутный бюджет воркспейса.
const OTHERS_STARTUP_DELAY_MS = envMs('INSTANTLY_OTHERS_STARTUP_DELAY_MS', 90_000, 0);
const WORKER_ID = `instantly-leads-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Поллинг — система записи / reconciliation-бэкап. Поведение не менялось.
async function pollLoop(shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    try {
      const count = await pollAndQualifyReplies();
      if (count > 0) log('info', `Qualified ${count} reply(s)`);
    } catch (err) {
      log('error', 'Poll cycle failed', err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Others-watchdog — редкий тик по вкладке Unibox «Others»: достаёт реальные
// ответы лидов, которые Instantly засортировал мимо Primary (и мимо основного
// поллера). Свой контур с СОБСТВЕННЫМ интервалом: ошибка/лимит внутри тика не
// трогает основной пайплайн, дедуп с ним — тот же instantly_email_id.
async function othersLoop(shouldStop: () => boolean): Promise<void> {
  await sleep(OTHERS_STARTUP_DELAY_MS);
  while (!shouldStop()) {
    try {
      const count = await pollOthersOnce();
      if (count > 0) log('info', `Others watchdog qualified ${count} reply(s)`);
    } catch (err) {
      log('error', 'Others watchdog cycle failed', err);
    }
    await sleep(OTHERS_INTERVAL_MS);
  }
}

// Real-time путь — разгребает reply-события из очереди вебхуков (за флагом).
// Делит ту же qualifyOneReply + UNIQUE-дедуп instantly_email_id с поллингом,
// поэтому двойных вставок/алертов быть не может.
async function drainLoop(shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    try {
      const n = await drainWebhookQueue();
      if (n > 0) log('info', `Drained ${n} reply(s) from webhook queue`);
    } catch (err) {
      log('error', 'Drain cycle failed', err);
    }
    await sleep(DRAIN_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  log('info', `Starting Instantly lead qualification worker (pid=${process.pid})`);

  if (!supabaseInstantly) {
    log('error', 'INSTANTLY_SUPABASE_URL / INSTANTLY_SUPABASE_SERVICE_ROLE_KEY not set — cannot start');
    process.exit(1);
  }

  const shouldStop = setupGracefulShutdown(log);

  const loops = [pollLoop(shouldStop)];
  if (OTHERS_ENABLED) {
    log('info', `Others watchdog ENABLED (every ${OTHERS_INTERVAL_MS}ms)`);
    loops.push(othersLoop(shouldStop));
  } else {
    // Логируем и выключенное состояние: фича едет dormant, и после деплоя надо
    // видеть в логах, что код на месте, — иначе «оно вообще выкатилось?».
    log('info', 'Others watchdog DISABLED (set INSTANTLY_OTHERS_ENABLED=1 to enable)');
  }
  if (DRAIN_ENABLED) {
    log('info', `Real-time webhook drain ENABLED (every ${DRAIN_INTERVAL_MS}ms)`);
    loops.push(drainLoop(shouldStop));
  }
  await Promise.all(loops);

  log('info', 'Worker stopped');
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
