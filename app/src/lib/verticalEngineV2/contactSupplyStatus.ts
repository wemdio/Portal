import type { SupabaseClient } from '@supabase/supabase-js';
import { buildVeContactDeliveryPreview } from './contactDeliveryPreview';
import { readContactDeliveryPages } from './contactDeliveryInventory';
import { getBlockedEmailSet } from '@/lib/clientBlocklist/blockedContacts';
import { allocateContactSupplyTargets } from './contactSupplyPlanner';

export interface VeContactSupplyStatus {
  required: boolean;
  preview_revision?: string;
  plan: null | {
    id: string;
    status: 'approved' | 'active' | 'paused' | 'exhausted' | 'limited' | 'error';
    current: boolean;
    approved_at: string;
    launched: boolean;
    preset_id: string;
    portal_project_id: string;
    portal_period_id: string;
    target_contacts: number;
    error: string | null;
  };
  metrics: null | {
    ready: number;
    uploaded: number;
    uploaded_today: number;
    uncertain: number;
    project_first_contacted: number;
    project_daily_plan: number;
    project_required_daily: number;
    project_ready: number;
    project_stock_workdays: number | null;
    hypothesis_daily_target: number;
    hypothesis_stock_workdays: number | null;
    hypothesis_estimated_workdays: number | null;
    business_date: string;
    timezone: string;
  };
  estimate: null | { contacts: number; as_of: string; scope: string; confidence: 'low' };
  metrics_error?: string;
}

