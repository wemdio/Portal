import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { sendMessage, sendDocument } from './telegram';
import type { AgentUser } from './types';
import { exportPipelineResults } from './pipelineExport';
import { cleanNamesForPipelineStep } from './cleanNames';
import { deduplicateByField } from './dedup';

export type StepType =
  | 'parse_hh'
  | 'parse_search'
  | 'parse_yandex_maps'
  | 'clean_names'
  | 'enrich_emails'
  | 'validate_emails'
  | 'deduplicate'
  | 'export';

export type PipelineStep = {
  type: StepType;
  config: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  job_id?: string | null;
  job_table?: string | null;
  result_count?: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
};

export type Pipeline = {
  id: string;
  user_id: string;
  chat_id: number;
  name: string;
  status: string;
  current_step_index: number;
  steps: PipelineStep[];
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  error_message?: string | null;
};

function ensureAdmin() {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');
  return supabaseAdmin;
}

const JOB_TABLE_MAP: Record<string, string> = {
  parse_hh: 'parser_jobs',
  parse_search: 'search_parser_jobs',
  parse_yandex_maps: 'yandex_maps_jobs',
  enrich_emails: 'website_enrichment_jobs',
  validate_emails: 'email_validation_jobs',
};

const RESULT_TABLE_MAP: Record<string, string> = {
  parse_hh: 'hh_vacancies',
  parse_search: 'search_results',
  parse_yandex_maps: 'yandex_maps_organizations',
  enrich_emails: 'website_enrichment_queue',
  validate_emails: 'email_validation_queue',
};

const URL_COLUMN_MAP: Record<string, string> = {
  parse_hh: 'company_site_url',
  parse_search: 'site',
  parse_yandex_maps: 'website',
};

// ── Create ──

const PARSER_TYPES = new Set(['parse_hh', 'parse_search', 'parse_yandex_maps']);

const STEP_ORDER: Record<string, number> = {
  parse_hh: 0, parse_search: 0, parse_yandex_maps: 0,
  clean_names: 1,
  enrich_emails: 2,
  validate_emails: 3,
  deduplicate: 3.5,
  export: 4,
};

function validateStepOrder(steps: PipelineStep[]): string | null {
  const hasParser = steps.some((s) => PARSER_TYPES.has(s.type));
  if (!hasParser) return 'Пайплайн должен начинаться с шага парсинга (parse_hh, parse_search или parse_yandex_maps).';

  const hasValidate = steps.some((s) => s.type === 'validate_emails');
  const hasEnrich = steps.some((s) => s.type === 'enrich_emails');
  if (hasValidate && !hasEnrich) {
    const parserHasEmails = steps.some((s) => s.type === 'parse_search' || s.type === 'parse_yandex_maps');
    if (!parserHasEmails) return 'Для валидации email нужен шаг enrich_emails (или парсер, который сам находит email).';
  }

  for (let i = 1; i < steps.length; i++) {
    const prev = STEP_ORDER[steps[i - 1].type] ?? 0;
    const curr = STEP_ORDER[steps[i].type] ?? 0;
    if (curr < prev) {
      return `Неверный порядок шагов: ${steps[i].type} не может идти после ${steps[i - 1].type}. Правильный порядок: парсинг → очистка названий → поиск email → валидация → дедупликация → экспорт.`;
    }
  }

  return null;
}

export async function createPipeline(
  user: AgentUser,
  chatId: number,
  name: string,
  steps: PipelineStep[],
): Promise<Pipeline> {
  const sb = ensureAdmin();
  if (steps.length === 0) throw new Error('Pipeline must have at least one step');

  if (steps[steps.length - 1].type !== 'export') {
    steps.push({ type: 'export', config: {}, status: 'pending' });
  }

  const orderError = validateStepOrder(steps);
  if (orderError) throw new Error(orderError);

  const { data, error } = await sb
    .from('agent_pipelines')
    .insert({
      user_id: user.userId,
      chat_id: chatId,
      name: name || 'Pipeline',
      status: 'pending',
      current_step_index: 0,
      steps,
      context: {},
    })
    .select('*')
    .single();

  if (error) throw new Error(error.message);

  await logAudit('telegram-agent.pipeline.created', `Pipeline "${name}" created with ${steps.length} steps`, {
    pipelineId: data.id,
    userId: user.userId,
    userName: user.fullName,
    stepTypes: steps.map((s) => s.type),
  });

  return data as Pipeline;
}

// ── Start ──

