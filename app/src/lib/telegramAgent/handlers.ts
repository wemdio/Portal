import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ToolHandler } from './types';

function ensureAdmin() {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');
  return supabaseAdmin;
}

function toJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

const getProjects: ToolHandler = async (params) => {
  const sb = ensureAdmin();
  let query = sb
    .from('projects')
    .select('id, client, name, status, manager, specialist, deadline, kpi_plan, kpi_fact, contacts_obligation, contacts_done, budget, margin');

  if (params.status) query = query.eq('status', params.status as string);
  if (params.manager) query = query.ilike('manager', `%${params.manager}%`);
  if (params.specialist) query = query.ilike('specialist', `%${params.specialist}%`);

  query = query.order('created_at', { ascending: false }).limit((params.limit as number) ?? 20);

  const { data, error } = await query;
  if (error) return `Ошибка: ${error.message}`;
  if (!data?.length) return 'Проекты не найдены.';
  return toJson(data);
};

const getProjectDetail: ToolHandler = async (params) => {
  const sb = ensureAdmin();
  let query = sb.from('projects').select('*');

  if (params.id) {
    query = query.eq('id', params.id as string);
  } else if (params.client) {
    query = query.ilike('client', `%${params.client}%`);
  } else {
    return 'Укажите id или client для поиска проекта.';
  }

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) return `Ошибка: ${error.message}`;
  if (!data) return 'Проект не найден.';
  return toJson(data);
};

const getOverdueProjects: ToolHandler = async (params) => {
  const sb = ensureAdmin();
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await sb
    .from('projects')
    .select('id, client, name, status, manager, specialist, deadline, kpi_plan, kpi_fact')
    .lt('deadline', today)
    .not('status', 'in', '("Завершен","Отменен")')
    .not('deadline', 'is', null)
    .order('deadline', { ascending: true })
    .limit((params.limit as number) ?? 50);

  if (error) return `Ошибка: ${error.message}`;
  if (!data?.length) return 'Просроченных проектов нет.';
  return toJson(data);
};

const getKpiSummary: ToolHandler = async (params) => {
  const sb = ensureAdmin();
  const groupBy = (params.group_by as string) || 'manager';

  const { data, error } = await sb
    .from('projects')
    .select('manager, specialist, kpi_plan, kpi_fact, status')
    .in('status', ['В работе', 'Тестирование']);

  if (error) return `Ошибка: ${error.message}`;
  if (!data?.length) return 'Нет проектов в работе/тестировании.';

  type KpiRow = { manager: string | null; specialist: string | null; kpi_plan: number | null; kpi_fact: number | null };
  const groups: Record<string, { plan: number; fact: number; count: number }> = {};
  for (const row of data as KpiRow[]) {
    const key = (groupBy === 'specialist' ? row.specialist : row.manager) || 'Не указано';
    if (!groups[key]) groups[key] = { plan: 0, fact: 0, count: 0 };
    groups[key].plan += row.kpi_plan ?? 0;
    groups[key].fact += row.kpi_fact ?? 0;
    groups[key].count += 1;
  }

  const result = Object.entries(groups).map(([name, g]) => ({
    [groupBy]: name,
    projects: g.count,
    kpi_plan_total: g.plan,
    kpi_fact_total: g.fact,
    completion_percent: g.plan > 0 ? Math.round((g.fact / g.plan) * 100) : 0,
  }));

  return toJson(result);
};

const getTasks: ToolHandler = async (params) => {
  const sb = ensureAdmin();
  let query = sb
    .from('tasks')
    .select('id, title, status, specialist, project_id, created_at, updated_at');

  if (params.specialist) query = query.ilike('specialist', `%${params.specialist}%`);
  if (params.status) query = query.eq('status', params.status as string);
  if (params.project_id) query = query.eq('project_id', params.project_id as string);

  query = query.order('created_at', { ascending: false }).limit((params.limit as number) ?? 20);

  const { data, error } = await query;
  if (error) return `Ошибка: ${error.message}`;
  if (!data?.length) return 'Задачи не найдены.';
  return toJson(data);
};

