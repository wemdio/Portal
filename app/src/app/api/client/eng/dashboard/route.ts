import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { stripTaskHarvest } from '@/lib/hypothesisEngine/projectDetail';
import {
  toClientEngAutopilotHold,
  toClientEngCampaignName,
  toClientEngCollectInfo,
  toClientEngJobProgressLabel,
  type ClientEngAutopilotHold,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { reconcileProjectVerticals } from '@/lib/hypothesisEngine/actualsReconcile';
import {
  buildEngDashboardEvents,
  deriveEngVerticalStage,
  nextDailyRunIso,
  utcDayStartIso,
} from '@/lib/hypothesisEngine/engDashboard';
import { engServerError } from '../_shared';

export const dynamic = 'force-dynamic';

/** Дашборд поллится каждые 15 с — один текст на все сбои сборки агрегата. */
const DASHBOARD_LOAD_FAILED = 'Failed to load the dashboard';

/**
 * GET — агрегат ENG Command Center (кабинет /client/eng/dashboard): общий
 * экран по ВСЕМ своим ENG-проектам (created_by = user id).
 *
 * Один ответ без N+1: проекты → волна батч-запросов по project_id
 * (verticals/bases/jobs/configs/runs) → вторая волна по vertical_id
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
 * Имя кампании чистится на ВХОДЕ в склейку, а не в трёх местах на выходе:
 * из `launch_info.campaign_name` оно расходится по дашборду тремя путями —
 * `stageDetail` («live: <имя>», engDashboard.ts:156-158), карточка Launch
 * (`launch.campaign_name` ниже) и лента активности («campaign launched
 * (paused): <имя>», engDashboard.ts:366). У запусков до этой волны в имени
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
    .select('id, name, status, created_at')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (projErr) return engServerError('client.eng.dashboard.projects_failed', projErr, DASHBOARD_LOAD_FAILED, { userId });

  const projectRows = projects ?? [];
  const emptyAggregate = {
    projects: projectRows.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    verticals: [] as unknown[],
    today: { appended: 0, valid: 0, collected: 0, collected_companies: 0 },
    autoRefill: { enabled: false, next_run_at: nextDailyRunIso(now), daily_cap: 0 },
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
  const [verticalsRes, basesRes, activeJobsRes, finishedJobsRes, configsRes, runsRes] =
    await Promise.all([
      supabaseAdmin
        .from('he_verticals')
        .select('id, project_id, name, created_at, potential_pct, actual_reply_pct, actual_sent, actual_measured_at')
        .in('project_id', projectIds),
      supabaseAdmin
        .from('he_bases')
        .select('id, project_id, vertical_id, status, source, row_count, collect_info, created_at, updated_at')
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
    ]);
  for (const res of [verticalsRes, basesRes, activeJobsRes, finishedJobsRes, configsRes, runsRes]) {
    if (res.error) {
      return engServerError('client.eng.dashboard.aggregate_failed', res.error, DASHBOARD_LOAD_FAILED, { userId });
    }
  }

  const verticalRows = verticalsRes.data ?? [];
  const verticalIds = verticalRows.map((v) => v.id as string);
  // collect_info: harvest (до limit строк на задачу, задач в плане 1–4) режет
  // stripTaskHarvest. Снять его с ЭТОГО маршрута нельзя, хотя терминальная
  // запись стадии харвест больше не сохраняет (dropCollectWorkState в
  // stages/baseCollect): дашборд рисует прогресс ИДУЩЕЙ сборки, а у неё харвест
  // в collect_info лежит по построению — это чекпойнт мёрджа между тиками.
  // Всё остальное — клиентская проекция (план сорсинга с pdl_filters, id джоб
  // конструктора и состояние долива дашборду не нужны и клиенту не полагаются).
  // toClientEngBase здесь НЕ годится: дашборду нужны project_id/updated_at,
  // которых нет в белом списке мастера.
  const baseRows = (basesRes.data ?? []).map((b) => {
    const row = stripTaskHarvest(b as Record<string, unknown>);
    const info = row.collect_info;
    if (info && typeof info === 'object' && !Array.isArray(info)) {
      return { ...row, collect_info: toClientEngCollectInfo(info as Record<string, unknown>) };
    }
    return row;
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
  const holdsRes = await supabaseAdmin
    .from('he_projects')
    .select('id, autopilot, autopilot_error, autopilot_error_at')
    .in('id', projectIds);
  if (!holdsRes.error) {
    for (const raw of holdsRes.data ?? []) {
      const row = raw as Record<string, unknown>;
      const pid = str(row.id);
      if (!pid) continue;
      // Пауза — факт автопилота: у ручного прогона координатор ничего не ставит.
      if (row.autopilot !== true) continue;
      const hold = toClientEngAutopilotHold(row);
      if (hold) autopilotHoldByProjectId.set(pid, hold);
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
   *    у компании с пятью адресами строк пять — компаниями это число не
   *    является, и карточка «Collected today» печатает его как строки.
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

  const verticals = verticalRows
    .slice()
    .sort((a, b) => ts(a.created_at) - ts(b.created_at))
    .map((v) => {
      const vid = v.id as string;
      const project = projectById.get(v.project_id as string);
      const vBases = baseRows.filter((b) => b.vertical_id === vid);
      const vTemplates = templateRows.filter((t) => t.vertical_id === vid);
      const vChains = chainRows.filter((c) => c.vertical_id === vid);
      const vActiveJobs = activeJobRows.filter((j) => {
        const payload =
          j.payload && typeof j.payload === 'object'
            ? (j.payload as Record<string, unknown>)
            : {};
        if (str(payload.vertical_id) === vid) return true;
        const b = baseById.get(str(payload.base_id));
        return b ? b.vertical_id === vid : false;
      });

      const derived = deriveEngVerticalStage({
        projectStatus: str(project?.status),
        chains: vChains,
        bases: vBases,
        templates: vTemplates,
        activeJobs: vActiveJobs,
      });

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
        dots: derived.dots,
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
        // Прогноз vs факт (петля actualsReconcile, 24ч свежесть).
        forecast: typeof v.potential_pct === 'number' ? { pct: v.potential_pct } : null,
        actual:
          typeof v.actual_reply_pct === 'number'
            ? {
                reply_pct: v.actual_reply_pct,
                sent: num(v.actual_sent),
                measured_at: str(v.actual_measured_at),
              }
            : null,
      };
    });

  const enabledConfigs = configRows.filter((c) => c.enabled === true);
  const autoRefill = {
    enabled: enabledConfigs.length > 0,
    next_run_at: nextDailyRunIso(now),
    daily_cap: enabledConfigs.reduce((acc, c) => acc + num(c.daily_leads_cap), 0),
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
    })),
    verticals,
    today,
    autoRefill,
    events,
    activeJobs,
  });
}
