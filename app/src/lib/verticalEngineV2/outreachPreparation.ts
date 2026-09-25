import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueueVeBaseCollect } from './baseCollectEnqueue';
import { VE_PREVIEW_READY_TARGET, VE_COLLECTION_MAX_CANDIDATES } from './collectionTarget';
import type { VeOutreachPreparation } from './outreachSetup';

class PreparationLeaseLost extends Error {}
class PreparationReadError extends Error {}
type ClaimedPreparation = VeOutreachPreparation & { claim_token: string };

// This timer runs beside research. Do not deserialize megabytes of saved
// candidates/evidence just to inspect a base's status every ten seconds.
const BASE_STATE_COLUMNS = 'id,status,error,row_count,updated_at,collection_mode:collect_info->>collection_mode,target_progress:collect_info->target_progress';

/** A resumed base was committed after the old job finished, then the process died before enqueue. */
export function isVeInterruptedCollectionResume(
  base: { status?: unknown; updated_at?: unknown },
  job: { status?: unknown; finished_at?: unknown } | null,
): boolean {
  if (base.status !== 'collecting' || job?.status !== 'done') return false;
  const resumed = typeof base.updated_at === 'string' ? Date.parse(base.updated_at) : NaN;
  const finished = typeof job.finished_at === 'string' ? Date.parse(job.finished_at) : NaN;
  return Number.isFinite(resumed) && Number.isFinite(finished) && resumed > finished;
}

