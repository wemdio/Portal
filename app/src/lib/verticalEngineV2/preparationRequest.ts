import type { SupabaseClient } from '@supabase/supabase-js';
import { getVeCollectionContinuation } from './collectionRecovery';
import { saveVeCollectionContinuationCache } from './collectionContinuationCache';

export interface VePreparationAction {
  status: 'queued' | 'already_running' | 'unavailable' | 'ready';
  reason: string;
  hypothesis_id: string | null;
  base_id?: string;
  code?: string;
  /** Durable intent for analyzed partial previews; omitted for preparation repair. */
  resume_collection?: boolean;
}

/** Preflight for a single explicit request; only the compact verdict is saved.
 * Enqueue rechecks the state under its claim. No jobs or paid checks start here. */
export async function checkVePreparationRequest(
  db: SupabaseClient, projectId: string, revision: number, hypothesisId: string,
): Promise<VePreparationAction> {
  const [setup, preparation, hypothesis] = await Promise.all([
    db.from('ve_outreach_setups').select('revision,selected_hypothesis_ids')
      .eq('project_id', projectId).maybeSingle(),
    db.from('ve_outreach_preparations').select('base_id,template_id,status,locked_until')
      .eq('project_id', projectId).eq('hypothesis_id', hypothesisId).maybeSingle(),
    db.from('ve_hypotheses').select('id,vertical_id,status')
      .eq('project_id', projectId).eq('id', hypothesisId).maybeSingle(),
  ]);
  for (const result of [setup, preparation, hypothesis]) if (result.error) throw new Error(result.error.message);
  const outcome = (status: VePreparationAction['status'], reason: string, code?: string, baseId?: string): VePreparationAction =>
    ({ status, reason, hypothesis_id: hypothesisId, ...(code ? { code } : {}), ...(baseId ? { base_id: baseId } : {}) });
  if (setup.data?.revision !== revision) return outcome('unavailable', 'Выбор изменился. Обновите страницу', 'selection_changed');
  if (!setup.data?.selected_hypothesis_ids?.includes(hypothesisId) || !hypothesis.data?.vertical_id
    || hypothesis.data.status === 'rejected') return outcome('unavailable', 'Выберите доступную гипотезу этого проекта', 'not_selected');

  const queued = () => outcome('queued', 'Запрос принят. Подготовка продолжится автоматически.');
  const busy = (baseId?: string) => outcome('already_running', 'Подготовка уже выполняется. Повторно нажимать не нужно.', 'already_running', baseId);
  if (preparation.data?.status === 'pending'
    || Date.parse(preparation.data?.locked_until ?? '') > Date.now()) return busy(preparation.data?.base_id ?? undefined);
  // Match the coordinator: a finished result takes precedence over a later
  // failed duplicate. Read one saved base only, never all project checkpoints.
  let query = db.from('ve_bases')
    .select('id,project_id,hypothesis_id,source,status,error,row_count,updated_at,collection_continuation_revision,collect_info,max_emails_per_company,contact_cap_applied')
    .eq('project_id', projectId).eq('hypothesis_id', hypothesisId).eq('source', 'auto')
    .eq('collect_info->>collection_mode', 'preview');
  if (preparation.data?.base_id) query = query.eq('id', preparation.data.base_id);
  let base = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
  if (base.error) throw new Error(base.error.message);
  if (!base.data) return preparation.data?.base_id
    ? outcome('unavailable', 'Сохранённая база недоступна. Обновите страницу.', 'base_missing') : queued();
  if (base.data.status === 'failed') {
    const prepared = await db.from('ve_bases')
      .select('id,project_id,hypothesis_id,source,status,error,row_count,updated_at,collection_continuation_revision,collect_info,max_emails_per_company,contact_cap_applied')
      .eq('project_id', projectId).eq('hypothesis_id', hypothesisId).eq('source', 'auto')
      .eq('collect_info->>collection_mode', 'preview').in('status', ['analyzing', 'analyzed'])
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
    if (prepared.error) throw new Error(prepared.error.message);
    if (prepared.data) base = prepared;
  }
  const saved = base.data!;
  const [active, template, launched] = await Promise.all([
    db.from('ve_jobs').select('id').eq('project_id', projectId).eq('payload->>base_id', saved.id)
      .in('stage', ['base_collect', 'base_analyze', 'template', 'base_reproject_contacts'])
      .in('status', ['pending', 'running']).limit(1).maybeSingle(),
    db.from('ve_templates').select('id,status,launch_info').eq('base_id', saved.id).is('supply_batch_id', null)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle(),
    db.from('ve_templates').select('id').eq('base_id', saved.id).not('launch_info', 'is', null).limit(1).maybeSingle(),
  ]);
  for (const result of [active, template, launched]) if (result.error) throw new Error(result.error.message);
  if (active.data) return busy(saved.id);
  if (launched.data) return outcome('ready', 'База уже передана в запуск. Пополнение управляется в результатах.', 'launched', saved.id);
  // These requests repair preparation, not acquisition. Do not let an
  // exhausted source plan hide a failed analysis/letter job or an orphan.
  if (saved.status === 'collecting' || saved.status === 'analyzing'
    || (saved.status === 'failed' && saved.error === 'Отменено пользователем')
    || (saved.status === 'analyzed' && saved.row_count > 0 && template.data?.status !== 'ready')) return queued();
  if (saved.status === 'analyzed' && saved.row_count > 0 && template.data?.status === 'ready'
    && (preparation.data?.status !== 'ready' || preparation.data.base_id !== saved.id
      || preparation.data.template_id !== template.data.id)) return {
    ...queued(), base_id: saved.id, code: 'preparation_incomplete',
    reason: 'Завершим подготовку по сохранённой базе и готовым письмам.',
  };
  const decision = getVeCollectionContinuation(saved);
  if (!await saveVeCollectionContinuationCache(db, saved, decision)) return outcome('unavailable',
    'Не удалось подтвердить актуальное состояние базы. Обновите страницу.', 'state_changed', saved.id);
  if (decision.available) return { ...queued(), base_id: saved.id, code: decision.code, resume_collection: true };
  if (decision.code === 'target_reached') return outcome('ready', 'База и письма готовы к проверке и запуску.', decision.code, saved.id);
  return outcome('unavailable', decision.reason, decision.code, saved.id);
}
