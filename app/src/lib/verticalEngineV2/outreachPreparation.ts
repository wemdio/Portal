import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueueVeBaseCollect } from './baseCollectEnqueue';
import { VE_PREVIEW_READY_TARGET, VE_COLLECTION_MAX_CANDIDATES } from './collectionTarget';
import type { VeOutreachPreparation } from './outreachSetup';

class PreparationLeaseLost extends Error {}
type ClaimedPreparation = VeOutreachPreparation & { claim_token: string };

/** Advances durable user-requested preparation. No paid calls in this coordinator. */
export async function runVeOutreachPreparations(db: SupabaseClient): Promise<void> {
  for (let n = 0; n < 2; n++) {
    const claimed = await db.rpc('ve_claim_outreach_preparation');
    if (claimed.error) throw new Error(claimed.error.message);
    const p = (claimed.data as ClaimedPreparation[] | null)?.[0];
    if (!p) return;
    let baseId = p.base_id;
    let templateId = p.template_id;
    const retryRequested = p.status === 'pending';
    const save = async (status: VeOutreachPreparation['status'], error: string | null = null, release = true) => {
      const result = await db.rpc('ve_save_outreach_preparation', {
        p_project_id: p.project_id, p_hypothesis_id: p.hypothesis_id, p_claim_token: p.claim_token,
        p_status: status, p_base_id: baseId, p_template_id: templateId, p_error: error, p_release: release,
      });
      if (result.error) throw new Error(result.error.message);
      if (result.data !== true) throw new PreparationLeaseLost('Preparation claim changed');
    };
    const latestBase = async () => {
      const result = await db.from('ve_bases').select('id,status,collect_info')
        .eq('project_id', p.project_id).eq('hypothesis_id', p.hypothesis_id).eq('source', 'auto')
        .eq('collect_info->>collection_mode', 'preview').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
      if (result.error) throw new Error(result.error.message);
      return result.data;
    };
    const latestJob = async (stage: string) => {
      const result = await db.from('ve_jobs').select('id,status,payload,error')
        .eq('project_id', p.project_id).eq('stage', stage).eq('payload->>base_id', baseId!)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
      if (result.error) throw new Error(result.error.message);
      return result.data;
    };
    const queue = async (stage: 'base_analyze' | 'template') => {
      const result = await db.rpc('ve_enqueue_outreach_preparation_job', {
        p_project_id: p.project_id, p_hypothesis_id: p.hypothesis_id, p_claim_token: p.claim_token,
        p_base_id: baseId, p_stage: stage,
      });
      if (result.error) {
        if (result.error.message.includes('VE_OUTREACH_PREPARATION_LEASE_LOST')) throw new PreparationLeaseLost(result.error.message);
        throw new Error(result.error.message);
      }
    };
    try {
      const h = await db.from('ve_hypotheses').select('id,vertical_id,status').eq('id', p.hypothesis_id).eq('project_id', p.project_id).maybeSingle();
      if (h.error || !h.data?.vertical_id || h.data.status === 'rejected') throw new Error('Гипотеза больше недоступна. Измените выбор');
      if (!baseId) baseId = (await latestBase())?.id ?? null;
      let base = baseId ? await db.from('ve_bases').select('id,status,error,row_count,collect_info')
        .eq('id', baseId).eq('project_id', p.project_id).eq('hypothesis_id', p.hypothesis_id).maybeSingle() : null;
      if (base?.error) throw new Error(base.error.message);
      if (baseId && !base?.data) throw new Error('Сохранённая база недоступна. Обновите страницу');
      if (baseId && retryRequested && base?.data?.status === 'failed' && base.data.error === 'Отменено пользователем') {
        const resumed = await db.rpc('ve_resume_outreach_cancelled_base', {
          p_project_id: p.project_id, p_hypothesis_id: p.hypothesis_id, p_claim_token: p.claim_token, p_base_id: baseId,
        });
        if (resumed.error) {
          if (resumed.error.message.includes('VE_OUTREACH_PREPARATION_LEASE_LOST')) throw new PreparationLeaseLost(resumed.error.message);
          throw new Error(resumed.error.message);
        }
        base = await db.from('ve_bases').select('id,status,error,row_count,collect_info')
          .eq('id', baseId).eq('project_id', p.project_id).eq('hypothesis_id', p.hypothesis_id).maybeSingle();
        if (base.error) throw new Error(base.error.message);
      }
      if (!baseId || (base?.data?.status === 'failed' && retryRequested)) {
        // Persist any adopted identity before enqueue/recovery can fail. A retry
        // continues the paid checkpoint instead of losing it and buying a new base.
        await save('collecting', null, false);
        const v = await db.from('ve_verticals').select('name').eq('id', h.data.vertical_id).eq('project_id', p.project_id).single();
        if (v.error) throw new Error(v.error.message);
        const result = await enqueueVeBaseCollect(db, { projectId: p.project_id, verticalId: h.data.vertical_id,
          verticalName: v.data.name, hypothesisIds: [p.hypothesis_id], collectionMode: 'preview',
          readyTarget: VE_PREVIEW_READY_TARGET, limit: VE_COLLECTION_MAX_CANDIDATES });
        if (!result.ok) {
          // enqueue can insert the base before reporting its job-insert failure.
          // Recover that durable identity even when the returned outcome has none.
          baseId = (await latestBase())?.id ?? baseId;
          throw new Error(result.message);
        }
        baseId = String(result.base.id);
        templateId = null;
        await save('collecting', null, false);
        base = await db.from('ve_bases').select('id,status,error,row_count,collect_info')
          .eq('id', baseId).eq('project_id', p.project_id).eq('hypothesis_id', p.hypothesis_id).maybeSingle();
        if (base.error) throw new Error(base.error.message);
      }
      if (!baseId || !base?.data) throw new Error('Не удалось определить базу гипотезы');
      await save('collecting', null, false);
      if (base.data.collect_info?.collection_mode !== 'preview') throw new Error('Подготовка требует отдельного превью гипотезы');
      if (base.data.status === 'failed') throw new Error(base.data.error ?? 'Сбор остановлен. Готовые результаты сохранены');
      if (base.data.status === 'collecting') {
        const job = await latestJob('base_collect');
        if (job && ['failed', 'cancelled'].includes(job.status) && !retryRequested) throw new Error(job.error ?? 'Сбор базы остановлен. Нажмите «Продолжить подготовку»');
        if (!job || (retryRequested && !['pending', 'running'].includes(job.status))) {
          const v = await db.from('ve_verticals').select('name').eq('id', h.data.vertical_id).eq('project_id', p.project_id).single();
          if (v.error) throw new Error(v.error.message);
          const result = await enqueueVeBaseCollect(db, { projectId: p.project_id, verticalId: h.data.vertical_id,
            verticalName: v.data.name, hypothesisIds: [p.hypothesis_id], collectionMode: 'preview',
            readyTarget: VE_PREVIEW_READY_TARGET, limit: VE_COLLECTION_MAX_CANDIDATES });
          if (!result.ok) throw new Error(result.message);
          baseId = String(result.base.id);
        } else if (!['pending', 'running'].includes(job.status)) throw new Error('Задача сбора завершилась, но база не готова. Нажмите «Продолжить подготовку»');
        await save('collecting');
        continue;
      }
      if (base.data.status === 'analyzing') {
        const job = await latestJob('base_analyze');
        if (job && !['pending', 'running'].includes(job.status) && !retryRequested) {
          throw new Error(job.error ?? 'Разбор базы остановлен. Нажмите «Продолжить подготовку»');
        }
        await queue('base_analyze');
        await save('collecting');
        continue;
      }
      if (base.data.status !== 'analyzed') throw new Error(`База ещё не готова: ${base.data.status}`);
      // Collection also uses this terminal status for an empty preview. It has
      // no analysis and must not enqueue paid letter generation or reuse letters.
      if (!(base.data.row_count > 0)) throw new Error('Сбор завершён без готовых контактов. Для подготовки писем нужна непустая база.');
      const template = await db.from('ve_templates').select('id,status').eq('base_id', baseId).is('supply_batch_id', null)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
      if (template.error) throw new Error(template.error.message);
      if (template.data?.status === 'ready') {
        templateId = template.data.id;
        await save('ready');
        continue;
      }
      const job = await latestJob('template');
      if (job && !['pending', 'running'].includes(job.status) && !retryRequested) {
        throw new Error(job.error ?? 'Подготовка писем остановлена. Нажмите «Продолжить подготовку»');
      }
      await queue('template');
      await save('generating');
    } catch (error) {
      if (error instanceof PreparationLeaseLost) continue;
      try { await save('error', error instanceof Error ? error.message : 'Не удалось продолжить подготовку'); }
      catch (saveError) { if (!(saveError instanceof PreparationLeaseLost)) throw saveError; }
    }
  }
}
