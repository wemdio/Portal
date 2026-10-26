/**
 * Ядро запуска авто-сборки базы под вертикаль «Движка вертикалей» (стадия
 * base_collect: план источников → коллекторы → harvest в ve_bases).
 *
 * Вынесено из POST api/tools/vertical-engine-v2/verticals/[id]/collect —
 * клиентский ENG-контур запускает сборку тем же кодом (со своими лимитами).
 * Здесь: дедупы и вставки. Валидация тела, загрузка вертикали (со скоупом
 * владельца в клиентском контуре) и аудит остаются в роутах.
 *
 * Создаёт ve_bases (source='auto', status='collecting') + ve_jobs
 * (stage='base_collect'). Лимит и непустой hypothesis_ids едут в payload
 * джобы (их читают totalRowsCap и buildPlan в стадии) и в
 * ve_bases.collect_info (его показывает UI).
 *
 * Дедуп: активная (pending/running) base_collect-задача этой вертикали или
 * собирающаяся auto-база уже есть → outcome 'existing' (UI показывает «уже
 * собирается», а не молча продолжает; collect_info в выборке — ради
 * collect_info.limit в этом уведомлении).
 * Гонку двух параллельных запусков (оба прошли проверки до insert) закрывают
 * partial unique index'ы: ve_bases_one_collecting_per_hypothesis (базы с
 * гипотезой) и ve_bases_one_collecting_per_vertical (легаси/refill, где
 * hypothesis_id IS NULL). Проигравший insert получает 23505 и тоже отвечает
 * 'existing' с чужой collecting-базой.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { collectionRoundLimit, createCollectionTarget, type VeCollectionMode } from './collectionTarget';
import { canResumePartialPreview, getVeCollectionContinuation, grantVeResumeRoundBudget, needsVeControlledAudienceRefresh, openNextVeCollectionRound, previewRecoveryKind, type VeCollectionContinuation } from './collectionRecovery';
import { prepareVeGeographyRepairContinuation } from './collectionGeographyRepair';
import { normalizeVeMaxEmailsPerCompany } from './companyContactCap';
import { resumeVeSavedEmailRecovery } from './savedEmailRecovery';
import { isVeResumableDirectoryError } from './collectionErrors';
import { compactVeRelevanceReserve, readVeRelevanceReserve } from './relevanceReserve';
import { veAudienceReviewHold } from './audienceReviewHold';
import { readVeSourceCostPolicy, withVeRetailRefreshMarket } from './sourceAudience';
import { addVeKnownWebsiteSource, needsVeKnownWebsiteContinuation } from './knownWebsiteDirectory';
import { applyVeRestaurantSourceContinuation, needsVeRestaurantSourceContinuation } from './restaurantSourcePolicy';
import { veCollectionGeographyFromBrief, type VeCollectionGeography } from './collectionGeography';
import { projectMarket } from './market';
import { createVeTwoGisSourceFlag, readVeTwoGisSettings, veTwoGisFlagAllowed, veTwoGisSnapshotReady,
  type VeTwoGisSourceFlag } from './twoGisSettings';

export interface VeBaseCollectInput {
  verticalId: string;
  projectId: string;
  /** Имя вертикали — в filename авто-базы («auto: <name>»). */
  verticalName: string;
  /** Лимит строк сборки (практический предохранитель от раздутого data jsonb). */
  limit: number;
  /** Выбранные в UI гипотезы; null — собирать по всем. */
  hypothesisIds: string[] | null;
  collectionMode?: VeCollectionMode;
  readyTarget?: number;
  /** Exact saved preview explicitly continued by its preparation coordinator. */
  resumeBaseId?: string;
  /**
   * Переопределение filename авто-базы (по умолчанию «auto: <name>»).
   * ENG auto-pipeline пишет «auto-refill: <name> · <дата>».
   */
  filename?: string;
  /**
   * Refill-режим (ENG auto-pipeline): после сборки и конструктора стадия
   * НЕ ставит base_analyze/template, а доливает валидные строки лидaми в
   * уже запущенную кампанию campaignId (см. stages/baseCollectRefill.ts).
   * campaign_id дублируется в collect_info — на момент постановки это
   * снапшот launch_info, стадия умеет и фолбэк на последний launched шаблон.
   */
  refill?: { campaignId: string };
}

export type VeBaseCollectResult =
  /** Сборка стартовала: созданы базы + джобы (по одной на гипотезу либо одна). */
  | { ok: true; created: true; bases: Array<Record<string, unknown>>; base: Record<string, unknown> }
  /** Существующее превью: сборка уже идёт либо результат сохранён. */
  | { ok: true; created: false; base: Record<string, unknown>; continuation?: VeCollectionContinuation }
  | { ok: false; message: string };

