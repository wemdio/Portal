import { isVeProviderBillingError, isVeTransientDirectoryError, isVeResumableDirectoryError, isVeTransientCatalogError } from './collectionErrors';
import { isTransientDbError } from '@/lib/db/transientError';
import { isVeStageDbInterruption } from './stageDb';
import {
  collectionRoundLimit, veCollectionMaxRounds, VE_COLLECTION_ROUND_BUDGET, VE_COLLECTION_ROUND_CEILING,
  type VeCollectionTargetProgress,
} from './collectionTarget';
import { buildVeRelevanceReviewBatch, readVeRelevanceReserve, readVeRelevanceSourceRows, veSavedReviewSignature } from './relevanceReserve';
import { hasPendingVeSavedEmailRecovery } from './savedEmailRecovery';
import { isVeRelevanceTriageEnabled } from './relevanceTriageConfig';
import { normalizeVeMaxEmailsPerCompany } from './companyContactCap';
import { VE_COMPANY_CAP_FIELD } from './relevanceReserve';
import { veCanWidenPlan } from './planWidening';
import { isVeRenewableSourceTask, reopenVeSourceTask } from './sourceRenewal';
import { validVeAdaptiveCollection, veAdaptiveSourceDeferred, veAdaptiveSourceDry, veSourceStrategyKey, type VeAdaptiveCollection } from './adaptiveCollection';
import type { VeCollectTask } from './prompts/sourcePlan';
import { needsVeKnownWebsiteContinuation } from './knownWebsiteDirectory';
import { needsVeRestaurantSourceContinuation } from './restaurantSourcePolicy';
import type { VeStaffingCorrectionScope } from './staffingCorrection';
import { relevanceHash } from './relevanceCheckpoint';
import { detectVeNicheSourceProfile, normalizeVeNicheSourceTask, veNicheRubricAllowed, type VeNicheSourceProfile } from './nicheSourcePolicy';
import { isVeAudienceScopeEnabled } from './audienceScope';
import { veAutomaticAudienceReviewRows } from './audienceReviewHold';
import { needsLegacyFintechAudienceRefresh, needsLegacyRetailAudienceRefresh, readVeCollectionAudienceSnapshot, veAudienceNicheProfile, veSourceDiscoveryIsExistingOnly, type VeSourceAudienceHypothesis } from './sourceAudience';

