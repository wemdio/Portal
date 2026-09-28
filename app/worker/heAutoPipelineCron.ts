/**
 * One-shot cron entry: ENG auto-pipeline Движка вертикалей — ежедневный добор
 * лидов в уже запущенные кампании us-проектов (аналог autoPipelineCron для RU).
 *
 * Запускается system crontab'ом раз в сутки. Не висит в памяти: грузит
 * enabled-конфиги he_auto_pipeline_configs, для каждого ставит refill-сборки
 * base_collect (вертикали с запущенной кампанией, не более verticals_per_run)
 * через runHeAutoPipelineTick и выходит. Сам добор (сборка → конструктор →
 * долив в кампанию) выполняет стадия base_collect воркера hypothesis-engine —
 * этот крон только ПОСТАНОВКА.
 *
 * Деплой:
 *   1. Один раз: worker/heAutoPipelineCron.ts в build:workers esbuild
 *      команду package.json и в список Dockerfile.worker (уже добавлен) →
 *      бандл dist/workers/heAutoPipelineCron.js → в образе /app/workers/.
 *   2. Прокатить миграцию supabase/migrations/20260804_0005_he_auto_pipeline.sql
 *      (he_auto_pipeline_configs/runs).
 *   3. Завести конфиги: insert в he_auto_pipeline_configs (project_id us-проекта,
 *      enabled, daily_leads_cap, verticals_per_run).
 *   4. Пересобрать и перезапустить образ воркеров (обычный деплой worker'ов).
 *   5. На хосте добавить в crontab (03:20 UTC = 06:20 МСК — после ночного
 *      jobhive-инжеста, до утренней рассылки):
 *
 *        20 3 * * * docker exec portal-worker-hypothesis-engine node /app/workers/heAutoPipelineCron.js >> /var/log/portal/he-auto-pipeline.log 2>&1
 *
 *      Крон исполняется ВНУТРИ контейнера hypothesis-engine: env (.env) уже
 *      содержит и portal-, и instantly-БД — отдельной обвязки не нужно.
 *
 * Тестовый прогон вручную:
 *   docker exec portal-worker-hypothesis-engine node /app/workers/heAutoPipelineCron.js
 * (локально: cd app && node --env-file=../.env dist/workers/heAutoPipelineCron.js)
 *
 * Перед постановкой тик спрашивает у рассыльщика остаток ёмкости воркспейса
 * (один запрос на воркспейс за ночь) и при нуле НЕ ставит сборку: платит сборка,
 * а не долив. Такая вертикаль пишется в лог как capacity_blocked (уровень warn) и
 * в he_auto_pipeline_runs строкой без base_id.
 *
 * Exit code: 0 — все конфиги отработали; 1 — был хотя бы один fail (постановка
 * или обход конфига), чтобы cron-алерты это видели. capacity_blocked код НЕ
 * меняет: место у рассыльщика — штатный отказ, а не сбой тика.
 */

import { createWorkerLogger, requireSupabaseAdmin } from './_shared';
import { runHeAutoPipelineTick } from '@/lib/hypothesisEngine/autoPipeline';

const WORKER_ID = 'he-auto-pipeline-cron';

async function main(): Promise<number> {
  const log = createWorkerLogger(WORKER_ID);
  const supabase = requireSupabaseAdmin(log);

  const startedAt = Date.now();
  log('info', 'Loading enabled HE auto-pipeline configs…');

  let summary;
  try {
    summary = await runHeAutoPipelineTick(supabase);
  } catch (err) {
    log('error', 'Tick failed fatally', err);
    return 1;
  }

  for (const d of summary.details) {
    const target = d.verticalId ? ` vertical ${d.verticalId}` : '';
    const base = d.baseId ? ` base ${d.baseId}` : '';
    const msg = d.message ? ` — ${d.message}` : '';
    // capacity_blocked — штатный отказ, а не сбой: 'warn', чтобы строка была
    // видна в ночном логе, но не читалась алертами как падение тика.
    const level = d.status === 'failed' ? 'error' : d.status === 'capacity_blocked' ? 'warn' : 'info';
    log(level, `config ${d.configId}${target}${base}: ${d.status}${msg}`);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  log(
    'info',
    `Done: ${summary.configs} configs, ${summary.enqueued} enqueued, ${summary.existing} existing, ` +
      `${summary.noCampaign} no_campaign, ${summary.capacityBlocked} capacity_blocked, ` +
      `${summary.failed} failed in ${elapsedSec}s`,
  );
  return summary.failed > 0 ? 1 : 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[worker][he-auto-pipeline-cron][FATAL]', err);
    process.exit(1);
  });