export async function startPipeline(pipeline: Pipeline, user: AgentUser): Promise<string> {
  const sb = ensureAdmin();
  const step = pipeline.steps[0];
  if (!step) return 'Pipeline has no steps.';

  try {
    const jobId = await launchStep(pipeline, 0, user);
    step.status = 'running';
    step.job_id = jobId;
    step.job_table = JOB_TABLE_MAP[step.type] ?? null;
    step.started_at = new Date().toISOString();

    await sb
      .from('agent_pipelines')
      .update({ status: 'running', steps: pipeline.steps, updated_at: new Date().toISOString() })
      .eq('id', pipeline.id);

    return `Пайплайн «${pipeline.name}» запущен (ID: ${pipeline.id}).\nШаг 1/${pipeline.steps.length}: ${describeStep(step)}\nЯ сообщу когда завершится.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    step.status = 'failed';
    step.error = msg;
    await sb
      .from('agent_pipelines')
      .update({ status: 'failed', steps: pipeline.steps, error_message: msg, updated_at: new Date().toISOString() })
      .eq('id', pipeline.id);
    return `Ошибка запуска пайплайна: ${msg}`;
  }
}

// ── Advance ──

export async function advancePipeline(pipelineId: string): Promise<boolean> {
  const sb = ensureAdmin();

  const { data: raw, error } = await sb
    .from('agent_pipelines')
    .select('*')
    .eq('id', pipelineId)
    .maybeSingle();

  if (error || !raw) return false;
  const pipeline = raw as Pipeline;
  if (pipeline.status !== 'running') return false;

  const stepIdx = pipeline.current_step_index;
  const step = pipeline.steps[stepIdx];
  if (!step || step.status !== 'running') return false;

  const jobStatus = await checkJobStatus(step);
  if (!jobStatus) return false;

  if (jobStatus === 'failed') {
    step.status = 'failed';
    step.completed_at = new Date().toISOString();
    step.error = 'Job failed';
    await sb
      .from('agent_pipelines')
      .update({
        status: 'failed',
        steps: pipeline.steps,
        error_message: `Шаг ${stepIdx + 1} (${step.type}) завершился с ошибкой`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', pipelineId);

    await sendMessage(pipeline.chat_id, `❌ Пайплайн «${pipeline.name}» — ошибка на шаге ${stepIdx + 1} (${describeStep(step)}).`);
    return true;
  }

  if (jobStatus !== 'completed') return false;

  step.status = 'completed';
  step.completed_at = new Date().toISOString();
  step.result_count = await countResults(step);

  const nextIdx = stepIdx + 1;

  if (nextIdx >= pipeline.steps.length) {
    await sb
      .from('agent_pipelines')
      .update({
        status: 'completed',
        steps: pipeline.steps,
        current_step_index: nextIdx,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', pipelineId);

    await sendMessage(pipeline.chat_id, `✅ Пайплайн «${pipeline.name}» завершён!`);
    return true;
  }

  const nextStep = pipeline.steps[nextIdx];
  const SYNC_STEPS = new Set<StepType>(['export', 'clean_names', 'deduplicate']);

  if (nextStep.type === 'export') {
    nextStep.status = 'running';
    nextStep.started_at = new Date().toISOString();
    pipeline.current_step_index = nextIdx;

    await sb
      .from('agent_pipelines')
      .update({ steps: pipeline.steps, current_step_index: nextIdx, updated_at: new Date().toISOString() })
      .eq('id', pipelineId);

    await executeExportStep(pipeline);
    return true;
  }

  try {
    const user: AgentUser = {
      userId: pipeline.user_id,
      fullName: 'Pipeline',
      role: 'specialist',
      email: '',
      telegramId: 0,
    };

    await sendMessage(
      pipeline.chat_id,
      `📋 Пайплайн «${pipeline.name}» — шаг ${nextIdx + 1}/${pipeline.steps.length}: ${describeStep(nextStep)}`,
    );

    const jobId = await launchStep(pipeline, nextIdx, user);

    if (SYNC_STEPS.has(nextStep.type)) {
      nextStep.status = 'completed';
      nextStep.started_at = new Date().toISOString();
      nextStep.completed_at = new Date().toISOString();
      pipeline.current_step_index = nextIdx;

      await sb
        .from('agent_pipelines')
        .update({ steps: pipeline.steps, current_step_index: nextIdx, updated_at: new Date().toISOString() })
        .eq('id', pipelineId);

      return advancePipeline(pipelineId);
    }

    nextStep.status = 'running';
    nextStep.job_id = jobId;
    nextStep.job_table = JOB_TABLE_MAP[nextStep.type] ?? null;
    nextStep.started_at = new Date().toISOString();
    pipeline.current_step_index = nextIdx;

    await sb
      .from('agent_pipelines')
      .update({ steps: pipeline.steps, current_step_index: nextIdx, updated_at: new Date().toISOString() })
      .eq('id', pipelineId);

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    nextStep.status = 'failed';
    nextStep.error = msg;
    pipeline.current_step_index = nextIdx;

    await sb
      .from('agent_pipelines')
      .update({
        status: 'failed',
        steps: pipeline.steps,
        current_step_index: nextIdx,
        error_message: msg,
        updated_at: new Date().toISOString(),
      })
      .eq('id', pipelineId);

    await sendMessage(pipeline.chat_id, `❌ Пайплайн «${pipeline.name}» — ошибка на шаге ${nextIdx + 1}: ${msg}`);
    return true;
  }
}

export async function advanceAllPipelines(): Promise<number> {
  const sb = ensureAdmin();
  const { data } = await sb
    .from('agent_pipelines')
    .select('id')
    .eq('status', 'running');

  if (!data?.length) return 0;

  let advanced = 0;
  for (const row of data) {
    try {
      const did = await advancePipeline(row.id as string);
      if (did) advanced++;
    } catch (err) {
      await logError('telegram-agent.pipeline.advance-error', err);
    }
  }
  return advanced;
}

// ── Get status ──

export async function getPipelineStatus(pipelineId?: string, userId?: string): Promise<string> {
  const sb = ensureAdmin();

  if (pipelineId) {
    const { data, error } = await sb
      .from('agent_pipelines')
      .select('*')
      .eq('id', pipelineId)
      .maybeSingle();
    if (error || !data) return 'Пайплайн не найден.';
    return formatPipelineStatus(data as Pipeline);
  }

  if (userId) {
    const { data, error } = await sb
      .from('agent_pipelines')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error || !data?.length) return 'Пайплайнов не найдено.';
    return (data as Pipeline[]).map(formatPipelineStatus).join('\n\n---\n\n');
  }

  return 'Укажите pipeline_id или user_id.';
}

// ── Internal helpers ──

async function checkJobStatus(step: PipelineStep): Promise<string | null> {
  if (!step.job_id || !step.job_table) return null;
  const sb = ensureAdmin();

  const { data } = await sb
    .from(step.job_table)
    .select('status')
    .eq('id', step.job_id)
    .maybeSingle();

  return (data?.status as string) ?? null;
}

async function countResults(step: PipelineStep): Promise<number> {
  if (!step.job_id) return 0;
  const resultTable = RESULT_TABLE_MAP[step.type];
  if (!resultTable) return 0;

  const sb = ensureAdmin();
  const { count } = await sb
    .from(resultTable)
    .select('id', { count: 'exact', head: true })
    .eq('job_id', step.job_id);

  return count ?? 0;
}

async function launchStep(pipeline: Pipeline, stepIdx: number, user: AgentUser): Promise<string> {
  const sb = ensureAdmin();
  const step = pipeline.steps[stepIdx];
  const now = new Date().toISOString();

  switch (step.type) {
    case 'parse_hh': {
      const config = step.config;
      if (!config.text) throw new Error('HH parser requires "text" in config');
      const { data, error } = await sb
        .from('parser_jobs')
        .insert({ user_id: user.userId, parser_type: 'hh_vacancies', status: 'pending', progress_stage: 'pending', progress_percent: 0, config })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      return data.id as string;
    }

    case 'parse_search': {
      const config = step.config;
      const queries = (config.queries as string[] | undefined) ?? [];
      const { data, error } = await sb
        .from('search_parser_jobs')
        .insert({ user_id: user.userId, status: 'pending', config, total_queries: queries.length })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      return data.id as string;
    }

    case 'parse_yandex_maps': {
      const config = step.config;
      if (!config.search_urls) throw new Error('Yandex Maps parser requires "search_urls" in config');
      const { data, error } = await sb
        .from('yandex_maps_jobs')
        .insert({ user_id: user.userId, status: 'pending', config, progress_stage: 'pending' })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      return data.id as string;
    }

    case 'enrich_emails': {
      const urls = await extractUrlsFromPreviousSteps(pipeline, stepIdx);
      if (urls.length === 0) throw new Error('Нет URL для обогащения — предыдущий парсер не нашёл сайтов компаний.');

      const { data: job, error: jobErr } = await sb
        .from('website_enrichment_jobs')
        .insert({ user_id: user.userId, status: 'pending', extraction_type: 'email', total: urls.length, processed: 0, success_count: 0, error_count: 0, created_at: now })
        .select('id')
        .single();
      if (jobErr) throw new Error(jobErr.message);

      const queue = urls.map((url, i) => ({
        job_id: job.id, user_id: user.userId, row_index: i,
        url_raw: url, url_normalized: url,
        status: 'pending', attempt_count: 0, result_text: null, last_error: null,
        created_at: now, updated_at: now, completed_at: null,
      }));
      for (let i = 0; i < queue.length; i += 500) {
        const { error } = await sb.from('website_enrichment_queue').insert(queue.slice(i, i + 500));
        if (error) throw new Error(error.message);
      }
      return job.id as string;
    }

    case 'validate_emails': {
      const emails = await extractEmailsFromPreviousSteps(pipeline, stepIdx);
      if (emails.length === 0) throw new Error('Нет email для валидации — предыдущий шаг не нашёл почтовых адресов.');

      const { data: job, error: jobErr } = await sb
        .from('email_validation_jobs')
        .insert({ user_id: user.userId, status: 'pending', total: emails.length, processed: 0, success_count: 0, error_count: 0, created_at: now })
        .select('id')
        .single();
      if (jobErr) throw new Error(jobErr.message);

      const queue = emails.map((email, i) => ({
        job_id: job.id, user_id: user.userId, row_index: i,
        email_raw: email, email_normalized: email,
        status: 'pending', attempt_count: 0, result: null, quality: null, last_error: null,
        created_at: now, updated_at: now, completed_at: null,
      }));
      for (let i = 0; i < queue.length; i += 500) {
        const { error } = await sb.from('email_validation_queue').insert(queue.slice(i, i + 500));
        if (error) throw new Error(error.message);
      }
      return job.id as string;
    }

    case 'clean_names': {
      const parserStep = pipeline.steps.slice(0, stepIdx).reverse()
        .find((s) => PARSER_TYPES.has(s.type) && s.status === 'completed' && s.job_id);
      if (!parserStep?.job_id) throw new Error('Нет завершённого шага парсинга для очистки названий.');

      const typeKey = parserStep.type.replace('parse_', '');
      await cleanNamesForPipelineStep(parserStep.job_id, typeKey);
      return `clean_${parserStep.job_id}`;
    }

    case 'deduplicate': {
      const parserStep = pipeline.steps.slice(0, stepIdx).reverse()
        .find((s) => PARSER_TYPES.has(s.type) && s.status === 'completed' && s.job_id);
      if (!parserStep?.job_id) throw new Error('Нет завершённого шага парсинга для дедупликации.');

      const typeKey = parserStep.type.replace('parse_', '');
      const field = (step.config.field as 'email' | 'site' | undefined) ?? 'email';
      const removeEmpty = step.config.remove_empty === true;
      const result = await deduplicateByField(parserStep.job_id, field, typeKey, removeEmpty);
      if (typeof result === 'string') throw new Error(result);
      step.result_count = result.total - result.removed;
      return `dedup_${parserStep.job_id}`;
    }

    default:
      throw new Error(`Cannot launch step type: ${step.type}`);
  }
}

async function extractUrlsFromPreviousSteps(pipeline: Pipeline, currentIdx: number): Promise<string[]> {
  const sb = ensureAdmin();

  for (let i = currentIdx - 1; i >= 0; i--) {
    const prev = pipeline.steps[i];
    const urlCol = URL_COLUMN_MAP[prev.type];
    if (!urlCol || !prev.job_id || prev.status !== 'completed') continue;

    const resultTable = RESULT_TABLE_MAP[prev.type];
    if (!resultTable) continue;

    const { data } = await sb
      .from(resultTable)
      .select(urlCol)
      .eq('job_id', prev.job_id)
      .not(urlCol, 'is', null);

    if (!data?.length) continue;

    const urls = [...new Set(
      (data as Record<string, unknown>[])
        .map((r) => String(r[urlCol] ?? '').trim())
        .filter((u) => u.length > 0 && u.startsWith('http')),
    )];

    if (urls.length > 0) return urls;
  }

  return [];
}

async function extractEmailsFromPreviousSteps(pipeline: Pipeline, currentIdx: number): Promise<string[]> {
  const sb = ensureAdmin();

  for (let i = currentIdx - 1; i >= 0; i--) {
    const prev = pipeline.steps[i];

    if (prev.type === 'enrich_emails' && prev.job_id && prev.status === 'completed') {
      const { data } = await sb
        .from('website_enrichment_queue')
        .select('result_text')
        .eq('job_id', prev.job_id)
        .eq('status', 'completed')
        .not('result_text', 'is', null);

      if (!data?.length) continue;

      const emails = [...new Set(
        data
          .flatMap((r) => String(r.result_text ?? '').split(/[\n,;]+/))
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e.includes('@') && e.includes('.')),
      )];

      if (emails.length > 0) return emails;
    }

    if (['parse_search', 'parse_yandex_maps'].includes(prev.type) && prev.job_id && prev.status === 'completed') {
      const resultTable = RESULT_TABLE_MAP[prev.type];
      if (!resultTable) continue;

      const { data } = await sb
        .from(resultTable)
        .select('email')
        .eq('job_id', prev.job_id)
        .not('email', 'is', null);

      if (!data?.length) continue;

      const emails = [...new Set(
        (data as Record<string, unknown>[])
          .map((r) => String(r.email ?? '').trim().toLowerCase())
          .filter((e) => e.includes('@') && e.includes('.')),
      )];

      if (emails.length > 0) return emails;
    }
  }

  return [];
}

async function executeExportStep(pipeline: Pipeline): Promise<void> {
  const sb = ensureAdmin();
  const exportStep = pipeline.steps[pipeline.current_step_index];

  try {
    const result = await exportPipelineResults(pipeline);

    if (typeof result === 'string') {
      exportStep.status = 'completed';
      exportStep.completed_at = new Date().toISOString();
      exportStep.result_count = 0;

      await sb
        .from('agent_pipelines')
        .update({ status: 'completed', steps: pipeline.steps, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', pipeline.id);

      await sendMessage(pipeline.chat_id, `✅ Пайплайн «${pipeline.name}» завершён.\n${result}`);
      return;
    }

    await sendDocument(pipeline.chat_id, result.filename, result.buffer, `Пайплайн «${pipeline.name}»: ${result.rowCount} записей`);

    exportStep.status = 'completed';
    exportStep.completed_at = new Date().toISOString();
    exportStep.result_count = result.rowCount;

    await sb
      .from('agent_pipelines')
      .update({ status: 'completed', steps: pipeline.steps, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', pipeline.id);

    await sendMessage(pipeline.chat_id, `✅ Пайплайн «${pipeline.name}» завершён! Файл отправлен (${result.rowCount} записей).`);

    await logAudit('telegram-agent.pipeline.completed', `Pipeline "${pipeline.name}" completed`, {
      pipelineId: pipeline.id,
      userId: pipeline.user_id,
      totalSteps: pipeline.steps.length,
      rowCount: result.rowCount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    exportStep.status = 'failed';
    exportStep.error = msg;

    await sb
      .from('agent_pipelines')
      .update({ status: 'failed', steps: pipeline.steps, error_message: msg, updated_at: new Date().toISOString() })
      .eq('id', pipeline.id);

    await sendMessage(pipeline.chat_id, `❌ Пайплайн «${pipeline.name}» — ошибка экспорта: ${msg}`);
    await logError('telegram-agent.pipeline.export-error', err);
  }
}

function describeStep(step: PipelineStep): string {
  const labels: Record<string, string> = {
    parse_hh: 'Парсинг HH',
    parse_search: 'Поисковый парсер',
    parse_yandex_maps: 'Яндекс.Карты',
    clean_names: 'Очистка названий',
    enrich_emails: 'Поиск email',
    validate_emails: 'Валидация email',
    deduplicate: 'Дедупликация',
    export: 'Экспорт CSV',
  };
  return labels[step.type] ?? step.type;
}

const STATUS_EMOJI: Record<string, string> = {
  pending: '⏳',
  running: '🔄',
  completed: '✅',
  failed: '❌',
  skipped: '⏭️',
};

function formatPipelineStatus(p: Pipeline): string {
  const statusEmoji = STATUS_EMOJI[p.status] ?? '❓';
  const lines = [`${statusEmoji} <b>${p.name}</b> (${p.status})`];

  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i];
    const emoji = STATUS_EMOJI[s.status] ?? '❓';
    const count = s.result_count != null ? ` — ${s.result_count} результатов` : '';
    lines.push(`  ${i + 1}. ${emoji} ${describeStep(s)}${count}`);
  }

  if (p.error_message) lines.push(`\nОшибка: ${p.error_message}`);
  return lines.join('\n');
}
