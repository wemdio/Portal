/**
 * ENG Command Center (клиентский кабинет /client/eng/dashboard): чистая
 * логика агрегата — вывод этапа вертикали из сущностей, расчёт ближайшего
 * авто-добора (ежедневно 03:20 UTC, крон heAutoPipelineCron) и сборка ленты
 * событий из jobs/templates/runs.
 *
 * Всё время — UTC: дневные суммы и слот крона считаются по UTC-суткам
 * (как daily_leads_cap в refill-ветке base_collect). Строки stageDetail и
 * текстов событий — английские: кабинет ENG-клиентов англоязычный.
 *
 * Роут app/src/app/api/client/eng/dashboard/route.ts — тонкая обвязка
 * (auth + скоуп created_by + батч-запросы), вся склейка здесь.
 */

import { heLaunchIsIncomplete, parseLaunchInfo, type HeTemplateLaunchInfo } from './launchHandoff';
// Справочник клиентских текстов без зависимостей (тот же, что реэкспортирует
// clientErrors.ts): короткая нейтральная фраза про отказ, который чинит команда.
import { HE_TEAM_ON_IT_SHORT_EN } from '@/components/client-eng/clientFailureText';

/* ─────────────────────────── Время (UTC) ─────────────────────────── */

/** Слот ежедневного авто-добора: 03:20 UTC (crontab heAutoPipelineCron). */
export const HE_AUTO_RUN_HOUR_UTC = 3;
export const HE_AUTO_RUN_MINUTE_UTC = 20;

/** Начало текущих UTC-суток — дневные суммы дашборда считаются по ним. */
export function utcDayStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Ближайший прогон авто-добора СТРОГО в будущем: если сейчас ровно 03:20
 * (крон стартует) или позже — следующий слот уже завтра.
 */
export function nextDailyRunIso(now: Date): string {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      HE_AUTO_RUN_HOUR_UTC,
      HE_AUTO_RUN_MINUTE_UTC,
      0,
      0,
    ),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

/* ─────────────────────────── Этап вертикали ─────────────────────────── */

/**
 * `launch_unfinished` — запись о запуске есть, но `heLaunchIsIncomplete` (часть
 * аудитории без кампании или без адресов). Тот же предикат, что у шага 5 и у
 * самого запуска: «live» для такой записи значило бы, что клиенту делать
 * нечего, хотя достроить запуск может только его нажатие на шаге 5.
 *
 * `pending` есть и у ИДУЩЕГО запуска: ядро пишет запись по ходу (группа в
 * полёте и ещё не начатые группы — launchTemplate.ts, persistProgress), а
 * аренда (`running_until`) в проекцию кабинета не уходит. Поэтому подпись
 * говорит «ещё не уехала» (has not gone out yet), а не «не уехала»: она верна
 * и посреди запуска, и после обрыва. Нажатие на шаге 5, пока аренда жива,
 * получает честный 409 «запуск ещё идёт или оборвался меньше 15 минут назад».
 */
export type EngDashStage =
  | 'research'
  | 'letters'
  | 'collecting'
  | 'construct'
  | 'analyzing'
  | 'analyzed'
  | 'template'
  | 'launch_unfinished'
  | 'launched';

/** Пять точек прогресса карточки: research → letters → base → template → launched. */
export type EngDashDots = [boolean, boolean, boolean, boolean, boolean];

export interface EngDashVerticalSlice {
  projectStatus: string;
  chains: Array<Record<string, unknown>>;
  bases: Array<Record<string, unknown>>;
  templates: Array<Record<string, unknown>>;
  /** Активные джобы вертикали (pending/running) — для живых подписей. */
  activeJobs: Array<Record<string, unknown>>;
}