export interface VeCollectionContinuation {
  available: boolean;
  action: 'resume_collection' | 'resume_preparation' | null;
  code: 'not_preview' | 'state_unchecked' | 'preparation_incomplete' | 'launched' | 'already_running' | 'in_progress' | 'recovery_available' | 'recovery_unavailable' | 'invalid_checkpoint'
    | 'target_reached' | 'saved_work' | 'contact_limit_changed' | 'round_limit' | 'candidate_limit'
    | 'source_update' | 'sources_available' | 'source_expansion' | 'low_yield' | 'sources_exhausted';
  reason: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const records = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
  ? value.flatMap((item) => { const parsed = record(item); return parsed ? [parsed] : []; }) : [];
const available = (code: VeCollectionContinuation['code'], reason: string,
  action: Exclude<VeCollectionContinuation['action'], null> = 'resume_preparation'): VeCollectionContinuation => ({ available: true, action, code, reason });
const unavailable = (code: VeCollectionContinuation['code'], reason: string): VeCollectionContinuation => ({ available: false, action: null, code, reason });

/** A feature flag is eligibility, never permission to restart an old base.
 * The enqueue caller additionally requires an exact explicit resume and CAS. */
export function needsVeControlledAudienceRefresh(base: Record<string, unknown>, currentHypothesis?: Record<string, unknown> | null): boolean {
  const info = record(base.collect_info);
  if (!info || base.status !== 'analyzed' || base.source !== 'auto'
    || !currentHypothesis || currentHypothesis.id !== base.hypothesis_id || currentHypothesis.status === 'rejected') return false;
  const saved = records(info.hypotheses);
  if (saved.length !== 1 || saved[0].id !== base.hypothesis_id) return false;
  const candidate = { ...info, hypotheses: [currentHypothesis as unknown as VeSourceAudienceHypothesis] };
  return (currentHypothesis.collection_market === 'ru' && needsLegacyRetailAudienceRefresh(candidate))
    || (isVeAudienceScopeEnabled(typeof base.project_id === 'string' ? base.project_id : null) && needsLegacyFintechAudienceRefresh(candidate));
}

/** Detect the same quiescent, one-way correction as the collector, without
 * changing cursors, receipts or the amount of work already admitted. */
function hasSourceCorrection(info: Record<string, unknown>, tasks: Array<Record<string, unknown>>): boolean {
  const selection = record(info.source_selection);
  const snapshot = readVeCollectionAudienceSnapshot(info.audience_snapshot);
  const hypotheses = records(info.hypotheses).filter((h) => typeof h.title === 'string') as Array<{ title: string }>;
  // Match the collector: a title or old profile cannot restore a specialty
  // rewrite which the frozen audience (including required conditions) forbids.
  const profile = snapshot ? veAudienceNicheProfile(snapshot.hypotheses)
    : (typeof info.niche_source_profile === 'string' ? info.niche_source_profile
      : detectVeNicheSourceProfile(hypotheses)) as VeNicheSourceProfile | null;
  if (!profile || !['payments', 'esoteric_platform', 'adult_platform', 'crossborder_ecommerce', 'crossborder_buyers'].includes(profile)
    || !info.plan || !tasks.length || (selection && !(profile === 'payments' && selection.profile === 'payments' && selection.version === 1))
    || (info.construct && record(info.construct)?.status !== 'done') || record(info.adaptive_collection)?.pending
    || records(record(info.preview_pipeline)?.batches).length || tasks.some((task) => task.status === 'dispatched')) return false;
  return tasks.some((state) => {
    const task = record(state.task) as VeCollectTask | null;
    if (!task || (state.source === 'hh_live' && state.status !== 'pending')) return false;
    const updated = normalizeVeNicheSourceTask(task, profile);
    const categories = record(record(state.catalog)?.filters)?.categories;
    return veSourceStrategyKey(task) !== veSourceStrategyKey(updated)
      || (Array.isArray(categories) && categories.some((label) => typeof label === 'string' && !veNicheRubricAllowed(profile, label)));
  });
}

/** Only a single, explicitly identified audience can correct saved verdicts. */
export function veSavedRelevanceScope(info: { hypotheses?: unknown; audience_snapshot?: unknown }, hypothesisId: unknown): VeStaffingCorrectionScope {
  const snapshot = readVeCollectionAudienceSnapshot(info.audience_snapshot);
  const hypotheses = records(snapshot?.hypotheses ?? info.hypotheses);
  const hypothesis = hypotheses.length === 1 && typeof hypothesisId === 'string'
    && hypotheses[0].id === hypothesisId ? hypotheses[0] : null;
  if (!hypothesis || hypothesis.status === 'rejected') return {};
  // This helper only selects the legacy staffing relaxation. A frozen typed
  // scope can require hiring explicitly, so reopening that refusal would pay
  // for a review that cannot apply. Other pending-review selectors are intact.
  if (snapshot && hypothesis.audience_scope != null) return {};
  return {
    hypothesisTitle: typeof hypothesis.title === 'string' ? hypothesis.title : undefined,
    hypothesisDescription: typeof hypothesis.description === 'string' ? hypothesis.description : undefined,
    hypothesisOrigin: hypothesis.origin === 'generated' || hypothesis.origin === 'manual' ? hypothesis.origin : undefined,
  };
}

/** Pure server decision; callers additionally apply live-job and launched-base guards. */
export function getVeCollectionContinuation(base: Record<string, unknown>, currentHypothesis?: Record<string, unknown> | null): VeCollectionContinuation {
  const info = record(base.collect_info);
  if (base.source !== 'auto' || !base.hypothesis_id || info?.collection_mode !== 'preview' || info.refill || info.supply_batch_id) {
    return unavailable('not_preview', 'Для этой базы продолжение сбора недоступно.');
  }
  let existingOnly: boolean;
  try {
    readVeCollectionAudienceSnapshot(info.audience_snapshot);
    existingOnly = veSourceDiscoveryIsExistingOnly(info);
  } catch {
    return unavailable('invalid_checkpoint', 'Сохранённые условия аудитории или расходов требуют проверки.');
  }
  if (base.status === 'collecting') return available('in_progress', 'Продолжится незавершённый этап подготовки.');
  // Explicit preparation can undo the specialist's cancellation through its
  // existing leased RPC; this does not authorize automatic cancellation undo.
  if (base.status === 'failed') return base.error === 'Отменено пользователем' || previewRecoveryKind(base)
    ? available('recovery_available', 'Продолжится этап, на котором произошёл сбой. Сохранённые результаты будут использованы повторно.')
    : unavailable('recovery_unavailable', 'Причину остановки нужно исправить перед продолжением подготовки.');
  const target = record(info.target_progress);
  const checkpoint = record(info.target_checkpoint);
  if (base.status !== 'analyzed' || !target) return unavailable('not_preview', 'Подготовка базы ещё не завершена.');
  if (typeof target.ready_rows === 'number' && typeof target.ready_target === 'number' && target.ready_rows >= target.ready_target) {
    return unavailable('target_reached', 'Цель сбора достигнута.');
  }
  if (!['limited', 'exhausted', 'error'].includes(String(target.status))
    || !Number.isSafeInteger(target.ready_rows) || Number(target.ready_rows) < 0
    || !Number.isSafeInteger(target.ready_target) || Number(target.ready_target) <= 0
    || !Number.isSafeInteger(target.round) || Number(target.round) < 1 || checkpoint?.completed_round !== target.round) {
    return unavailable('invalid_checkpoint', 'Сохранённый этап не готов к продолжению. Требуется проверка состояния базы.');
  }
  const tasks = records(info.tasks);
  // Drain admitted work before applying caps or economic source holds.
  if (info.company_name_recovery || record(info.saved_email_recovery)?.batch
    || (record(info.construct)?.status === 'dispatched' && record(info.construct)?.bc_job_id)
    || records(record(info.preview_pipeline)?.batches).length
    || tasks.some((task) => task.status === 'dispatched')) return available('saved_work', 'Осталось завершить обработку уже найденных компаний.');
  // Source-only correction precedes optional reviews of the old reserve. Its
  // own predicate requires BOTH original budgets and a quiescent free slot.
  if (needsVeKnownWebsiteContinuation(base, currentHypothesis)) {
    return available('source_update', 'Доступна проверка официальных сайтов платформ в пределах сохранённого бюджета.', 'resume_collection');
  }
  if (needsVeRestaurantSourceContinuation(base, currentHypothesis)) {
    return available('source_update', 'Доступен готовый каталог профильных заведений в пределах сохранённого бюджета.', 'resume_collection');
  }
  if (info.restaurant_source_refresh) {
    return unavailable('sources_exhausted', 'Доступное продолжение по каталогу завершено. Проверенные контакты сохранены.');
  }
  if (record(info.known_website_source)?.continuation_only === true) {
    return unavailable('sources_exhausted', 'Проверка доступных официальных сайтов завершена. Проверенные контакты сохранены.');
  }
  const reserve = readVeRelevanceReserve(info.relevance_reserve);
  // The specialist raised the "addresses per company" limit. The addresses the
  // previous one held back are validated and waiting in the reserve, but only a
  // normal round can return them: their company names still need preparing.
  const limit = normalizeVeMaxEmailsPerCompany((base as { max_emails_per_company?: unknown }).max_emails_per_company);
  const appliedLimit = normalizeVeMaxEmailsPerCompany((base as { contact_cap_applied?: unknown }).contact_cap_applied);
  if (appliedLimit !== null && (limit === null || limit > appliedLimit)
    && reserve.some((row) => row[VE_COMPANY_CAP_FIELD])) return available('contact_limit_changed', 'Можно вернуть проверенные адреса из резерва с новым лимитом на компанию.');
  // An audited source correction must not first buy reviews under the old
  // audience. In-flight children were handled above; untouched reserve rows
  // are held when the explicit refresh is persisted by the worker.
  if (currentHypothesis && needsLegacyRetailAudienceRefresh({ ...info,
    hypotheses: [currentHypothesis as unknown as VeSourceAudienceHypothesis] })
    && needsVeControlledAudienceRefresh(base, currentHypothesis)) {
    if (!(Number(target.candidates_processed) < Number(target.max_candidates))) {
      return unavailable('candidate_limit', 'Сохранённый бюджет кандидатов исчерпан. Готовые контакты сохранены.');
    }
    if (Number(target.round) >= Math.min(VE_COLLECTION_ROUND_CEILING, veCollectionMaxRounds(target.max_rounds))) {
      return unavailable('round_limit', 'Сохранённый бюджет сбора исчерпан. Обновление источников само не увеличивает его; готовые контакты сохранены.');
    }
    if (info.adaptive_collection && !validVeAdaptiveCollection(info.adaptive_collection as VeAdaptiveCollection)) {
      return unavailable('invalid_checkpoint', 'Сохранённый план сбора требует проверки. Готовые контакты сохранены.');
    }
    return available('source_update', 'Доступен обновлённый подбор источников в пределах сохранённого бюджета.', 'resume_collection');
  }
  // Reuse current eligibility rules: completed uncertain checks do not become
  // an unlimited paid loop merely because fewer than 500 contacts were found.
  // With the calibrated triage enabled, saved uncertainty it has not read yet is
  // resumable work as well: one cheap pass per company, no sources or search.
  try {
    if (hasPendingVeSavedEmailRecovery(veAutomaticAudienceReviewRows(reserve, record(info.audience_source_refresh)?.held_review_companies), info.saved_email_recovery)) return available('saved_work', 'Можно завершить проверку сохранённых адресов.');
  } catch {
    return unavailable('invalid_checkpoint', 'Сохранённые результаты проверки адресов требуют проверки.');
  }
  const triage = isVeRelevanceTriageEnabled(typeof base.project_id === 'string' ? base.project_id : null);
  const scope = veSavedRelevanceScope(info.audience_snapshot || currentHypothesis === undefined
    ? info : { hypotheses: currentHypothesis ? [currentHypothesis] : [] }, base.hypothesis_id);
  const batch = buildVeRelevanceReviewBatch({ ...scope,
    reserve: veAutomaticAudienceReviewRows(reserve, record(info.audience_source_refresh)?.held_review_companies),
    ready: [], source: readVeRelevanceSourceRows(info.relevance_reserve), automatic: true,
    allowPaidSearch: !existingOnly, triage });
  if (batch.rows.length && record(info.relevance_review_progress)?.signature !== relevanceHash(veSavedReviewSignature(batch.rows, { ...scope, triage, source: batch.evidenceRows }))) {
    return available('saved_work', 'Можно уточнить соответствие уже найденных компаний.');
  }
  // Предел раундов не препятствие: продолжение само даёт новый бюджет
  // (grantVeResumeRoundBudget). Так b5934955 после круга повторной отправки
  // стояла на 100 из 100 раундов с живым реестром, и дособрать её было нельзя.
  if (!(Number(target.candidates_processed) < Number(target.max_candidates))) {
    return unavailable('candidate_limit', 'Достигнут лимит проверенных кандидатов. Повторное нажатие не откроет новый сбор; готовые контакты сохранены.');
  }
  if (Number(target.round) >= VE_COLLECTION_ROUND_CEILING) return unavailable('round_limit', 'Достигнут предел попыток сбора. Готовые контакты сохранены.');
  const adaptive = record(info.adaptive_collection) as VeAdaptiveCollection | null;
  if (info.adaptive_collection && (!adaptive || !validVeAdaptiveCollection(adaptive))) {
    return unavailable('invalid_checkpoint', 'Сохранённый план сбора требует проверки. Готовые контакты сохранены.');
  }
  if (needsVeControlledAudienceRefresh(base, currentHypothesis)) {
    if (Number(target.round) >= veCollectionMaxRounds(target.max_rounds)) {
      return unavailable('round_limit', 'Сохранённый бюджет сбора исчерпан. Обновление источников само не увеличивает его; готовые контакты сохранены.');
    }
    return available('source_update', 'Доступен обновлённый подбор источников в пределах сохранённого бюджета.', 'resume_collection');
  }
  if (hasSourceCorrection(info, tasks)) return available('source_update', 'Доступен обновлённый подбор источников для этой аудитории.', 'resume_collection');
  const policy = adaptive ?? undefined;
  const taskHeld = (state: Record<string, unknown>) => {
    const task = record(state.task) as VeCollectTask | null;
    return !!policy && !!task && !!(veAdaptiveSourceDeferred(policy, veSourceStrategyKey(task))
      || veAdaptiveSourceDry(policy.completed, veSourceStrategyKey(task)));
  };
  // Старая задача карт (живой парсер до 16.09) тоже продолжаема: следующий
  // раунд читает её запросы из готового каталога.
  if (tasks.some((task) => !taskHeld(task) && (task.status === 'pending' || isVeRenewableSourceTask(task)))) {
    return available('sources_available', 'Сбор продолжится с сохранённой позиции источников.', 'resume_collection');
  }
  // План выбран до дна, но база ещё не расширяла срез сама (вторая очередь
  // без придуманных порогов или подбор нового среза): её можно продолжить.
  // Так остались 33 базы аудита 22.09 — «Продолжить подготовку» их не брала.
  const planTasks = tasks.flatMap((task) => record(task.task) ? [task.task as VeCollectTask] : []);
  const deferred = !!policy && tasks.some((state) => record(state.task)
    && !!veAdaptiveSourceDeferred(policy, veSourceStrategyKey(state.task as VeCollectTask)));
  // Economic holds close widening too; dry sources can still use an available
  // bounded alternative plan. Neither rule resets the previous yield history.
  if (!deferred && target.status !== 'error' && veCanWidenPlan(planTasks, policy)) {
    return available('source_expansion', 'Доступно продолжение по следующему срезу той же аудитории.', 'resume_collection');
  }
  return tasks.some(taskHeld) || target.stop_cause === 'low_yield'
    ? unavailable('low_yield', 'Текущие источники почти не дают новых контактов. Повторный запуск с теми же источниками не поможет; готовая часть сохранена.')
    : unavailable('sources_exhausted', 'Текущий план источников обработан, незавершённых проверок нет. Готовая часть сохранена; это не означает, что весь рынок исчерпан.');
}

/** Compatibility for callers considering terminal partial previews only. */
export function canResumePartialPreview(base: Record<string, unknown>, currentHypothesis?: Record<string, unknown> | null): boolean {
  return base.status === 'analyzed' && getVeCollectionContinuation(base, currentHypothesis).available;
}

/**
 * Явное «Продолжить подготовку» — новый бюджет раундов, один на нажатие:
 * предел ставится от текущего раунда, а не прибавляется к прежнему, поэтому
 * повторные нажатия без работы между ними бюджет не копят. Счёт холостых
 * раундов тоже начинается заново.
 */
export function grantVeResumeRoundBudget(info: Record<string, unknown>): void {
  const progress = info.target_progress as VeCollectionTargetProgress | undefined;
  if (!progress || typeof progress !== 'object' || !Number.isSafeInteger(progress.round) || progress.round < 1) return;
  const next: VeCollectionTargetProgress = { ...progress, max_rounds: Math.max(veCollectionMaxRounds(progress.max_rounds),
    Math.min(VE_COLLECTION_ROUND_CEILING, progress.round + VE_COLLECTION_ROUND_BUDGET)) };
  delete next.idle_streak;
  info.target_progress = next;
}

/** Only recognized preview failures may reuse a base; never supply/refill. */
export function previewRecoveryKind(base: Record<string, unknown>): 'validation' | 'billing' | 'pipeline' | 'discovery' | 'catalog' | 'interrupted' | null {
  const info = base.collect_info as Record<string, unknown> | null;
  if (base.source !== 'auto' || base.status !== 'failed' || !base.hypothesis_id
    || !info || info.collection_mode !== 'preview' || info.refill || info.supply_batch_id) return null;
  const progress = info.target_progress as Record<string, unknown> | undefined;
  const checkpoint = info.target_checkpoint as Record<string, unknown> | undefined;
  const construct = info.construct as Record<string, unknown> | undefined;
  const stats = info.stats as Record<string, unknown> | undefined;
  const names = info.company_name_cleanup as Record<string, unknown> | undefined;
  if (!progress) return null;
  // Accounting failures stop paid work immediately, possibly between rounds.
  // An explicit continuation must reuse the durable children/cursors instead
  // of purchasing a new base. Reject incoherent checkpoints and cancellations.
  // Exhausted 429 waits fail the job with the round still `collecting`; the
  // saved checkpoint is coherent and must be continued, not replaced by a new
  // paid base (18.09.2026: five bases). Same rule as the journal outage.
  // The inactivity watchdog (19.09.2026) fails the same way after its retries:
  // the round is still `collecting` and every checkpoint is intact.
  if ((base.error === 'Provider usage journal could not be saved.'
    || /^(?:Requesty 429|VE2 [a-z_]+ inactivity timeout)\b/.test(String(base.error ?? ''))
    || isVeTransientDirectoryError(base.error) || isVeTransientCatalogError(base.error))
    && progress.status === 'collecting'
    && typeof progress.round === 'number' && Number.isSafeInteger(progress.round) && progress.round > 0
    && (checkpoint?.completed_round ?? 0) === progress.round
      - (info.validation_retry || info.company_name_recovery || info.relevance_review_requested ? 0 : 1)) return 'interrupted';
  const discovery = info.source_contact_recovery as Record<string, unknown> | undefined;
  if (progress.status === 'error' && !construct && discovery?.version === 1
    && typeof progress.round === 'number' && Number.isSafeInteger(progress.round) && progress.round > 0
    && (checkpoint?.completed_round ?? 0) === progress.round - 1) return 'discovery';
  const pipeline = info.preview_pipeline as Record<string, unknown> | undefined;
  // An unknown preview save deliberately leaves the durable progress intact.
  // Reuse only a coherent pipeline after a recognized DB outage, never buy a
  // replacement base or reopen an arbitrary permission/schema failure.
  const previewSaveFailure = typeof base.error === 'string' && base.error.startsWith('Preview checkpoint save: ')
    && (isTransientDbError({ message: base.error })
      || isVeStageDbInterruption(base.error)
      || /^Preview checkpoint save: An invalid response was received from upstream server[.!]?$/.test(base.error));
  if ((progress.status === 'error' || (progress.status === 'collecting' && previewSaveFailure))
    && pipeline?.version === 1 && Array.isArray(pipeline.batches)
    && typeof pipeline.revision === 'number' && Number.isSafeInteger(pipeline.revision)
    && typeof progress.round === 'number' && Number.isSafeInteger(progress.round) && progress.round > 0
    && (checkpoint?.completed_round === progress.round
      || (pipeline.batches.length > 0 && (checkpoint?.completed_round ?? 0) === progress.round - 1))) return 'pipeline';
  if (progress.status === 'error' && construct?.status === 'done' && typeof construct.bc_job_id === 'string'
    && typeof progress.round === 'number' && Number.isInteger(progress.round) && progress.round > 0
    && checkpoint?.completed_round === progress.round
    // Older multi-round previews lack prior_* diagnostic counters. Recovery
    // uses the completed constructor and saved recipients, not those counters.
    // Requiring them would silently start and pay for a new collection.
    && (stats?.relevance_coverage_complete === false
      || base.error === 'Проверка email завершилась не полностью'
      || (!!info.company_name_recovery && names?.status === 'partial'))) return 'validation';
  // A failed planner has not committed any candidate round. Reuse its empty
  // base after funds are restored, instead of accumulating duplicate failures.
  if (!construct && !checkpoint && progress.round === 1 && progress.candidates_processed === 0
    && isVeProviderBillingError(base.error ?? progress.reason)) return 'billing';
  // `pending` здесь — не новая задача, а след незавершённого возобновления:
  // продолжение само переводит упавшую задачу карт в pending, и если следующий
  // заход стадии упал (прод 17.09.2026), задача остаётся в этом статусе
  // навсегда. Не узнать своё же состояние — значит на «Продолжить подготовку»
  // купить новую базу вместо уже проверенных контактов старой.
  if (progress.status === 'error' && Array.isArray(info.tasks) && info.tasks.some((task) =>
    task?.source === 'yandex_maps' && (task.status === 'failed' || task.status === 'pending')
    && task.task?.maps_query?.queries?.length)) return 'catalog';
  if (progress.status === 'error' && Array.isArray(info.tasks) && info.tasks.some((task) =>
    task?.source === 'companies_directory' && task.status === 'failed' && isVeResumableDirectoryError(task.error))
    && typeof progress.round === 'number' && Number.isSafeInteger(progress.round) && progress.round > 0
    && ((checkpoint?.completed_round ?? 0) === progress.round - 1 || checkpoint?.completed_round === progress.round)) return 'catalog';
  return null;
}

/**
 * Раунд, записавший контрольную точку, ЗАКРЫТ: `completed_round === round`.
 * При ошибке задачи `finishCollectionRound` возвращает `error`, НЕ увеличивая
 * номер раунда, поэтому продолжение обязано открыть СЛЕДУЮЩИЙ раунд: стадия
 * читает `completed_round === round - 1` как «этот раунд ещё не собирался» и
 * отвергает собственное сохранённое состояние.
 *
 * Номер нельзя двигать в одиночку. В стадии инкремент всегда идёт в паре со
 * сбросом завершённого конструктора и пересчётом лимита набора: конструктор
 * закрытого раунда, оставленный следующему, заново втягивает те же компании и
 * завышает `candidates_processed`. Здесь повторён ровно тот же переход.
 *
 * Контрольная точка на раунд позади — согласованное состояние (раунд ещё не
 * закрылся), его продолжают тем же номером: функция ничего не меняет.
 */
export function openNextVeCollectionRound(info: Record<string, unknown>): boolean {
  const progress = info.target_progress as VeCollectionTargetProgress | undefined;
  const checkpoint = info.target_checkpoint as { completed_round?: unknown } | undefined;
  // Потолок раундов не повторяем: стадия проверяет его сама, уже своим
  // текущим значением. Сохранённое в старой базе (5 при нынешних 100) здесь
  // означало бы отказ чинить ровно те базы, ради которых потолок и подняли.
  if (!progress || typeof progress !== 'object'
    || !Number.isSafeInteger(progress.round) || progress.round < 1
    || checkpoint?.completed_round !== progress.round) return false;
  // Равенство completed_round и round означает «раунд закрыт» ТОЛЬКО без флагов
  // повторного прохода: с любым из них стадия читает то же равенство как «идёт
  // сохранённый проход того же раунда» (предикат на входе стадии вычитает
  // единицу лишь когда флагов нет). Сдвинув номер такой базе, мы отобрали бы у
  // неё конструктор и залипли бы ровно той ошибкой, ради которой всё это.
  if (info.validation_retry || info.company_name_recovery || info.relevance_review_requested) return false;
  const next: VeCollectionTargetProgress = { ...progress, round: progress.round + 1, status: 'collecting' };
  delete next.reason;
  info.target_progress = next;
  // Конструктор принадлежит закрытому раунду; следующий строит свой.
  delete info.construct;
  const policy = info.search_policy as Record<string, unknown> | undefined;
  if (policy && typeof policy === 'object') delete policy.construct_rows;
  const stats = info.stats as Record<string, unknown> | undefined;
  if (stats && typeof stats === 'object') delete stats.finished_at;
  // Живые лейны реестра и каталога снова читают СВОЮ закладку — тот же сброс,
  // что делает стадия на границе раунда; старая задача карт открывается как
  // чтение каталога. Исчерпанные и упёршиеся в потолок остаются как есть, как
  // и задачи, которые возобновление уже подняло.
  const tasks = info.tasks;
  if (Array.isArray(tasks) && !info.preview_pipeline && !info.adaptive_collection) {
    info.tasks = tasks.map((state) => {
      const task = state as Record<string, unknown> | null;
      return task && isVeRenewableSourceTask(task) ? reopenVeSourceTask(task) : state;
    });
  }
  info.limit = collectionRoundLimit(next);
  return true;
}
