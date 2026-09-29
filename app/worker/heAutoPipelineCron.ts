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
 * Раньше предполёта ёмкости работает ПРАВИЛО СУХОЙ ВЕРТИКАЛИ
 * (lib/hypothesisEngine/autoPipeline.ts, блок «СУХАЯ ВЕРТИКАЛЬ»): N подряд
 * завершённых прогонов со статусом 'no_new' — и вертикаль ночной слот больше не
 * получает (строка лога `dry`, уровень info: это намеренная экономия, а не
 * сбой), пока клиент не вернёт её кнопкой в кабинете. Правило выключено по
 * умолчанию, включается env-флагом HE_VERTICAL_DRY_STOP=1 и только вместе с
 * применённой миграцией supabase/migrations/20260930_0003_he_vertical_dry.sql.
 * Порог N — he_auto_pipeline_configs.dry_nights_limit (дефолт 7).
 *
 * С ВЫКЛЮЧЕННЫМ флагом проход всё равно СЧИТАЕТ серию и печатает её в строке
 * каждой вертикали (`dry nights N`). Это сделано затем, чтобы порог можно было
 * выбрать по факту: ночной добор ENG в production не запускался ни разу, и
 * другой истории для калибровки не существует. Слот при этом не отнимается ни у
 * кого, а пометки, оставшиеся от включённого периода, снимаются — иначе кабинет
 * показывал бы паузу, которой больше нет.
 *
 * Перед постановкой доливов крон делает ПРОХОД АВТОПОДЪЁМА баз, легших на
 * временном отказе провайдера (lib/hypothesisEngine/baseAutoResume →
 * RPC he_auto_resume_transient_bases). Проход выключен по умолчанию, включается
 * env-флагом HE_AUTO_RESUME_TRANSIENT=1 и только вместе с применённой миграцией
 * supabase/migrations/20260929_0001_he_base_transient_resume.sql.
 *
 * Почему ДО постановки доливов, а не после. Поднятая база возвращается в
 * 'collecting', а дедуп постановки (enqueueHeBaseCollect) и partial unique index
 * he_bases_one_collecting_per_vertical считают вертикаль с такой базой занятой.
 * Значит один из двух проиграет: либо вертикаль на ночь теряет долив (проход
 * первый), либо база не поднимается НИКОГДА — каждую ночь долив успевал бы
 * занять вертикаль раньше (проход второй). Первое — потеря одной ночи долива у
 * одной вертикали; второе — навсегда брошенный незаконченный сбор, за который
 * уже заплатили. Поэтому проход идёт первым.
 *
 * ПОСЛЕ доливов идёт ПРОХОД РЕКОНСИЛЕРА АВТОПИЛОТА
 * (lib/hypothesisEngine/autopilotReconcile → runHeAutopilotReconcilePass): тем
 * же кодом, что и кнопка «Start outreach» в кабинете, он доставляет проектам с
 * autopilot=true стадии, которые никто не ставил — например когда координатор
 * воркера не смог прочитать состояние после done-джобы и конвейер встал.
 * Проход выключен по умолчанию, включается env-флагом HE_AUTOPILOT_RECONCILE=1.
 *
 * Почему ПОСЛЕ доливов, а не до (обратный довод к автоподъёму выше). Проход
 * может поставить вертикали ОСНОВНУЮ сборку, и она заняла бы слот
 * partial unique index he_bases_one_collecting_per_vertical на всю ночь. Но
 * встретиться они почти не могут: долив идёт только в вертикаль с ЗАПУЩЕННОЙ
 * кампанией, а такая вертикаль по определению имеет готовую базу и шаблон —
 * значит реконсилер по ней ничего не ставит. Голодания при этом нет: вертикаль,
 * которой реконсилер нужен, доливать некуда, и слот у неё никто не отнимает.
 * Зато порядок «сначала деньги клиента, потом восстановление» честен: ночной
 * добор приносит контакты в живые кампании, а доставка пропущенной стадии
 * подождёт минуты.
 *
 * Exit code: 0 — все конфиги отработали; 1 — был хотя бы один fail (постановка
 * или обход конфига), либо сам проход автоподъёма не отработал, либо проход
 * реконсилера упал (целиком или по отдельному проекту), чтобы cron-алерты это
 * видели. capacity_blocked код НЕ меняет: место у рассыльщика — штатный
 * отказ, а не сбой тика. `dry` — тем более: это решение, а не отказ. Отказ автоподъёма (потолок, остывание, занятая
 * вертикаль) — тоже штатный: код не меняет. Пропуск проекта реконсилером
 * (нечего ставить, ждём человека) — тоже.
 */

import { createWorkerLogger, requireSupabaseAdmin } from './_shared';
import { runHeAutoPipelineTick } from '@/lib/hypothesisEngine/autoPipeline';
import {
  HE_AUTO_RESUME_FLAG_ENV,
  HE_AUTO_RESUME_MAX_PER_BASE,
  HE_AUTO_RESUME_PER_RUN,
  runHeAutoResumeTransientPass,
} from '@/lib/hypothesisEngine/baseAutoResume';
import {
  HE_AUTOPILOT_RECONCILE_FLAG_ENV,
  HE_AUTOPILOT_RECONCILE_PER_RUN,
  runHeAutopilotReconcilePass,
} from '@/lib/hypothesisEngine/autopilotReconcile';

const WORKER_ID = 'he-auto-pipeline-cron';

