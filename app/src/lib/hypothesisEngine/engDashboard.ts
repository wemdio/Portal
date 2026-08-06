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

import { parseLaunchInfo, type HeTemplateLaunchInfo } from './launchHandoff';

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

export type EngDashStage =
  | 'research'
  | 'letters'
  | 'collecting'
  | 'construct'
  | 'analyzing'
  | 'analyzed'
  | 'template'
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
  /** База-«паспорт» вертикали (из которой считаются companies/emails/valid). */
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
      stageDetail: `base analyzed: ${asNum(analyzedBase.row_count)} companies`,
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
    | 'refill_appended'
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
          text: withVertical(`base analyzed: ${rows} companies`, vname),
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
    events.push({
      type: 'launched',
      text: `campaign launched (paused)${launch.campaign_name ? `: ${launch.campaign_name}` : ''}`,
      at,
    });
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
      events.push({
        type: 'refill_appended',
        text: withVertical(`refill: +${asNum(stats.appended)} leads`, vname),
        at,
      });
    } else if (status === 'no_new') {
      events.push({ type: 'refill_empty', text: withVertical('refill: no new companies', vname), at });
    } else if (status === 'failed') {
      events.push({ type: 'failed', text: withVertical('refill failed', vname), at });
    }
  }

  return events
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}
