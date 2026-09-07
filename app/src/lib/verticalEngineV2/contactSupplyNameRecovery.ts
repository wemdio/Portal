import type { SupabaseClient } from '@supabase/supabase-js';
import { companyNameSource, VE_COMPANY_NAME_FIELD } from './companyNames';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;

/** The runner must pause this open batch, not finalize it and advance the source cursor. */
export function hasPendingSupplyNames(recovery: unknown, summary: unknown): boolean {
  return record(recovery) !== null && record(summary)?.status === 'partial';
}

/**
 * Only called by an explicitly authenticated resume request, BEFORE its existing
 * approval/status RPC. The batch stays open and the plan stays paused until that
 * RPC succeeds. A crash between writes can be repaired by the same request; the
 * existing active-job unique index is the final concurrency authority.
 */
export async function prepareVeSupplyNameResume(
  db: SupabaseClient,
  input: { planId: string; templateId: string; now?: Date },
): Promise<boolean> {
  const { data: plan, error: planError } = await db.from('ve_contact_supply_plans')
    .select('id, project_id, hypothesis_id, item_id, status').eq('id', input.planId)
    .eq('template_id', input.templateId).maybeSingle();
  if (planError || !plan) throw new Error('План пополнения недоступен для продолжения');
  if (!plan.item_id) return false;
  const { data: batch, error: batchError } = await db.from('ve_contact_supply_batches')
    .select('id, base_id, status, audit_id').eq('plan_id', plan.id)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
  if (batchError) throw new Error('Не удалось прочитать сохранённую партию пополнения');
  if (!batch || !['collecting', 'failed'].includes(batch.status) || batch.audit_id) return false;
  const { data: base, error: baseError } = await db.from('ve_bases')
    .select('id, project_id, vertical_id, hypothesis_id, source, status, collect_info, data, row_count, updated_at')
    .eq('id', batch.base_id).eq('project_id', plan.project_id).eq('hypothesis_id', plan.hypothesis_id).maybeSingle();
  if (baseError || !base) throw new Error('Сохранённая база пополнения недоступна');
  const info = record(base.collect_info);
  if (!info || !hasPendingSupplyNames(info.company_name_recovery, info.company_name_cleanup)) return false;
  if (batch.status !== 'collecting') {
    throw new Error('Партия с незавершённой очисткой уже закрыта. Нужна проверка администратора; новый сбор не запущен.');
  }
  if (!['failed', 'collecting'].includes(base.status)) return false;
  const progress = record(info.target_progress);
  const checkpoint = record(info.target_checkpoint);
  const recovery = record(info.company_name_recovery)!;
  const rows = Array.isArray(base.data) ? base.data : null;
  if (base.source !== 'auto' || info.collection_mode !== 'supply' || info.refill
    || info.supply_batch_id !== batch.id || !rows || base.row_count !== rows.length
    || !progress || !count(progress.round) || progress.round < 1 || progress.round > 5
    || checkpoint?.completed_round !== progress.round
    || !count(progress.candidates_processed) || progress.candidates_processed > 10_000
    || !count(info.ready_target) || info.ready_target < 1 || info.ready_target > 10_000
    || typeof recovery.has_buffered_candidates !== 'boolean'
    || !(recovery.validation_error === null || typeof recovery.validation_error === 'string')
    || !count(recovery.round_low_relevance) || !count(recovery.round_relevance_unchecked)
    || rows.some((value) => {
      const row = record(value);
      const meta = row && record(row[VE_COMPANY_NAME_FIELD]);
      if (!row || !meta) return true;
      const source = companyNameSource(row);
      return row._email_status !== 'ok' || row._low_relevance === true || row._relevance_unchecked === true
        || meta.version !== 1 || !['ready', 'failed'].includes(String(meta.status))
        || meta.source !== source.source || meta.website !== source.website;
    })) {
    throw new Error('Сохранённая партия не подтверждает завершённую проверку контактов; повторный сбор не запущен');
  }
  const now = (input.now ?? new Date()).toISOString();
  // Even a resume sent while the runner is observing the failure must not
  // activate paid work before the normal approval RPC below the caller succeeds.
  const { error: pauseError } = await db.rpc('ve_pause_contact_supply_plan', {
    p_plan_id: plan.id, p_error: 'Продолжение очистки сохранённых названий ожидает подтверждения запуска', p_now: now,
  });
  if (pauseError) throw new Error('Не удалось безопасно приостановить план перед продолжением');
  if (base.status === 'failed') {
    const { data: claimed, error: claimError } = await db.from('ve_bases')
      .update({ status: 'collecting', error: null, updated_at: now }).eq('id', base.id)
      .eq('project_id', plan.project_id).eq('status', 'failed').eq('updated_at', base.updated_at)
      .select('id').maybeSingle();
    if (claimError || !claimed) throw new Error('Состояние сохранённой базы изменилось. Повторите продолжение после обновления страницы.');
  }
  const readActive = () => db.from('ve_jobs').select('id, payload')
    .eq('project_id', plan.project_id).eq('stage', 'base_collect').eq('payload->>base_id', base.id)
    .in('status', ['pending', 'running']).limit(1).maybeSingle();
  const isOurResume = (job: { payload?: unknown } | null) => {
    const payload = record(job?.payload);
    return payload?.company_name_resume === true && payload.supply_batch_id === batch.id;
  };
  const { data: active, error: activeError } = await readActive();
  if (activeError) throw new Error('Не удалось проверить очередь продолжения; план остаётся на паузе');
  if (active) {
    // The old job can still be finishing its failed attempt. Do not report a
    // repaired queue merely because that soon-terminal running row exists.
    if (!isOurResume(active)) throw new Error('Предыдущая попытка ещё завершается. Повторите продолжение через несколько секунд.');
    return true;
  }
  const { error: insertError } = await db.from('ve_jobs').insert({
    project_id: plan.project_id, stage: 'base_collect', status: 'pending',
    payload: { base_id: base.id, vertical_id: base.vertical_id, hypothesis_id: base.hypothesis_id,
      collection_mode: 'supply', supply_batch_id: batch.id, ready_target: info.ready_target,
      company_name_resume: true },
  });
  if (insertError) {
    const { data: winner, error: winnerError } = await readActive();
    if (winnerError || !isOurResume(winner)) {
      throw new Error('Не удалось поставить продолжение в очередь. Контакты сохранены, план на паузе; повторите продолжение.');
    }
  }
  return true;
}
