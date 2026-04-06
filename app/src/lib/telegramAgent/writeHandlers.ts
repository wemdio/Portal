import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { WriteToolHandler } from './types';
import { logAudit } from '@/lib/loggerServer';
import { createPipeline, startPipeline } from './pipeline';
import type { PipelineStep } from './pipeline';
import { cleanCompanyNames } from './cleanNames';
import { deduplicateByField } from './dedup';

function ensureAdmin() {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');
  return supabaseAdmin;
}

const REVIEW_TRANSITIONS: Record<string, string[]> = {
  submitted: ['review_approved', 'needs_rework'],
  needs_rework: ['submitted'],
  review_approved: ['sent_to_client', 'needs_rework'],
  sent_to_client: ['client_approved', 'client_requested_changes'],
  client_requested_changes: ['submitted'],
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Ожидает',
  in_progress: 'В работе',
  done: 'Завершено',
  submitted: 'На проверке',
  needs_rework: 'На доработке',
  review_approved: 'Одобрено',
  sent_to_client: 'Отправлено клиенту',
  client_approved: 'Клиент одобрил',
  client_requested_changes: 'Клиент просит изменения',
};

function label(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function pick(params: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
      result[key] = params[key];
    }
  }
  return result;
}

export const updateProjectStatus: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const { project_id, new_status } = params as { project_id: string; new_status: string };

  const { data: project, error: fetchErr } = await sb
    .from('projects')
    .select('id, name, client, status')
    .eq('id', project_id)
    .maybeSingle();

  if (fetchErr || !project) return 'Проект не найден.';

  const { error } = await sb
    .from('projects')
    .update({ status: new_status, updated_at: new Date().toISOString() })
    .eq('id', project_id);

  if (error) return `Ошибка: ${error.message}`;

  await logAudit('telegram-agent.write.project-status', `${project.name}: ${project.status} → ${new_status}`, { project_id, userId: user.userId, userName: user.fullName });
  return `Статус проекта «${project.name}» изменён: ${project.status} → ${new_status}`;
};

export const updateProjectFields: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const projectId = params.project_id as string;
  const fields = pick(params, ['manager', 'specialist', 'deadline', 'kpi_plan', 'kpi_fact', 'budget', 'margin', 'comments', 'weekly_tasks', 'contacts_obligation', 'contacts_done']);

  if (Object.keys(fields).length === 0) return 'Не указаны поля для обновления.';

  const { data: project, error: fetchErr } = await sb
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .maybeSingle();

  if (fetchErr || !project) return 'Проект не найден.';

  const { error } = await sb
    .from('projects')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', projectId);

  if (error) return `Ошибка: ${error.message}`;

  const changed = Object.keys(fields).join(', ');
  await logAudit('telegram-agent.write.project-fields', `${project.name}: updated ${changed}`, { project_id: projectId, fields, userId: user.userId, userName: user.fullName });
  return `Проект «${project.name}» обновлён. Изменённые поля: ${changed}`;
};

export const createProject: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const data = pick(params, ['name', 'client', 'status', 'manager', 'specialist', 'deadline', 'kpi_plan', 'budget', 'margin', 'comments']);

  if (!data.name) return 'Название проекта обязательно.';
  if (!data.status) data.status = 'Подготовка';

  const { data: created, error } = await sb
    .from('projects')
    .insert(data)
    .select('id, name, status')
    .single();

  if (error) return `Ошибка: ${error.message}`;

  await logAudit('telegram-agent.write.project-create', `Created: ${created.name}`, { project_id: created.id, userId: user.userId, userName: user.fullName });
  return `Проект «${created.name}» создан (статус: ${created.status}, ID: ${created.id})`;
};

export const createTask: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const data = pick(params, ['title', 'specialist', 'project_id', 'description', 'status', 'deadline']);

  if (!data.title) return 'Название задачи обязательно.';
  if (!data.status) data.status = 'pending';
  data.created_by = user.fullName;

  const { data: created, error } = await sb
    .from('tasks')
    .insert(data)
    .select('id, title, status')
    .single();

  if (error) return `Ошибка: ${error.message}`;

  await logAudit('telegram-agent.write.task-create', `Created: ${created.title}`, { task_id: created.id, userId: user.userId, userName: user.fullName });
  return `Задача «${created.title}» создана (статус: ${label(created.status)}, ID: ${created.id})`;
};

