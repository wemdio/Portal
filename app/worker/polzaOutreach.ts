import { runAutofillTick } from '@/lib/outreachAutofill/check';
import { runPolzaOutreachJob } from '@/lib/polzaOutreach/runner';
import { runRuOutreachJob } from '@/lib/polzaRuOutreach/runner';
import { runGosplanSyncTick } from '@/lib/polzaRuOutreach/sources/gosplanSync';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';
import { claimParserJob, recoverRunningParserJobs } from './parserJobs';
import { installUndiciAssertGuard } from './_undiciAssertGuard';

/**
 * Воркер автоаутричей Polza: английский (polza_outreach) и «Наш автоаутрич»
 * (polza_ru_outreach). У каждого типа свой слот: русский запуск не ждёт в
 * очереди за английским и наоборот, но два запуска одного типа параллельно не
 * идут — оба ходят в hh/OpenRouter/сайты и делят их лимиты.
 */

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const WORKER_ID = `polza-outreach-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();
/**
 * Автодобор базы (lib/outreachAutofill): раз в минуту разбирает законченные
 * автосборы, а в 09:00 и 21:00 МСК проверяет, хватает ли базы на 3 рабочих дня.
 * Здесь же, где идут запуски: сбор, заливка в «Рассылку» и старт — в одном процессе.
 */
const AUTOFILL_TICK_MS = 60_000;
let autofillTicking = false;

async function autofillTick(): Promise<void> {
  if (autofillTicking) return;
  autofillTicking = true;
  try {
    await runAutofillTick(new Date(), log);
  } catch (err) {
    log('error', 'Autofill tick crashed', err);
  } finally {
    autofillTicking = false;
  }
}

/**
 * Синк ГосПлан (sources/gosplanSync.ts): раз в 15 минут проверяет, загружен ли
 * вчерашний день контрактов 44-ФЗ / 223-ФЗ; сама загрузка — раз в день МСК.
 * На тестовом сервере (10 запросов в минуту) день идёт минуты — тик не ждут.
 */
const GOSPLAN_TICK_MS = 15 * 60_000;
let gosplanTicking = false;

async function gosplanTick(shouldStop: () => boolean): Promise<void> {
  if (gosplanTicking) return;
  gosplanTicking = true;
  try {
    await runGosplanSyncTick(requireSupabaseAdmin(log), new Date(), log, shouldStop);
  } catch (err) {
    log('error', 'GosPlan sync tick crashed', err);
  } finally {
    gosplanTicking = false;
  }
}

const SLOTS: Array<{ parserType: string; label: string; run: (jobId: string) => Promise<void>; active: boolean }> = [
  { parserType: 'polza_outreach', label: 'Polza outreach', run: runPolzaOutreachJob, active: false },
  { parserType: 'polza_ru_outreach', label: 'Polza RU outreach', run: runRuOutreachJob, active: false },
];

async function startupRecovery(): Promise<void> {
  await recoverRunningParserJobs(log, SLOTS.map((s) => s.parserType), 'Polza outreach parser_jobs');
}

async function pollOnce(): Promise<boolean> {
  let claimedAny = false;
  for (const slot of SLOTS) {
    if (slot.active) continue;
    const jobId = await claimParserJob(log, slot.parserType);
    if (!jobId) continue;
    claimedAny = true;
    slot.active = true;
    const task = (async () => {
      log('info', `Running ${slot.label} parser job ${jobId}`);
      try {
        await slot.run(jobId);
      } catch (err) {
        log('error', `${slot.label} parser job ${jobId} crashed`, err);
      }
    })();
    running.add(task);
    void task.finally(() => {
      running.delete(task);
      slot.active = false;
    });
  }
  if (claimedAny) return true;

  if (running.size > 0) {
    await sleep(250);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  log('info', `Starting Polza outreach worker (pid=${process.pid})`);
  // Клиент ИИ обрывает запросы по таймауту и по остановке запуска, а поиск
  // почты — страницы сайтов. На таком обрыве undici может бросить ассерт мимо
  // промиса fetch (см. _undiciAssertGuard.ts) — без перехвата он валил бы весь
  // воркер, а перезапуск заново платил бы за разбор обоих идущих запусков.
  installUndiciAssertGuard(log);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  void autofillTick();
  const autofillTimer = setInterval(() => {
    if (!shouldStop()) void autofillTick();
  }, AUTOFILL_TICK_MS);
  void gosplanTick(shouldStop);
  const gosplanTimer = setInterval(() => {
    if (!shouldStop()) void gosplanTick(shouldStop);
  }, GOSPLAN_TICK_MS);

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['parser_jobs'],
  });
  clearInterval(autofillTimer);
  clearInterval(gosplanTimer);
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