/**
 * Rebuild a lost job exclusively from the persisted base snapshot. The
 * retrying caller may be normal or refill and must never change that mode.
 */
function repairJobPayload(base: Record<string, unknown>): Record<string, unknown> {
  const info = base.collect_info && typeof base.collect_info === 'object'
    ? base.collect_info as Record<string, unknown>
    : {};
  const payload: Record<string, unknown> = {};
  if (
    typeof info.limit === 'number'
    && Number.isSafeInteger(info.limit)
    && info.limit > 0
  ) {
    payload.limit = info.limit;
  }

  if (info.refill === true) {
    payload.refill = true;
    return payload;
  }
  if (info.collection_mode === 'preview' || info.collection_mode === 'supply') {
    const target = createCollectionTarget(info.collection_mode, info.ready_target as number | undefined);
    payload.collection_mode = target.mode;
    const savedProgress = info.target_progress && typeof info.target_progress === 'object'
      ? info.target_progress as Record<string, unknown> : null;
    const savedTarget = savedProgress?.ready_target;
    payload.ready_target = typeof savedTarget === 'number' && Number.isSafeInteger(savedTarget)
      && savedTarget > 0 && savedTarget <= target.max_candidates ? savedTarget : target.ready_target;
    if (typeof info.supply_batch_id === 'string') payload.supply_batch_id = info.supply_batch_id;
  }

  const hypothesisId = typeof base.hypothesis_id === 'string' && base.hypothesis_id
    ? base.hypothesis_id
    : typeof info.hypothesis_id === 'string' && info.hypothesis_id
      ? info.hypothesis_id
      : null;
  if (hypothesisId) {
    payload.hypothesis_id = hypothesisId;
    return payload;
  }

  if (
    Array.isArray(info.hypothesis_ids)
    && info.hypothesis_ids.length > 0
    && info.hypothesis_ids.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    payload.hypothesis_ids = info.hypothesis_ids;
  }
  return payload;
}

/** 2ГИС (план 26.10, R3 «Флаг»): флаг нового RU-превью, решается прямо перед INSERT. Никогда не
 * бросает: любой сбой — база без 2ГИС. Сбой чтения настроек readVeTwoGisSettings пишет в лог сам (только вид). */
async function freezeVeTwoGisSource(supabase: SupabaseClient, projectId: string): Promise<VeTwoGisSourceFlag | null> {
  try {
    const settings = await readVeTwoGisSettings(supabase);
    if (settings && veTwoGisFlagAllowed(settings, projectId)) return createVeTwoGisSourceFlag(settings, new Date());
    // mode=on без проверенного снимка — ошибка порядка шагов (Ш6 раньше Ш5), а не норма.
    if (settings?.mode === 'on' && !veTwoGisSnapshotReady(settings)) {
      console.warn('[ve2-2gis] mode=on, но снимок не проверен (Ш5): новое превью без 2ГИС');
    }
    return null;
  } catch (error) {
    console.warn(`[ve2-2gis] new preview without 2GIS: ${error instanceof Error ? error.name : 'error'}`);
    return null;
  }
}