export const updateTaskStatus: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const { task_id, new_status } = params as { task_id: string; new_status: string };

  const { data: task, error: fetchErr } = await sb
    .from('tasks')
    .select('id, title, status')
    .eq('id', task_id)
    .maybeSingle();

  if (fetchErr || !task) return 'Задача не найдена.';

  const { error } = await sb
    .from('tasks')
    .update({ status: new_status, updated_at: new Date().toISOString() })
    .eq('id', task_id);

  if (error) return `Ошибка: ${error.message}`;

  await logAudit('telegram-agent.write.task-status', `${task.title}: ${label(task.status)} → ${label(new_status)}`, { task_id, userId: user.userId, userName: user.fullName });
  return `Задача «${task.title}»: ${label(task.status)} → ${label(new_status)}`;
};

export const updateTaskFields: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const taskId = params.task_id as string;
  const fields = pick(params, ['title', 'specialist', 'description', 'result', 'deadline']);

  if (Object.keys(fields).length === 0) return 'Не указаны поля для обновления.';

  const { data: task, error: fetchErr } = await sb
    .from('tasks')
    .select('id, title')
    .eq('id', taskId)
    .maybeSingle();

  if (fetchErr || !task) return 'Задача не найдена.';

  const { error } = await sb
    .from('tasks')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', taskId);

  if (error) return `Ошибка: ${error.message}`;

  const changed = Object.keys(fields).join(', ');
  await logAudit('telegram-agent.write.task-fields', `${task.title}: updated ${changed}`, { task_id: taskId, fields, userId: user.userId, userName: user.fullName });
  return `Задача «${task.title}» обновлена. Изменённые поля: ${changed}`;
};

export const updateReviewStatus: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const { review_id, new_status, comment } = params as { review_id: string; new_status: string; comment?: string };

  const { data: review, error: fetchErr } = await sb
    .from('database_review_requests')
    .select('id, tab_name, status')
    .eq('id', review_id)
    .maybeSingle();

  if (fetchErr || !review) return 'Ревью-запрос не найден.';

  const allowed = REVIEW_TRANSITIONS[review.status];
  if (!allowed?.includes(new_status)) {
    return `Недопустимый переход: ${label(review.status)} → ${label(new_status)}. Допустимые: ${(allowed ?? []).map(label).join(', ')}`;
  }

  const update: Record<string, unknown> = { status: new_status, updated_at: new Date().toISOString() };
  if (comment) update.reviewer_comment = comment;

  const { error } = await sb
    .from('database_review_requests')
    .update(update)
    .eq('id', review_id);

  if (error) return `Ошибка: ${error.message}`;

  await logAudit('telegram-agent.write.review-status', `${review.tab_name}: ${label(review.status)} → ${label(new_status)}`, { review_id, userId: user.userId, userName: user.fullName });
  return `Ревью «${review.tab_name}»: ${label(review.status)} → ${label(new_status)}`;
};

export const launchHhParser: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const text = params.text as string | undefined;
  if (!text) return 'Поисковый запрос (text) обязателен.';

  const config: Record<string, unknown> = { text };
  if (params.area) config.area = params.area;
  if (params.salary_from) config.salary_from = params.salary_from;
  if (params.date_from) config.date_from = params.date_from;
  if (params.date_to) config.date_to = params.date_to;
  if (params.fetch_employers !== undefined) config.fetch_employers = params.fetch_employers;

  const { data: job, error } = await sb
    .from('parser_jobs')
    .insert({
      user_id: user.userId,
      parser_type: 'hh_vacancies',
      status: 'pending',
      progress_stage: 'pending',
      progress_percent: 0,
      config,
    })
    .select('id, status, parser_type, config')
    .single();

  if (error) return `Ошибка: ${error.message}`;

  await logAudit('telegram-agent.write.hh-parser-launch', `HH parser launched: "${text}"`, {
    jobId: job.id,
    config,
    userId: user.userId,
    userName: user.fullName,
  });

  return `Парсер HH запущен (ID: ${job.id}). Поиск: «${text}».\nСтатус можно проверить командой «статус парсера ${job.id}».`;
};

