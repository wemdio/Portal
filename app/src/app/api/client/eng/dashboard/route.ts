import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { stripTaskHarvest } from '@/lib/hypothesisEngine/projectDetail';
import {
  heTemplateNeedsRewrite,
  toClientEngAutopilotHold,
  toClientEngBase,
  toClientEngCampaignName,
  toClientEngJobProgressLabel,
  toClientEngRefillState,
  toClientEngStageErrorCode,
  type ClientEngAutopilotHold,
  type HeClientRefillState,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { projectMarket } from '@/lib/hypothesisEngine/market';
import { requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { reconcileProjectVerticals } from '@/lib/hypothesisEngine/actualsReconcile';
import {
  isAnalyzingBaseLive,
  latestEndedJobByBase,
  liveBaseIdsFromJobs,
} from '@/lib/hypothesisEngine/autopilotNext';
import { readHeEngSendingSummaries, type HeEngLaunchRef } from '@/lib/hypothesisEngine/engCampaignSending';
import {
  heEngLaunchPredatesSelfServe,
  readHeEngClientStates,
  readHeEngPoolAssignedSince,
} from '@/lib/hypothesisEngine/engCampaignStatus';
import { heRefillMainCampaignId, readHeRefillMainVerdicts } from '@/lib/hypothesisEngine/autoPipeline';
import {
  buildEngDashboardEvents,
  deriveEngTopUpVerdict,
  deriveEngVerticalStage,
  engDashLaunchedTemplate,
  engDashReadyTemplateId,
  engDashRewriteCandidateIds,
  engDashSelectionByVertical,
  nextDailyRunIso,
  utcDayStartIso,
  type EngDashAutoLaunch,
  type EngDashSelection,
  type EngDashTopUp,
} from '@/lib/hypothesisEngine/engDashboard';
import {
  HE_ENG_AUTO_LAUNCH_STALE_MS,
  heEngAutoLaunchLeaseExpired,
  readHeEngAutoLaunchForProjects,
} from '@/lib/hypothesisEngine/engAutoLaunch';
import { readHeEngSendingAccess } from '@/lib/hypothesisEngine/engSendingAccess';
import { engServerError } from '../_shared';

export const dynamic = 'force-dynamic';

/** Дашборд поллится каждые 15 с — один текст на все сбои сборки агрегата. */
const DASHBOARD_LOAD_FAILED = 'Failed to load the dashboard';

/**
 * GET — агрегат ENG Command Center (кабинет /client/eng/dashboard): общий
 * экран по ВСЕМ своим ENG-проектам (created_by = user id).
 *
 * Один ответ без N+1: проекты → волна батч-запросов по project_id
 * (verticals/bases/jobs/configs/runs/hypotheses) → вторая волна по vertical_id
 * (chains/templates) → склейка в JS (lib/hypothesisEngine/engDashboard).
 * Запросы — индексированные eq/in по id; count(*) по большим таблицам нет.
 * Скоуп владельца — как у остальных client/eng роутов: чужие строки не
 * попадают в выборку уже на уровне projectIds.
 */

// Горизонт ленты событий для runs: текущие UTC-сутки + 6 дней назад
// (ежедневный refill даёт событие в день; недельной глубины достаточно).
const RUNS_EVENT_HORIZON_DAYS = 6;
// Капы выборок — защита от переросших аккаунтов; склейка и так капает
// events (15) и сортирует activeJobs в JS.
const FINISHED_JOBS_LIMIT = 30;
const ACTIVE_JOBS_LIMIT = 50;
const RUNS_LIMIT = 100;
// Гипотезы — только ради выбора вертикалей (EngDashSelection). Выборка, упёршаяся
// в кап, неполна: выбор тогда не выводится вовсе (см. selectionOf ниже).
const HYPOTHESES_LIMIT = 1000;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function ts(v: unknown): number {
  const t = Date.parse(str(v));
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Имя кампании чистится на ВХОДЕ в склейку, а не в каждом месте на выходе:
 * из `launch_info.campaign_name` оно расходится по дашборду двумя путями —
 * карточка Launch (`launch.campaign_name` ниже) и лента активности («campaign
 * launched: <имя>», buildEngDashboardEvents); `stageDetail` этапа
 * 'launched' имени больше не несёт. У запусков до этой волны в имени
 * лежит внутренний префикс `HE · ` и русский фолбэк «база»: гейт на записи
 * (launchTemplate.ts) задал новые имена, но старые строки остались как были.
 *
 * Копия поверхностная — остальные поля записи склейке нужны как есть
 * (`campaign_id`, `created_at`, `leads_count`). `campaigns[]` не трогаем: до
 * клиента с дашборда доезжает только скалярное имя.
 */
function withSafeCampaignName(template: Record<string, unknown>): Record<string, unknown> {
  const info = template.launch_info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return template;
  const launch = info as Record<string, unknown>;
  return {
    ...template,
    launch_info: { ...launch, campaign_name: toClientEngCampaignName(launch.campaign_name) },
  };
}

/**
 * Компаний в базе — ЕДИНСТВЕННОЕ честное число компаний, доступное дашборду:
 * `collect_info.stats.companies_total` (уникальные ключи «компания|домен»,
 * пишет стадия при финализации базы — stages/baseCollect.ts, capImportedRows).
 *
 * `row_count` компаниями НЕ является: ENG-сборка разносит один адрес на строку
 * (шаг `split_emails` у market='us'), поэтому у компании с пятью адресами строк
 * пять, и строк до капа адресов на компанию (по умолчанию 5) раз больше, чем
 * компаний. Ровно это число дашборд и печатал как «N companies».
 *
 * Читаем из СЫРОЙ строки выборки, а не из спроецированной: клиентская проекция
 * collect_info этот ключ не пропускает (COLLECT_STATS_FIELDS в
 * clientEngProjection — файл чужой полосы), а наружу уезжает один скаляр.
 *
 * Ключа нет у сборок до 26.09.2026 → компаний мы не знаем, и тогда здесь 0:
 * карточка прячет подпись сама (`s.companies > 0`, EngDashboard.tsx), а делить
 * `row_count` на кап — выдуманное число, оно хуже отсутствия числа. Правдивую
 * цифру строк такая вертикаль отдаёт в `stats.rows`.
 */
function companiesTotalOf(base: Record<string, unknown>): number {
  const info = base.collect_info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return 0;
  const stats = (info as Record<string, unknown>).stats;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return 0;
  return num((stats as Record<string, unknown>).companies_total);
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const gate = await requireEngMarket(supabaseAdmin, userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  const now = new Date();
  const todayStartIso = utcDayStartIso(now);
  const todayStartTs = Date.parse(todayStartIso);
  const runsSinceIso = new Date(
    todayStartTs - RUNS_EVENT_HORIZON_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: projects, error: projErr } = await supabaseAdmin
    .from('he_projects')
    // `error` — только ради кода причины упавшего проекта (этап 'attention'
    // карточек его вертикалей, см. projectErrorCode ниже); сырой текст наружу
    // не уходит.
    .select('id, name, status, market, error, created_at')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (projErr) return engServerError('client.eng.dashboard.projects_failed', projErr, DASHBOARD_LOAD_FAILED, { userId });

  const projectRows = projects ?? [];
  const emptyAggregate = {
    projects: projectRows.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    verticals: [] as unknown[],
    today: { appended: 0, valid: 0, collected: 0, collected_companies: 0 },
    autoRefill: { next_run_at: nextDailyRunIso(now), daily_cap: 0 },
    events: [] as unknown[],
    activeJobs: [] as unknown[],
  };
  if (projectRows.length === 0) return NextResponse.json(emptyAggregate);

  const projectIds = projectRows.map((p) => p.id as string);

  // Петля сверки прогноза с реальностью (actualsReconcile): best-effort,
  // fire-and-forget — дашборд от неё не зависит; свежие цифры подъедут к
  // следующему поллу (окно свежести 24ч внутри модуля).
  for (const pid of projectIds) {
    void reconcileProjectVerticals(supabaseAdmin, pid);
  }

  // Первая волна: всё по project_id (индексы на месте — см. миграции he_*).
  const [verticalsRes, basesRes, activeJobsRes, finishedJobsRes, configsRes, runsRes, hypothesesRes] =
    await Promise.all([
      supabaseAdmin
        .from('he_verticals')
        .select('id, project_id, name, created_at, potential_pct, actual_reply_pct, actual_sent, actual_measured_at')
        .in('project_id', projectIds),
      supabaseAdmin
        .from('he_bases')
        .select('id, project_id, vertical_id, status, source, row_count, error, filename, collect_info, created_at, updated_at')
        .in('project_id', projectIds),
      supabaseAdmin
        .from('he_jobs')
        .select('id, project_id, stage, status, payload, progress, created_at, updated_at')
        .in('project_id', projectIds)
        .in('status', ['pending', 'running'])
        .limit(ACTIVE_JOBS_LIMIT),
      supabaseAdmin
        .from('he_jobs')
        .select('id, project_id, stage, status, payload, progress, created_at, updated_at')
        .in('project_id', projectIds)
        .in('status', ['done', 'failed'])
        .order('updated_at', { ascending: false })
        .limit(FINISHED_JOBS_LIMIT),
      supabaseAdmin
        .from('he_auto_pipeline_configs')
        .select('project_id, enabled, daily_leads_cap, verticals_per_run, last_run_at')
        .in('project_id', projectIds),
      supabaseAdmin
        .from('he_auto_pipeline_runs')
        .select('id, project_id, vertical_id, base_id, status, stats, created_at, completed_at')
        .in('project_id', projectIds)
        .gte('created_at', runsSinceIso)
        .order('created_at', { ascending: false })
        .limit(RUNS_LIMIT),
      // Выбор вертикалей: те же колонки и тот же скоуп (project_id), что у
      // снапшота автопилота (autopilotReconcile.ts), — предикат один.
      supabaseAdmin
        .from('he_hypotheses')
        .select('id, vertical_id, status')
        .in('project_id', projectIds)
        .limit(HYPOTHESES_LIMIT),
    ]);
  for (const res of [verticalsRes, basesRes, activeJobsRes, finishedJobsRes, configsRes, runsRes]) {
    if (res.error) {
      return engServerError('client.eng.dashboard.aggregate_failed', res.error, DASHBOARD_LOAD_FAILED, { userId });
    }
  }
  /**
   * Выбор вертикали — best-effort, а не причина уронить весь агрегат: не
   * прочитали (или упёрлись в кап и прочли не всё) — `undefined`, и этап
   * вертикали выводится как без выбора (deriveEngVerticalStage), а оценка
   * «market fit» не печатается. Прочитали — вертикаль без строк гипотез это
   * `no_hypotheses`.
   */
  const hypothesisRows = hypothesesRes.error ? null : ((hypothesesRes.data ?? []) as Array<Record<string, unknown>>);
  const selectionByVertical =
    hypothesisRows !== null && hypothesisRows.length < HYPOTHESES_LIMIT
      ? engDashSelectionByVertical(hypothesisRows)
      : null;
  const selectionOf = (verticalId: string): EngDashSelection | undefined =>
    selectionByVertical ? (selectionByVertical.get(verticalId) ?? 'no_hypotheses') : undefined;

  const verticalRows = verticalsRes.data ?? [];
  const verticalIds = verticalRows.map((v) => v.id as string);
  // collect_info: harvest (до limit строк на задачу, задач в плане 1–4) режет
  // stripTaskHarvest. Снять его с ЭТОГО маршрута нельзя, хотя терминальная
  // запись стадии харвест больше не сохраняет (dropCollectWorkState в
  // stages/baseCollect): дашборд рисует прогресс ИДУЩЕЙ сборки, а у неё харвест
  // в collect_info лежит по построению — это чекпойнт мёрджа между тиками.
  // Всё остальное — клиентская проекция (план сорсинга с pdl_filters, id джоб
  // конструктора и состояние долива дашборду не нужны и клиенту не полагаются).
  // Строкой toClientEngBase дашборд не заменяет: ему нужны project_id/updated_at,
  // которых нет в белом списке мастера. Но три поля берёт ИМЕННО из неё, чтобы
  // шаг 4 и карточка Command Center говорили про одну базу одно и то же:
  // `collect_info` (та же проекция), `refill` (прогон долива, а не база
  // вертикали — по collect_info.refill или имени «auto-refill») и `error_code`
  // (код причины he_bases.error, в том числе 'cancelled'). Сырые `error` и
  // `filename` в склейку не идут: они выбраны только ради этих двух признаков.
  const baseRows = (basesRes.data ?? []).map((b) => {
    const row = stripTaskHarvest(b as Record<string, unknown>);
    const client = toClientEngBase(row);
    const out: Record<string, unknown> = {
      ...row,
      collect_info: client.collect_info ?? null,
      refill: client.refill === true,
      error_code: client.error_code ?? null,
    };
    delete out.error;
    delete out.filename;
    return out;
  });
  // Счётчик компаний строится по СЫРЫМ строкам баз (см. companiesTotalOf):
  // спроецированный `collect_info` ключа `companies_total` уже не несёт.
  const companiesByBaseId = new Map(
    (basesRes.data ?? []).map((b) => [
      str((b as Record<string, unknown>).id),
      companiesTotalOf(b as Record<string, unknown>),
    ]),
  );
  const activeJobRows = activeJobsRes.data ?? [];
  const finishedJobRows = finishedJobsRes.data ?? [];
  /**
   * Активные джобы для СУДА этапа вертикали (deriveEngVerticalStage), а не для
   * показа. Этап 'attention' («вертикаль встала») ставится только без идущей
   * работы вертикали, а `activeJobRows` капнут ACTIVE_JOBS_LIMIT на все проекты
   * пользователя: упёрлась выборка в кап — отсутствие в ней джобы вертикали
   * ничего не доказывает. Тогда — второе чтение тех же джоб без капа, только
   * стадия и payload (по ним джоба относится к вертикали). Не прочиталось —
   * null: идёт ли работа, неизвестно, и 'attention' не ставится никому
   * (`liveWorkUnknown`). Без капа (обычный случай) лишнего запроса нет.
   */
  let liveJobRows: Array<Record<string, unknown>> | null = activeJobRows;
  if (activeJobRows.length >= ACTIVE_JOBS_LIMIT) {
    const liveRes = await supabaseAdmin
      .from('he_jobs')
      .select('stage, payload')
      .in('project_id', projectIds)
      .in('status', ['pending', 'running']);
    liveJobRows = liveRes.error ? null : ((liveRes.data ?? []) as Array<Record<string, unknown>>);
  }

  /**
   * 'analyzing'-базы, АНАЛИЗ КОТОРЫХ НЕ ИДЁТ. Финальный фейл base_analyze базу
   * не трогает (она остаётся 'analyzing'), и карточка печатала «analyzing the
   * base…» вечно. Живость — общим предикатом воркера, автопилота и «Start
   * outreach» (isAnalyzingBaseLive: активная джоба любой стадии на её base_id
   * или запись строки в пределах окна постановки), по ПОЛНОМУ списку активных
   * джоб (liveJobRows); список неизвестен — не проверяем, и база читается
   * идущей, как раньше.
   *
   * Для каждой такой базы — исход ПОСЛЕДНЕГО упавшего или отменённого
   * base_analyze (latestEndedJobByBase, то же правило «решает поздний», что у
   * автопилота): отмена печатается как отмена, а не как сбой. Чтение только
   * когда такие базы есть (обычно их нет вовсе); отказ чтения — исход
   * неизвестен (null), а что анализ не идёт, всё равно известно.
   */
  const stalledAnalysis = new Map<string, 'cancelled' | null>();
  if (liveJobRows !== null) {
    const liveBaseIds = liveBaseIdsFromJobs(liveJobRows);
    const stalledIds = baseRows
      .filter(
        (b) =>
          str(b.status) === 'analyzing' &&
          str(b.id) !== '' &&
          !isAnalyzingBaseLive({ id: str(b.id), updated_at: str(b.updated_at) || null }, liveBaseIds),
      )
      .map((b) => str(b.id));
    if (stalledIds.length > 0) {
      const endedRes = await supabaseAdmin
        .from('he_jobs')
        .select('id, stage, status, payload, created_at')
        .in('project_id', projectIds)
        .eq('stage', 'base_analyze')
        .in('status', ['failed', 'cancelled'])
        .in('payload->>base_id', stalledIds);
      const ended = endedRes.error
        ? new Map<string, 'failed' | 'cancelled'>()
        : latestEndedJobByBase((endedRes.data ?? []) as Array<Record<string, unknown>>, ['base_analyze']);
      for (const id of stalledIds) stalledAnalysis.set(id, ended.get(id) === 'cancelled' ? 'cancelled' : null);
    }
  }

  /**
   * Пауза автопилота — ОТДЕЛЬНЫМ запросом и best-effort, а не колонкой в
   * выборке проектов выше.
   *
   * `autopilot_error` появляется миграцией, а на установке без неё PostgREST
   * отвечает 42703 на ВЕСЬ `select` — дописать колонку к выборке проектов
   * значило бы положить весь Command Center до применения миграции. Тот же
   * приём и по той же причине применён к `max_emails_per_company` в
   * `baseCollectEnqueue`: отдельный запрос, отказ — молча в дефолт.
   *
   * Дефолт здесь — «паузы не знаем», то есть НИЧЕГО не показать. Выдумывать
   * состояние, которого мы не прочитали, дашборду нельзя: пустая карточка
   * честнее придуманной.
   *
   * Проект с активной джобой паузу не показывает: запись остаётся в колонке и
   * после того, как конвейер снова поехал, а блок «Right now» в этот момент
   * уже печатает идущие стадии.
   *
   * «ЕСТЬ ЛИ АКТИВНЫЕ ДЖОБЫ» СЧИТАЕТСЯ ОТДЕЛЬНЫМ ЗАПРОСОМ, а не по
   * `activeJobRows`. Та выборка капнута ACTIVE_JOBS_LIMIT строк на ВСЕ проекты
   * пользователя: у аккаунта с полусотней идущих джоб на одном проекте джобы
   * остальных в неё просто не попадают, и такой проект читался как простаивающий
   * — то есть дашборд печатал бы старую паузу поверх ИДУЩЕГО конвейера, ровно
   * тот случай, ради которого вторая граница и заводилась. Кап там законный:
   * `activeJobs` — список для показа, и рисовать бесконечный список незачем.
   *
   * Выбран ids-only запрос, а не сравнение свежести: «пауза старше последнего
   * движения по проекту» опирается на he_projects.updated_at, а его двигает
   * учёт расхода стадии (accumulateProjectUsage) — то есть только ОПЛАЧЕННАЯ
   * работа. Джоба, которая встала в pending и ещё ничего не потратила, такого
   * следа не оставляет вовсе, и сравнение молча вернуло бы «не занят» в самом
   * частом случае. Запрос к he_jobs отвечает на вопрос прямо.
   *
   * Он идёт ТОЛЬКО по проектам, у которых пауза реально записана (обычно их
   * нет вовсе), берёт одну колонку и потому кап ему не нужен: строк столько,
   * сколько активных джоб у этих проектов. Сбой запроса — как и сбой чтения
   * самих пауз: не показываем ничего (выдумывать непрочитанное состояние
   * нельзя), а не показываем всё.
   */
  const autopilotHoldByProjectId = new Map<string, ClientEngAutopilotHold>();
  /**
   * Проекты с ЗАПИСАННОЙ паузой по потолку расхода ('spend_paused'), без
   * фильтров карточки выше (автопилот, занятость): этот набор читает не
   * карточка паузы, а `requeues` остановленного анализа (engDashAttentionOf).
   * Ремонт осиротевшей базы сам потолок не спрашивает, но проход «Start
   * outreach» над потолком кончается на первой платной постановке любой
   * вертикали (autopilotReconcile, stopOnSpendCeiling), и до ремонта этой
   * вертикали он может не дойти — «queues the analysis again» не доказано.
   * null — паузы не прочитаны: «не доказано» тоже, `requeues` ложно.
   */
  let spendPausedProjectIds: Set<string> | null = null;
  /**
   * Автопилот проекта (he_projects.autopilot) из того же чтения: этап 'letters'
   * с готовыми письмами говорит «next: collecting contacts», только когда сбор
   * поставит автопилот, иначе зовёт к «Launch» (deriveEngVerticalStage).
   * null — не прочитан: подпись не обещает ни того, ни другого.
   */
  let autopilotByProjectId: Map<string, boolean> | null = null;
  const holdsRes = await supabaseAdmin
    .from('he_projects')
    .select('id, autopilot, autopilot_error, autopilot_error_at')
    .in('id', projectIds);
  if (!holdsRes.error) {
    spendPausedProjectIds = new Set<string>();
    autopilotByProjectId = new Map<string, boolean>();
    for (const raw of holdsRes.data ?? []) {
      const row = raw as Record<string, unknown>;
      const pid = str(row.id);
      if (!pid) continue;
      autopilotByProjectId.set(pid, row.autopilot === true);
      // Пауза — факт автопилота: у ручного прогона координатор ничего не ставит.
      // Исключение — 'spend_paused' (потолок расхода, по умолчанию выключен):
      // её пишет и без автопилота отказ кнопки ручного режима (в том числе
      // старта исследования; начатую цепочку research потолок не обрывает), и
      // та же карточка мастера показывает её у такого проекта.
      const hold = toClientEngAutopilotHold(row);
      if (hold?.code === 'spend_paused') spendPausedProjectIds.add(pid);
      if (!hold || (row.autopilot !== true && hold.code !== 'spend_paused')) continue;
      autopilotHoldByProjectId.set(pid, hold);
    }
  }
  if (autopilotHoldByProjectId.size > 0) {
    const heldIds = [...autopilotHoldByProjectId.keys()];
    const busyRes = await supabaseAdmin
      .from('he_jobs')
      .select('project_id')
      .in('project_id', heldIds)
      .in('status', ['pending', 'running']);
    if (busyRes.error) {
      autopilotHoldByProjectId.clear();
    } else {
      for (const raw of busyRes.data ?? []) {
        const pid = str((raw as Record<string, unknown>).project_id);
        if (pid) autopilotHoldByProjectId.delete(pid);
      }
    }
  }
  const configRows = configsRes.data ?? [];
  const runRows = runsRes.data ?? [];

  // Вторая волна: chains/templates привязаны к вертикалям.
  let chainRows: Array<Record<string, unknown>> = [];
  let templateRows: Array<Record<string, unknown>> = [];
  if (verticalIds.length > 0) {
    const [chainsRes, templatesRes] = await Promise.all([
      supabaseAdmin
        .from('he_chains')
        .select('id, vertical_id, status, language, created_at')
        .in('vertical_id', verticalIds),
      supabaseAdmin
        .from('he_templates')
        .select('id, vertical_id, base_id, status, launch_info, created_at')
        .in('vertical_id', verticalIds),
    ]);
    if (chainsRes.error) {
      return engServerError('client.eng.dashboard.chains_failed', chainsRes.error, DASHBOARD_LOAD_FAILED, { userId });
    }
    if (templatesRes.error) {
      return engServerError('client.eng.dashboard.templates_failed', templatesRes.error, DASHBOARD_LOAD_FAILED, {
        userId,
      });
    }
    chainRows = chainsRes.data ?? [];
    templateRows = (templatesRes.data ?? []).map(withSafeCampaignName);
  }

  const projectById = new Map(projectRows.map((p) => [p.id as string, p]));

  /**
   * ПИСЬМА, КОТОРЫЕ ЗАПУСК ОТКАЖЕТ (`needs_rewrite`). Шаблоны, записанные до
   * гейта писем стадии (09.10.2026), лежат 'ready', но ядро запуска откажет им
   * кодом template_unresolved_operators (шаг 4b″), и достройку тоже. Без
   * признака карточка звала такой шаблон «ready to launch / launch from Review &
   * Launch», а незаконченный запуск — «finish the launch on step 5».
   *
   * Признак — функция проекции деталки (heTemplateNeedsRewrite), а не копия:
   * шаги 4/5 и дашборд обязаны говорить одно и то же про один шаблон. Ей нужны
   * письма и маппинг шаблона и колонки с первыми строками (sample_rows) его
   * базы, а выборки выше их не несут: ради шаблонов, о которых карточка может
   * сказать «запускай» или «достраивай» (не больше одного на вертикаль,
   * engDashRewriteCandidateIds), не тащим письма каждого шаблона аккаунта на
   * 15-секундном полле. Только проекты market='us' (у RU-запуска гейта нет, и
   * функция для них всё равно false). Отказ чтения — тот же ответ, что у
   * остальных выборок агрегата: печатать «ready to launch» по непрочитанному
   * нельзя.
   */
  const usProjectIds = new Set(
    projectRows.filter((p) => projectMarket(p as { market?: string | null }) === 'us').map((p) => p.id as string),
  );
  const projectOfVertical = new Map(verticalRows.map((v) => [v.id as string, str(v.project_id)]));
  const rewriteCandidates = engDashRewriteCandidateIds(
    templateRows.filter((t) => usProjectIds.has(projectOfVertical.get(str(t.vertical_id)) ?? '')),
  );
  const rewriteTemplateIds = new Set<string>();
  if (rewriteCandidates.length > 0) {
    const candidateRows = templateRows.filter((t) => rewriteCandidates.includes(str(t.id)));
    const candidateBaseIds = [...new Set(candidateRows.map((t) => str(t.base_id)).filter(Boolean))];
    const [lettersRes, baseColumnsRes] = await Promise.all([
      supabaseAdmin
        .from('he_templates')
        .select('id, letters, personalization_plan')
        .in('id', rewriteCandidates),
      candidateBaseIds.length > 0
        ? supabaseAdmin.from('he_bases').select('id, columns, sample_rows').in('id', candidateBaseIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    ]);
    if (lettersRes.error) {
      return engServerError('client.eng.dashboard.template_letters_failed', lettersRes.error, DASHBOARD_LOAD_FAILED, {
        userId,
      });
    }
    if (baseColumnsRes.error) {
      return engServerError('client.eng.dashboard.base_columns_failed', baseColumnsRes.error, DASHBOARD_LOAD_FAILED, {
        userId,
      });
    }
    const lettersById = new Map(
      (lettersRes.data ?? []).map((t) => [str((t as Record<string, unknown>).id), t as Record<string, unknown>]),
    );
    const gateBaseById = new Map(
      (baseColumnsRes.data ?? []).map((b) => [str((b as Record<string, unknown>).id), b as Record<string, unknown>]),
    );
    for (const t of candidateRows) {
      const extra = lettersById.get(str(t.id));
      // Строки шаблона нет во второй выборке (удалён между запросами) —
      // признак не ставим: шаблона, которому он адресован, уже нет.
      if (!extra) continue;
      if (heTemplateNeedsRewrite({ ...t, ...extra }, gateBaseById.get(str(t.base_id)), 'us')) {
        rewriteTemplateIds.add(str(t.id));
      }
    }
  }
  const verticalNames = new Map(verticalRows.map((v) => [v.id as string, str(v.name)]));
  const baseById = new Map(baseRows.map((b) => [str(b.id), b]));

  // today-суммы: прогоны, созданные в текущих UTC-сутках (крон ставит их в
  // 03:20, долив завершается тем же днём; stats {} у ещё идущих — нули).
  const todayRuns = runRows.filter((r) => ts(r.created_at) >= todayStartTs);
  /**
   * Счётчики дня — ТРИ РАЗНЫЕ ЕДИНИЦЫ, и каждая названа своей:
   *  - `collected` — СТРОКИ сборки: `stats.collected` долива это
   *    `finalRows.length` (stages/baseCollectRefill.ts, runStats). У market='us'
   *    конструктор разносит один адрес на строку (шаг `split_emails`), поэтому
   *    у компании с пятью адресами строк пять, а у компании без найденного
   *    адреса — одна ПУСТАЯ строка (их часто большинство); туда же входят
   *    строки, отложенные гейтом релевантности. Ни компаниями, ни адресами это
   *    число не является — карточка «Collected today» печатает его как строки,
   *    когда компаний не знает.
   *  - `collected_companies` — КОМПАНИИ, и только записанным числом:
   *    `collect_info.stats.companies_total` баз сегодняшних доливов
   *    (companiesTotalOf). Воронка самого прогона компаний не знает вовсе:
   *    `stats.company_target`/`company_limit` — ПЛАН сборки, а не факт, и
   *    печатать их как собранные компании нельзя.
   *  - `valid` / `appended` — АДРЕСА: строк с допущенным вердиктом валидации и
   *    лидов, принятых Instantly (подписи карточек — про почты и лиды).
   */
  const today = { appended: 0, valid: 0, collected: 0, collected_companies: 0 };
  const appendedTodayByVertical = new Map<string, number>();
  // Компании дня собираем отдельным накопителем, чтобы ни одна единица не
  // попала в чужую сумму. `companiesKnown` — правило «частичную сумму не
  // печатаем», см. ниже.
  let collectedCompanies = 0;
  let companiesKnown = true;
  const companiesCountedBases = new Set<string>();
  for (const r of todayRuns) {
    const stats =
      r.stats && typeof r.stats === 'object' ? (r.stats as Record<string, unknown>) : {};
    const appended = num(stats.appended);
    const collected = num(stats.collected);
    today.appended += appended;
    today.valid += num(stats.valid);
    today.collected += collected;
    const vid = str(r.vertical_id);
    if (vid) appendedTodayByVertical.set(vid, (appendedTodayByVertical.get(vid) ?? 0) + appended);
    // Компании — по БАЗЕ прогона (один прогон = одна база: крон пишет строку
    // 'collecting' с base_id, финал долива обновляет её же по base_id —
    // autoPipeline.insertRun / baseCollectRefill.writeRefillRun).
    //
    // Прогон без собранных строк — это отказ постановки (base_id NULL, stats
    // нет) или пустой harvest: компаний он не добавляет и незнанием не
    // считается. Повторный прогон по той же базе компании не удваивает:
    // companies_total — свойство базы, а не прогона.
    if (collected === 0) continue;
    const bid = str(r.base_id);
    if (!bid || companiesCountedBases.has(bid)) {
      if (!bid) companiesKnown = false;
      continue;
    }
    companiesCountedBases.add(bid);
    const companies = companiesByBaseId.get(bid) ?? 0;
    if (companies === 0) {
      companiesKnown = false;
      continue;
    }
    collectedCompanies += companies;
  }
  // Частичную сумму компаний НЕ печатаем: у базы старше 26.09.2026 ключа
  // companies_total нет, и сумма по остальным прогонам читалась бы как «сегодня
  // собрали меньше компаний», то есть была бы выдуманным числом. 0 — та же
  // договорённость, что у `stats.companies` вертикали: «не знаем», и тогда
  // единственное правдивое число дня — строки в `collected`.
  today.collected_companies = companiesKnown ? collectedCompanies : 0;

  /**
   * ПОМЕТКА СУХОЙ ВЕРТИКАЛИ — отдельным запросом и best-effort, тем же приёмом
   * и по той же причине, что паузы выше и ниже: `refill_dry_since` появляется
   * миграцией 20260930_0003, а на установке без неё PostgREST отвечает 42703
   * на ВЕСЬ `select` — дописать колонку к выборке вертикалей значило бы
   * положить весь Command Center до применения миграции.
   *
   * Зачем: правило сухой вертикали снимает с ночного добора ОДНУ вертикаль, а
   * состояние добора выше — про проект. Без пометки карточка такой вертикали
   * печатала «next: daily refill 03:20 UTC» с зелёной точкой, пока шаг 2 того
   * же проекта писал «Auto-refill is paused for this vertical».
   *
   * Дефолт — «пометки нет», и это прочитанный факт, а не выдумка: без колонки
   * правила нет и у ночного тика. Худший случай — колонка есть, а этот запрос
   * сорвался: тогда до следующего полла (15 с) карточка покажет добор, который
   * ночь вертикали не даст. Признак — только штамп, как у шага 2
   * (`refillPauseNote`, EngStepVerticals): по нему же правило решает, выдавать
   * ли вертикали слот. Запрос идёт только когда есть включённый конфиг — без
   * него ночного добора нет вовсе и печатать про вертикаль нечего. Окно
   * рассинхрона то же, что у шага 2: флаг правила (`HE_VERTICAL_DRY_STOP`)
   * читает воркер, а не кабинет, и пометки выключенного правила снимает первый
   * ночной проход проекта с включённым конфигом — до него карточка может
   * показать паузу, которой той ночью уже не будет.
   */
  const dryVerticalIds = new Set<string>();
  if (verticalIds.length > 0 && configRows.some((c) => c.enabled === true)) {
    const dryRes = await supabaseAdmin
      .from('he_verticals')
      .select('id, refill_dry_since')
      .in('id', verticalIds)
      .not('refill_dry_since', 'is', null);
    if (!dryRes.error) {
      for (const raw of dryRes.data ?? []) {
        const row = raw as Record<string, unknown>;
        if (str(row.refill_dry_since).trim()) dryVerticalIds.add(str(row.id));
      }
    }
  }

  /**
   * ОТПРАВКА ЗАПУСКА вертикали (S2): настоящий статус кампаний у рассыльщика и
   * счётчики — из общего кэша (engCampaignStatus; живое чтение фоном, не чаще
   * раза в 5 минут на кампанию, только API кампаний, никогда LIST /emails), с
   * кнопкой Pause / Start sending / Resume карточки. Только us-проекты и только
   * запущенный шаблон этапа (engDashLaunchedTemplate — тот же выбор, что у
   * этапа). Сбой чтения — сводка без статуса ('unknown'), а не отказ агрегата.
   */
  const launchRefs: HeEngLaunchRef[] = [];
  const launchedTemplateByVertical = new Map<string, string>();
  for (const v of verticalRows) {
    const vid = v.id as string;
    if (!usProjectIds.has(str(v.project_id))) continue;
    const launched = engDashLaunchedTemplate(templateRows.filter((t) => t.vertical_id === vid));
    if (!launched) continue;
    launchedTemplateByVertical.set(vid, launched.templateId);
    launchRefs.push({ projectId: str(v.project_id), templateId: launched.templateId, launch: launched.launch });
  }
  const sendingByTemplate = await readHeEngSendingSummaries(supabaseAdmin, supabaseInstantly, {
    userId,
    launches: launchRefs,
    refresh: true,
    now: now.getTime(),
  });

  /**
   * ДОБОР ВЕРТИКАЛИ (S2): возьмёт ли её ближайшая ночь (deriveEngTopUpVerdict) —
   * по тем же данным, что у гейта ночи, без провайдера: желание клиента
   * (he_eng_launch_sending), запуск до self-serve (когда проекту отданы ящики
   * пула) и вердикт ОСНОВНОЙ кампании по кэшу статусов (readHeRefillMainVerdicts):
   * ночь решает она, а сводка `sending` говорит «отправляет хоть одна». Три
   * чтения БД на опрос и только при запусках; ни одно не бросает — несчитанное
   * становится 'unavailable', агрегат не падает. Наружу — только вердикт,
   * подробности гейта (русские строки для staff) не идут.
   */
  const topUpByTemplate = new Map<string, EngDashTopUp>();
  if (launchRefs.length > 0) {
    const [clientStates, mainVerdicts, assignedSince] = await Promise.all([
      readHeEngClientStates(supabaseAdmin, launchRefs.map((l) => l.templateId)),
      readHeRefillMainVerdicts(supabaseAdmin, launchRefs, now.getTime()),
      readHeEngPoolAssignedSince(supabaseAdmin, launchRefs.map((l) => l.projectId)),
    ]);
    for (const ref of launchRefs) {
      const summary = sendingByTemplate.get(ref.templateId);
      if (!summary) continue;
      topUpByTemplate.set(ref.templateId, {
        verdict: deriveEngTopUpVerdict({
          access: summary.access,
          readable: summary.readable,
          clientState: clientStates === null ? 'unreadable' : (clientStates.get(ref.templateId)?.state ?? null),
          preSelfServe:
            assignedSince === null ? 'unreadable' : heEngLaunchPredatesSelfServe(ref.launch, ref.projectId, assignedSince),
          main: !heRefillMainCampaignId(ref.launch)
            ? 'no_main'
            : mainVerdicts === null
              ? null
              : (mainVerdicts.get(ref.templateId)?.verdict ?? null),
        }),
        split: (ref.launch.campaigns?.length ?? 0) > 1,
      });
    }
  }

  /**
   * АВТОЗАПУСК (S3, engAutoLaunch): строка he_eng_auto_launch шаблона этапа
   * (запущенного или готового) и включён ли автозапуск проекта («Launch»
   * нажат). Только us-проекты, одно чтение пачкой; сбой или нет миграции —
   * ключ автозапуска null на всех карточках, подпись — без него.
   */
  const autoLaunchRead =
    usProjectIds.size > 0 ? await readHeEngAutoLaunchForProjects(supabaseAdmin, [...usProjectIds]) : null;
  /**
   * Выключатель отправки аккаунта — для строки 'waiting' без кода (тик рынок
   * ещё не пробовал): при 'not_enabled' или 'revoked' «sending starts
   * automatically shortly» неправда, и подпись говорит то же, что строка рынка
   * на шаге 3 (там тот же выключатель читает GET …/launch). Одно чтение без
   * записи и алерта, только когда автозапуск хоть одного проекта включён;
   * сбой чтения — поля нет, как у шага 3 при 'unknown'.
   */
  let accountAccess: 'not_enabled' | 'revoked' | undefined;
  if (autoLaunchRead && autoLaunchRead.wanted.size > 0) {
    const access = await readHeEngSendingAccess(supabaseAdmin, userId);
    if (access.state === 'not_enabled' || access.state === 'revoked') accountAccess = access.state;
  }

  const verticals = verticalRows
    .slice()
    .sort((a, b) => ts(a.created_at) - ts(b.created_at))
    .map((v) => {
      const vid = v.id as string;
      const project = projectById.get(v.project_id as string);
      const vBases = baseRows.filter((b) => b.vertical_id === vid);
      const vTemplates = templateRows.filter((t) => t.vertical_id === vid);
      const vChains = chainRows.filter((c) => c.vertical_id === vid);
      // Из полного списка, если кап пришлось дочитывать (liveJobRows выше).
      const vActiveJobs = (liveJobRows ?? activeJobRows).filter((j) => {
        const payload =
          j.payload && typeof j.payload === 'object'
            ? (j.payload as Record<string, unknown>)
            : {};
        if (str(payload.vertical_id) === vid) return true;
        const b = baseById.get(str(payload.base_id));
        return b ? b.vertical_id === vid : false;
      });
      const selection = selectionOf(vid);
      // Строка автозапуска шаблона этапа; у готового шаблона выбранной
      // вертикали проекта с нажатым «Launch» без строки — 'waiting' (тик её
      // ещё не взял), как в деталке проекта.
      // Строку пишет и кнопка «Launch now» (замок шаблона), поэтому строка сама
      // по себе ещё не значит «запустится само»: берём её, только когда
      // автозапуск проекта включён (тик ведёт лишь такие проекты) или запуск
      // идёт прямо сейчас — то же правило, что у карточки рынка на шаге 3.
      // Ещё 'done needs_support' — при любом автозапуске: у шаблона без записи
      // о запуске это «запись не легла», и шаг 3 тогда зовёт в Support, а не к
      // «Launch now» (кампании могли быть созданы).
      const autoTemplateId = launchedTemplateByVertical.get(vid) ?? engDashReadyTemplateId(vTemplates);
      const autoRowRaw = autoTemplateId && autoLaunchRead ? autoLaunchRead.rows.get(autoTemplateId) : undefined;
      const autoRow =
        autoRowRaw &&
        (autoRowRaw.state === 'running' ||
          (autoRowRaw.state === 'done' && autoRowRaw.code === 'needs_support') ||
          autoLaunchRead?.wanted.has(str(v.project_id)))
          ? autoRowRaw
          : undefined;
      const autoLaunchRaw: EngDashAutoLaunch | null = autoRow
        ? { state: autoRow.state, code: autoRow.code }
        : autoLaunchRead &&
            autoTemplateId &&
            !launchedTemplateByVertical.has(vid) &&
            selection === 'selected' &&
            autoLaunchRead.wanted.has(str(v.project_id))
          ? { state: 'waiting', code: null }
          : null;
      // 'waiting' без кода: выключатель аккаунта и «дольше обычного» — как у
      // строки рынка на шаге 3 (её отсчёт — от даты строки, у синтетической —
      // от даты шаблона, как в деталке проекта).
      const autoSince = autoRow
        ? autoRow.created_at
        : str(vTemplates.find((t) => str(t.id) === autoTemplateId)?.created_at);
      const autoSinceMs = Date.parse(autoSince);
      // 'running', аренду которой никто не держит (попытка брошена): то же
      // `stale`, что у строки рынка на шаге 3 (деталка проекта), — там тогда
      // стоит «Launch now», а не вечное «starting sending…».
      const autoLaunch: EngDashAutoLaunch | null =
        autoLaunchRaw && autoLaunchRaw.state === 'waiting' && autoLaunchRaw.code === null
          ? {
              ...autoLaunchRaw,
              ...(accountAccess ? { access: accountAccess } : {}),
              ...(Number.isFinite(autoSinceMs) && now.getTime() - autoSinceMs > HE_ENG_AUTO_LAUNCH_STALE_MS
                ? { stale: true }
                : {}),
            }
          : autoLaunchRaw && autoRow && heEngAutoLaunchLeaseExpired(autoRow, now.getTime())
            ? { ...autoLaunchRaw, stale: true }
            : autoLaunchRaw;

      const derived = deriveEngVerticalStage({
        projectStatus: str(project?.status),
        // Код причины — только у упавшего проекта: у живого колонка error может
        // хранить прошлый сбой, а этап 'attention' читает его лишь при 'failed'.
        projectErrorCode:
          str(project?.status) === 'failed'
            ? toClientEngStageErrorCode((project as { error?: unknown } | undefined)?.error)
            : null,
        chains: vChains,
        bases: vBases,
        templates: vTemplates,
        activeJobs: vActiveJobs,
        liveWorkUnknown: liveJobRows === null,
        // Без полного списка активных джоб живость не проверялась — поля нет.
        ...(liveJobRows !== null ? { stalledAnalysis } : {}),
        selection,
        rewriteTemplateIds,
        autoLaunch,
        // Не прочитан — поля нет: подпись этапа 'letters' ничего не обещает.
        ...(autopilotByProjectId !== null ? { autopilot: autopilotByProjectId.get(v.project_id as string) === true } : {}),
        // Не прочитано — поля нет, и `requeues` ложно (не доказано).
        ...(spendPausedProjectIds !== null
          ? { spendPaused: spendPausedProjectIds.has(v.project_id as string) }
          : {}),
      });

      const launchedTemplateId = launchedTemplateByVertical.get(vid);
      const sending = launchedTemplateId ? (sendingByTemplate.get(launchedTemplateId) ?? null) : null;
      // Пятая точка — «кампания отправляет»: только по прочитанному статусу.
      const dots = [...derived.dots] as typeof derived.dots;
      dots[4] = derived.stage === 'launched' && sending?.state === 'sending';

      const mainInfo =
        derived.mainBase?.collect_info && typeof derived.mainBase.collect_info === 'object'
          ? (derived.mainBase.collect_info as Record<string, unknown>)
          : {};
      const construct =
        mainInfo.construct && typeof mainInfo.construct === 'object'
          ? (mainInfo.construct as Record<string, unknown>)
          : null;

      return {
        id: vid,
        project_id: v.project_id,
        name: v.name,
        stage: derived.stage,
        stageDetail: derived.stageDetail,
        dots,
        stats: {
          // КОМПАНИИ и СТРОКИ — разные числа, и раньше в обоих полях лежало
          // одно: `row_count`. Теперь `companies` — только счётчик стадии
          // (companiesTotalOf; 0 = не знаем, карточка подпись прячет), а
          // `rows` — то самое число строк, которое печатает шаг 4 мастера
          // («N rows») и подпись этапа 'analyzed' (engDashboard.ts).
          companies: companiesByBaseId.get(str(derived.mainBase?.id)) ?? 0,
          rows: num(derived.mainBase?.row_count),
          // Адреса, не компании: emails_found — найдено конструктором,
          // valid_count — из них с вердиктом 'ok' (collect_info.construct).
          emails_found: num(construct?.emails_found),
          valid_count: num(construct?.valid_count),
          appended_today: appendedTodayByVertical.get(vid) ?? 0,
          leads_launched: derived.launch?.leads_count ?? 0,
        },
        // campaign_url не отдаём: это ссылка вида
        // `https://app.instantly.ai/app/campaign/<id>` — домен рассыльщика и
        // его id кампании в payload'е white-label кабинета. Карточка рисует
        // только имя кампании (EngDashboard: vertical.launch?.campaign_name),
        // ссылок наружу в кабинете нет.
        launch: derived.launch ? { campaign_name: derived.launch.campaign_name } : null,
        // Прогноз vs факт (петля actualsReconcile, 24ч свежесть). Имя поля
        // прежнее, но это оценка модели 0–100 (potential_pct), а не прогноз
        // доли ответов: карточка подписывает её «market fit» (EngDashboard.tsx).
        // Только у ВЫБРАННОЙ вертикали: пересчёт разметки (reviewRecompute)
        // пишет 0, когда все гипотезы отклонены, и «market fit 0/100 — a model
        // score» был бы неправдой; невыбранная вертикаль в работу не идёт, а выбор
        // не прочитан — оценку не печатаем вовсе.
        forecast: selection === 'selected' && typeof v.potential_pct === 'number' ? { pct: v.potential_pct } : null,
        actual:
          typeof v.actual_reply_pct === 'number'
            ? {
                reply_pct: v.actual_reply_pct,
                sent: num(v.actual_sent),
                measured_at: str(v.actual_measured_at),
              }
            : null,
        refill_dry: dryVerticalIds.has(vid),
        // Письма шаблона этапа ('template' / 'launch_unfinished') запуск
        // откажет — карточка пишет «letters need rewriting» вместо «ready to
        // launch» / «finish the launch» (EngDashboard.tsx).
        letters_need_rewrite: derived.lettersNeedRewrite,
        // Письма сняты «Rewrite letters», новых нет (EngDashStageInfo.lettersRetired):
        // карточка зовёт на шаг 3 («Rewrite letters» или Support), а не ждёт шаблона.
        letters_retired: derived.lettersRetired === true,
        // Автопилот проекта; null — не прочитан. Строка «next» карточки зовёт к
        // «Launch», когда он выключен (следующую стадию никто не поставит).
        autopilot: autopilotByProjectId ? (autopilotByProjectId.get(v.project_id as string) ?? null) : null,
        // Записанная пауза по потолку расхода у проекта ('spend_paused'); null —
        // паузы не прочитаны. Строка «next» карточки тогда не зовёт к «Launch»:
        // реконсилер встаёт на потолке и ничего платного не ставит.
        spend_paused: spendPausedProjectIds ? spendPausedProjectIds.has(v.project_id as string) : null,
        // Этап 'attention': причина и код (машинный код словаря кабинета, без
        // сырого текста стадии). У остальных этапов — null.
        attention: derived.attention,
        // Выбор вертикали клиентом (EngDashSelection); null — не прочитан.
        selection: selection ?? null,
        // Отправка запущенного шаблона (HeEngSendingSummary: состояние,
        // счётчики, кнопка); null — запуска нет. Шаблон — только id для
        // кнопки (POST /eng/templates/[id]/sending); id кампаний наружу не идут.
        sending,
        sending_template_id: sending ? (launchedTemplateId ?? null) : null,
        // Автозапуск шаблона этапа (EngDashAutoLaunch: состояние и код); null —
        // не назначен или не прочитан. Счётчики и аренда наружу не идут.
        auto_launch: autoLaunch,
        auto_launch_template_id: autoLaunch ? (autoTemplateId ?? null) : null,
        // Возьмёт ли вертикаль ближайшая ночь добора (EngDashTopUp); null — запуска нет.
        top_up: launchedTemplateId ? (topUpByTemplate.get(launchedTemplateId) ?? null) : null,
      };
    });

  /**
   * ПАУЗА НОЧНОГО ДОБОРА — ОТДЕЛЬНЫМ ЗАПРОСОМ И BEST-EFFORT, тем же приёмом и
   * по той же причине, что `autopilot_error` выше: `refill_paused_at`
   * появляется миграцией 20260930_0005, а на установке без неё PostgREST
   * отвечает 42703 на ВЕСЬ `select` — дописать колонку к выборке конфигов
   * значило бы положить весь Command Center до применения миграции.
   *
   * ДЕФОЛТ ЗДЕСЬ — «паузы нет», и в отличие от автопилотного блока это не
   * выдуманное состояние, а прочитанный факт: без колонки механизма паузы нет
   * ни у кабинета, ни у ночного тика (`loadConfigs` читает её так же
   * опционально и при 42703 повторяет запрос без неё), то есть ночь сборку
   * поставит и «next run» — правда.
   * Худший случай — колонка ЕСТЬ, а этот один запрос сорвался: тогда кабинет
   * покажет «next run» проекту, который ночь пропустит, ровно до следующего
   * полла (15 с). Обратное поведение — печатать паузу, которой мы не прочитали,
   * — врало бы столько же, но в сторону «у вас всё встало», и самопроизвольно
   * не чинилось бы.
   *
   * Запрос идёт ТОЛЬКО когда у клиента есть хотя бы один включённый конфиг: в
   * production `he_auto_pipeline_configs` пуста, и лишнего похода в БД на
   * 15-секундном полле у подавляющего большинства кабинетов не будет вовсе.
   * Капа у запроса нет и не нужно: `project_id` у таблицы уникален
   * (20260804_0005), а сам список проектов уже ограничен сотней строк выше —
   * больше сотни строк отсюда не приедет.
   *
   * `refill_pause_reason` ЧИТАЕТСЯ, НО НАРУЖУ НЕ УХОДИТ. Это русский текст для
   * сотрудника с именем рассыльщика (у потолка расхода — с суммами и
   * порогом); кабинету из него нужен только повод — пауза записана отменой
   * клиентом, потолком расхода или ёмкостью (у каждого своя правдивая фраза,
   * см. HeClientRefillState: `stopped` / `spend_paused` / `paused`). Повод
   * различает проекция (toClientEngRefillState), в ответ уезжает только
   * состояние; сам текст живёт в этой функции и дальше карты не идёт. Колонка из той же миграции 20260930_0005, что и штамп:
   * без миграции запрос отказывает целиком, и дашборд ведёт себя как раньше
   * («паузы нет», см. выше).
   */
  const enabledConfigs = configRows.filter((c) => c.enabled === true);
  const refillPauseByProjectId = new Map<string, { pausedAt: string; reason: string | null }>();
  if (enabledConfigs.length > 0) {
    const pauseRes = await supabaseAdmin
      .from('he_auto_pipeline_configs')
      .select('project_id, refill_paused_at, refill_pause_reason')
      .in('project_id', projectIds);
    if (!pauseRes.error) {
      for (const raw of pauseRes.data ?? []) {
        const row = raw as Record<string, unknown>;
        const pid = str(row.project_id);
        const pausedAt = str(row.refill_paused_at);
        const reason = str(row.refill_pause_reason);
        if (pid && pausedAt) refillPauseByProjectId.set(pid, { pausedAt, reason: reason || null });
      }
    }
  }
  const refillStateByProjectId = new Map<string, HeClientRefillState>(
    configRows.map((c) => {
      const pid = str((c as Record<string, unknown>).project_id);
      const pause = refillPauseByProjectId.get(pid);
      // Строка конфига как есть плюс две колонки паузы, которые пришлось
      // читать отдельно, — решение о состоянии принимает проекция.
      return [
        pid,
        toClientEngRefillState({
          ...(c as Record<string, unknown>),
          refill_paused_at: pause?.pausedAt ?? null,
          refill_pause_reason: pause?.reason ?? null,
        }),
      ];
    }),
  );
  /**
   * Агрегат добора по ВСЕМ проектам клиента: счётчики состояний кабинет
   * считает сам по `projects[].refill` — второго источника той же правды
   * здесь нет намеренно.
   *
   * `daily_cap` СУММИРУЕТСЯ ТОЛЬКО ПО ИДУЩИМ проектам. Кап — обещание про
   * ближайшую ночь («daily cap N» рядом с обратным отсчётом), а проект на
   * паузе или остановленный отменой (`paused` / `spend_paused` / `stopped`) в
   * эту ночь не возьмёт ни одного лида: включать его кап в сумму значило бы
   * назвать число, которого сегодня не будет.
   */
  const autoRefill = {
    next_run_at: nextDailyRunIso(now),
    daily_cap: enabledConfigs.reduce(
      (acc, c) =>
        refillStateByProjectId.get(str((c as Record<string, unknown>).project_id)) === 'running'
          ? acc + num(c.daily_leads_cap)
          : acc,
      0,
    ),
  };

  const events = buildEngDashboardEvents({
    jobs: finishedJobRows,
    bases: baseRows,
    templates: templateRows,
    runs: runRows,
    verticalNames,
  });

  // «Сейчас работает»: активные джобы, свежие первыми; вертикаль выводим из
  // payload (vertical_id напрямую, либо base_id → база → вертикаль).
  const activeJobs = activeJobRows
    .slice()
    .sort((a, b) => ts(b.updated_at) - ts(a.updated_at))
    .map((j) => {
      const payload =
        j.payload && typeof j.payload === 'object' ? (j.payload as Record<string, unknown>) : {};
      const direct = str(payload.vertical_id);
      const viaBase = baseById.get(str(payload.base_id));
      const progress =
        j.progress && typeof j.progress === 'object'
          ? (j.progress as Record<string, unknown>)
          : null;
      return {
        id: j.id,
        project_id: j.project_id,
        stage: j.stage,
        status: j.status,
        vertical_id: direct || (viaBase ? str(viaBase.vertical_id) : null),
        // Подпись прогресса — только из карты проекции: строки `he_jobs`,
        // записанные до рыночного гейта в стадиях, несут русский текст, а
        // блок «Right now» печатает подпись как есть (EngDashboard.tsx:472-473).
        progress: progress
          ? {
              done: num(progress.done),
              total: num(progress.total),
              label: toClientEngJobProgressLabel(progress.label),
            }
          : null,
      };
    });

  return NextResponse.json({
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      autopilot_hold: autopilotHoldByProjectId.get(p.id as string) ?? null,
      // Состояние ночного добора ПРОЕКТА, а не аккаунта: карточки вертикалей
      // печатают «next: daily refill …» по своему проекту (у вертикали есть
      // project_id), и у клиента с двумя проектами — один на паузе, второй
      // идёт — обе фразы теперь верны каждая про своё.
      refill: refillStateByProjectId.get(p.id as string) ?? 'off',
    })),
    verticals,
    today,
    autoRefill,
    events,
    activeJobs,
  });
}
