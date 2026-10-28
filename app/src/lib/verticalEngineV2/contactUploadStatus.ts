import type { SupabaseClient } from '@supabase/supabase-js';
import { readContactDeliveryPages } from './contactDeliveryInventory';
import { readVe2SendingSwitch } from '@/lib/sender/ve2SendingSwitch';

export interface VeContactUploadStatus {
  campaigns?: Array<{campaign_id: string; campaign_name: string; remote_status: number | null;
    status_observed_at: string | null; leads_count: number;
    /** Только у кампаний «Рассылки» с запуском, назначенным там на время. */
    scheduled_start_at?: string}>;
  /** Только у запуска в «Рассылку»: все кампании запуска там (transport строки очереди). */
  transport?: 'sender';
  /** Только у запуска в «Рассылку»: запуск закрыт (отпущен, отменён) — запускать и подавать нечего. */
  launch_closed?: true;
  /** Только у запуска в «Рассылку»: отправку кампаний Движка остановил администратор (этап 6). */
  sending_stopped?: { at: string | null };
  blocked: null | { run_id: string; blocked_at: string; run_date: string; accepted: number; pending: number; uncertain: number };
}

/** Resolve the project from stored template identity, never from browser input. */
export async function loadContactUploadProject(db: SupabaseClient, templateId: string): Promise<string> {
  const { data: template, error: templateError } = await db.from('ve_templates')
    .select('base_id, supply_batch_id').eq('id', templateId).maybeSingle();
  if (templateError || !template || template.supply_batch_id) throw new Error('Шаблон недоступен');
  const { data: base, error } = await db.from('ve_bases').select('project_id').eq('id', template.base_id).maybeSingle();
  if (error || !base?.project_id) throw new Error('Проект загрузки недоступен');
  return base.project_id;
}

/** A project pause is shared by its campaign cards, including imported bases. */
export async function loadContactUploadStatus(db: SupabaseClient, projectId: string, templateId?: string): Promise<VeContactUploadStatus> {
  const { data, error } = await db.from('ve_contact_delivery_daily_runs')
    .select('id, run_date, upload_blocked_at, accepted_count, skipped_count, uncertain_count, reserved_count')
    .eq('ve_project_id', projectId).not('upload_blocked_at', 'is', null)
    .order('run_date', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error('Не удалось проверить загрузку контактов');
  let campaigns: VeContactUploadStatus['campaigns'];
  let sender = false;
  let closed = false;
  if (templateId) {
    const {data: item, error: itemError} = await db.from('ve_launch_queue_items')
      .select('id, transport, status').eq('project_id', projectId).eq('template_id', templateId).maybeSingle();
    if (itemError) throw new Error('Не удалось прочитать состояние кампаний');
    sender = item?.transport === 'sender';
    closed = sender && !['prepared', 'queued', 'active', 'uncertain'].includes(String(item?.status));
    campaigns = item ? await readContactDeliveryPages('campaign display status', (from, to) =>
      db.from('ve_launch_queue_campaigns')
        .select('campaign_id, campaign_name, remote_status, status_observed_at, leads_count', {count: 'exact'})
        .eq('item_id', item.id).order('id', {ascending: true}).range(from, to)) : [];
    if (sender && campaigns.length) {
      // Назначенный в «Рассылке» запуск — только для подписи; не прочитали — карточка без него.
      const { data: rows, error: scheduleError } = await db.from('sender_campaigns')
        .select('id, scheduled_start_at').in('id', campaigns.map((campaign) => campaign.campaign_id));
      const scheduled = new Map(scheduleError ? [] : ((rows ?? []) as Array<{ id: string; scheduled_start_at: string | null }>)
        .filter((row) => typeof row.scheduled_start_at === 'string' && row.scheduled_start_at)
        .map((row) => [row.id, row.scheduled_start_at as string]));
      campaigns = campaigns.map((campaign) => (scheduled.has(campaign.campaign_id)
        ? { ...campaign, scheduled_start_at: scheduled.get(campaign.campaign_id)! } : campaign));
    }
  }
  // Выключатель отправки — только для подписи и кнопки; не прочитали — карточка без него (запуск всё равно откажет).
  const sendingSwitch = sender ? await readVe2SendingSwitch(db) : null;
  const sendingStopped = sendingSwitch?.state === 'stopped' ? { sending_stopped: { at: sendingSwitch.changedAt } } : {};
  return { ...(campaigns ? {campaigns} : {}), ...(sender ? { transport: 'sender' as const, ...(closed ? { launch_closed: true as const } : {}), ...sendingStopped } : {}), blocked: data ? {
    run_id: data.id, blocked_at: data.upload_blocked_at, run_date: data.run_date,
    accepted: data.accepted_count, uncertain: data.uncertain_count,
    pending: Math.max(0, data.reserved_count - data.accepted_count - data.skipped_count - data.uncertain_count),
  } : null };
}
