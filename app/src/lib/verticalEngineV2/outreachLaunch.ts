import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { approveVeContactSupply } from './contactSupplyApproval';
import { buildVeContactDeliveryPreview } from './contactDeliveryPreview';
import { activateVeLaunchPortfolioItem } from './launchActivation';
import { parseLaunchInfo, VE_LAUNCH_MAX_LEADS } from './launchHandoff';
import { runVeTemplateLaunch } from './launchTemplate';
import { prepareAuditSnapshot, validateStoredAuditSnapshot } from './stages/segmentationAudit';
import { requeueVeJob, type VeStageContext, type VeStageResult } from './stages/shared';
import type { VeBase, VeJob, VeSegmentationAudit, VeTemplate } from './types';

const itemSchema = z.object({
  hypothesis_id: z.string().uuid(), base_id: z.string().uuid(), template_id: z.string().uuid(),
  preview_revision: z.string().min(1).max(128), segmentation_audit_id: z.string().uuid().optional(),
}).strict();
export const outreachLaunchRequestSchema = z.object({
  setup_revision: z.number().int().positive(), preset_id: z.string().min(1).max(200),
  portal_project_id: z.string().uuid(), expected_portal_period_id: z.string().uuid(),
  target_contacts: z.number().int().positive().max(1_000_000), items: z.array(itemSchema).min(1).max(50),
}).strict();
export type VeOutreachLaunchRequest = z.infer<typeof outreachLaunchRequestSchema>;
type LaunchItem = VeOutreachLaunchRequest['items'][number];
type RunItem = LaunchItem & { status: 'queued' | 'approving' | 'creating' | 'activating' | 'waiting' | 'active' | 'blocked';
  item_id?: string; error?: string; code?: string; campaigns?: unknown; last_attempt_at?: string };