async function main(): Promise<number> {
  const log = createWorkerLogger(WORKER_ID);
  const supabase = requireSupabaseAdmin(log);

  const startedAt = Date.now();

  // ─── Автоподъём баз после временного отказа провайдера ───
  // Идёт ПЕРЕД постановкой доливов (почему — в докблоке файла). Сбой прохода не
  // отменяет ночной добор: платит и приносит контакты именно он.
  let resumeFailed = false;
  try {
    const resume = await runHeAutoResumeTransientPass(supabase);
    if (!resume.enabled) {
      log('info', `Auto-resume pass is off (${HE_AUTO_RESUME_FLAG_ENV} is not set) — nothing resumed`);
    } else {
      for (const r of resume.rows) {
        const target = r.verticalId ? ` vertical ${r.verticalId}` : '';
        // Отказ — 'warn': строка обязана быть видна в ночном логе, но не
        // читаться алертами как падение (ровно как capacity_blocked ниже).
        log(
          r.outcome === 'resumed' ? 'info' : 'warn',
          `auto-resume base ${r.baseId}${target}: ${r.outcome}` +
            (r.reason ? ` — ${r.reason}` : '') +
            (r.jobId ? `, he_jobs base_collect ${r.jobId}` : '') +
            ` (resumes ${r.resumes}/${HE_AUTO_RESUME_MAX_PER_BASE})`,
        );
      }
      log(
        'info',
        `Auto-resume: ${resume.resumed} resumed, ${resume.refused} refused ` +
          `(up to ${HE_AUTO_RESUME_PER_RUN} per night, ${HE_AUTO_RESUME_MAX_PER_BASE} per base)`,
      );
    }
  } catch (err) {
    // Громко: флаг включён, а проход не отработал (нет миграции, нет прав, сбой
    // БД). Ночь при этом продолжается.
    log('error', 'Auto-resume pass failed', err);
    resumeFailed = true;
  }

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
    // Серия пустых ночей печатается у ЛЮБОГО исхода, где её удалось прочитать:
    // с выключенным правилом это единственный материал для выбора порога, а с
    // включённым — объяснение строки `dry`.
    const dry = d.dryNights === undefined ? '' : `, dry nights ${d.dryNights}`;
    // capacity_blocked — штатный отказ, а не сбой: 'warn', чтобы строка была
    // видна в ночном логе, но не читалась алертами как падение тика. `dry` —
    // не отказ вовсе, а намеренный пропуск: 'info'.
    const level = d.status === 'failed' ? 'error' : d.status === 'capacity_blocked' ? 'warn' : 'info';
    log(level, `config ${d.configId}${target}${base}: ${d.status}${dry}${msg}`);
  }

  // ─── Реконсилер автопилота: доставить стадии, которые никто не поставил ───
  // Идёт ПОСЛЕ доливов (почему — в докблоке файла). Сбой прохода ночной добор
  // уже не отменяет: он отработал.
  let reconcileFailed = false;
  try {
    const reconcile = await runHeAutopilotReconcilePass(supabase);
    if (!reconcile.enabled) {
      log(
        'info',
        `Autopilot reconcile is off (${HE_AUTOPILOT_RECONCILE_FLAG_ENV} is not set) — nothing delivered`,
      );
    } else {
      for (const row of reconcile.rows) {
        const counts = row.counts
          ? ` (chains ${row.counts.chainsEnqueued}, collects ${row.counts.collectsEnqueued}, ` +
            `templates ${row.counts.templatesEnqueued}, analyses ${row.counts.analysesRequeued}, ` +
            `skipped ${row.counts.verticalsSkipped})`
          : '';
        // Доставленное печатаем вместе с базой: без неё в ночном логе нельзя
        // сопоставить строку с конкретной базой, а по ней специалист ищет и
        // джобу, и расход.
        const why = row.details
          .filter((d) => d.outcome === 'skipped' && d.reason)
          .map((d) => `${d.verticalId}=${d.reason}`)
          .concat(
            row.details
              .filter((d) => d.outcome !== 'skipped')
              .map((d) => `${d.verticalId}=${d.outcome}${d.baseId ? `:${d.baseId}` : ''}`),
          )
          .join(' ');
        log(
          row.outcome === 'failed' ? 'error' : 'info',
          `autopilot reconcile project ${row.projectId}: ${row.outcome}${counts}` +
            (row.pause ? `, pause ${row.pause}` : '') +
            (why ? ` — ${why}` : '') +
            (row.message ? ` — ${row.message}` : ''),
        );
      }
      log(
        'info',
        `Autopilot reconcile: ${reconcile.projects} projects, ${reconcile.acted} acted, ` +
          `${reconcile.idle} idle, ${reconcile.refused} refused, ${reconcile.failed} failed ` +
          `(up to ${HE_AUTOPILOT_RECONCILE_PER_RUN} per night)`,
      );
      reconcileFailed = reconcile.failed > 0;
    }
  } catch (err) {
    // Громко: флаг включён, а проход не отработал (нет прав, сбой БД).
    log('error', 'Autopilot reconcile pass failed', err);
    reconcileFailed = true;
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  log(
    'info',
    `Done: ${summary.configs} configs, ${summary.enqueued} enqueued, ${summary.existing} existing, ` +
      `${summary.noCampaign} no_campaign, ${summary.capacityBlocked} capacity_blocked, ` +
      `${summary.dry} dry, ${summary.failed} failed in ${elapsedSec}s`,
  );
  return summary.failed > 0 || resumeFailed || reconcileFailed ? 1 : 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[worker][he-auto-pipeline-cron][FATAL]', err);
    process.exit(1);
  });