async function resumeFailedPreview(
  supabase: SupabaseClient, input: VeBaseCollectInput, hypothesisId: string,
  activeBaseIds: string[], currentHypothesis: Record<string, unknown> | null,
): Promise<VeBaseCollectResult | null> {
  let query = supabase.from('ve_bases')
    .select('id, project_id, vertical_id, hypothesis_id, source, status, error, collect_info, created_at, updated_at, collection_continuation_revision, max_emails_per_company, contact_cap_applied')
    .eq('project_id', input.projectId).eq('vertical_id', input.verticalId).eq('hypothesis_id', hypothesisId)
    .eq('source', 'auto');
  query = input.resumeBaseId ? query.eq('id', input.resumeBaseId).in('status', ['failed', 'analyzed']) : query.eq('status', 'failed');
  const { data: failed, error } = await query.order('created_at', { ascending: false }).limit(100);
  if (error) return { ok: false, message: error.message };
  const candidates = (failed ?? []).filter((base) => previewRecoveryKind(base) || (input.resumeBaseId && canResumePartialPreview(base, currentHypothesis)));
  // A newer empty 402 attempt must not hide an older already enriched result.
  const saved = candidates.find((base) => previewRecoveryKind(base) === 'validation')
    ?? candidates.find((base) => previewRecoveryKind(base) !== 'billing') ?? candidates[0];
  if (!saved) {
    const requested = input.resumeBaseId && (failed ?? []).find((base) => base.id === input.resumeBaseId);
    return requested ? { ok: true, created: false, base: requested, continuation: getVeCollectionContinuation(requested, currentHypothesis) } : null;
  }
  if (activeBaseIds.includes(saved.id)) return { ok: true, created: false, base: saved };
  {
    // A launched campaign owns this audience. Recovery must not mutate it.
    const launched = await supabase.from('ve_templates').select('id').eq('base_id', saved.id)
      .not('launch_info', 'is', null).limit(1).maybeSingle();
    if (launched.error) return { ok: false, message: launched.error.message };
    if (launched.data) return { ok: true, created: false, base: saved, continuation: {
      available: false, action: null, code: 'launched', reason: 'База уже передана в запуск. Пополнение управляется в результатах.',
    } };
  }
  const continuation = getVeCollectionContinuation(saved, currentHypothesis);
  const refreshKnownWebsites = input.resumeBaseId === saved.id && continuation.code === 'source_update'
    && continuation.action === 'resume_collection' && needsVeKnownWebsiteContinuation(saved, currentHypothesis);
  const refreshRestaurant = input.resumeBaseId === saved.id && continuation.code === 'source_update'
    && continuation.action === 'resume_collection' && needsVeRestaurantSourceContinuation(saved, currentHypothesis);
  const refreshAudience = input.resumeBaseId === saved.id && continuation.code === 'source_update'
    && continuation.action === 'resume_collection' && needsVeControlledAudienceRefresh(saved, currentHypothesis);
  const pendingAudienceRefresh = saved.collect_info?.audience_scope_refresh_requested === true;
  const refreshGeography = saved.status === 'analyzed' && saved.collect_info?.geography_repair !== undefined;
  if (pendingAudienceRefresh) {
    try {
      if (readVeSourceCostPolicy(saved.collect_info.cost_policy)?.website_discovery !== 'existing_only') throw new Error('Missing source refresh cost policy');
    } catch { return { ok: false, message: 'Сохранённое обновление источников требует проверки условий расходов.' }; }
  }
  const sourceRefresh = refreshGeography || refreshAudience || pendingAudienceRefresh || refreshKnownWebsites || refreshRestaurant
    || saved.collect_info?.known_website_source?.continuation_only === true || !!saved.collect_info?.restaurant_source_refresh;
  const info = { ...saved.collect_info,
    ...(saved.collect_info?.geography_repair === undefined && currentHypothesis && (refreshAudience || (!pendingAudienceRefresh && /^B2B\s+SaaS\b/i.test(String(currentHypothesis.title ?? '')))) ? { hypotheses: [currentHypothesis] } : {}),
    ...(previewRecoveryKind(saved) === 'validation' && !sourceRefresh ? { validation_retry: true } : {}),
    ...(saved.status === 'analyzed' && !sourceRefresh ? { validation_retry: true, relevance_review_requested: true } : {}),
    ...(refreshAudience ? { audience_scope_refresh_requested: true,
      cost_policy: { version: 1, website_discovery: 'existing_only' } } : {}),
  };
  if (refreshGeography) {
    try {
      const prepared = prepareVeGeographyRepairContinuation(info);
      if (!prepared.can_continue) return { ok: true, created: false, base: saved, continuation };
      Object.assign(info, prepared.collect_info);
      // Object.assign does not remove the closed constructor; it must never
      // be imported into the new round a second time.
      delete info.construct;
    } catch { return { ok: false, message: 'Сохранённые условия исправления базы требуют проверки.' }; }
  }
  if (refreshRestaurant) {
    applyVeRestaurantSourceContinuation(info, currentHypothesis!, veAudienceReviewHold(readVeRelevanceReserve(info.relevance_reserve)));
  }
  if (refreshKnownWebsites) {
    if (!addVeKnownWebsiteSource(info)) return { ok: false, message: 'Состояние источников изменилось. Обновите страницу.' };
    info.known_website_source.continuation_only = true;
    info.known_website_source.held_review_companies = veAudienceReviewHold(readVeRelevanceReserve(info.relevance_reserve));
    // Keep all old receipts/rows, but the completed constructor cannot be
    // imported a second time as the new round's result.
    delete info.construct;
    if (info.search_policy) { info.search_policy = { ...info.search_policy }; delete info.search_policy.construct_rows; }
  }
  if (saved.status === 'failed' && (info.known_website_source?.continuation_only || info.restaurant_source_refresh)
    && info.target_checkpoint?.completed_round === info.target_progress?.round) {
    // The bounded round already saved its observations. Retry only its saved
    // validation, using the old-reserve hold, not another discovery round.
    info.validation_retry = true;
    info.relevance_review_requested = true;
  }
  // Continuing acquisition is not permission to repeat completed SMTP checks.
  // Clear inconclusive results only when this failed preparation actually
  // stopped on email recovery; conclusive verdicts and dispatched children
  // are retained by the recovery helper in that case as well.
  const emailRecoveryFailed = saved.status === 'failed' && (saved.error === 'Проверка email завершилась не полностью'
    || info.company_name_recovery?.validation_error === 'Проверка email завершилась не полностью'
    || (typeof info.saved_email_recovery?.error === 'string' && info.saved_email_recovery.error.length > 0));
  if (info.saved_email_recovery !== undefined && emailRecoveryFailed) {
    info.saved_email_recovery = resumeVeSavedEmailRecovery(info.saved_email_recovery);
  }
  if (!sourceRefresh && previewRecoveryKind(saved) === 'pipeline' && info.target_checkpoint?.completed_round === info.target_progress?.round) {
    // Review saved observations from ALL completed batches; the last child
    // alone cannot represent a pipelined preview. No re-scraping old inputs.
    info.validation_retry = true;
    info.relevance_review_requested = true;
  }
  if (info.company_name_recovery?.validation_error && info.relevance_review_requested === true) {
    // An explicit retry must finish BOTH interrupted phases. Name cleanup can
    // succeed while the saved validation error still needs a fresh check.
    info.company_name_recovery = { ...info.company_name_recovery, retry_validation_after_cleanup: true };
  }
  info.target_progress = { ...info.target_progress, status: 'collecting' };
  delete info.target_progress.reason;
  if (refreshAudience || refreshKnownWebsites || refreshRestaurant) {
    // A closed source round advances once; its saved spending envelope and
    // low-yield history do not grow just because the source plan was fixed.
    info.target_progress.round += 1;
    if (info.stats) { info.stats = { ...info.stats }; delete info.stats.finished_at; }
  }
  // Каталожный сбой — единственный вид восстановления, который может застать
  // раунд ЗАКРЫТЫМ: его контрольная точка записана, а номер остался прежним,
  // потому что ошибка задачи не даёт finishCollectionRound его увеличить.
  // Остальные виды либо требуют `completed_round === round - 1`, либо ставят
  // флаги повтора — те редактируют уже собранное и номер двигать не должны.
  if (!sourceRefresh && previewRecoveryKind(saved) === 'catalog') openNextVeCollectionRound(info);
  // Reopen failed tasks after advancing a closed round: its normal renewal
  // must not discard the saved prefix of a newly recovered directory task.
  // Older workers timed out queued children from dispatch time. On an explicit
  // continuation, poll the SAME child again instead of buying another scrape.
  if (Array.isArray(info.tasks) && !sourceRefresh) {
    info.tasks = info.tasks.map((task: Record<string, unknown>) => {
      if (task.source === 'companies_directory' && task.status === 'failed'
        && isVeResumableDirectoryError(task.error)) {
        // Drain any saved prefix before reading another page. Renewable done
        // tasks reopen only after their harvest has been consumed.
        const recovered: Record<string, unknown> = { ...task,
          status: Array.isArray(task.harvest) && task.harvest.length ? 'done' : 'pending' };
        delete recovered.error;
        return recovered;
      }
      if (task.source === 'yandex_maps' && task.status === 'failed') {
        const recovered: Record<string, unknown> = { ...task, status: 'pending', child_job_id: null,
          ...(task.child_job_id ? { legacy_child_job_id: task.child_job_id } : {}) };
        delete recovered.error;
        return recovered;
      }
      if (task.status !== 'failed' || !task.child_job_id || task.error !== 'timeout: дочерняя джоба зависла') return task;
      const recovered: Record<string, unknown> = { ...task, status: 'dispatched' };
      delete recovered.error;
      return recovered;
    });
  }
  // «Продолжить подготовку» этой базы — новый бюджет раундов.
  if (input.resumeBaseId === saved.id && !sourceRefresh) {
    // Only an explicit later continuation grants a new envelope. Automatic
    // billing recovery itself never calls this path or clears its receipt.
    delete info.preview_billing_resume;
    grantVeResumeRoundBudget(info);
  }
  if (info.preview_pipeline?.version === 1) {
    info.preview_pipeline = { ...info.preview_pipeline, revision: info.preview_pipeline.revision + 1 };
    delete info.preview_pipeline.error;
  }
  const claimedAt = new Date().toISOString();
  if (info.relevance_reserve) info.relevance_reserve = compactVeRelevanceReserve(info.relevance_reserve);
  let claim = supabase.from('ve_bases')
    .update({ status: 'collecting', error: null, collect_info: info, updated_at: claimedAt })
    .eq('id', saved.id).eq('project_id', input.projectId).eq('status', saved.status);
  // A same-status writer may have changed the contact cap or a checkpoint.
  // Its revision must win over this snapshot; a cache-only write changes
  // neither revision nor timestamp and therefore does not block a real resume.
  claim = saved.updated_at == null ? claim.is('updated_at', null) : claim.eq('updated_at', saved.updated_at);
  claim = saved.collection_continuation_revision == null ? claim.is('collection_continuation_revision', null)
    : claim.eq('collection_continuation_revision', saved.collection_continuation_revision);
  const { data: claimed, error: claimError } = await claim.select('id, status, hypothesis_id').maybeSingle();
  if (claimError || !claimed) {
    // Both same-base CAS and competing-base unique races are idempotent.
    const { data: winner, error: winnerError } = await supabase.from('ve_bases')
      .select('id, status, hypothesis_id, collect_info').eq('project_id', input.projectId)
      .eq('vertical_id', input.verticalId).eq('hypothesis_id', hypothesisId)
      .eq('source', 'auto').eq('status', 'collecting').limit(1).maybeSingle();
    if (!winnerError && winner) return { ok: true, created: false, base: winner };
    return { ok: false, message: claimError?.message ?? winnerError?.message ?? 'Состояние базы изменилось. Обновите страницу и повторите попытку.' };
  }
  // Reuse the snapshot already in memory, instead of receiving/parsing it again.
  const resumed = { ...claimed, collect_info: info };
  const { error: jobError } = await supabase.from('ve_jobs').insert({
    project_id: input.projectId, stage: 'base_collect', status: 'pending',
    payload: { base_id: claimed.id, ...repairJobPayload(resumed) },
  });
  if (jobError) {
    const { data: jobs, error: readError } = await supabase.from('ve_jobs').select('id, payload')
      .eq('project_id', input.projectId).eq('stage', 'base_collect').in('status', ['pending', 'running']);
    if (!readError && (jobs ?? []).some((j) => j.payload?.base_id === claimed.id)) {
      return { ok: true, created: false, base: resumed };
    }
    // Never restore failed based on a non-atomic absence read: another request
    // can insert an orphan-repair job without changing the base timestamp.
    // UI exposes "Проверить запуск"; the existing repair is idempotent.
    return { ok: false, message: jobError.message };
  }
  return { ok: true, created: true, base: resumed, bases: [resumed] };
}

