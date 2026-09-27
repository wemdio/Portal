/**
 * One-shot cron entry для OutreachOS daily pipeline (self-outreach).
 *
 * Раз в сутки запускается system crontab'ом, прогоняет один singleton-конфиг
 * (outreachos_pipeline_config, id=1) через runOutreachOsDailyPipeline и выходит.
 * Не висит в памяти — намеренно НЕ always-on контейнер: прод-бокс почти полон
 * по CPU/RAM, а задача суточная. Сам конструктор баз обрабатывается уже
 * существующим контейнером worker-baseconstructor (мы только кладём ему job).
 *
 * ВАЖНО: модель — autoPipelineCron? НЕТ. autoPipelineCron импортирует
 * runAutoPipelineForClient → Mailganer-скоринг. Здесь импортируется ТОЛЬКО
 * наш изолированный runOutreachOsDailyPipeline. Ни одного Mailganer-символа.
 *
 * Прод (с 06.08.2026) — root crontab хоста, exec в portal-worker-hh:
 *
 *   15 5 * * * docker exec portal-worker-hh node /app/workers/outreachosCron.js >> /var/log/portal/outreachos-cron.log 2>&1
 *
 * Деплой пересоздаёт portal-worker-hh и убивает exec'нутый прогон (инцидент
 * 23–24.09.2026). Поэтому рядом работает сторож worker/outreachosWatchdogCron.ts:
 * он продолжает убитый прогон с контрольной точки через этот же файл —
 *
 *   --resume=<runId>   продолжить прогон с его точки (constructor/upload);
 *   --anchor=<ISO>     перезапуск дня: HH с окна убитого прогона (started_at).
 *
 * Перед обычным стартом — страховка: другой живой прогон в контейнере → пропуск;
 * running-строки без процесса старше 10 мин закрываются как failed.
 *
 * Ручной прогон:
 *   docker exec portal-worker-hh node /app/workers/outreachosCron.js
 *
 * Нужны env: HH_ACCESS_TOKEN, PROXY_URLS (RU-прокси для HH),
 *   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (main),
 *   INSTANTLY_SUPABASE_URL + INSTANTLY_SUPABASE_SERVICE_ROLE_KEY (Instantly DB, для append),
 *   INSTANTLY_API_KEY / INSTANTLY_ACCOUNTS_JSON (Instantly API),
 *   SMTP_PROXY_URLS + SMTP_PROXY_API_KEY (на контейнере worker-baseconstructor — для validate_emails).
 *   НЕ нужны никакие MAILGANER_*.
 */

import { createWorkerLogger } from './_shared';
import {
  resumeOutreachOsRun,
  runOutreachOsDailyPipeline,
  type OutreachOsRunResult,
} from '@/lib/outreachos/pipelineRunner';
import { hasLiveOutreachOsProcess, PIPELINE_PROCESS_MARKER } from '@/lib/outreachos/liveProcess';
import { pruneRunCheckpoints } from '@/lib/outreachos/runCheckpoint';
import { WATCHDOG_GRACE_MS, WATCHDOG_REAP_PREFIX } from '@/lib/outreachos/watchdogPolicy';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const WORKER_ID = 'outreachos-cron';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) || undefined;
}

/**
 * Страховка обычного старта. false — в контейнере уже идёт другой прогон.
 * Строки running без живого процесса старше grace — трупы, их закрываем.
 */
async function guardDailyStart(log: (msg: string) => void): Promise<boolean> {
  if (!supabaseAdmin) return true; // runner сам ответит failed
  // Сторож сюда не входит: его тик совпадает с кроном в 05:15 и длится секунды.
  if (hasLiveOutreachOsProcess([PIPELINE_PROCESS_MARKER], log)) {
    log('В контейнере уже идёт прогон OutreachOS — сегодняшний старт пропускаем');
    return false;
  }
  const cutoff = new Date(Date.now() - WATCHDOG_GRACE_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('outreachos_pipeline_runs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_message: `${WATCHDOG_REAP_PREFIX} процесс прогона не найден при старте следующего прогона (вероятно, контейнер пересоздан деплоем)`,
    })
    .eq('status', 'running')
    .lt('started_at', cutoff)
    .select('id, started_at');
  if (error) {
    log(`Не удалось закрыть брошенные прогоны: ${error.message}`);
  } else {
    for (const row of (data ?? []) as Array<{ id: string; started_at: string }>) {
      log(`Брошенный прогон ${row.id} (started_at=${row.started_at}) закрыт как failed — процесса нет`);
    }
  }
  await pruneRunCheckpoints(log);
  return true;
}

async function main(): Promise<number> {
  const log = createWorkerLogger(WORKER_ID);
  const info = (m: string) => log('info', m);
  const startedAt = Date.now();
  const resumeRunId = argValue('resume');
  const anchorStartedAt = argValue('anchor');

  try {
    let summary: OutreachOsRunResult;
    if (resumeRunId) {
      log('info', `Resuming OutreachOS run ${resumeRunId}…`);
      summary = await resumeOutreachOsRun(resumeRunId, info);
    } else {
      log('info', anchorStartedAt
        ? `Restarting OutreachOS daily pipeline (HH window of run started ${anchorStartedAt})…`
        : 'Starting OutreachOS daily pipeline…');
      if (!(await guardDailyStart(info))) {
        log('info', `Skipped (another run in progress) in ${Math.round((Date.now() - startedAt) / 1000)}s`);
        return 0;
      }
      summary = await runOutreachOsDailyPipeline(info, { anchorStartedAt });
    }
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

    if (summary.status === 'completed') {
      log(
        'info',
        `Completed in ${elapsedSec}s: parsed=${summary.parsed} new=${summary.newEmployers} ` +
          `valid=${summary.validContacts} appended=${summary.appended} skipped=${summary.skipped}`,
      );
      return 0;
    }
    if (summary.status === 'skipped') {
      log('info', `Skipped (${summary.error ?? 'disabled/not configured'}) in ${elapsedSec}s`);
      return 0;
    }
    log('error', `Failed in ${elapsedSec}s: ${summary.error ?? 'unknown'}`);
    return 1;
  } catch (err) {
    log('error', 'Crashed', err);
    return 1;
  }
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[worker][outreachos-cron][FATAL]', err);
    process.exit(1);
  });