const getTaskBoardSummary: ToolHandler = async () => {
  const sb = ensureAdmin();

  const [boardsRes, columnsRes, tasksRes] = await Promise.all([
    sb.from('task_boards').select('id, name').order('position', { ascending: true }),
    sb.from('task_board_columns').select('id, board_id, title, status').order('position', { ascending: true }),
    sb.from('tasks').select('id, column_id'),
  ]);

  if (boardsRes.error || columnsRes.error || tasksRes.error) {
    return `Ошибка: ${boardsRes.error?.message ?? columnsRes.error?.message ?? tasksRes.error?.message}`;
  }

  const taskCounts: Record<string, number> = {};
  for (const task of tasksRes.data ?? []) {
    const colId = task.column_id as string;
    taskCounts[colId] = (taskCounts[colId] ?? 0) + 1;
  }

  const boards = (boardsRes.data ?? []).map((board) => ({
    board: board.name,
    columns: (columnsRes.data ?? [])
      .filter((col) => col.board_id === board.id)
      .map((col) => ({
        column: col.title,
        status: col.status,
        task_count: taskCounts[col.id] ?? 0,
      })),
  }));

  return toJson(boards);
};

const getParserJobs: ToolHandler = async (params) => {
  const sb = ensureAdmin();
  const parserType = params.parser_type as string | undefined;
  const limit = (params.limit as number) ?? 10;

  type JobRow = { id: string; status: string; created_at: string; [k: string]: unknown };
  const results: { type: string; jobs: JobRow[] }[] = [];
  const types = parserType ? [parserType] : ['hh', 'search', 'yandex_maps'];

  for (const pType of types) {
    if (pType === 'hh') {
      const { data } = await sb.from('parser_jobs')
        .select('id, status, config, total_found, total_parsed, progress_percent, created_at, completed_at, error_message')
        .eq('parser_type', 'hh_vacancies')
        .order('created_at', { ascending: false })
        .limit(limit);
      results.push({ type: 'hh', jobs: (data ?? []) as JobRow[] });
    } else if (pType === 'search') {
      const { data } = await sb.from('search_parser_jobs')
        .select('id, status, config, total_queries, processed_queries, total_results, created_at, completed_at, error_message')
        .order('created_at', { ascending: false })
        .limit(limit);
      results.push({ type: 'search', jobs: (data ?? []) as JobRow[] });
    } else if (pType === 'yandex_maps') {
      const { data } = await sb.from('yandex_maps_jobs')
        .select('id, status, config, total_links, processed_links, total_organizations, created_at, completed_at, error_message')
        .order('created_at', { ascending: false })
        .limit(limit);
      results.push({ type: 'yandex_maps', jobs: (data ?? []) as JobRow[] });
    }
  }

  if (results.every((r) => r.jobs.length === 0)) return 'Парсер-задач не найдено.';
  return toJson(results);
};

const getParserResultsSummary: ToolHandler = async (params) => {
  const sb = ensureAdmin();
  const jobId = params.job_id as string;
  const parserType = params.parser_type as string;

  if (!jobId || !parserType) return 'Нужно указать job_id и parser_type.';

  if (parserType === 'hh') {
    const { data, error } = await sb.from('hh_vacancies')
      .select('id, name, company_name, area, salary_from, salary_to')
      .eq('job_id', jobId)
      .limit(10);
    if (error) return `Ошибка: ${error.message}`;
    const { count } = await sb.from('hh_vacancies').select('id', { count: 'exact', head: true }).eq('job_id', jobId);
    return toJson({ total: count ?? data?.length ?? 0, sample: data ?? [] });
  }

  if (parserType === 'search') {
    const { data, error } = await sb.from('search_results')
      .select('id, query, title, link, snippet')
      .eq('job_id', jobId)
      .limit(10);
    if (error) return `Ошибка: ${error.message}`;
    const { count } = await sb.from('search_results').select('id', { count: 'exact', head: true }).eq('job_id', jobId);
    return toJson({ total: count ?? data?.length ?? 0, sample: data ?? [] });
  }

  if (parserType === 'yandex_maps') {
    const { data, error } = await sb.from('yandex_maps_organizations')
      .select('id, name, city, email, phone, website, rating')
      .eq('job_id', jobId)
      .limit(10);
    if (error) return `Ошибка: ${error.message}`;
    const { count } = await sb.from('yandex_maps_organizations').select('id', { count: 'exact', head: true }).eq('job_id', jobId);
    return toJson({ total: count ?? data?.length ?? 0, sample: data ?? [] });
  }

  return `Неизвестный тип парсера: ${parserType}`;
};