export const launchSearchParser: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const queriesRaw = params.queries as string | undefined;
  const brief = params.brief as string | undefined;
  const queries = queriesRaw
    ? queriesRaw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
    : [];

  if (queries.length === 0 && !brief) return 'Нужно указать queries (поисковые запросы) или brief (описание ЦА).';

  const rawDepth = Number(params.search_depth);
  const search_depth = Number.isFinite(rawDepth) ? Math.max(1, Math.min(30, Math.round(rawDepth))) : 5;

  const config: Record<string, unknown> = { search_depth };
  if (brief) config.brief = brief;
  if (queries.length > 0) config.queries = queries;

  const { data: job, error } = await sb
    .from('search_parser_jobs')
    .insert({
      user_id: user.userId,
      status: 'pending',
      config,
      total_queries: queries.length,
    })
    .select('id, status')
    .single();

  if (error) return `Ошибка: ${error.message}`;

  const desc = queries.length > 0
    ? `${queries.length} запрос(ов): «${queries.slice(0, 3).join('», «')}»${queries.length > 3 ? '...' : ''}`
    : `бриф: «${(brief ?? '').slice(0, 80)}...»`;

  await logAudit('telegram-agent.write.search-parser-launch', `Search parser launched: ${desc}`, {
    jobId: job.id, config, userId: user.userId, userName: user.fullName,
  });
  return `Поисковый парсер запущен (ID: ${job.id}). ${desc}`;
};

export const launchYandexMapsParser: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const urlsRaw = params.search_urls as string | undefined;
  if (!urlsRaw) return 'Необходимо указать URL-ы поиска Яндекс.Карт.';

  const search_urls = urlsRaw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (search_urls.length === 0) return 'Не найдено ни одного URL.';

  const max_results = Math.max(1, Math.min(5000, Number(params.max_results ?? 500) || 500));

  const { data: job, error } = await sb
    .from('yandex_maps_jobs')
    .insert({
      user_id: user.userId,
      status: 'pending',
      config: { search_urls, max_results, headless: true },
      progress_stage: 'pending',
    })
    .select('id, status')
    .single();

  if (error) return `Ошибка: ${error.message}`;

  await logAudit('telegram-agent.write.yandex-maps-launch', `Yandex Maps parser launched`, {
    jobId: job.id, search_urls, max_results, userId: user.userId, userName: user.fullName,
  });
  return `Парсер Яндекс.Карт запущен (ID: ${job.id}). URL-ов: ${search_urls.length}, макс. результатов: ${max_results}.`;
};

export const launchEmailSearch: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const urlsRaw = params.urls as string | undefined;
  if (!urlsRaw) return 'Необходимо указать список URL сайтов.';

  const urls = urlsRaw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (urls.length === 0) return 'Не найдено ни одного URL.';
  if (urls.length > 500) return 'Максимум 500 URL за один запрос через бота. Для больших объёмов используйте портал.';

  const now = new Date().toISOString();

  const { data: job, error: jobErr } = await sb
    .from('website_enrichment_jobs')
    .insert({
      user_id: user.userId,
      status: 'pending',
      extraction_type: 'email',
      total: urls.length,
      processed: 0,
      success_count: 0,
      error_count: 0,
      created_at: now,
    })
    .select('id')
    .single();

  if (jobErr || !job) return `Ошибка: ${jobErr?.message ?? 'Не удалось создать задачу'}`;

  const queueItems = urls.map((url, i) => ({
    job_id: job.id,
    user_id: user.userId,
    row_index: i,
    url_raw: url,
    url_normalized: url,
    status: 'pending',
    attempt_count: 0,
    result_text: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  }));

  const batchSize = 500;
  for (let i = 0; i < queueItems.length; i += batchSize) {
    const { error } = await sb.from('website_enrichment_queue').insert(queueItems.slice(i, i + batchSize));
    if (error) return `Ошибка записи очереди: ${error.message}`;
  }

  await logAudit('telegram-agent.write.email-search-launch', `Email search launched: ${urls.length} URLs`, {
    jobId: job.id, urlCount: urls.length, userId: user.userId, userName: user.fullName,
  });
  return `Поиск email запущен (ID: ${job.id}). Сайтов: ${urls.length}.`;
};

