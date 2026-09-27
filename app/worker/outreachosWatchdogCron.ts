/**
 * Сторож ежедневного прогона OutreachOS. Крон дёргает его каждые 15 минут В ТОМ
 * ЖЕ контейнере, где идёт прогон:
 *
 *   5-59/15 5-13 * * * docker exec portal-worker-hh node /app/workers/outreachosWatchdogCron.js >> /var/log/portal/outreachos-watchdog.log 2>&1
 *
 * Минуты 5/20/35/50 — чтобы тик не совпадал со стартом прогона в 05:15.
 *
 * Зачем (инцидент 23–24.09.2026): деплой пересоздаёт portal-worker-hh и молча
 * убивает exec'нутый прогон — лог обрывается, строка outreachos_pipeline_runs
 * навсегда висит в `running`, ничего не залито. 23.09 так пропала готовая
 * выгрузка конструктора на 3 649 почт, 24.09 — весь день. Образец — сторож
 * gisSignalOutreach (инцидент 12.08.2026).
 *
 * Что делает: сверяет строки `running` с живыми процессами в /proc.
 *   - процесс прогона или другого сторожа жив → молчим;
 *   - строка есть, процесса нет, есть контрольная точка → продолжаем прогон
 *     с неё (`outreachosCron.js --resume=<id>`, та же строка прогона);
 *   - точки нет → закрываем как failed и, если сутки ещё можно спасти,
 *     перезапускаем день (`outreachosCron.js --anchor=<started_at>`).
 * Прогон идёт дочерним процессом outreachosCron.js, и сторож ждёт его: следующий
 * тик увидит в /proc и прогон, и сторожа.
 *
 * Все ограничители (окно 05:30–14:00 МСК, потолок попыток и прогонов в сутки)
 * живут в чистой политике lib/outreachos/watchdogPolicy.ts.
 *
 * Env — те же, что у outreachosCron (берутся из окружения контейнера).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createWorkerLogger } from './_shared';
import { loadOutreachOsConfig } from '@/lib/outreachos/config';
import {
  hasLiveOutreachOsProcess,
  PIPELINE_PROCESS_MARKER,
  WATCHDOG_PROCESS_MARKER,
} from '@/lib/outreachos/liveProcess';
import { loadCheckpointHeads, type CheckpointHead } from '@/lib/outreachos/runCheckpoint';
import {
  decideWatchdogAction,
  mskMidnightIso,
  mskParts,
  WATCHDOG_REAP_PREFIX,
  type WatchdogRunningRun,
  type WatchdogTodayRun,
} from '@/lib/outreachos/watchdogPolicy';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendWorkerAlert } from '@/lib/telegram/workerAlert';

const WORKER_ID = 'outreachos-watchdog';

/** Прогон — дочерний процесс: его видно в /proc, у него свой pid и код выхода. */
function runPipelineChild(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'outreachosCron.js'), ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', (err) => {
      console.error(`[worker][${WORKER_ID}][ERROR] не удалось запустить прогон`, err);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function alert(subject: string, reason: string, context: Record<string, string | number>): Promise<void> {
  try {
    await sendWorkerAlert({ workerId: WORKER_ID, subject, error: reason, context });
  } catch { /* алерт best-effort, не роняет сторож */ }
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
    .from('outreachos_pipeline_runs')
    .select('id, started_at')
    .eq('status', 'running');
  if (runningErr) {
    log('error', `не удалось прочитать running-строки: ${runningErr.message}`);
    return 1;
  }
  const { data: todayData, error: todayErr } = await db
    .from('outreachos_pipeline_runs')
    .select('id, status, error_message')
    .gte('started_at', mskMidnightIso(now));
  if (todayErr) {
    log('error', `не удалось прочитать сегодняшние прогоны: ${todayErr.message}`);
    return 1;
  }

  const running = (runningData ?? []) as Array<{ id: string; started_at: string }>;
  let heads: Map<string, CheckpointHead>;
  try {
    heads = await loadCheckpointHeads(running.map((r) => r.id));
  } catch (err) {
    log('error', `не удалось прочитать контрольные точки: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const runningRuns: WatchdogRunningRun[] = running.map((r) => {
    const head = heads.get(r.id);
    return {
      id: r.id,
      started_at: r.started_at,
      checkpoint: head ? { phase: head.phase, resumeAttempts: head.resumeAttempts } : null,
    };
  });
  const todayRuns = (todayData ?? []) as WatchdogTodayRun[];

  const decision = decideWatchdogAction({
    now,
    runningRuns,
    liveProcess: hasLiveOutreachOsProcess(
      [PIPELINE_PROCESS_MARKER, WATCHDOG_PROCESS_MARKER],
      (m) => log('warn', m),
    ),
    todayRuns,
  });
  log('info', `running=${runningRuns.length} сегодня=${todayRuns.length} → ${decision.reason}`);

  // 1. Закрыть трупы: строка есть, процесса нет, продолжать не будем.
  for (const row of decision.reap) {
    const note = row.checkpoint
      ? `; точка «${row.checkpoint.phase}» сохранена, продолжений было ${row.checkpoint.resumeAttempts}`
      : '';
    const { error } = await db
      .from('outreachos_pipeline_runs')
      .update({
        status: 'failed',
        error_message: `${WATCHDOG_REAP_PREFIX} процесс прогона не найден (вероятно, контейнер пересоздан деплоем)${note}`,
        finished_at: now.toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'running');
    log(
      error ? 'error' : 'info',
      error
        ? `не смог пометить run ${row.id} failed: ${error.message}`
        : `run ${row.id} (started_at=${row.started_at}) помечен failed — процесса нет`,
    );
  }

  // Выключенный пайплайн не продолжаем и не перезапускаем — только чистим трупы.
  const config = decision.resume || decision.restart ? await loadOutreachOsConfig() : null;
  if ((decision.resume || decision.restart) && !config?.enabled) {
    log('info', 'пайплайн выключен (enabled=false) или конфиг недоступен — не продолжаем и не перезапускаем');
    if (decision.reap.length > 0) {
      await alert(`убитый прогон закрыт (${decision.reap.length})`, decision.reason, {
        date: mskParts(now).dateKey,
        reaped: decision.reap.map((r) => r.id).join(', '),
      });
    }
    return 0;
  }

  if (decision.resume) {
    await alert('продолжаем убитый прогон', decision.reason, {
      date: mskParts(now).dateKey,
      run: decision.resume.id,
      reaped: decision.reap.map((r) => r.id).join(', ') || '—',
    });
    const code = await runPipelineChild([`--resume=${decision.resume.id}`]);
    log(code === 0 ? 'info' : 'error', `продолжение прогона ${decision.resume.id} завершилось с кодом ${code}`);
    return code;
  }

  if (decision.restart) {
    await alert('автоперезапуск дневного прогона', decision.reason, {
      date: mskParts(now).dateKey,
      runs_today: todayRuns.length,
      reaped: decision.reap.map((r) => r.id).join(', ') || '—',
    });
    const code = await runPipelineChild(decision.restartAnchor ? [`--anchor=${decision.restartAnchor}`] : []);
    log(code === 0 ? 'info' : 'error', `перезапуск дня завершился с кодом ${code}`);
    return code;
  }

  if (decision.reap.length > 0) {
    await alert(`убитый прогон закрыт (${decision.reap.length})`, decision.reason, {
      date: mskParts(now).dateKey,
      reaped: decision.reap.map((r) => r.id).join(', '),
    });
  }
  return 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[worker][outreachos-watchdog][FATAL]', err);
    process.exit(1);
  });
