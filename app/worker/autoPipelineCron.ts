/**
 * One-shot cron entry for the HH auto-pipeline.
 *
 * Запускается system crontab'ом раз в сутки (07:00 МСК). Не висит в памяти —
 * грузит eligible-клиентов, прогоняет каждого через runAutoPipelineForClient,
 * выходит. Это отличается от других воркеров в worker/* (которые long-running
 * процессы под `node --watch`); здесь нам нужен ровно один прогон по
 * расписанию системного крона, поэтому никаких polling / supabase realtime.
 *
 * Деплой:
 *   1. Один раз: добавить worker/autoPipelineCron.ts в build:workers esbuild
 *      команду в package.json (бандл попадёт в dist/workers/autoPipelineCron.js).
 *   2. Прокатить `npm run build:workers` в CI/деплое.
 *   3. На сервере добавить в crontab (под пользователем, под которым крутится
 *      приложение, не root):
 *
 *        0 4 * * * cd /path/to/portal/app && /usr/bin/node --env-file=../.env dist/workers/autoPipelineCron.js >> /var/log/portal/auto-pipeline.log 2>&1
 *
 *      (04:00 UTC = 07:00 МСК. Путь к node может отличаться: `which node`.)
 *
 *   4. Создать /var/log/portal/ с правами на запись для рабочего пользователя.
 *
 * Тестовый прогон вручную:
 *   cd /path/to/portal/app && node --env-file=../.env dist/workers/autoPipelineCron.js
 *
 * Альтернативный путь без сборки — оставлен HTTP-эндпоинт
 * /api/cron/auto-hh-pipeline?secret=<CRON_SECRET>. Удобно для отладки в проде,
 * но cron'ить через wget/curl менее надёжно, чем прямой node-вызов.
 */

import { createWorkerLogger, requireSupabaseAdmin } from './_shared';
import { runAutoPipelineForClient } from '@/lib/jobs/autoPipelineRunner';

const WORKER_ID = 'auto-pipeline-cron';

async function main(): Promise<number> {
  const log = createWorkerLogger(WORKER_ID);
  const supabase = requireSupabaseAdmin(log);

  // 1. Eligible-клиенты — конфиг enabled И флаг на профиле тоже enabled.
  //    Два источника, чтобы можно было отключить пайплайн в одной точке
  //    (например, при разборе сбоя биллинга) без правки configs.
  const startedAt = Date.now();
  log('info', 'Loading eligible clients…');

  const { data: configs, error: configsErr } = await supabase
    .from('client_auto_pipeline_configs')
    .select('client_user_id')
    .eq('enabled', true);

  if (configsErr) {
    log('error', 'Failed to load configs', configsErr);
    return 1;
  }

  const candidateIds = (configs ?? [])
    .map((c) => (c as { client_user_id: string }).client_user_id)
    .filter(Boolean);

  if (candidateIds.length === 0) {
    log('info', 'No clients in auto-pipeline mode — nothing to do');
    return 0;
  }

  const { data: profiles, error: profilesErr } = await supabase
    .from('profiles')
    .select('id')
    .in('id', candidateIds)
    .eq('auto_pipeline_enabled', true);

  if (profilesErr) {
    log('error', 'Failed to filter by profile flag', profilesErr);
    return 1;
  }

  const eligibleIds = (profiles ?? []).map((p) => (p as { id: string }).id);
  log(
    'info',
    `Configs enabled: ${candidateIds.length}, profile-flag enabled: ${eligibleIds.length}`,
  );

  // 2. Прогон последовательно. Параллельность тут опасна — каждый клиент
  //    делает сотни внешних HTTP-запросов (HH + scrape + Mailganer), не
  //    хочется случайно DDoS'ить ни одну из этих сторон.
  let ok = 0;
  let failed = 0;
  for (const clientId of eligibleIds) {
    log('info', `→ Running pipeline for client ${clientId}…`);
    try {
      const summary = await runAutoPipelineForClient(clientId);
      if (summary.status === 'completed') {
        ok++;
        log(
          'info',
          `← Completed ${clientId}: parsed=${summary.parsed} new=${summary.new} routed=${summary.routed} stored=${summary.stored} skipped=${summary.skipped} failed=${summary.failed}`,
        );
      } else {
        failed++;
        log('error', `← Failed ${clientId}: ${summary.error ?? 'unknown'}`);
      }
    } catch (err) {
      failed++;
      log('error', `← Crashed ${clientId}`, err);
    }
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  log(
    'info',
    `Done: ${ok} ok, ${failed} failed in ${elapsedSec}s`,
  );

  // Exit code: 0 если все прошли, 1 если был хотя бы один fail. Так cron'у
  // легко понять «что-то не так» в системных алертах.
  return failed > 0 ? 1 : 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[worker][auto-pipeline-cron][FATAL]', err);
    process.exit(1);
  });