export const launchEmailValidation: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const emailsRaw = params.emails as string | undefined;
  if (!emailsRaw) return 'Необходимо указать список email.';

  const emails = emailsRaw.split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (emails.length === 0) return 'Не найдено ни одного email.';
  if (emails.length > 500) return 'Максимум 500 email за один запрос через бота. Для больших объёмов используйте портал.';

  const now = new Date().toISOString();

  const { data: job, error: jobErr } = await sb
    .from('email_validation_jobs')
    .insert({
      user_id: user.userId,
      status: 'pending',
      total: emails.length,
      processed: 0,
      success_count: 0,
      error_count: 0,
      created_at: now,
    })
    .select('id')
    .single();

  if (jobErr || !job) return `Ошибка: ${jobErr?.message ?? 'Не удалось создать задачу'}`;

  const queueItems = emails.map((email, i) => ({
    job_id: job.id,
    user_id: user.userId,
    row_index: i,
    email_raw: email,
    email_normalized: email,
    status: 'pending',
    last_error: null,
    result: null,
    quality: null,
    attempt_count: 0,
    created_at: now,
    updated_at: now,
    completed_at: null,
  }));

  const batchSize = 500;
  for (let i = 0; i < queueItems.length; i += batchSize) {
    const { error } = await sb.from('email_validation_queue').insert(queueItems.slice(i, i + batchSize));
    if (error) return `Ошибка записи очереди: ${error.message}`;
  }

  await logAudit('telegram-agent.write.email-validation-launch', `Email validation launched: ${emails.length} emails`, {
    jobId: job.id, emailCount: emails.length, userId: user.userId, userName: user.fullName,
  });
  return `Валидация email запущена (ID: ${job.id}). Email-ов: ${emails.length}.`;
};

export const launchLprSearch: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const domain = params.domain as string | undefined;
  const companyName = params.company_name as string | undefined;
  const linkedinUrl = params.linkedin_url as string | undefined;

  if (!domain && !companyName && !linkedinUrl) {
    return 'Укажите хотя бы один параметр: domain, company_name или linkedin_url.';
  }

  const company: Record<string, string> = {};
  if (domain) company.domain = domain;
  if (companyName) company.company_name = companyName;
  if (linkedinUrl) company.linkedin_url = linkedinUrl;

  const seniorities = params.seniorities
    ? String(params.seniorities).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const functions = params.functions
    ? String(params.functions).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const config: Record<string, unknown> = { company };
  if (seniorities) config.seniorities = seniorities;
  if (functions) config.functions = functions;
  if (params.max_candidates) config.max_candidates = params.max_candidates;

  const now = new Date().toISOString();
  const { data: job, error } = await sb
    .from('lpr_jobs')
    .insert({
      user_id: user.userId,
      status: 'pending',
      config,
      created_at: now,
    })
    .select('id, status')
    .single();

  if (error) return `Ошибка: ${error.message}`;

  const companyDesc = domain ?? companyName ?? linkedinUrl ?? '';
  await logAudit('telegram-agent.write.lpr-search-launch', `LPR search launched: ${companyDesc}`, {
    jobId: job.id, config, userId: user.userId, userName: user.fullName,
  });
  return `Поиск ЛПР запущен (ID: ${job.id}). Компания: «${companyDesc}».`;
};

export const launchBriefScoring: WriteToolHandler = async (params, user) => {
  const sb = ensureAdmin();
  const briefText = (params.brief_text as string | undefined)?.trim();
  if (!briefText) return 'Текст брифа (brief_text) обязателен.';

  const companiesRaw = params.companies as string | undefined;
  const companies = companiesRaw
    ? companiesRaw.split(/\n+/).map((s) => s.trim()).filter(Boolean)
    : [];

  const now = new Date().toISOString();

  const { data: job, error: jobErr } = await sb
    .from('brief_scoring_jobs')
    .insert({
      user_id: user.userId,
      status: companies.length > 0 ? 'pending' : 'running',
      brief_text: briefText,
      total: companies.length,
      processed: 0,
      success_count: 0,
      error_count: 0,
      created_at: now,
      started_at: companies.length > 0 ? null : now,
    })
    .select('id')
    .single();

  if (jobErr || !job) return `Ошибка: ${jobErr?.message ?? 'Не удалось создать задачу'}`;

  if (companies.length > 0) {
    const queueItems = companies.map((name, i) => ({
      job_id: job.id,
      user_id: user.userId,
      row_index: i,
      company_data: { name },
      status: 'pending',
      attempt_count: 0,
      score: null,
      reason: null,
      last_error: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    }));

    const batchSize = 500;
    for (let i = 0; i < queueItems.length; i += batchSize) {
      const { error } = await sb.from('brief_scoring_queue').insert(queueItems.slice(i, i + batchSize));
      if (error) return `Ошибка записи очереди: ${error.message}`;
    }
  }

  await logAudit('telegram-agent.write.brief-scoring-launch', `Brief scoring launched`, {
    jobId: job.id, briefPreview: briefText.slice(0, 100), companiesCount: companies.length,
    userId: user.userId, userName: user.fullName,
  });

  const companyInfo = companies.length > 0
    ? `Компаний: ${companies.length}.`
    : 'Компании можно добавить на портале.';
  return `Скоринг ЦА запущен (ID: ${job.id}). Бриф: «${briefText.slice(0, 60)}...». ${companyInfo}`;
};

