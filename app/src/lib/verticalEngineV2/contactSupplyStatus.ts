import type { SupabaseClient } from '@supabase/supabase-js';
import { buildVeContactDeliveryPreview } from './contactDeliveryPreview';
import { readContactDeliveryPages } from './contactDeliveryInventory';
import { getBlockedEmailSet } from '@/lib/clientBlocklist/blockedContacts';
import { allocateContactSupplyTargets } from './contactSupplyPlanner';
import { buildVeBaseAudienceSummary, type VeAudienceBase, type VeBaseAudienceSummary } from './baseAudienceSummary';
import { localIsoDate } from './portalDeliveryTerm';

type SupplyStock = {
  ready: number; uploaded: number; uploaded_today: number; uncertain: number;
  business_date: string; timezone: string;
};

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
    /** null — проект Portal без периодов. */
    portal_period_id: string | null;
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
  /** Confirmed ledger facts remain visible when the forecast is unavailable. */
  stock?: SupplyStock;
  analytics_pending?: boolean;
  /** Available before approval; facts and forecast never require creating a plan. */
  audience?: VeBaseAudienceSummary;
}

/** Read-only display data; only facts from the ledger, never provider calls. */
export async function loadVeContactSupplyStatus(db: SupabaseClient, instantlyDb: SupabaseClient, templateId: string): Promise<VeContactSupplyStatus> {
  const { data: template, error: templateError } = await db.from('ve_templates')
    .select('base_id, supply_batch_id').eq('id', templateId).maybeSingle();
  if (templateError || !template || template.supply_batch_id) throw new Error('Шаблон недоступен');
  const { data: base, error: baseError } = await db.from('ve_bases')
    .select('id, project_id, hypothesis_id, data, columns, source, status, updated_at, collect_info').eq('id', template.base_id).maybeSingle();
  if (baseError || !base) throw new Error('Превью недоступно');
  const result: VeContactSupplyStatus = { required: base.collect_info?.collection_mode === 'preview', plan: null, metrics: null, estimate: null };
  result.audience = buildVeBaseAudienceSummary(base as VeAudienceBase);
  result.estimate = result.audience.estimate;
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
    portal_period_id: binding.portal_period_id ?? null, target_contacts: binding.target_contacts, error: plan.last_error,
  };
  // A later batch with unknown coverage invalidates the first preview's estimate,
  // including while analytics/forecast are unavailable.
  const estimate = plan.source_state?.previous_base_id
    ? plan.estimate?.remaining_ready_estimate : base.collect_info?.estimate?.remaining_ready_estimate;
  result.estimate = estimate && Number.isSafeInteger(estimate.contacts) && estimate.contacts >= 0 &&
    typeof estimate.as_of === 'string' && typeof estimate.scope === 'string'
    ? { contacts: estimate.contacts, as_of: estimate.as_of, scope: estimate.scope, confidence: 'low' }
    : null;
  const rows = plan.item_id ? await readContactDeliveryPages<{status: string; finalized_at: string | null; email_normalized: string}>(
    'supply display inventory', (from, to) => db.from('ve_contact_delivery_rows')
      .select('status, finalized_at, email_normalized', { count: 'exact' }).eq('item_id', plan.item_id)
      .order('id').range(from, to),
  ) : [];
  const { data: preset, error: presetError } = await instantlyDb.from('client_campaign_presets')
    .select('client_user_id, schedule_timezone').eq('id', binding.preset_id).maybeSingle();
  if (presetError || !preset?.client_user_id) throw new Error('Не удалось проверить запас клиента');
  const blocked = await getBlockedEmailSet(instantlyDb, preset.client_user_id);
  const stockAt = (timezone: string, businessDate: string): SupplyStock => ({
    ready: rows.filter(row => row.status === 'ready' && !blocked.has(row.email_normalized)).length,
    uploaded: rows.filter(row => row.status === 'accepted').length,
    uploaded_today: rows.filter(row => row.status === 'accepted' && row.finalized_at &&
      Number.isFinite(Date.parse(row.finalized_at)) && localIsoDate(new Date(row.finalized_at), timezone) === businessDate).length,
    uncertain: rows.filter(row => row.status === 'uncertain' || row.status === 'attempting').length,
    business_date: businessDate, timezone,
  });
  if (plan.item_id) {
    const { data: project, error: projectError } = await db.from('ve_projects')
      .select('portal_project_id, delivery_timezone').eq('id', plan.project_id).maybeSingle();
    if (projectError || !project) throw new Error('Не удалось прочитать часовой пояс запуска');
    const timezone = project.portal_project_id ? project.delivery_timezone : preset.schedule_timezone;
    if (typeof timezone !== 'string' || !timezone.trim()) throw new Error('Не указан часовой пояс запуска');
    result.stock = stockAt(timezone, localIsoDate(new Date(), timezone));
  }
  const preview = await buildVeContactDeliveryPreview(db, instantlyDb, {
    templateId, presetId: binding.preset_id, portalProjectId: binding.portal_project_id,
    expectedPortalPeriodId: binding.portal_period_id ?? null, targetContacts: binding.target_contacts,
    segmentationAuditId: plan.preview_audit_id,
  });
  if (preview.status !== 200) {
    if (preview.body.code === 'DELIVERY_ANALYTICS_PENDING') {
      result.analytics_pending = true;
      result.metrics_error = String(preview.body.error);
      return result;
    }
    // Точная причина (закрытый период, новый период у проекта без периодов,
    // дедлайн карточки) важнее общего совета.
    result.metrics_error = typeof preview.body.error === 'string' && preview.status < 500
      ? `План и запас не пересчитаны: ${preview.body.error}`
      : 'Не удалось пересчитать план и запас. Проверьте проект, период и аудит.';
    return result;
  }
  const p = preview.body.preview as Record<string, number | string>;
  const items = await readContactDeliveryPages<{id: string; potential_pct: number}>(
    'supply display weights', (from, to) => db.from('ve_launch_queue_items')
      .select('id, potential_pct', { count: 'exact' }).eq('project_id', plan.project_id).eq('status', 'active')
      .order('id').range(from, to),
  );
  const dayRunQuery = db.from('ve_contact_delivery_daily_runs')
    .select('effective_count').eq('ve_project_id', plan.project_id);
  // PostgREST не сравнивает с NULL через eq: запуск без периода ищем через is.
  const { data: dayRun, error: dayError } = await (binding.portal_period_id
    ? dayRunQuery.eq('portal_period_id', binding.portal_period_id)
    : dayRunQuery.is('portal_period_id', null))
    .eq('run_date', p.business_date).maybeSingle();
  if (dayError) throw new Error('Не удалось сверить сегодняшний план');
  const timezone = String(p.delivery_timezone);
  const stock = stockAt(timezone, String(p.business_date));
  const requiredDaily = Math.min(Number(p.required_daily), Number(p.sender_capacity));
  const dailyTarget = allocateContactSupplyTargets(requiredDaily, items.map((item) => ({ id: item.id, weight: item.potential_pct })))
    .find((item) => item.itemId === plan.item_id)?.contacts ?? 0;
  const ready = plan.item_id ? rows.filter((row) => row.status === 'ready' && !blocked.has(row.email_normalized)).length : Number(p.prospective_ready);
  result.metrics = {
    ...stock,
    ready,
    project_first_contacted: Number(p.contacts_done_count), project_daily_plan: dayRun?.effective_count ?? Number(p.effective_daily),
    project_required_daily: requiredDaily, project_ready: Number(p.ready_remaining),
    project_stock_workdays: requiredDaily > 0 ? Math.floor(Number(p.ready_remaining) / requiredDaily) : null,
    hypothesis_daily_target: dailyTarget,
    hypothesis_stock_workdays: dailyTarget > 0 ? Math.floor(ready / dailyTarget) : null,
    hypothesis_estimated_workdays: null,
    business_date: String(p.business_date), timezone,
  };
  if (result.estimate) {
    result.metrics.hypothesis_estimated_workdays = dailyTarget > 0 ? Math.floor((ready + result.estimate.contacts) / dailyTarget) : null;
  }
  return result;
}
