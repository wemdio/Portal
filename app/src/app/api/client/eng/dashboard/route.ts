import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { stripTaskHarvest } from '@/lib/hypothesisEngine/projectDetail';
import { reconcileProjectVerticals } from '@/lib/hypothesisEngine/actualsReconcile';
import {
  buildEngDashboardEvents,
  deriveEngVerticalStage,
  nextDailyRunIso,
  utcDayStartIso,
} from '@/lib/hypothesisEngine/engDashboard';

export const dynamic = 'force-dynamic';

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

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
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
  if (projErr) return jsonError(projErr.message, 500);

  const projectRows = projects ?? [];
  const emptyAggregate = {
    projects: projectRows.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    verticals: [] as unknown[],
    today: { appended: 0, valid: 0, collected: 0 },
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
    if (res.error) return jsonError(res.error.message, 500);
  }

  const verticalRows = verticalsRes.data ?? [];
  const verticalIds = verticalRows.map((v) => v.id as string);
  // collect_info.tasks[].harvest (до 50k строк на задачу) — рабочее состояние
  // воркера, дашборду не нужно: вырезаем, как деталка проекта.
  const baseRows = (basesRes.data ?? []).map((b) =>
    stripTaskHarvest(b as Record<string, unknown>),
  );
  const activeJobRows = activeJobsRes.data ?? [];
  const finishedJobRows = finishedJobsRes.data ?? [];
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
    if (chainsRes.error) return jsonError(chainsRes.error.message, 500);
    if (templatesRes.error) return jsonError(templatesRes.error.message, 500);
    chainRows = chainsRes.data ?? [];
    templateRows = templatesRes.data ?? [];
  }

  const projectById = new Map(projectRows.map((p) => [p.id as string, p]));
  const verticalNames = new Map(verticalRows.map((v) => [v.id as string, str(v.name)]));
  const baseById = new Map(baseRows.map((b) => [str(b.id), b]));

  // today-суммы: прогоны, созданные в текущих UTC-сутках (крон ставит их в
  // 03:20, долив завершается тем же днём; stats {} у ещё идущих — нули).
  const todayRuns = runRows.filter((r) => ts(r.created_at) >= todayStartTs);
  const today = { appended: 0, valid: 0, collected: 0 };
  const appendedTodayByVertical = new Map<string, number>();
  for (const r of todayRuns) {
    const stats =
      r.stats && typeof r.stats === 'object' ? (r.stats as Record<string, unknown>) : {};
    const appended = num(stats.appended);
    today.appended += appended;
    today.valid += num(stats.valid);
    today.collected += num(stats.collected);
    const vid = str(r.vertical_id);
    if (vid) appendedTodayByVertical.set(vid, (appendedTodayByVertical.get(vid) ?? 0) + appended);
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
          companies: num(derived.mainBase?.row_count),
          emails_found: num(construct?.emails_found),
          valid_count: num(construct?.valid_count),
          appended_today: appendedTodayByVertical.get(vid) ?? 0,
          leads_launched: derived.launch?.leads_count ?? 0,
        },
        launch: derived.launch
          ? {
              campaign_url: derived.launch.campaign_url,
              campaign_name: derived.launch.campaign_name,
            }
          : null,
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
        progress: progress
          ? { done: num(progress.done), total: num(progress.total), label: str(progress.label) }
          : null,
      };
    });

  return NextResponse.json({
    projects: projectRows.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    verticals,
    today,
    autoRefill,
    events,
    activeJobs,
  });
}