export interface EngDashStageInfo {
  stage: EngDashStage;
  stageDetail: string;
  dots: EngDashDots;
  /**
   * База-«паспорт» вертикали: из неё берутся `row_count` и счётчики
   * конструктора (emails_found/valid_count).
   *
   * ВНИМАНИЕ: `row_count` — это СТРОКИ базы, а не компании. ENG-сборка
   * разносит один адрес на строку (шаг `split_emails` в `constructStepsFor`
   * для market='us'), поэтому у компании с пятью адресами строк пять, и
   * `row_count` до капа адресов на компанию (по умолчанию 5) раз больше
   * числа компаний. Компаний в этом модуле НЕТ: `he_bases.row_count` их не
   * знает, поэтому любая подпись здесь называет строки строками. Само число
   * компаний живёт в `collect_info.stats.companies_total` (пишет
   * `capImportedRows` в `stages/baseCollect.ts`), и роут дашборда берёт
   * `companies` оттуда, а `rows` — из этого `row_count`; у баз, собранных до
   * появления ключа, компаний нет вовсе — там 0 со смыслом «не знаем».
   */
  mainBase: Record<string, unknown> | null;
  launch: HeTemplateLaunchInfo | null;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function tsOf(v: unknown): number {
  const t = Date.parse(asStr(v));
  return Number.isNaN(t) ? 0 : t;
}

/** Последняя по created_at строка (стабильно: при равенстве — поздняя в списке). */
function latest<T extends Record<string, unknown>>(rows: T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!best || tsOf(row.created_at) >= tsOf(best.created_at)) best = row;
  }
  return best;
}

/** Шаблон с запуском, самый свежий по дате запуска (force-перезапуск перезаписывает launch_info). */
function latestLaunchedTemplate(
  templates: Array<Record<string, unknown>>,
): { row: Record<string, unknown>; launch: HeTemplateLaunchInfo } | null {
  let best: { row: Record<string, unknown>; launch: HeTemplateLaunchInfo; ts: number } | null = null;
  for (const row of templates) {
    const launch = parseLaunchInfo(row.launch_info);
    if (!launch) continue;
    const ts = tsOf(launch.created_at) || tsOf(row.created_at);
    if (!best || ts >= best.ts) best = { row, launch, ts };
  }
  return best ? { row: best.row, launch: best.launch } : null;
}

function collectInfo(base: Record<string, unknown> | null): Record<string, unknown> {
  const info = base?.collect_info;
  return info && typeof info === 'object' ? (info as Record<string, unknown>) : {};
}

/**
 * Этап вертикали из сущностей (порядок конвейера: research → letters →
 * base (collecting → construct → analyzing) → template → launched; дальше
 * ежедневный refill — отдельным блоком дашборда). Приоритет: запущенное
 * всегда сверху; активная работа базы (collecting/construct/analyzing)
 * важнее «статичного» analyzed — ре-collect той же вертикали честно
 * показывает прогресс, а не вчерашний финиш.
 */
