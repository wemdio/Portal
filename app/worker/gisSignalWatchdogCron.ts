/**
 * Host-сторож дневного прогона gisSignalOutreach. Крон дёргает его каждые 15
 * минут В ТОМ ЖЕ контейнере, где идёт прогон:
 *
 *   *\/15 6-13 * * 1-5 docker exec portal-worker-baseconstructor node /app/workers/gisSignalWatchdogCron.js >> /var/log/portal/gis-signal-watchdog.log 2>&1
 *
 * Зачем (инцидент 12.08.2026): пересоздание контейнеров при деплое молча убивает
 * exec'нутый воркер — лог обрывается, строка gis_signal_runs навсегда виснет в
 * `running`, TG-алерта нет (посылать его было некому). Так подряд умерли три
 * прогона и пропал целый день заливок. Внутрипроцессный stall-watchdog такое не
 * ловит по построению: он умирает вместе с процессом.
 *
 * Что делает: сверяет строки `running` с реальными процессами в /proc.
 *   - процесс жив → молчим (зависший, но живой прогон — забота внутрипроцессного
 *     watchdog'а с его таймером тишины);
 *   - строка есть, процесса нет → помечаем failed + TG-алерт;
 *   - и, если сутки ещё можно спасти, перезапускаем прогон ИНЛАЙНОМ (этот же
 *     процесс живёт ~60–80 мин; следующий тик сторожа увидит его в /proc и не
 *     полезет).
 *
 * Все ограничители перезапуска (будни, окно 06:40–13:00 МСК, отсутствие
 * успешного прогона, потолок 3 прогона в сутки) живут в чистой политике
 * lib/gisSignalOutreach/watchdogPolicy.ts — она же покрыта тестами.
 *
 * Env — те же, что у gisSignalOutreachCron (берутся из окружения контейнера).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createWorkerLogger } from './_shared';
import { runGisSignalPipeline } from '@/lib/gisSignalOutreach/pipelineRunner';
import { decideWatchdogAction, mskParts } from '@/lib/gisSignalOutreach/watchdogPolicy';
import type { RunningRunRow } from '@/lib/gisSignalOutreach/runGuards';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendWorkerAlert } from '@/lib/telegram/workerAlert';

const WORKER_ID = 'gis-signal-watchdog';

/** Процессы прогона и сторожа в этом контейнере (кроме себя самого). */
const LIVE_PROCESS_MARKERS = ['gisSignalOutreachCron', 'gisSignalWatchdogCron'];

/**
 * Есть ли живой процесс прогона в контейнере. FAIL-SAFE: не смогли прочитать
 * /proc — возвращаем true, то есть сторож молчит. Ошибиться в эту сторону
 * дёшево (пропустим один тик), в обратную — дорого (реапнем живой прогон).
 */
function hasLiveGisProcess(log: (level: 'info' | 'warn', msg: string) => void): boolean {
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch (err) {
    log('warn', `/proc недоступен (${err instanceof Error ? err.message : String(err)}) — считаем прогон живым`);
    return true;
  }
  const selfPid = String(process.pid);
  for (const pid of pids) {
    if (pid === selfPid) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue; // процесс успел завершиться или недоступен — не наш случай
    }
    if (LIVE_PROCESS_MARKERS.some((marker) => cmdline.includes(marker))) return true;
  }
  return false;
}

/** Момент московской полуночи сегодняшних суток (Москва без DST, всегда +03:00). */
function mskMidnightIso(now: Date): string {
  return new Date(`${mskParts(now).dateKey}T00:00:00+03:00`).toISOString();
}

async function main(): Promise<number> {
  const log = createWorkerLogger(WORKER_ID);
  const now = new Date();

  if (!supabaseAdmin) {
    log('error', 'supabaseAdmin недоступен — сторож не может проверить состояние');
    return 1;
  }
  const db = supabaseAdmin;

  const { data: runningData, error: runningErr } = await db
    .from('gis_signal_runs')
    .select('id, started_at')
    .eq('status', 'running');
  if (runningErr) {
    log('error', `не удалось прочитать running-строки: ${runningErr.message}`);
    return 1;
  }
  const { data: todayData, error: todayErr } = await db
    .from('gis_signal_runs')
    .select('id, status')
    .gte('started_at', mskMidnightIso(now));
  if (todayErr) {
    log('error', `не удалось прочитать сегодняшние прогоны: ${todayErr.message}`);
    return 1;
  }

  const runningRuns = (runningData ?? []) as RunningRunRow[];
  const todayRows = (todayData ?? []) as Array<{ status?: string }>;
  const decision = decideWatchdogAction({
    now,
    runningRuns,
    liveProcess: hasLiveGisProcess(log),
    runsToday: todayRows.length,
    completedToday: todayRows.filter((r) => r.status === 'completed').length,
  });
  log('info', `running=${runningRuns.length} сегодня=${todayRows.length} → ${decision.reason}`);

  // 1. Реап трупов: строка есть, процесса нет.
  for (const row of decision.reap) {
    const { error } = await db
      .from('gis_signal_runs')
      .update({
        status: 'failed',
        error: 'watchdog: процесс прогона не найден (вероятно, контейнер пересоздан деплоем)',
        finished_at: now.toISOString(),
      })
      .eq('id', row.id);
    log(
      error ? 'error' : 'info',
      error
        ? `не смог пометить run ${row.id} failed: ${error.message}`
        : `run ${row.id} (started_at=${row.started_at}) помечен failed — процесса нет`,
    );
  }
  if (decision.reap.length > 0) {
    try {
      await sendWorkerAlert({
        workerId: WORKER_ID,
        subject: `убитый прогон подобран (${decision.reap.length})`,
        error: decision.reason,
        context: {
          date: mskParts(now).dateKey,
          reaped: decision.reap.map((r) => String(r.id)).join(', '),
          restart: decision.restart ? 'да' : 'нет',
        },
      });
    } catch { /* алерт best-effort, не роняет сторож */ }
  }

  if (!decision.restart) return 0;

  // 2. Перезапуск дня инлайном. Прогон сам ведёт свою строку в gis_signal_runs,
  //    свои hard-timeout'ы и свой stall-watchdog — сторож только даёт старт.
  log('info', 'перезапуск прогона…');
  try {
    await sendWorkerAlert({
      workerId: WORKER_ID,
      subject: 'автоперезапуск дневного прогона',
      error: decision.reason,
      context: { date: mskParts(now).dateKey, runs_today: todayRows.length },
    });
  } catch { /* best-effort */ }

  const summary = await runGisSignalPipeline((m) => log('info', m));
  log(
    summary.status === 'failed' ? 'error' : 'info',
    `перезапуск завершён: status=${summary.status} pulled=${summary.pulled} ` +
      `valid=${summary.validContacts} appended=${summary.appended}${summary.error ? ` error=${summary.error}` : ''}`,
  );
  return summary.status === 'failed' ? 1 : 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[worker][gis-signal-watchdog][FATAL]', err);
    process.exit(1);
  });
