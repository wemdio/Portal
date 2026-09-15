import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  discoverQualificationReplies,
  drainQualificationReplies,
  maybeReprocessOwnershipReviews,
  reconcileQualificationDeliveries,
  drainWebhookQueue,
} from '@/lib/instantly/leadQualificationWorker';
import { pollOthersOnce } from '@/lib/instantly/othersWatchdog';
import { createWorkerLogger, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = envMs('WORKER_POLL_INTERVAL_MS', 30_000, 10_000);
const DRAIN_INTERVAL_MS = envMs('INSTANTLY_WEBHOOK_DRAIN_INTERVAL_MS', 7_000, 1_000);
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

// ── Адаптивный интервал discovery (аудит API 14.09.2026) ─────────────────────
// Треть бюджета LIST /emails уходила на «пустые» head-чтения каждые 30с, когда
// новых ответов нет. Вместо фиксированного тика: интервал растёт при простое
// (30с → 60с → 120с → 180с) и мгновенно сбрасывается при (а) новых staged
// ответах, (б) reply-событии из Instantly webhooks (instantly_activity_events,
// push-события квоту не тратят), (в) ошибке цикла.
// Худший случай при тихо умерших webhook'ах: ответ подхватится за ≤3 мин вместо
// ≤30с — компромисс согласован с задачей «перестать спрашивать каждые 30с».
// Выключатель INSTANTLY_DISCOVERY_ADAPTIVE=0 возвращает фиксированный тик.
const DISCOVERY_ADAPTIVE_ENABLED = !['0', 'false', 'no', 'off'].includes(
  (process.env.INSTANTLY_DISCOVERY_ADAPTIVE ?? '').toLowerCase(),
);
const DISCOVERY_MAX_IDLE_INTERVAL_MS = envMs('INSTANTLY_DISCOVERY_MAX_IDLE_MS', 180_000, 30_000);
const DISCOVERY_IDLE_MULTIPLIERS = [1, 2, 4, 6] as const;

function discoveryIdleIntervalMs(idleStreak: number): number {
  const multiplier = DISCOVERY_IDLE_MULTIPLIERS[Math.min(idleStreak, DISCOVERY_IDLE_MULTIPLIERS.length - 1)];
  return Math.min(DISCOVERY_MAX_IDLE_INTERVAL_MS, POLL_INTERVAL_MS * multiplier);
}

/** Reply-событие из webhook-журнала позже sinceIso. Ошибка проверки = «была
 *  активность»: безопаснее не разгонять интервал на слепом предположении. */
async function hasRepliedActivitySince(sinceIso: string): Promise<boolean> {
  if (!supabaseAdmin) return true;
  const { count, error } = await supabaseAdmin
    .from('instantly_activity_events')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'replied')
    .gt('occurred_at', sinceIso);
  if (error) return true;
  return (count ?? 0) > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only durable discovery runs here. Slow AI and recovery cannot hold the next
// page hostage, and collection continues while the AI account is unavailable.
async function pollLoop(shouldStop: () => boolean): Promise<void> {
  let idleStreak = 0;
  let activitySinceIso = new Date().toISOString();
  while (!shouldStop()) {
    let staged = 0;
    let errored = false;
    try {
      staged = await discoverQualificationReplies();
      if (staged > 0) log('info', `Staged ${staged} reply(s) in durable intake`);
    } catch (err) {
      errored = true;
      log('error', 'Poll cycle failed', err);
    }
    let replyActivity = true;
    try {
      replyActivity = await hasRepliedActivitySince(activitySinceIso);
    } catch {
      replyActivity = true;
    }
    activitySinceIso = new Date().toISOString();
    if (staged > 0 || errored || replyActivity) {
      idleStreak = 0;
    } else if (DISCOVERY_ADAPTIVE_ENABLED) {
      idleStreak += 1;
    }
    const intervalMs = DISCOVERY_ADAPTIVE_ENABLED ? discoveryIdleIntervalMs(idleStreak) : POLL_INTERVAL_MS;
    if (intervalMs !== POLL_INTERVAL_MS) {
      log('info', `No new replies — discovery idle interval stretched to ${Math.round(intervalMs / 1000)}s`);
    }
    await sleep(intervalMs);
  }
}

async function qualificationLoop(shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    try {
      const count = await drainQualificationReplies();
      if (count > 0) log('info', `Completed intake for ${count} reply(s)`);
    } catch (error) {
      log('error', 'Durable qualification cycle failed', error);
    }
    await sleep(7_000);
  }
}

async function recoveryLoop(shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    try {
      await maybeReprocessOwnershipReviews();
    } catch (error) {
      log('error', 'Qualification recovery cycle failed', error);
    }
    await sleep(30_000);
  }
}

async function deliveryLoop(shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    try {
      await reconcileQualificationDeliveries();
    } catch (error) {
      log('error', 'Qualification delivery reconciliation failed', error);
    }
    await sleep(30_000);
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

  const loops = [pollLoop(shouldStop), qualificationLoop(shouldStop), recoveryLoop(shouldStop), deliveryLoop(shouldStop)];
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