export function deriveEngVerticalStage(input: EngDashVerticalSlice): EngDashStageInfo {
  const { projectStatus, chains, bases, templates, activeJobs } = input;

  const launched = latestLaunchedTemplate(templates);
  const readyTemplate = latest(
    templates.filter((t) => asStr(t.status) === 'ready' && !parseLaunchInfo(t.launch_info)),
  );
  const analyzingBase = latest(bases.filter((b) => asStr(b.status) === 'analyzing'));
  const collectingBase = latest(bases.filter((b) => asStr(b.status) === 'collecting'));
  const analyzedBase = latest(bases.filter((b) => asStr(b.status) === 'analyzed'));
  const hasReadyChain = chains.some((c) => asStr(c.status) === 'ready');

  // База-«паспорт» вертикали: из которой собран запущенный/готовый шаблон,
  // иначе свежая analyzed, иначе текущая собирающаяся.
  const templateBaseId = asStr((launched?.row ?? readyTemplate)?.base_id);
  const mainBase =
    (templateBaseId ? bases.find((b) => asStr(b.id) === templateBaseId) : undefined) ??
    analyzedBase ??
    collectingBase ??
    latest(bases);

  if (launched && heLaunchIsIncomplete(launched.launch)) {
    return {
      stage: 'launch_unfinished',
      stageDetail: 'launch unfinished — part of the audience has not gone out yet',
      dots: [true, true, true, true, false],
      mainBase,
      launch: launched.launch,
    };
  }
  if (launched) {
    return {
      stage: 'launched',
      stageDetail: launched.launch.campaign_name
        ? `live: ${launched.launch.campaign_name}`
        : 'campaign launched',
      dots: [true, true, true, true, true],
      mainBase,
      launch: launched.launch,
    };
  }
  if (readyTemplate) {
    return {
      stage: 'template',
      stageDetail: 'template ready — launch when set',
      dots: [true, true, true, false, false],
      mainBase,
      launch: null,
    };
  }
  if (analyzingBase) {
    return {
      stage: 'analyzing',
      stageDetail: 'analyzing the base…',
      dots: [true, true, false, false, false],
      mainBase,
      launch: null,
    };
  }
  if (collectingBase) {
    const info = collectInfo(collectingBase);
    const construct =
      info.construct && typeof info.construct === 'object'
        ? (info.construct as Record<string, unknown>)
        : null;
    if (construct && asStr(construct.status) === 'dispatched') {
      const emails = asNum(construct.emails_found);
      const valid = asNum(construct.valid_count);
      return {
        stage: 'construct',
        stageDetail:
          emails > 0 ? `constructor: ${valid}/${emails} valid` : 'constructor: finding emails…',
        dots: [true, true, false, false, false],
        mainBase,
        launch: null,
      };
    }
    const stats =
      info.stats && typeof info.stats === 'object' ? (info.stats as Record<string, unknown>) : null;
    const done = asNum(stats?.tasks_done);
    const total = asNum(stats?.tasks_total);
    return {
      stage: 'collecting',
      stageDetail: total > 0 ? `collecting: task ${done}/${total}` : 'collecting: starting…',
      dots: [true, true, false, false, false],
      mainBase,
      launch: null,
    };
  }
  if (analyzedBase) {
    return {
      stage: 'analyzed',
      // «rows», а не «companies»: см. mainBase в EngDashStageInfo. Слово взято
      // у шага 4 мастера (EngStepBases: «{row_count} rows»), чтобы у одного и
      // того же числа в кабинете было одно имя.
      stageDetail: `base analyzed: ${asNum(analyzedBase.row_count)} rows`,
      dots: [true, true, true, false, false],
      mainBase,
      launch: null,
    };
  }
  if (hasReadyChain) {
    return {
      stage: 'letters',
      stageDetail: 'letters ready — collect a base',
      dots: [true, true, false, false, false],
      mainBase,
      launch: null,
    };
  }
  if (projectStatus === 'researching') {
    return {
      stage: 'research',
      stageDetail: 'researching your market…',
      dots: [false, false, false, false, false],
      mainBase,
      launch: null,
    };
  }
  const chainJobActive = activeJobs.some((j) => asStr(j.stage) === 'chain');
  return {
    stage: 'letters',
    stageDetail: chainJobActive ? 'writing letters…' : 'letters pending — generate a chain',
    dots: [true, false, false, false, false],
    mainBase,
    launch: null,
  };
}

/* ─────────────────────────── Лента событий ─────────────────────────── */

export interface EngDashEvent {
  type:
    | 'letters_ready'
    | 'base_collected'
    | 'base_analyzed'
    | 'template_ready'
    | 'launched'
    /** Запуск записан, но не закончен (`heLaunchIsIncomplete`) — не «launched». */
    | 'launch_unfinished'
    | 'refill_appended'
    /**
     * Ночь БЕЗ отправки и БЕЗ сбоя кода. Причины разные, строка ленты одна:
     * отправлять нечего ('no_new'), у рассыльщика нет места
     * (stats.error_kind='instantly_capacity'), дневной бюджет не дал строк
     * (stats.budget_outcome) и отмена клиентом без подтверждённого приёма
     * (stats.cancelled). Тип переиспользован осознанно:
     * в кабинете он рисуется серым, а 'failed' — красным сбоем (EVENT_ICON,
     * components/client-eng/EngDashboard.tsx), и отложенная ночь — именно
     * серая. Разница причин — в тексте, а не в типе: заводить ключ, которого
     * нет в клиентском union, значит рисовать событие значком по умолчанию.
     */
    | 'refill_empty'
    | 'failed';
  text: string;
  /** ISO-время события (сортировка desc по нему). */
  at: string;
}

export const ENG_DASH_EVENTS_LIMIT = 15;

const JOB_STAGE_LABELS: Record<string, string> = {
  site_profile: 'research',
  competitors: 'competitor research',
  brand_cloud: 'brand cloud',
  hypotheses: 'hypotheses',
  evidence: 'evidence',
  clustering: 'clustering',
  chain: 'letter writing',
  vocab: 'vocabulary',
  base_collect: 'base collect',
  base_analyze: 'base analysis',
  template: 'template build',
  dossier: 'dossier',
};

function withVertical(text: string, name: string): string {
  return name ? `${text} · ${name}` : text;
}

/**
 * События из уже выбранных сущностей (без доп. запросов): финишированные
 * джобы (по updated_at), запуски кампаний (launch_info.created_at) и
 * refill-прогоны (completed_at). Отсортированы desc, кап eventsLimit.
 */