/** Read-only display data; only facts from the ledger, never provider calls. */
export async function loadVeContactSupplyStatus(db: SupabaseClient, instantlyDb: SupabaseClient, templateId: string): Promise<VeContactSupplyStatus> {
  const { data: template, error: templateError } = await db.from('ve_templates')
    .select('base_id, supply_batch_id').eq('id', templateId).maybeSingle();
  if (templateError || !template || template.supply_batch_id) throw new Error('Шаблон недоступен');
  const { data: base, error: baseError } = await db.from('ve_bases')
    .select('id, collect_info').eq('id', template.base_id).maybeSingle();
  if (baseError || !base) throw new Error('Превью недоступно');
  const result: VeContactSupplyStatus = { required: base.collect_info?.collection_mode === 'preview', plan: null, metrics: null, estimate: null };
  if (!result.required) return result;
  const { data: revision, error: revisionError } = await db.rpc('ve_contact_supply_preview_revision', { p_template_id: templateId });
  if (revisionError || typeof revision !== 'string') throw new Error('Не удалось зафиксировать версию превью');
  result.preview_revision = revision;
  const { data: plan, error } = await db.from('ve_contact_supply_plans').select('*').eq('template_id', templateId).maybeSingle();
  if (error) throw new Error('Автопополнение недоступно. Проверьте миграцию и доступ к данным.');
  if (!plan) return result;
  const { data: current, error: currentError } = await db.rpc('ve_contact_supply_approval_current', { p_plan_id: plan.id });
  if (currentError) throw new Error('Не удалось проверить актуальность согласования');
  const binding = plan.approval_snapshot;
  result.plan = {
    id: plan.id, status: plan.status, current: current === true, approved_at: plan.approved_at,
    launched: Boolean(plan.item_id), preset_id: binding.preset_id, portal_project_id: binding.portal_project_id,
    portal_period_id: binding.portal_period_id, target_contacts: binding.target_contacts, error: plan.last_error,
  };
  const preview = await buildVeContactDeliveryPreview(db, instantlyDb, {
    templateId, presetId: binding.preset_id, portalProjectId: binding.portal_project_id,
    expectedPortalPeriodId: binding.portal_period_id, targetContacts: binding.target_contacts,
    segmentationAuditId: plan.preview_audit_id,
  });
  if (preview.status !== 200) {
    result.metrics_error = 'Не удалось пересчитать план и запас. Проверьте активный период и аудит.';
    return result;
  }
  const p = preview.body.preview as Record<string, number | string>;
  const rows = plan.item_id ? await readContactDeliveryPages<{status: string; finalized_at: string | null; email_normalized: string}>(
    'supply display inventory', (from, to) => db.from('ve_contact_delivery_rows')
      .select('status, finalized_at, email_normalized', { count: 'exact' }).eq('item_id', plan.item_id)
      .order('id').range(from, to),
  ) : [];
  const { data: preset, error: presetError } = await instantlyDb.from('client_campaign_presets')
    .select('client_user_id').eq('id', binding.preset_id).maybeSingle();
  if (presetError || !preset?.client_user_id) throw new Error('Не удалось проверить запас клиента');
  const blocked = await getBlockedEmailSet(instantlyDb, preset.client_user_id);
  const items = await readContactDeliveryPages<{id: string; potential_pct: number}>(
    'supply display weights', (from, to) => db.from('ve_launch_queue_items')
      .select('id, potential_pct', { count: 'exact' }).eq('project_id', plan.project_id).eq('status', 'active')
      .order('id').range(from, to),
  );
  const { data: dayRun, error: dayError } = await db.from('ve_contact_delivery_daily_runs')
    .select('effective_count').eq('ve_project_id', plan.project_id).eq('portal_period_id', binding.portal_period_id)
    .eq('run_date', p.business_date).maybeSingle();
  if (dayError) throw new Error('Не удалось сверить сегодняшний план');
  const timezone = String(p.delivery_timezone);
  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDate = (value: string | null): string | null => {
    if (!value || !Number.isFinite(Date.parse(value))) return null;
    const parts = new Map(dateFormatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
  };
  const requiredDaily = Math.min(Number(p.required_daily), Number(p.sender_capacity));
  const dailyTarget = allocateContactSupplyTargets(requiredDaily, items.map((item) => ({ id: item.id, weight: item.potential_pct })))
    .find((item) => item.itemId === plan.item_id)?.contacts ?? 0;
  const ready = plan.item_id ? rows.filter((row) => row.status === 'ready' && !blocked.has(row.email_normalized)).length : Number(p.prospective_ready);
  result.metrics = {
    ready,
    uploaded: rows.filter((row) => row.status === 'accepted').length,
    uploaded_today: rows.filter((row) => row.status === 'accepted' && localDate(row.finalized_at) === p.business_date).length,
    uncertain: rows.filter((row) => row.status === 'uncertain' || row.status === 'attempting').length,
    project_first_contacted: Number(p.contacts_done_count), project_daily_plan: dayRun?.effective_count ?? Number(p.effective_daily),
    project_required_daily: requiredDaily, project_ready: Number(p.ready_remaining),
    project_stock_workdays: requiredDaily > 0 ? Math.floor(Number(p.ready_remaining) / requiredDaily) : null,
    hypothesis_daily_target: dailyTarget,
    hypothesis_stock_workdays: dailyTarget > 0 ? Math.floor(ready / dailyTarget) : null,
    hypothesis_estimated_workdays: null,
    business_date: String(p.business_date), timezone,
  };
  // Only the collector can prove the source scope. An absent estimate stays unknown.
  // A subsequent batch with unknown coverage invalidates the old first-preview
  // estimate; do not silently keep showing the original market remainder.
  const estimate = plan.source_state?.previous_base_id
    ? plan.estimate?.remaining_ready_estimate : base.collect_info?.estimate?.remaining_ready_estimate;
  if (estimate && Number.isSafeInteger(estimate.contacts) && estimate.contacts >= 0
    && typeof estimate.as_of === 'string' && typeof estimate.scope === 'string') {
    result.estimate = { contacts: estimate.contacts, as_of: estimate.as_of, scope: estimate.scope, confidence: 'low' };
    result.metrics.hypothesis_estimated_workdays = dailyTarget > 0 ? Math.floor((ready + estimate.contacts) / dailyTarget) : null;
  }
  return result;
}
