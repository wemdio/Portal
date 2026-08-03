/**
 * One-shot cron entry для gisSignalOutreach daily pipeline
 * (2GIS → 6-сигнальная квалификация → конструктор баз → добор в Instantly).
 *
 * Раз в сутки запускается system crontab'ом, прогоняет один singleton-конфиг
 * (gis_signal_pipeline_config, id=1) через runGisSignalPipeline и выходит.
 * Не висит в памяти — намеренно НЕ always-on контейнер: прод-бокс почти полон
 * по CPU/RAM, а задача суточная. Сам конструктор баз обрабатывается уже
 * существующим контейнером worker-baseconstructor (мы только кладём ему job).
 *
 * Что делает прогон: тянет новые компании из 2GIS по рубрикам сегментов
 * (gis_signal_segments), проверяет сайты 6-сигнальным детектором, архивирует
 * ВСЕ проверки в gis_signal_company_signals, квалифицированные компании
 * (>= signal_min_count сигналов) отправляет в base_constructor_jobs
 * (поиск/валидация почт), валидных лидов доливает в per-сегментные кампании
 * Instantly и журналирует seen + воронку (gis_signal_runs.funnel).
 * measure_only=true → воронка без заливки и без seen.
 *
 * Деплой:
 *   1. Один раз: worker/gisSignalOutreachCron.ts уже в build:workers
 *      (package.json) → бандл в dist/workers/gisSignalOutreachCron.js.
 *   2. Прокатить `npm run build:workers`.
 *   3. На сервере в crontab (под пользователем приложения, не root):
 *
 *        0 6 * * * cd /home/Portal/prod/app && /usr/bin/node --env-file=../.env dist/workers/gisSignalOutreachCron.js >> /var/log/portal/gis-signals.log 2>&1
 *
 *      (06:00 UTC = 09:00 МСК — после ночных джоб, перед рабочим днем сейлзов.
 *      Путь к node: `which node`.)
 *
 * Ручной прогон:
 *   cd app && node --env-file=../.env dist/workers/gisSignalOutreachCron.js
 *
 * Нужны env: TWOGIS_DATASET_DB_URL (2GIS-датасет),
 *   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (main),
 *   INSTANTLY_SUPABASE_URL + INSTANTLY_SUPABASE_SERVICE_ROLE_KEY (Instantly DB, для append),
 *   INSTANTLY_API_KEY / INSTANTLY_ACCOUNTS_JSON (Instantly API),
 *   OPENROUTER_SIGNALS_API_KEY или OPENROUTER_BRIEF_API_KEY (LLM-добор сигналов),
 *   SMTP_PROXY_URLS + SMTP_PROXY_API_KEY (на контейнере worker-baseconstructor — для validate_emails).
 */

import { createWorkerLogger } from './_shared';
import { runGisSignalPipeline } from '@/lib/gisSignalOutreach/pipelineRunner';

const WORKER_ID = 'gis-signal-cron';

async function main(): Promise<number> {
  const log = createWorkerLogger(WORKER_ID);
  const startedAt = Date.now();
  log('info', 'Starting gisSignalOutreach daily pipeline…');

  try {
    const summary = await runGisSignalPipeline((m) => log('info', m));
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

    if (summary.status === 'success') {
      log(
        'info',
        `Completed in ${elapsedSec}s: pulled=${summary.pulled} signalsOk=${summary.signalsOk} ` +
          `valid=${summary.validContacts} appended=${summary.appended}`,
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
    console.error('[worker][gis-signal-cron][FATAL]', err);
    process.exit(1);
  });
