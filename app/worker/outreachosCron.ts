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
 * Деплой:
 *   1. Один раз: worker/outreachosCron.ts уже в build:workers (package.json) →
 *      бандл в dist/workers/outreachosCron.js.
 *   2. Прокатить `npm run build:workers`.
 *   3. На сервере в crontab (под пользователем приложения, не root):
 *
 *        0 5 * * * cd /home/Portal/prod/app && /usr/bin/node --env-file=../.env dist/workers/outreachosCron.js >> /var/log/portal/outreachos.log 2>&1
 *
 *      (05:00 UTC = 08:00 МСК — после ночного HH-окна. Путь к node: `which node`.)
 *
 * Ручной прогон:
 *   cd app && node --env-file=../.env dist/workers/outreachosCron.js
 *
 * Нужны env: HH_ACCESS_TOKEN, PROXY_URLS (RU-прокси для HH),
 *   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (main),
 *   INSTANTLY_SUPABASE_URL + INSTANTLY_SUPABASE_SERVICE_ROLE_KEY (Instantly DB, для append),
 *   INSTANTLY_API_KEY / INSTANTLY_ACCOUNTS_JSON (Instantly API),
 *   SMTP_PROXY_URLS + SMTP_PROXY_API_KEY (на контейнере worker-baseconstructor — для validate_emails).
 *   НЕ нужны никакие MAILGANER_*.
 */

import { createWorkerLogger } from './_shared';
import { runOutreachOsDailyPipeline } from '@/lib/outreachos/pipelineRunner';

const WORKER_ID = 'outreachos-cron';

async function main(): Promise<number> {
  const log = createWorkerLogger(WORKER_ID);
  const startedAt = Date.now();
  log('info', 'Starting OutreachOS daily pipeline…');

  try {
    const summary = await runOutreachOsDailyPipeline((m) => log('info', m));
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