export function buildEngDashboardEvents(input: {
  jobs: Array<Record<string, unknown>>;
  bases: Array<Record<string, unknown>>;
  templates: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  verticalNames: Map<string, string>;
  limit?: number;
}): EngDashEvent[] {
  const { jobs, bases, templates, runs, verticalNames } = input;
  const limit = input.limit ?? ENG_DASH_EVENTS_LIMIT;
  const events: EngDashEvent[] = [];

  const baseById = new Map(bases.map((b) => [asStr(b.id), b]));
  const nameOfVertical = (id: string) => verticalNames.get(id) ?? '';
  const nameByBaseId = (baseId: string) => {
    const b = baseById.get(baseId);
    return b ? nameOfVertical(asStr(b.vertical_id)) : '';
  };

  for (const job of jobs) {
    const stage = asStr(job.stage);
    const status = asStr(job.status);
    const at = asStr(job.updated_at) || asStr(job.created_at);
    if (!at) continue;
    const payload =
      job.payload && typeof job.payload === 'object'
        ? (job.payload as Record<string, unknown>)
        : {};
    const vname =
      nameOfVertical(asStr(payload.vertical_id)) || nameByBaseId(asStr(payload.base_id));

    if (status === 'failed') {
      events.push({
        type: 'failed',
        text: withVertical(`${JOB_STAGE_LABELS[stage] ?? stage} failed`, vname),
        at,
      });
      continue;
    }
    if (status !== 'done') continue;
    switch (stage) {
      case 'chain':
        events.push({ type: 'letters_ready', text: withVertical('letters ready', vname), at });
        break;
      case 'base_collect':
        events.push({ type: 'base_collected', text: withVertical('base collected', vname), at });
        break;
      case 'base_analyze': {
        const b = baseById.get(asStr(payload.base_id));
        const rows = b ? asNum(b.row_count) : 0;
        events.push({
          type: 'base_analyzed',
          // Та же подпись, что у stageDetail этапа 'analyzed': строки, не
          // компании (см. mainBase в EngDashStageInfo).
          text: withVertical(`base analyzed: ${rows} rows`, vname),
          at,
        });
        break;
      }
      case 'template':
        events.push({ type: 'template_ready', text: withVertical('template ready', vname), at });
        break;
      default:
        // Внутренние стадии research (site_profile/competitors/…) — слишком
        // гранулярны для ленты; живой прогресс виден в activeJobs.
        break;
    }
  }

  for (const t of templates) {
    const launch = parseLaunchInfo(t.launch_info);
    if (!launch) continue;
    const at = launch.created_at || asStr(t.created_at);
    if (!at) continue;
    const name = launch.campaign_name ? `: ${launch.campaign_name}` : '';
    events.push(
      heLaunchIsIncomplete(launch)
        ? {
            type: 'launch_unfinished',
            text: `campaign launch unfinished — part of the audience has not gone out yet${name}`,
            at,
          }
        : { type: 'launched', text: `campaign launched (paused)${name}`, at },
    );
  }

  for (const run of runs) {
    const status = asStr(run.status);
    if (status === 'collecting') continue; // ещё работает — виден в activeJobs
    const at = asStr(run.completed_at) || asStr(run.created_at);
    if (!at) continue;
    const vname = nameOfVertical(asStr(run.vertical_id));
    const stats =
      run.stats && typeof run.stats === 'object' ? (run.stats as Record<string, unknown>) : {};
    if (status === 'appended') {
      // Часть строк рассыльщик не взял по ёмкости (stats.deferred +
      // deferred_reason, пишет stages/baseCollectRefill.ts). Ночь состоялась,
      // но не целиком: без остатка «+N leads» читается как «уехало всё».
      // «not sent», а не «on hold»: число — про ЭТОТ прогон, и только это про
      // него правда при любой судьбе строк. Судьба у них разная: у market='us'
      // компании, ни один адрес которых не дошёл до рассыльщика, ложатся в
      // очередь переноса (he_refill_carryover, stages/baseCollectRefill.ts) и
      // идут первыми в следующие ночи своей вертикали — до
      // HE_REFILL_CARRYOVER_MAX_AGE_DAYS (7) суток, потом отпускаются, и их
      // может заново подготовить обычная сборка; вторые адреса компаний,
      // которым письмо ушло, не переносятся вовсе (компания охвачена); очередь
      // не прочиталась или не записалась (нет миграции) — не переносится
      // ничего, компании остаются исключёнными. «on hold» обещало бы, что
      // уедут все эти строки, а этого не обещает ни одна из форм. Причину не
      // называем (решение владельца 04.10.2026): «работаем» правда, потому что
      // та же ветка долива, что пишет deferred_reason, сначала шлёт алерт
      // команде (alertRefillCapacityStop → opsAlert.ts).
      const deferred = asNum(stats.deferred);
      const heldBack =
        deferred > 0 && asStr(stats.deferred_reason) === 'instantly_capacity'
          ? `, ${deferred} not sent (${HE_TEAM_ON_IT_SHORT_EN})`
          : '';
      events.push({
        type: 'refill_appended',
        text: withVertical(`refill: +${asNum(stats.appended)} leads${heldBack}`, vname),
        at,
      });
    } else if (status === 'no_new') {
      // 'no_new' ставится по ДВУМ причинам (stages/baseCollectRefill.ts):
      // пустой harvest (новых компаний действительно нет) и valid === 0
      // (компании нашлись, но ни одного адреса с вердиктом 'ok'); у
      // market='us' — только если и очередь переноса не дала ни одного
      // допущенного адреса. Про компании мы знаем только в первом случае,
      // поэтому подпись говорит ровно то, что верно для обоих: отправлять нечего.
      events.push({ type: 'refill_empty', text: withVertical('refill: nothing new to send', vname), at });
    } else if (status === 'failed') {
      // Нет места у рассыльщика — не сбой кода, а ночь, которую некуда было
      // отправить. Подпись — про ЭТОТ прогон («stopped»), а не про состояние
      // добора («on hold»): строка ленты историческая, а durable-пауза проекта
      // (he_auto_pipeline_configs.refill_paused_at) пишется best-effort — без
      // конфига или колонок её нет, а поставленную снимает сотрудник. Текущее
      // состояние добора кабинет печатает отдельно, по `projects[].refill`.
      // Читаем машинную причину, а не текст: stats.error_kind='instantly_capacity'
      // пишут оба отказа по ёмкости — предполёт тика до сборки (autoPipeline.ts,
      // строка журнала без base_id) и отказ долива (stages/baseCollectRefill.ts,
      // runStats), — поэтому у ленты одно условие на оба. Причину клиенту не
      // называем (решение владельца 04.10.2026): короткая общая фраза, и она
      // правда, потому что оба места записи такого отказа шлют алерт команде
      // (lib/hypothesisEngine/opsAlert.ts).
      // Нулевой дневной бюджет — НЕ поломка, а решение, и у него ДВА исхода с
      // разным смыслом: 'cap_exhausted' — кап проекта на сегодня занят другими
      // бронями; 'already_reserved' — это повтор прогона той же базы, а её
      // первый прогон ещё держит свою бронь (кап проекта при этом может быть
      // свободен — писать «лимит исчерпан» было бы неправдой).
      const budgetOutcome = asStr(stats.budget_outcome);
      // Отмена клиентом («Cancel all jobs») — решение человека, а не сбой:
      // stats.cancelled пишет stages/baseCollectRefill.ts (refillUserCancelled).
      // «nothing added» здесь не пишем: строка прогона знает только
      // подтверждённый приём (stats.appended), а запрос в полёте мог лечь.
      if (stats.cancelled === true) {
        const appendedBeforeCancel = asNum(stats.appended);
        events.push(
          appendedBeforeCancel > 0
            ? {
                type: 'refill_appended',
                text: withVertical(`refill cancelled: +${appendedBeforeCancel} leads before the cancel`, vname),
                at,
              }
            : { type: 'refill_empty', text: withVertical('refill cancelled', vname), at },
        );
        continue;
      }
      events.push(
        asStr(stats.error_kind) === 'instantly_capacity'
          ? {
              type: 'refill_empty',
              text: withVertical(`refill stopped: ${HE_TEAM_ON_IT_SHORT_EN}`, vname),
              at,
            }
          : budgetOutcome === 'cap_exhausted'
            ? {
                type: 'refill_empty',
                text: withVertical("refill: nothing added — today's contact limit was already taken", vname),
                at,
              }
            : budgetOutcome === 'already_reserved'
              ? {
                  type: 'refill_empty',
                  text: withVertical('refill: nothing added — repeat of a run that already started today', vname),
                  at,
                }
              : { type: 'failed', text: withVertical('refill failed', vname), at },
      );
    }
  }

  return events
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}
