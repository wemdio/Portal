/** Continuous validated supply; only the existing daily runner talks to Instantly. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getBlockedEmailSet } from '@/lib/clientBlocklist/blockedContacts';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { loadContactDeliverySettings } from './contactDeliveryConfig';
import { buildContactDeliveryPlan } from './contactDeliveryPlanner';
import { buildContactSupplyRequests } from './contactSupplyPlanner';
import { parseExactNonNegativeContactCount } from './contactDeliveryPreview';
import { loadVeContactDeliveryCampaignInventory, loadVeContactDeliveryRows, readContactDeliveryPages } from './contactDeliveryInventory';
import { buildSegmentationLaunchGroups } from './segmentationAudit';
import { validateStoredAuditSnapshot } from './stages/segmentationAudit';
import type { VeBase, VeSegmentationAudit, VeTemplate } from './types';

const BUFFER_WORKDAYS = 2;
export { buildContactSupplyRequests } from './contactSupplyPlanner';
type SupplyStop = 'active' | 'exhausted' | 'limited' | 'error';
type SupplyProgress = { status?: unknown; reason?: unknown; ready_rows?: unknown };
export interface ContactSupplyPlanRow {
  id: string;
  project_id: string;
  hypothesis_id: string;
  template_id: string;
  item_id: string | null;
  status: 'approved' | 'active' | 'paused' | 'exhausted' | 'limited' | 'error';
  source_state?: { previous_base_id?: string } | null;
}
interface SupplyBatch {
  id: string;
  plan_id: string;
  base_id: string;
  template_id: string;
  audit_id: string | null;
  appended_count: number;
  status: 'collecting' | 'auditing' | 'ready' | 'appended' | 'failed';
  error?: string | null;
}
interface SupplyItem { id: string; potential_pct: number; status: string }
interface SupplyCampaign { id: string; item_id: string; campaign_id: string; segment: string | null }
export interface ContactSupplyResult {
  checkedPlans: number;
  queuedBatches: number;
  auditingBatches: number;
  appendedRows: number;
  stoppedPlans: number;
}

async function rpc(db: SupabaseClient, name: string, parameters: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, parameters);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function finishBatch(db: SupabaseClient, batch: SupplyBatch, status: SupplyStop, error: string | null, now: Date) {
  await rpc(db, 've_finish_contact_supply_batch', {
    p_batch_id: batch.id, p_status: status, p_error: error?.slice(0, 500) ?? null, p_now: now.toISOString(),
  });
}

function sourceOutcome(progress: SupplyProgress | null | undefined): { status: SupplyStop; reason: string | null } {
  const reason = typeof progress?.reason === 'string' ? progress.reason : null;
  if (progress?.status === 'target_reached') return { status: 'active', reason };
  if (progress?.status === 'exhausted' || progress?.status === 'limited' || progress?.status === 'error') {
    return { status: progress.status, reason };
  }
  return { status: 'error', reason: 'Сбор не подтвердил полный результат и состояние источников' };
}

function confirmedAppendOutcome(source: ReturnType<typeof sourceOutcome>, count: unknown) {
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('Supply append result did not confirm an exact inserted count');
  }
  return {
    appendedCount: count,
    status: count === 0 && source.status === 'active' ? 'limited' as const : source.status,
    reason: source.reason ?? (count === 0 ? 'Новых получателей после проверок и исключений нет' : null),
  };
}

async function loadSupplyContext(portalDb: SupabaseClient, instantlyDb: SupabaseClient, projectId: string, now: Date) {
  const { data: project, error: projectError } = await portalDb.from('ve_projects')
    .select('id, portal_project_id, portal_period_id, target_contacts, launch_preset_id, launch_instantly_account_id')
    .eq('id', projectId).maybeSingle();
  if (projectError || !project?.portal_project_id || !project.portal_period_id || !project.launch_preset_id
    || !Number.isSafeInteger(project.target_contacts) || project.target_contacts <= 0) {
    throw new Error('Continuous supply requires an explicitly bound delivery plan');
  }
  const { data: period, error: periodError } = await portalDb.from('project_periods')
    .select('id, project_id, status, contacts_done, deadline')
    .eq('id', project.portal_period_id).eq('project_id', project.portal_project_id).eq('status', 'active').maybeSingle();
  const contactsDone = parseExactNonNegativeContactCount(period?.contacts_done);
  if (periodError || !period || contactsDone === null || typeof period.deadline !== 'string') {
    throw new Error('Continuous supply requires the current active period and exact fulfillment facts');
  }
  const { data: preset, error: presetError } = await instantlyDb.from('client_campaign_presets')
    .select('client_user_id, instantly_account_id, daily_limit, daily_max_leads, schedule_days, schedule_timezone')
    .eq('id', project.launch_preset_id).maybeSingle();
  if (presetError || !preset?.client_user_id
    || resolveInstantlyAccountId(preset.instantly_account_id) !== project.launch_instantly_account_id) {
    throw new Error('Continuous supply preset/workspace scope is not current');
  }
  const settings = await loadContactDeliverySettings(portalDb, projectId, {
    portalProjectId: project.portal_project_id, portalPeriodId: project.portal_period_id,
    targetContacts: project.target_contacts, presetId: project.launch_preset_id,
  }, preset);
  const [inventory, rows, blocked, items] = await Promise.all([
    loadVeContactDeliveryCampaignInventory(portalDb, instantlyDb, projectId),
    loadVeContactDeliveryRows(portalDb, projectId),
    getBlockedEmailSet(instantlyDb, preset.client_user_id),
    readContactDeliveryPages<SupplyItem>('active supply items', (from, to) => portalDb.from('ve_launch_queue_items')
      .select('id, status, potential_pct', { count: 'exact' }).eq('project_id', projectId).eq('status', 'active')
      .order('id', { ascending: true }).range(from, to)),
  ]);
  const campaigns = items.length ? await readContactDeliveryPages<SupplyCampaign>('supply campaign mapping', (from, to) => portalDb
    .from('ve_launch_queue_campaigns').select('id, item_id, campaign_id, segment', { count: 'exact' })
    .in('item_id', items.map((item) => item.id)).order('id', { ascending: true }).range(from, to)) : [];
  const activeCampaignRows = new Set(inventory.activeCampaignRowIds);
  const committed = rows.filter((row) => ['accepted', 'attempting', 'uncertain'].includes(row.status)).length;
  const outstanding = Math.max(0, committed - Math.min(inventory.observedFirstContacted, contactsDone));
  const plan = buildContactDeliveryPlan({
    now, timezone: settings.timezone, deadline: period.deadline, scheduleDays: settings.scheduleDays,
    contactsObligation: project.target_contacts, contactsDone, dailyCapacity: settings.dailyCapacity,
    // Forecast demand independently of today's shortage, which this loop fills.
    availableContacts: Math.max(0, project.target_contacts - contactsDone), outstandingContacts: outstanding,
  });
  const bufferTarget = plan.days.slice(0, BUFFER_WORKDAYS).reduce((sum, day) => sum + day.quota, 0);
  const campaignItems = new Map(campaigns.map((campaign) => [campaign.id, campaign.item_id]));
  const requests = buildContactSupplyRequests(bufferTarget, items.map((item) => ({
    id: item.id, weight: item.potential_pct,
    ready: rows.filter((row) => activeCampaignRows.has(row.campaign_row_id)
      && campaignItems.get(row.campaign_row_id) === item.id
      && (row.status === 'ready' || row.status === 'reserved') && !blocked.has(row.email_normalized)).length,
  })));
  return { requests, campaigns, blocked, existingEmails: new Set(rows.map((row) => row.email_normalized)),
    eligibleToday: plan.remainingContacts > 0 && plan.days.some((day) => day.date === plan.businessDate) };
}

/** One bounded sweep; DB RPCs own cross-worker reservation and append idempotency. */
export async function runProjectContactSupply(input: {
  portalDb: SupabaseClient; instantlyDb: SupabaseClient; veProjectId: string; now?: Date;
}): Promise<ContactSupplyResult> {
  const { portalDb, instantlyDb, veProjectId } = input;
  const now = input.now ?? new Date();
  const result: ContactSupplyResult = { checkedPlans: 0, queuedBatches: 0, auditingBatches: 0, appendedRows: 0, stoppedPlans: 0 };
  const plans = await readContactDeliveryPages<ContactSupplyPlanRow>('active contact supply plans', (from, to) => portalDb
    .from('ve_contact_supply_plans').select('id, project_id, hypothesis_id, template_id, item_id, status, source_state', { count: 'exact' })
    .eq('project_id', veProjectId).eq('status', 'active').order('id', { ascending: true }).range(from, to));
  const approved: ContactSupplyPlanRow[] = [];
  for (const plan of plans) {
    result.checkedPlans += 1;
    if (!plan.item_id) continue;
    if (await rpc(portalDb, 've_contact_supply_approval_current', { p_plan_id: plan.id }) !== true) {
      await rpc(portalDb, 've_pause_contact_supply_plan', {
        p_plan_id: plan.id, p_error: 'Условия запуска изменились: требуется повторное подтверждение', p_now: now.toISOString(),
      });
      result.stoppedPlans += 1;
    } else approved.push(plan);
  }
  if (!approved.length) return result;
  const context = await loadSupplyContext(portalDb, instantlyDb, veProjectId, now);
  if (!context.eligibleToday) return result;
  const batches = await readContactDeliveryPages<SupplyBatch>('contact supply batches', (from, to) => portalDb
    .from('ve_contact_supply_batches').select('id, plan_id, base_id, template_id, audit_id, status, appended_count, error', { count: 'exact' })
    .in('plan_id', approved.map((plan) => plan.id)).order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, to));
  let pendingWork = false;
  for (const plan of approved) {
    if (!context.campaigns.some((campaign) => campaign.item_id === plan.item_id)) continue;
    const batch = batches.find((entry) => entry.plan_id === plan.id);
    if (!batch) continue;
    // source_state is updated atomically with terminal processing. An explicit
    // resume must not re-apply that old terminal decision on every sweep.
    if (['appended', 'failed'].includes(batch.status) && plan.source_state?.previous_base_id === batch.base_id) continue;
    const { data: rawBase, error: baseError } = await portalDb.from('ve_bases')
      .select('id, project_id, status, collect_info->target_progress').eq('id', batch.base_id).maybeSingle();
    if (baseError || !rawBase || rawBase.project_id !== veProjectId) throw new Error('Supply batch source is unavailable');
    // Do not repeatedly transfer harvest/checkpoints/full data while collection
    // or the async audit is still working. PostgREST names this JSON projection
    // after its last key.
    const progress = rawBase.target_progress as SupplyProgress | null | undefined;
    const outcome = sourceOutcome(progress);
    if (batch.status === 'appended') {
      const confirmed = confirmedAppendOutcome(outcome, batch.appended_count);
      await finishBatch(portalDb, batch, confirmed.status, confirmed.reason, now);
      if (confirmed.status !== 'active') result.stoppedPlans += 1;
      pendingWork = true;
      continue;
    }
    pendingWork = true;
    if (rawBase.status === 'collecting') continue;
    if (rawBase.status === 'failed' || batch.status === 'failed') {
      await finishBatch(portalDb, batch, 'error', batch.error ?? outcome.reason ?? 'Сбор базы завершился ошибкой', now);
      result.stoppedPlans += 1;
      continue;
    }
    if (rawBase.status !== 'analyzed') continue;
    if (progress?.ready_rows === 0) {
      await finishBatch(portalDb, batch, outcome.status === 'active' ? 'limited' : outcome.status,
        outcome.reason ?? 'Сбор не вернул новых проверенных получателей', now);
      result.stoppedPlans += 1;
      continue;
    }
    if (!batch.audit_id) {
      await rpc(portalDb, 've_enqueue_contact_supply_audit', { p_batch_id: batch.id, p_now: now.toISOString() });
      result.auditingBatches += 1;
      continue;
    }
    const [{ data: audit, error: auditError }, { data: template, error: templateError }] = await Promise.all([
      portalDb.from('ve_segmentation_audits').select('*').eq('id', batch.audit_id).maybeSingle(),
      portalDb.from('ve_templates').select('id, base_id, letters, personalization_plan, status').eq('id', batch.template_id).maybeSingle(),
    ]);
    if (auditError || templateError || !audit || !template) throw new Error('Supply segmentation audit is unavailable');
    if (audit.status === 'pending' || audit.status === 'running') continue;
    const { data: baseData, error: dataError } = await portalDb.from('ve_bases')
      .select('id, project_id, columns, data, source').eq('id', batch.base_id).maybeSingle();
    if (dataError || !baseData) throw new Error('Supply audit source rows are unavailable');
    const base = baseData as VeBase;
    const validation = template.status === 'ready'
      ? validateStoredAuditSnapshot({ audit: audit as VeSegmentationAudit, template: template as VeTemplate, base })
      : { state: 'stale' as const };
    if (validation.state !== 'current') {
      await finishBatch(portalDb, batch, 'error', 'Аудит новой партии не завершён полностью или устарел', now);
      result.stoppedPlans += 1;
      continue;
    }
    const groups = buildSegmentationLaunchGroups({
      segments: validation.snapshot.segments, leadCount: validation.snapshot.audience.leads.length,
      classification: { assignments: validation.assignments, unclassifiedRows: [], failedBatches: 0, totalBatches: 0, usage: { tokensUsed: 0, costUsd: 0 } },
    });
    const campaigns = context.campaigns.filter((campaign) => campaign.item_id === plan.item_id);
    const rows: Array<{ campaign_id: string; source_row_index: number; lead_payload: Record<string, unknown>; email_normalized: string }> = [];
    let missingCampaign = false;
    for (const group of groups) {
      const allowed = group.leadIndices.filter((index) => {
        const email = validation.snapshot.audience.leads[index].email.trim().toLowerCase();
        return !context.blocked.has(email) && !context.existingEmails.has(email);
      });
      if (!allowed.length) continue;
      const matches = campaigns.filter((campaign) => (campaign.segment ?? null) === group.segment);
      if (matches.length !== 1) { missingCampaign = true; break; }
      for (const index of allowed) {
        const lead = validation.snapshot.audience.leads[index];
        const email = lead.email.trim().toLowerCase();
        rows.push({
          campaign_id: matches[0].campaign_id, source_row_index: index, lead_payload: { ...lead }, email_normalized: email,
        });
      }
    }
    if (missingCampaign) {
      await finishBatch(portalDb, batch, 'limited', 'У нового сегмента нет исходной кампании: нужен отдельный подтверждённый запуск', now);
      result.stoppedPlans += 1;
      continue;
    }
    const appended = await rpc(portalDb, 've_append_contact_supply_batch', {
      p_batch_id: batch.id, p_audit_id: audit.id, p_rows: rows, p_now: now.toISOString(),
    }) as { appended_count?: number } | null;
    const confirmed = confirmedAppendOutcome(outcome, appended?.appended_count);
    result.appendedRows += confirmed.appendedCount;
    // Zero useful rows alone is never evidence that the market is exhausted.
    await finishBatch(portalDb, batch, confirmed.status, confirmed.reason, now);
    if (confirmed.status !== 'active') result.stoppedPlans += 1;
  }
  // Collection itself is project-serial. Finish existing work before buying
  // another bounded source batch; next sweep sees freshly appended inventory.
  if (pendingWork) return result;
  for (const request of context.requests) {
    const plan = approved.find((entry) => entry.item_id === request.itemId);
    if (!plan) continue;
    const enqueued = await rpc(portalDb, 've_enqueue_contact_supply_batch', {
      p_plan_id: plan.id, p_limit: request.readyTarget, p_now: now.toISOString(),
    }) as { created?: boolean } | null;
    if (enqueued?.created) result.queuedBatches += 1;
    break;
  }
  return result;
}