export async function enqueueVeBaseCollect(
  supabase: SupabaseClient,
  input: VeBaseCollectInput,
): Promise<VeBaseCollectResult> {
  const { verticalId, projectId, verticalName, hypothesisIds, filename, refill } = input;
  if (refill && input.collectionMode) return { ok: false, message: 'Target collection cannot use legacy refill' };
  const collectionTarget = input.collectionMode ? createCollectionTarget(input.collectionMode, input.readyTarget) : null;
  const limit = collectionTarget ? collectionRoundLimit(collectionTarget) : input.limit;

  // Base-per-hypothesis: непустой выбор гипотез → по одной базе на каждую.
  // hypothesisIds = null/пусто → прежний путь «одна база на вертикаль» (легаси
  // и ENG-refill: refill не использует hypothesis_ids, план строится по
  // неотклонённым гипотезам, как без явного выбора).
  const perHypothesis = !refill && Array.isArray(hypothesisIds) && hypothesisIds.length > 0;

  // Заголовки гипотез → различающий суффикс filename авто-базы. Гипотеза
  // показывается заголовком на карточке (Phase 3), но filename одинаков у всех
  // баз вертикали — без суффикса карточки неразличимы и экспорт путается.
  let hypothesisTitle: Record<string, string> = {};
  const currentHypotheses = new Map<string, Record<string, unknown>>();
  if (perHypothesis) {
    const ids = hypothesisIds as string[];
    const { data: hypRows, error: hypErr } = await supabase
      .from('ve_hypotheses')
      .select('id, title, description, origin, status, broad, audience_scope')
      .eq('project_id', projectId).eq('vertical_id', verticalId)
      .in('id', ids);
    if (hypErr) return { ok: false, message: hypErr.message };
    for (const h of hypRows ?? []) {
      try { currentHypotheses.set(String(h.id), input.resumeBaseId ? await withVeRetailRefreshMarket(supabase, projectId, h) : h); }
      catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Collection audience market read failed' }; }
    }
    hypothesisTitle = Object.fromEntries(
      (hypRows ?? []).map((h) => [String(h.id), String(h.title ?? '').trim() || String(h.id)]),
    );
  }

  const targets: Array<{ hypothesisId: string | null }> = perHypothesis
    ? (hypothesisIds as string[]).map((id) => ({ hypothesisId: id }))
    : [{ hypothesisId: null }];

  const created: Array<Record<string, unknown>> = [];
  const existing: Array<Record<string, unknown>> = [];
  // Read lazily after reuse/recovery checks. A retry owns its saved audience;
  // only a genuinely new preview freezes the current project geography.
  let collectionGeography: VeCollectionGeography | undefined;
  // 2ГИС (R3 «Флаг»): рынок читается тем же запросом, что и география; настройки — один раз на
  // запрос, только для RU-проекта и только на пути к новому INSERT. undefined — не решено, null — без 2ГИС.
  let ruProject: boolean | undefined;
  let twoGisSource: VeTwoGisSourceFlag | null | undefined;

  // A new preview starts with the project's "addresses per company" limit. A
  // failed read (or a database without the column) means no limit, and the
  // column is sent only when there is a value.
  let contactLimit: number | null = null;
  if (input.collectionMode === 'preview' && !refill) {
    try {
      const { data: setup, error: setupError } = await supabase.from('ve_outreach_setups').select('max_emails_per_company')
        .eq('project_id', projectId).maybeSingle();
      if (!setupError) contactLimit = normalizeVeMaxEmailsPerCompany((setup as { max_emails_per_company?: unknown } | null)?.max_emails_per_company);
    } catch { /* no limit */ }
  }

  for (const target of targets) {
    const hypothesisId = target.hypothesisId;

    // collect_info/payload джобы: у refill-сборки свой снапшот полей (кампания
    // долива), hypothesis_ids в нём не используется. У per-hypothesis — одна
    // hypothesis_id; у легаси — hypothesis_ids или только limit.
    const collectInfo: Record<string, unknown> = refill
      ? { limit, refill: true, campaign_id: refill.campaignId }
      : hypothesisId
        ? { limit, hypothesis_id: hypothesisId }
        : hypothesisIds
          ? { limit, hypothesis_ids: hypothesisIds }
          : { limit };
    const jobPayload: Record<string, unknown> = refill
      ? { limit, refill: true }
      : hypothesisId
        ? { limit, hypothesis_id: hypothesisId }
        : hypothesisIds
          ? { limit, hypothesis_ids: hypothesisIds }
          : { limit };
    if (collectionTarget) {
      Object.assign(collectInfo, {
        collection_mode: collectionTarget.mode, ready_target: collectionTarget.ready_target,
        target_progress: { ...collectionTarget },
        ...(collectionTarget.mode === 'preview' ? { preview_pipeline: { version: 1, revision: 0, batches: [] } } : {}),
      });
      Object.assign(jobPayload, {
        collection_mode: collectionTarget.mode, ready_target: collectionTarget.ready_target,
      });
    }

    // Дедуп 1: уже собирающаяся auto-база этой гипотезы (или вертикали, когда
    // гипотезы нет — легаси-путь).
    let collecting: Record<string, unknown> | null = null;
    if (hypothesisId) {
      const { data, error } = await supabase
        .from('ve_bases')
        .select('id, status, hypothesis_id, collect_info')
        .eq('hypothesis_id', hypothesisId)
        .eq('source', 'auto')
        .eq('status', 'collecting')
        .limit(1)
        .maybeSingle();
      if (error) return { ok: false, message: error.message };
      collecting = data as Record<string, unknown> | null;
    } else {
      const { data, error } = await supabase
        .from('ve_bases')
        .select('id, status, hypothesis_id, collect_info')
        .eq('vertical_id', verticalId)
        .is('hypothesis_id', null)
        .eq('source', 'auto')
        .eq('status', 'collecting')
        .limit(1)
        .maybeSingle();
      if (error) return { ok: false, message: error.message };
      collecting = data as Record<string, unknown> | null;
    }
    // Дедуп 2: pending/running base_collect-задача ЭТОЙ гипотезы (или вертикали,
    // когда гипотезы нет). База могла уже выйти из collecting, пока джоба ещё
    // активна. Фильтруем по hypothesis_id в payload — иначе своя же джоба первой
    // гипотезы заблокировала бы создание базы второй (multi-hypothesis).
    const { data: active, error: activeErr } = await supabase
      .from('ve_jobs')
      .select('id, payload')
      .eq('project_id', projectId)
      .eq('stage', 'base_collect')
      .in('status', ['pending', 'running']);
    if (activeErr) return { ok: false, message: activeErr.message };
    const allActiveBaseIds = (active ?? [])
      .map((j) => j.payload as { base_id?: string } | null)
      .map((payload) => payload?.base_id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const baseIds = (active ?? [])
      .map((j) => j.payload as { base_id?: string; hypothesis_id?: string | null } | null)
      // При per-hypothesis берём только джобы этой гипотезы; при легаси — без
      // hypothesis_id (джобы вертикали). Чужие гипотезы не блокируют.
      .filter((p) => (hypothesisId ? p?.hypothesis_id === hypothesisId : !p?.hypothesis_id))
      .map((p) => p?.base_id)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (collecting) {
      const collectingId = typeof collecting.id === 'string' ? collecting.id : '';
      if (!collectingId) return { ok: false, message: 'collecting base has no id' };

      // База могла остаться orphan между INSERT ve_bases и INSERT ve_jobs.
      // Повторный enqueue чинит её той же pending-задачей вместо вечного
      // ответа «уже собирается» без фактического воркера.
      if (!allActiveBaseIds.includes(collectingId)) {
        const storedPayload = repairJobPayload(collecting);
        const { error: repairErr } = await supabase.from('ve_jobs').insert({
          project_id: projectId,
          stage: 'base_collect',
          status: 'pending',
          payload: { base_id: collectingId, ...storedPayload },
        });
        if (repairErr) {
          // A concurrent retry may have won the unique-index race (or the
          // insert response may have been lost after commit). Re-read the
          // exact base before deciding that repair failed.
          const { data: repairRaceJobs, error: repairRaceErr } = await supabase
            .from('ve_jobs')
            .select('id, payload')
            .eq('project_id', projectId)
            .eq('stage', 'base_collect')
            .in('status', ['pending', 'running']);
          const repairedConcurrently = !repairRaceErr && (repairRaceJobs ?? []).some((candidate) => {
            const payload = candidate.payload as { base_id?: unknown } | null;
            return payload?.base_id === collectingId;
          });
          if (!repairedConcurrently) return { ok: false, message: repairErr.message };
        }
      }
      existing.push(collecting);
      continue;
    }
    if (baseIds.length > 0) {
      let existingQ = supabase
        .from('ve_bases')
        .select('id, status, hypothesis_id, vertical_id, collect_info')
        .in('id', baseIds)
        .neq('status', 'failed');
      existingQ = hypothesisId
        ? existingQ.eq('hypothesis_id', hypothesisId)
        : existingQ.eq('vertical_id', verticalId).is('hypothesis_id', null);
      existingQ = existingQ.limit(1);
      const { data: existingBase, error: baseErr } = await existingQ.maybeSingle();
      if (baseErr) return { ok: false, message: baseErr.message };
      if (existingBase) {
        existing.push(existingBase as Record<string, unknown>);
        continue;
      }
    }

    if (input.collectionMode === 'preview' && hypothesisId && !refill) {
      // A finished preview is a one-time result awaiting approval/launch.
      // Repeated preparation requests must reuse it, even below the target or
      // with zero contacts. Daily replenishment uses the approved supply path.
      const { data: prepared, error: preparedError } = await supabase
        .from('ve_bases')
        .select('id, status, hypothesis_id, row_count, collect_info')
        .eq('project_id', projectId)
        .eq('hypothesis_id', hypothesisId)
        .eq('source', 'auto')
        .eq('collect_info->>collection_mode', 'preview')
        .in('status', ['analyzing', 'analyzed'])
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (preparedError) return { ok: false, message: preparedError.message };
      if (prepared) {
        if (prepared.id === input.resumeBaseId) {
          const resumed = await resumeFailedPreview(supabase, input, hypothesisId, allActiveBaseIds, currentHypotheses.get(hypothesisId) ?? null);
          if (resumed) {
            if (!resumed.ok) return resumed;
            if (!resumed.created && resumed.continuation && !resumed.continuation.available) return resumed;
            (resumed.created ? created : existing).push(resumed.base);
            continue;
          }
        }
        existing.push(prepared as Record<string, unknown>);
        continue;
      }
      const resumed = await resumeFailedPreview(supabase, input, hypothesisId, allActiveBaseIds, currentHypotheses.get(hypothesisId) ?? null);
      if (resumed) {
        if (!resumed.ok) return resumed;
        if (!resumed.created && resumed.continuation && !resumed.continuation.available) return resumed;
        (resumed.created ? created : existing).push(resumed.base);
        continue;
      }
    }

    if (input.collectionMode === 'preview' && !refill) {
      try {
        if (!collectionGeography) {
          const { data: project, error: projectError } = await supabase.from('ve_projects')
            .select('brief, market').eq('id', projectId).maybeSingle();
          if (projectError || !project) return { ok: false,
            message: `Не удалось сохранить географию базы: ${projectError?.message ?? 'проект не найден'}` };
          collectionGeography = veCollectionGeographyFromBrief(project.brief);
          ruProject = projectMarket(project) === 'ru';
        }
        collectInfo.collection_geography = { ...collectionGeography };
      } catch (error) {
        return { ok: false, message: `Не удалось сохранить географию базы: ${error instanceof Error ? error.message : 'ошибка чтения брифа'}` };
      }
      // Только RU и только база гипотезы (строка ve_twogis_rows — проект + гипотеза). Вне try географии:
      // сбой 2ГИС не валит постановку. Сюда доходит лишь вставка новой базы — ветки повтора и
      // продолжения выше уже сделали continue, их collect_info не трогаем.
      if (hypothesisId && ruProject) {
        if (twoGisSource === undefined) twoGisSource = await freezeVeTwoGisSource(supabase, projectId);
        if (twoGisSource) collectInfo.two_gis_source = { ...twoGisSource };
      }
    }

    const { data: base, error: baseInsertErr } = await supabase
      .from('ve_bases')
      .insert({
        project_id: projectId,
        vertical_id: verticalId,
        hypothesis_id: hypothesisId,
        source: 'auto',
        status: 'collecting',
        // Уникальность по гипотезе: «auto: <вертикаль> — <гипотеза>». Только
        // для per-hypothesis (у легаси/refill гипотезы нет — прежнее имя).
        filename: filename ?? (hypothesisId && hypothesisTitle[hypothesisId]
          ? `auto: ${verticalName} — ${hypothesisTitle[hypothesisId]}`
          : `auto: ${verticalName}`),
        row_count: 0,
        columns: [],
        data: [],
        // Лимит и гипотеза — сразу в collect_info: прогресс-карта показывает
        // лимит, пока стадия ещё не перезаписала collect_info планом (поля
        // живут дальше — стадия мержит collect_info, а не заменяет).
        collect_info: collectInfo,
        ...(contactLimit !== null && hypothesisId ? { max_emails_per_company: contactLimit } : {}),
      })
      .select('id, status')
      .single();
    if (baseInsertErr || !base) {
      // 23505 = unique_violation на ve_bases_one_collecting_per_hypothesis /
      // ve_bases_one_collecting_per_vertical: параллельный запуск успел вставить
      // collecting-базу раньше. Это тот же дедуп, только пойманный индексом, —
      // отвечаем 'existing' с чужой базой.
      if (baseInsertErr?.code === '23505') {
        const conflictQ = hypothesisId
          ? supabase
              .from('ve_bases')
              .select('id, status, hypothesis_id, collect_info')
              .eq('hypothesis_id', hypothesisId)
              .eq('source', 'auto')
              .eq('status', 'collecting')
              .limit(1)
          : supabase
              .from('ve_bases')
              .select('id, status, hypothesis_id, collect_info')
              .eq('vertical_id', verticalId)
              .is('hypothesis_id', null)
              .eq('source', 'auto')
              .eq('status', 'collecting')
              .limit(1);
        const { data: conflict, error: conflictErr } = await conflictQ.maybeSingle();
        if (conflictErr) return { ok: false, message: conflictErr.message };
        if (conflict) {
          existing.push(conflict as Record<string, unknown>);
          continue;
        }
      }
      return { ok: false, message: baseInsertErr?.message ?? 'base insert failed' };
    }

    const { error: jobErr } = await supabase
      .from('ve_jobs')
      .insert({
        project_id: projectId,
        stage: 'base_collect',
        status: 'pending',
        payload: { base_id: base.id, ...jobPayload },
      });
    if (jobErr) {
      // Компенсация fail-closed: новая база без worker-job не должна навсегда
      // занимать partial unique index и блокировать следующие сборки.
      const { data: rescueJobs, error: rescueErr } = await supabase
        .from('ve_jobs')
        .select('id, payload')
        .eq('project_id', projectId)
        .eq('stage', 'base_collect')
        .in('status', ['pending', 'running']);
      if (!rescueErr) {
        const repairedConcurrently = (rescueJobs ?? []).some((candidate) => {
          const payload = candidate.payload as { base_id?: unknown } | null;
          return payload?.base_id === base.id;
        });
        if (repairedConcurrently) {
          created.push(base as Record<string, unknown>);
          continue;
        }
      }
      const { error: cleanupErr } = await supabase
        .from('ve_bases')
        .update({
          status: 'failed',
          error: `base_collect enqueue: ${jobErr.message}`.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq('id', base.id)
        .eq('status', 'collecting');
      if (cleanupErr) {
        return {
          ok: false,
          message: `${jobErr.message}; не удалось пометить orphan-базу failed: ${cleanupErr.message}`,
        };
      }
      return { ok: false, message: jobErr.message };
    }

    created.push(base as Record<string, unknown>);
  }

  if (created.length > 0) {
    return { ok: true, created: true, base: created[0], bases: created };
  }
  if (existing.length > 0) {
    return { ok: true, created: false, base: existing[0] };
  }
  return { ok: false, message: 'base collect targets are empty' };
}
