import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { WriteToolHandler } from './types';
import { logAudit } from '@/lib/loggerServer';

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

export const writeToolHandlers: Record<string, WriteToolHandler> = {
  update_project_status: updateProjectStatus,
  update_project_fields: updateProjectFields,
  create_project: createProject,
  create_task: createTask,
  update_task_status: updateTaskStatus,
  update_task_fields: updateTaskFields,
  update_review_status: updateReviewStatus,
  launch_hh_parser: launchHhParser,
};