export const cleanNames: WriteToolHandler = async (params, user) => {
  const jobId = params.job_id as string | undefined;
  if (!jobId) return 'Необходимо указать job_id.';

  const result = await cleanCompanyNames(jobId, params.parser_type as string | undefined);
  if (typeof result === 'string') return result;

  await logAudit('telegram-agent.write.clean-names', `Cleaned ${result.cleaned}/${result.total} company names`, {
    jobId, cleaned: result.cleaned, total: result.total, userId: user.userId, userName: user.fullName,
  });

  return `Очищено ${result.cleaned} из ${result.total} названий компаний.`;
};

export const deduplicateResults: WriteToolHandler = async (params, user) => {
  const jobId = params.job_id as string | undefined;
  if (!jobId) return 'Необходимо указать job_id.';

  const field = (params.field as 'email' | 'site' | undefined) ?? 'email';
  const removeEmpty = params.remove_empty === true;
  const result = await deduplicateByField(jobId, field, params.parser_type as string | undefined, removeEmpty);
  if (typeof result === 'string') return result;

  await logAudit('telegram-agent.write.deduplicate', `Deduplicated by ${field}: removed ${result.removed}/${result.total}, remove_empty=${removeEmpty}`, {
    jobId, field, removeEmpty, removed: result.removed, total: result.total, userId: user.userId, userName: user.fullName,
  });

  if (result.removed === 0) return `Дубликатов по полю «${field}» не найдено (${result.total} записей).`;
  return `Удалено ${result.removed} из ${result.total} записей (по полю «${field}»${removeEmpty ? ' + пустые строки' : ''}). Осталось ${result.total - result.removed}.`;
};

export const launchPipeline: WriteToolHandler = async (params, user) => {
  const rawSteps = params.steps as { type: string; config?: Record<string, unknown> }[] | undefined;
  if (!rawSteps?.length) return 'Необходимо указать хотя бы один шаг.';

  const validTypes = new Set(['parse_hh', 'parse_search', 'parse_yandex_maps', 'clean_names', 'enrich_emails', 'validate_emails', 'deduplicate', 'export']);
  for (const s of rawSteps) {
    if (!validTypes.has(s.type)) return `Неизвестный тип шага: ${s.type}. Допустимые: ${[...validTypes].join(', ')}`;
  }

  const steps: PipelineStep[] = rawSteps.map((s) => ({
    type: s.type as PipelineStep['type'],
    config: s.config ?? {},
    status: 'pending',
  }));

  const name = (params.name as string) || steps.map((s) => s.type).join(' → ');

  try {
    const pipeline = await createPipeline(user, params._chatId as number, name, steps);
    const result = await startPipeline(pipeline, user);
    return result;
  } catch (err) {
    return `Ошибка создания пайплайна: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
};

export const writeToolHandlers: Record<string, WriteToolHandler> = {
  update_project_status: updateProjectStatus,
  update_project_fields: updateProjectFields,
  create_project: createProject,
  create_task: createTask,
  update_task_status: updateTaskStatus,
  update_task_fields: updateTaskFields,
  update_review_status: updateReviewStatus,
  launch_hh_parser: launchHhParser,
  launch_search_parser: launchSearchParser,
  launch_yandex_maps_parser: launchYandexMapsParser,
  launch_email_search: launchEmailSearch,
  launch_email_validation: launchEmailValidation,
  launch_lpr_search: launchLprSearch,
  launch_brief_scoring: launchBriefScoring,
  clean_company_names: cleanNames,
  deduplicate_results: deduplicateResults,
  create_pipeline: launchPipeline,
};