export interface VeOutreachRun {
  id: string; project_id: string; requested_by: string; status: 'queued' | 'running' | 'waiting' | 'active' | 'blocked' | 'cancelled';
  request: VeOutreachLaunchRequest; request_hash: string; items: RunItem[]; error: string | null; created_at: string; updated_at: string;
}
export class VeOutreachLaunchError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
function fail(message: string): never { throw new VeOutreachLaunchError(message); }
const sorted = (values: string[]) => [...values].sort();
function canonicalRequest(input: VeOutreachLaunchRequest): VeOutreachLaunchRequest {
  return { ...input, items: [...input.items].sort((a, b) => a.hypothesis_id.localeCompare(b.hypothesis_id)) };
}
function requestHash(request: VeOutreachLaunchRequest) { return createHash('sha256').update(JSON.stringify(canonicalRequest(request))).digest('hex'); }
function activationKey(runId: string, templateId: string, planVersion: unknown): string {
  const hex = createHash('sha256').update(JSON.stringify([runId, templateId, planVersion])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function uniqueItems(request: VeOutreachLaunchRequest) {
  for (const key of ['hypothesis_id', 'base_id', 'template_id'] as const) {
    if (new Set(request.items.map((item) => item[key])).size !== request.items.length) fail('Каждая гипотеза должна иметь одну выбранную базу и одну версию писем.');
  }
}
async function readSetup(db: SupabaseClient, projectId: string, request: VeOutreachLaunchRequest) {
  uniqueItems(request);
  const { data, error } = await db.from('ve_outreach_setups').select('*').eq('project_id', projectId).maybeSingle();
  if (error) throw new VeOutreachLaunchError('Настройка запуска недоступна. Проверьте выпуск миграции автоаутрича.', 503);
  if (!data || Number(data.revision) !== request.setup_revision) fail('Выбранные гипотезы или согласования изменились. Обновите обзор запуска.');
  if (JSON.stringify(sorted(data.selected_hypothesis_ids ?? [])) !== JSON.stringify(sorted(request.items.map((item) => item.hypothesis_id)))) {
    fail('Состав запуска не совпадает с сохранённым выбором гипотез.');
  }
  for (const item of request.items) {
    const approval = data.approved_bases?.[item.base_id];
    if (approval?.template_id !== item.template_id || approval?.revision !== item.preview_revision) fail('База или письма изменились после одобрения. Проверьте их заново.');
  }
}
async function readItem(db: SupabaseClient, projectId: string, item: LaunchItem) {
  const [{ data: template, error: templateError }, { data: base, error: baseError }] = await Promise.all([
    db.from('ve_templates').select('*').eq('id', item.template_id).maybeSingle(),
    db.from('ve_bases').select('*').eq('id', item.base_id).maybeSingle(),
  ]);
  if (templateError || baseError) throw new VeOutreachLaunchError('Не удалось проверить сохранённые письма и базу.', 503);
  if (!template || !base || template.base_id !== base.id || base.project_id !== projectId
    || base.hypothesis_id !== item.hypothesis_id || template.status !== 'ready' || template.supply_batch_id
    || base.status !== 'analyzed' || base.collect_info?.collection_mode !== 'preview') fail('Письма или одобренная база ещё не готовы к запуску.');
  if (!Array.isArray(template.letters) || !template.letters.length || template.letters.some((letter: { selected_variant?: unknown }) => !['A', 'B'].includes(String(letter.selected_variant)))) {
    fail('Откройте и сохраните итоговые письма: для каждого письма нужен выбранный вариант A или B.');
  }
  const { data: revision, error } = await db.rpc('ve_contact_supply_preview_revision', { p_template_id: item.template_id });
  if (error || revision !== item.preview_revision) fail('Одобренная версия базы или писем изменилась. Требуется повторный просмотр.');
  return { template: template as VeTemplate & { launch_info?: unknown }, base: base as VeBase };
}
async function readAudit(db: SupabaseClient, item: LaunchItem) {
  const { data, error } = await db.from('ve_segmentation_audits').select('*').eq('id', item.segmentation_audit_id!).maybeSingle();
  if (error) throw new VeOutreachLaunchError('Проверка аудитории недоступна.', 503);
  if (!data || data.template_id !== item.template_id || data.base_id !== item.base_id) fail('Показанная проверка аудитории больше не доступна.');
  return data as VeSegmentationAudit;
}
function deliveryInput(request: VeOutreachLaunchRequest, item: LaunchItem) {
  return { templateId: item.template_id, presetId: request.preset_id, portalProjectId: request.portal_project_id,
    expectedPortalPeriodId: request.expected_portal_period_id, targetContacts: request.target_contacts, segmentationAuditId: item.segmentation_audit_id };
}

/** Explicit launch-overview preparation. Completed current audits are read, never bought again by polling. */
export async function prepareVeOutreachLaunch(db: SupabaseClient, instantlyDb: SupabaseClient, input: {
  projectId: string; userId: string; request: VeOutreachLaunchRequest; retryFailedAudits?: boolean;
}) {
  const { projectId, userId, request } = input;
  await readSetup(db, projectId, request);
  const items: Array<Record<string, unknown>> = [];
  for (const item of request.items) {
    try {
      const { template, base } = await readItem(db, projectId, item);
      if (parseLaunchInfo(template.launch_info)) fail('Для этой базы уже созданы кампании. Используйте существующий запуск.');
      const snapshot = prepareAuditSnapshot(template, base);
      if (!snapshot.audience.leads.length || snapshot.audience.leads.length > VE_LAUNCH_MAX_LEADS) fail('Количество проверенных адресатов не подходит для запуска.');
      const { data: audits, error } = await db.from('ve_segmentation_audits').select('*').eq('template_id', item.template_id)
        .eq('base_id', item.base_id).order('created_at', { ascending: false }).limit(10);
      if (error) throw new VeOutreachLaunchError('Не удалось загрузить проверку аудитории.', 503);
      const current = (audits ?? []).find((audit) => validateStoredAuditSnapshot({ audit, template, base }).state === 'current') as VeSegmentationAudit | undefined;
      if (current) {
        const reviewed = { ...item, segmentation_audit_id: current.id };
        const preview = await buildVeContactDeliveryPreview(db, instantlyDb, deliveryInput(request, reviewed));
        if (preview.status !== 200) fail(typeof preview.body.error === 'string' ? preview.body.error : 'Не удалось проверить условия отправки.');
        const details = preview.body.preview as { prospective_ready?: number; sender_capacity?: number } | undefined;
        if (!details?.prospective_ready || !details.sender_capacity) fail('Нет новых проверенных контактов или доступных отправителей.');
        items.push({ ...reviewed, status: 'ready', summary: current.summary, preview: preview.body.preview });
        continue;
      }
      const active = (audits ?? []).find((audit) => ['pending', 'running'].includes(audit.status));
      if (active) { items.push({ ...item, segmentation_audit_id: active.id, status: 'working' }); continue; }
      const latest = audits?.[0];
      if (latest && ['failed', 'cancelled'].includes(latest.status) && !input.retryFailedAudits) fail(latest.error || 'Проверка остановилась. Повторите проверку явно.');
      const { data: queued, error: queueError } = await db.rpc('ve_enqueue_segmentation_audit', {
        p_project_id: projectId, p_template_id: item.template_id, p_base_id: item.base_id, p_requested_by: userId,
      });
      const row = Array.isArray(queued) ? queued[0] : queued;
      if (queueError || !row?.audit_row?.id) throw new VeOutreachLaunchError('Не удалось поставить проверку аудитории в очередь.', 503);
      items.push({ ...item, segmentation_audit_id: row.audit_row.id, status: 'working' });
    } catch (error) {
      items.push({ ...item, status: 'blocked', error: error instanceof VeOutreachLaunchError ? error.message : 'Не удалось подготовить проверку запуска.' });
    }
  }
  return { ready: items.every((item) => item.status === 'ready'), items };
}

export async function startVeOutreach(db: SupabaseClient, instantlyDb: SupabaseClient, input: {
  projectId: string; userId: string; request: VeOutreachLaunchRequest; idempotencyKey: string; confirmedCustomerApproval: boolean;
}) {
  if (!input.confirmedCustomerApproval) fail('Подтвердите согласование баз и писем с заказчиком и разрешение на отправку.');
  const request = canonicalRequest(input.request), hash = requestHash(request);
  const { data: replay, error: replayError } = await db.from('ve_outreach_runs').select('*').eq('project_id', input.projectId)
    .eq('idempotency_key', input.idempotencyKey).maybeSingle();
  if (replayError) throw new VeOutreachLaunchError('Запуск недоступен. Проверьте выпуск миграции автоаутрича.', 503);
  if (replay) {
    if (replay.request_hash !== hash) fail('Этот запрос уже относится к другой версии запуска.');
    return { existing: true, run: replay as VeOutreachRun };
  }
  const { data: active, error: activeError } = await db.from('ve_outreach_runs').select('*').eq('project_id', input.projectId)
    .in('status', ['queued', 'running', 'waiting']).maybeSingle();
  if (activeError) throw new VeOutreachLaunchError('Не удалось проверить текущий запуск.', 503);
  if (active) {
    if (active.request_hash !== hash) fail('Предыдущий запуск ещё выполняется. Дождитесь его завершения.');
    return { existing: true, run: active as VeOutreachRun };
  }
  await readSetup(db, input.projectId, request);
  for (const item of request.items) {
    if (!item.segmentation_audit_id) fail('Дождитесь проверки аудитории и просмотрите обзор запуска.');
    const { template, base } = await readItem(db, input.projectId, item);
    if (parseLaunchInfo(template.launch_info)) fail('Для этой базы уже созданы кампании. Используйте существующий запуск.');
    const audit = await readAudit(db, item);
    if (validateStoredAuditSnapshot({ audit, template, base }).state !== 'current' || audit.launch_status !== 'idle') fail('Проверка аудитории изменилась или уже используется в запуске.');
    const preview = await buildVeContactDeliveryPreview(db, instantlyDb, deliveryInput(request, item));
    if (preview.status !== 200) fail(typeof preview.body.error === 'string' ? preview.body.error : 'Условия запуска недоступны.');
  }
  const { data, error } = await db.rpc('ve_start_outreach', { p_project_id: input.projectId, p_actor_id: input.userId,
    p_idempotency_key: input.idempotencyKey, p_request: request, p_request_hash: hash });
  if (error || !data?.run) throw new VeOutreachLaunchError(error?.message || 'Не удалось сохранить запуск.', 409);
  return { existing: data.existing === true, run: data.run as VeOutreachRun };
}

async function saveProgress(db: SupabaseClient, job: VeJob, run: VeOutreachRun) {
  const { data, error } = await db.rpc('ve_save_outreach_progress', {
    p_run_id: run.id, p_job_id: job.id, p_status: run.status, p_items: run.items, p_error: run.error,
  });
  if (error || data !== true) throw new Error('Outreach run lost job ownership or could not save progress');
}
const WAITING_ACTIVATION_CODES = new Set(['VE_LAUNCH_SLOT_OCCUPIED', 'VE_LAUNCH_TIMING_BLOCKED', 'VE_LAUNCH_HIGHER_PRIORITY_PENDING', 'VE_LAUNCH_PLAN_STALE', 'VE_LAUNCH_CAS_LOST']);

/** One durable project request, bounded to one unfinished hypothesis per worker turn. */
export async function runVeOutreachStartStage(job: VeJob, ctx: VeStageContext, instantlyDb: SupabaseClient): Promise<VeStageResult> {
  const db = ctx.supabase, runId = job.payload?.outreach_run_id;
  const { data: stored, error } = await db.from('ve_outreach_runs').select('*').eq('id', runId).eq('project_id', job.project_id).maybeSingle();
  if (error || !stored) throw new Error('Outreach run is unavailable');
  const run = stored as VeOutreachRun;
  if (['active', 'blocked', 'cancelled'].includes(run.status)) return { result: { outreach_run_id: run.id, status: run.status } };
  const request = run.request;
  const item = run.items.find((candidate) => !['active', 'blocked', 'waiting'].includes(candidate.status))
    ?? run.items.filter((candidate) => candidate.status === 'waiting')
      .sort((a, b) => Date.parse(a.last_attempt_at ?? '1970-01-01') - Date.parse(b.last_attempt_at ?? '1970-01-01'))[0];
  if (!item) { run.status = run.items.some((candidate) => candidate.status === 'blocked') ? 'blocked' : 'active'; await saveProgress(db, job, run); return { result: { outreach_run_id: run.id, status: run.status } }; }
  try {
    item.last_attempt_at = new Date().toISOString();
    ctx.signal?.throwIfAborted();
    await readSetup(db, job.project_id, request);
    const { template, base } = await readItem(db, job.project_id, item);
    const audit = await readAudit(db, item);
    if (validateStoredAuditSnapshot({ audit, template, base }).state !== 'current') fail('Одобренные письма или аудитория изменились. Требуется новый обзор запуска.');
    run.status = 'running'; run.error = null; delete item.error; delete item.code;
    await saveProgress(db, job, run);
    let launch = parseLaunchInfo(template.launch_info);
    if (!launch) {
      // A reserved or uncertain provider creation is not replayed blindly after restart.
      if (audit.launch_status !== 'idle') fail('Предыдущая попытка создания кампаний уже выполнялась. Проверьте её результат перед новым запуском.');
      item.status = 'approving'; await saveProgress(db, job, run); ctx.signal?.throwIfAborted();
      const approved = await approveVeContactSupply(db, instantlyDb, { ...deliveryInput(request, item), userId: run.requested_by,
        confirmed: true, reviewedRevision: item.preview_revision });
      if (approved.status !== 200) fail(typeof approved.body.error === 'string' ? approved.body.error : 'Не удалось закрепить согласованные условия.');
      item.status = 'creating'; await saveProgress(db, job, run); ctx.signal?.throwIfAborted();
      const created = await runVeTemplateLaunch({ portalDb: db, instantlyDb, ...deliveryInput(request, item),
        segmentationAuditId: item.segmentation_audit_id!, force: false, confirmSegmentation: true, userId: run.requested_by,
        locale: 'ru', eventPrefix: 'tools.vertical-engine-v2.outreach.start' });
      if (created.status < 200 || created.status >= 300) fail(typeof created.body.error === 'string' ? created.body.error : 'Не удалось подтвердить создание кампаний.');
      const { data: updated, error: readError } = await db.from('ve_templates').select('launch_info').eq('id', item.template_id).single();
      if (readError) throw new Error('Could not read committed campaign launch');
      launch = parseLaunchInfo(updated?.launch_info);
    }
    if (!launch || launch.reconciliation_required || launch.segmentation_audit_id !== item.segmentation_audit_id
      || launch.preset_id !== request.preset_id || launch.portal_project_id !== request.portal_project_id
      || launch.portal_period_id !== request.expected_portal_period_id || launch.target_contacts !== request.target_contacts) fail('Сохранённые кампании не соответствуют этому запуску. Нужна сверка.');
    const { data: queue, error: queueError } = await db.from('ve_launch_queue_items').select('id,status,plan_version')
      .eq('template_id', item.template_id).eq('project_id', job.project_id).maybeSingle();
    if (queueError || !queue) fail('Кампании сохранены, но очередь активации пока недоступна.');
    const planVersion = Number(queue.plan_version);
    if (!Number.isSafeInteger(planVersion) || planVersion < 1) fail('Версия очереди запуска недоступна.');
    item.item_id = queue.id; item.campaigns = launch.campaigns ?? [{ campaign_id: launch.campaign_id, campaign_url: launch.campaign_url }];
    if (queue.status === 'active') item.status = 'active';
    else {
      if (['uncertain', 'activating'].includes(queue.status)) fail('Состояние активации не подтверждено. Нужна сверка, повторная отправка не запускается.');
      if (queue.status !== 'queued') fail('Кампании выведены из очереди или остановлены. Автоматическое возобновление отключено.');
      item.status = 'activating'; await saveProgress(db, job, run); ctx.signal?.throwIfAborted();
      const activated = await activateVeLaunchPortfolioItem({ portalDb: db, itemId: queue.id, actorId: run.requested_by,
        body: { confirm_campaign_review: true, idempotency_key: activationKey(run.id, item.template_id, planVersion), plan_version: planVersion } });
      if (activated.status === 200) item.status = 'active';
      else if (WAITING_ACTIVATION_CODES.has(String(activated.body.code))) {
        item.status = 'waiting'; item.code = String(activated.body.code);
        item.error = item.code === 'VE_LAUNCH_TIMING_BLOCKED' ? 'Ожидает разрешённого времени запуска' : 'Ожидает свободных отправителей и своей очереди';
      } else fail(typeof activated.body.error === 'string' ? activated.body.error : 'Не удалось подтвердить активацию.');
    }
  } catch (error_) {
    ctx.signal?.throwIfAborted();
    item.status = 'blocked'; item.error = error_ instanceof VeOutreachLaunchError ? error_.message : 'Запуск остановлен из-за технической ошибки. Сохранённые кампании не создаются повторно.';
  }
  run.status = run.items.every((candidate) => candidate.status === 'active') ? 'active'
    : run.items.every((candidate) => ['active', 'blocked'].includes(candidate.status)) ? 'blocked' : 'waiting';
  run.error = run.items.find((candidate) => candidate.status === 'blocked')?.error ?? null;
  await saveProgress(db, job, run);
  if (run.status === 'waiting') await requeueVeJob(ctx, job, item.status === 'waiting' ? 60_000 : 1000);
  return { result: { outreach_run_id: run.id, status: run.status } };
}