const getInstantlyCampaigns: ToolHandler = async () => {
  const apiKey = process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '';
  if (!apiKey) return 'Instantly API key не настроен.';

  try {
    const res = await fetch(`https://api.instantly.ai/api/v2/campaigns?limit=100`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return `Instantly API ошибка: ${res.status}`;
    const data = await res.json();
    const items = (data as { items?: unknown[] })?.items ?? data;
    return toJson(items);
  } catch (err) {
    return `Ошибка при запросе к Instantly: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
};

const getReviewRequests: ToolHandler = async (params) => {
  const sb = ensureAdmin();
  let query = sb
    .from('database_review_requests')
    .select('id, tab_name, project_id, status, specialist_comment, reviewer_comment, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit((params.limit as number) ?? 20);

  if (params.status) query = query.eq('status', params.status as string);

  const { data, error } = await query;
  if (error) return `Ошибка: ${error.message}`;
  if (!data?.length) return 'Ревью-запросов не найдено.';
  return toJson(data);
};

const getTeamWorkload: ToolHandler = async () => {
  const sb = ensureAdmin();

  const [projRes, taskRes] = await Promise.all([
    sb.from('projects').select('id, specialist, manager, status, deadline').in('status', ['В работе', 'Тестирование', 'На паузе', 'Подготовка']),
    sb.from('tasks').select('id, specialist, status'),
  ]);

  if (projRes.error || taskRes.error) {
    return `Ошибка: ${projRes.error?.message ?? taskRes.error?.message}`;
  }

  const today = new Date().toISOString().split('T')[0];
  const people: Record<string, { projects: number; overdue: number; tasks_pending: number; tasks_in_progress: number; tasks_done: number }> = {};

  function ensure(name: string) {
    if (!name) return;
    if (!people[name]) people[name] = { projects: 0, overdue: 0, tasks_pending: 0, tasks_in_progress: 0, tasks_done: 0 };
  }

  for (const p of projRes.data ?? []) {
    const spec = p.specialist as string;
    if (spec) {
      ensure(spec);
      people[spec].projects += 1;
      if (p.deadline && (p.deadline as string) < today) people[spec].overdue += 1;
    }
  }

  for (const t of taskRes.data ?? []) {
    const spec = t.specialist as string;
    if (spec) {
      ensure(spec);
      const status = t.status as string;
      if (status === 'pending') people[spec].tasks_pending += 1;
      else if (status === 'in_progress') people[spec].tasks_in_progress += 1;
      else if (status === 'done') people[spec].tasks_done += 1;
    }
  }

  const result = Object.entries(people)
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.projects - a.projects);

  return toJson(result);
};

const getWeeklySummary: ToolHandler = async () => {
  const sb = ensureAdmin();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [allProjects, recentProjects, parserJobs, searchJobs, ymJobs] = await Promise.all([
    sb.from('projects').select('id, status, kpi_plan, kpi_fact').in('status', ['В работе', 'Тестирование']),
    sb.from('projects').select('id, status, created_at').gte('created_at', weekAgo),
    sb.from('parser_jobs').select('id, status').gte('created_at', weekAgo),
    sb.from('search_parser_jobs').select('id, status').gte('created_at', weekAgo),
    sb.from('yandex_maps_jobs').select('id, status').gte('created_at', weekAgo),
  ]);

  const active = allProjects.data ?? [];
  const recent = recentProjects.data ?? [];

  const newProjects = recent.filter((p) => p.status !== 'Завершен' && p.status !== 'Отменен').length;
  const completedProjects = recent.filter((p) => p.status === 'Завершен').length;

  let totalPlan = 0;
  let totalFact = 0;
  for (const p of active) {
    totalPlan += (p.kpi_plan as number) ?? 0;
    totalFact += (p.kpi_fact as number) ?? 0;
  }

  const allJobs = [...(parserJobs.data ?? []), ...(searchJobs.data ?? []), ...(ymJobs.data ?? [])];
  const parsersTotal = allJobs.length;
  const parsersCompleted = allJobs.filter((j) => j.status === 'completed').length;
  const parsersFailed = allJobs.filter((j) => j.status === 'failed').length;

  return toJson({
    active_projects: active.length,
    new_projects_this_week: newProjects,
    completed_this_week: completedProjects,
    kpi_plan_total: totalPlan,
    kpi_fact_total: totalFact,
    kpi_completion_percent: totalPlan > 0 ? Math.round((totalFact / totalPlan) * 100) : 0,
    parsers_launched_this_week: parsersTotal,
    parsers_completed: parsersCompleted,
    parsers_failed: parsersFailed,
  });
};

export const toolHandlers: Record<string, ToolHandler> = {
  get_projects: getProjects,
  get_project_detail: getProjectDetail,
  get_overdue_projects: getOverdueProjects,
  get_kpi_summary: getKpiSummary,
  get_tasks: getTasks,
  get_task_board_summary: getTaskBoardSummary,
  get_parser_jobs: getParserJobs,
  get_parser_results_summary: getParserResultsSummary,
  get_instantly_campaigns: getInstantlyCampaigns,
  get_review_requests: getReviewRequests,
  get_team_workload: getTeamWorkload,
  get_weekly_summary: getWeeklySummary,
};