/** Advances durable user-requested preparation. No paid calls in this coordinator. */
export async function runVeOutreachPreparations(db: SupabaseClient, shouldStop: () => boolean = () => false): Promise<void> {
  const visited = new Set<string>();
  const deadline = Date.now() + 8_000;
  for (let n = 0; n < 32 && Date.now() < deadline; n++) {
    if (shouldStop()) return;
    const claimed = await db.rpc('ve_claim_outreach_preparation');
    if (claimed.error) throw new Error(claimed.error.message);
    const p = (claimed.data as ClaimedPreparation[] | null)?.[0];
    if (!p) return;
    let baseId = p.base_id;
    let templateId = p.template_id;
    let resumeStatus = p.status;
    const retryRequested = p.status === 'pending';
    const save = async (status: VeOutreachPreparation['status'], error: string | null = null, release = true) => {
      const result = await db.rpc('ve_save_outreach_preparation', {
        p_project_id: p.project_id, p_hypothesis_id: p.hypothesis_id, p_claim_token: p.claim_token,
        p_status: status, p_base_id: baseId, p_template_id: templateId, p_error: error, p_release: release,
      });
      if (result.error) throw new Error(result.error.message);
      if (result.data !== true) throw new PreparationLeaseLost('Preparation claim changed');
      resumeStatus = status;
    };
    const latestBase = async () => {
      const result = await db.from('ve_bases').select('id,status')
        .eq('project_id', p.project_id).eq('hypothesis_id', p.hypothesis_id).eq('source', 'auto')
        .eq('collect_info->>collection_mode', 'preview').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
      if (result.error) throw new PreparationReadError(result.error.message);
      return result.data;
    };
    const latestJob = async (stage: string) => {
      const result = await db.from('ve_jobs').select('id,status,error,created_at,finished_at')
        .eq('project_id', p.project_id).eq('stage', stage).eq('payload->>base_id', baseId!)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
      if (result.error) throw new PreparationReadError(result.error.message);
      return result.data;
    };
    const readBase = async () => {
      const result = await db.from('ve_bases').select(BASE_STATE_COLUMNS)
        .eq('id', baseId!).eq('project_id', p.project_id).eq('hypothesis_id', p.hypothesis_id).maybeSingle();
      if (result.error) throw new PreparationReadError(result.error.message);
      if (!result.data) throw new Error('Сохранённая база недоступна. Обновите страницу');
      return { ...result, data: result.data };
    };
    const queue = async (stage: 'base_analyze' | 'template') => {
      const result = await db.rpc('ve_enqueue_outreach_preparation_job', {
        p_project_id: p.project_id, p_hypothesis_id: p.hypothesis_id, p_claim_token: p.claim_token,
        p_base_id: baseId, p_stage: stage,
      });
      if (result.error) {
        if (result.error.message.includes('VE_OUTREACH_PREPARATION_LEASE_LOST')) throw new PreparationLeaseLost(result.error.message);
        if (stage === 'base_analyze' && result.error.message.includes('База ещё не готова к выбранной стадии')) {
          const fresh = await readBase();
          if (fresh.data.status === 'analyzed') return;
        }
        throw new Error(result.error.message);
      }
    };
    try {
      const identity = `${p.project_id}:${p.hypothesis_id}`;
      // The claim RPC rotates oldest first. Stop after one full pass when the
      // queue is small, releasing the new lease without repeating its work.
      if (visited.has(identity)) { await save(p.status, p.last_error); return; }
      visited.add(identity);
      const h = await db.from('ve_hypotheses').select('id,vertical_id,status').eq('id', p.hypothesis_id).eq('project_id', p.project_id).maybeSingle();
      if (h.error) throw new PreparationReadError(h.error.message);
      if (!h.data?.vertical_id || h.data.status === 'rejected') throw new Error('Гипотеза больше недоступна. Измените выбор');
      if (!baseId) baseId = (await latestBase())?.id ?? null;
      let base = baseId ? await readBase() : null;
      if (baseId && !base?.data) throw new Error('Сохранённая база недоступна. Обновите страницу');
      if (retryRequested && base?.data?.status === 'failed') {
        // An older finished preview can coexist with a later failed duplicate.
        // Continue preparation from that result instead of reviving collection,
        // including when the duplicate was explicitly cancelled.
        const prepared = await db.from('ve_bases').select(BASE_STATE_COLUMNS)
          .eq('project_id', p.project_id).eq('hypothesis_id', p.hypothesis_id).eq('source', 'auto')
          .eq('collect_info->>collection_mode', 'preview').in('status', ['analyzing', 'analyzed'])
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
        if (prepared.error) throw new PreparationReadError(prepared.error.message);
        if (prepared.data) {
          baseId = prepared.data.id;
          templateId = null;
          base = { ...prepared, data: prepared.data };
        }
      }
      if (baseId && retryRequested && base?.data?.status === 'failed' && base.data.error === 'Отменено пользователем') {
        const resumed = await db.rpc('ve_resume_outreach_cancelled_base', {
          p_project_id: p.project_id, p_hypothesis_id: p.hypothesis_id, p_claim_token: p.claim_token, p_base_id: baseId,
        });
        if (resumed.error) {
          if (resumed.error.message.includes('VE_OUTREACH_PREPARATION_LEASE_LOST')) throw new PreparationLeaseLost(resumed.error.message);
          throw new Error(resumed.error.message);
        }
        base = await readBase();
      }
      const rawTarget = base?.data?.target_progress;
      const target = rawTarget && typeof rawTarget === 'object' && !Array.isArray(rawTarget) ? rawTarget : null;
      const continuePartial = retryRequested && base?.data?.status === 'analyzed'
        && target && ['limited', 'exhausted', 'error'].includes(String(target.status))
        && typeof target.ready_rows === 'number' && typeof target.ready_target === 'number'
        && target.ready_rows < target.ready_target;
      if (!baseId || (base?.data?.status === 'failed' && retryRequested) || continuePartial) {
        // Persist any adopted identity before enqueue/recovery can fail. A retry
        // continues the paid checkpoint instead of losing it and buying a new base.
        // Keep the explicit retry intent until a durable worker job exists.
        // A process death while loading/resuming a large base must not consume it.
        await save(retryRequested ? 'pending' : 'collecting', null, false);
        const v = await db.from('ve_verticals').select('name').eq('id', h.data.vertical_id).eq('project_id', p.project_id).single();
        if (v.error) throw new PreparationReadError(v.error.message);
        const result = await enqueueVeBaseCollect(db, { projectId: p.project_id, verticalId: h.data.vertical_id,
          verticalName: v.data.name, hypothesisIds: [p.hypothesis_id], collectionMode: 'preview',
          ...(continuePartial && baseId ? { resumeBaseId: baseId } : {}),
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
        base = await readBase();
      }
      if (!baseId || !base?.data) throw new Error('Не удалось определить базу гипотезы');
      await save(retryRequested ? 'pending' : 'collecting', null, false);
      if (base.data.collection_mode !== 'preview') throw new Error('Подготовка требует отдельного превью гипотезы');
      if (base.data.status === 'failed') throw new Error(base.data.error ?? 'Сбор остановлен. Готовые результаты сохранены');
      if (base.data.status === 'collecting') {
        const job = await latestJob('base_collect');
        // The stage writes its base before completing the job. Do not combine
        // an old base snapshot with a terminal job read a moment later.
        if (job && !['pending', 'running'].includes(job.status)) {
          base = await readBase();
          if (base.data.status !== 'collecting') { await save('collecting'); continue; }
        }
        if (job && ['failed', 'cancelled'].includes(job.status) && !retryRequested) throw new Error(job.error ?? 'Сбор базы остановлен. Нажмите «Продолжить подготовку»');
        if (!job || isVeInterruptedCollectionResume(base.data, job)
          || (retryRequested && !['pending', 'running'].includes(job.status))) {
          const v = await db.from('ve_verticals').select('name').eq('id', h.data.vertical_id).eq('project_id', p.project_id).single();
          if (v.error) throw new PreparationReadError(v.error.message);
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
        if (job && !['pending', 'running'].includes(job.status)) {
          base = await readBase();
          if (base.data.status !== 'analyzing') { await save('collecting'); continue; }
        }
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
      const readTemplate = async () => {
        const result = await db.from('ve_templates').select('id,status').eq('base_id', baseId).is('supply_batch_id', null)
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
        if (result.error) throw new PreparationReadError(result.error.message);
        return result;
      };
      let template = await readTemplate();
      if (template.data?.status === 'ready') {
        templateId = template.data.id;
        await save('ready');
        continue;
      }
      const job = await latestJob('template');
      if (job && !['pending', 'running'].includes(job.status) && !retryRequested) {
        template = await readTemplate();
        if (template.data?.status === 'ready') {
          templateId = template.data.id;
          await save('ready');
          continue;
        }
        // A failed letter job from an earlier collection must not veto a new
        // successful analysis. A failure of THIS analysis generation still
        // requires an explicit retry, so paid generation cannot loop forever.
        const analysis = await latestJob('base_analyze');
        // The analyzed base can become visible before its job's terminal
        // write completes. Wait for that job instead of reviving an old
        // letter error during the short gap between the two writes.
        if (analysis && ['pending', 'running'].includes(analysis.status)) {
          await save('collecting');
          continue;
        }
        const superseded = analysis?.status === 'done'
          // A template may be queued after the analysis write but before the
          // analysis job finishes. Its failure still belongs to this analysis.
          && Date.parse(job.created_at) < Date.parse(analysis.created_at);
        if (!superseded) throw new Error(job.error ?? 'Подготовка писем остановлена. Нажмите «Продолжить подготовку»');
      }
      await queue('template');
      await save('generating');
    } catch (error) {
      if (error instanceof PreparationLeaseLost) continue;
      // A failed coordinator read says nothing about the worker's progress.
      // Keep the durable request for the next poll; never restart paid work.
      try { await save(error instanceof PreparationReadError ? resumeStatus : 'error',
        error instanceof Error ? error.message : 'Не удалось продолжить подготовку'); }
      catch (saveError) { if (!(saveError instanceof PreparationLeaseLost)) throw saveError; }
    }
  }
}
