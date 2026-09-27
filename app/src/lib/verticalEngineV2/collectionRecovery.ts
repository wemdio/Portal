import { isVeProviderBillingError, isVeTransientDirectoryError, isVeResumableDirectoryError } from './collectionErrors';
import {
  collectionRoundLimit, veCollectionMaxRounds, VE_COLLECTION_ROUND_BUDGET, VE_COLLECTION_ROUND_CEILING,
  type VeCollectionTargetProgress,
} from './collectionTarget';
import { buildVeRelevanceReviewBatch, readVeRelevanceReserve, readVeRelevanceSourceRows } from './relevanceReserve';
import { needsVeSavedEmailReview } from './savedEmailReviewEligibility';
import { isVeRelevanceTriageEnabled } from './relevanceTriageConfig';
import { normalizeVeMaxEmailsPerCompany } from './companyContactCap';
import { VE_COMPANY_CAP_FIELD } from './relevanceReserve';
import { veCanWidenPlan } from './planWidening';
import { isVeRenewableSourceTask, reopenVeSourceTask } from './sourceRenewal';
import type { VeAdaptiveCollection } from './adaptiveCollection';
import type { VeCollectTask } from './prompts/sourcePlan';

/** Explicit continuation only: a terminal partial preview is never daily supply. */
export function canResumePartialPreview(base: Record<string, unknown>): boolean {
  const info = base.collect_info as Record<string, unknown> | null;
  const target = info?.target_progress as Record<string, unknown> | undefined;
  const checkpoint = info?.target_checkpoint as Record<string, unknown> | undefined;
  if (base.source !== 'auto' || base.status !== 'analyzed' || !base.hypothesis_id
    || info?.collection_mode !== 'preview' || info.refill || info.supply_batch_id || !target
    || !['limited', 'exhausted', 'error'].includes(String(target.status))
    || typeof target.ready_rows !== 'number' || !Number.isSafeInteger(target.ready_rows) || target.ready_rows < 0
    || typeof target.ready_target !== 'number' || !Number.isSafeInteger(target.ready_target) || target.ready_target <= 0
    || typeof target.round !== 'number' || !Number.isSafeInteger(target.round) || target.round < 1
    || checkpoint?.completed_round !== target.round
    || target.ready_rows >= target.ready_target) return false;
  const reserve = readVeRelevanceReserve(info.relevance_reserve);
  // The specialist raised the "addresses per company" limit. The addresses the
  // previous one held back are validated and waiting in the reserve, but only a
  // normal round can return them: their company names still need preparing.
  const limit = normalizeVeMaxEmailsPerCompany((base as { max_emails_per_company?: unknown }).max_emails_per_company);
  const appliedLimit = normalizeVeMaxEmailsPerCompany((base as { contact_cap_applied?: unknown }).contact_cap_applied);
  if (appliedLimit !== null && (limit === null || limit > appliedLimit)
    && reserve.some((row) => row[VE_COMPANY_CAP_FIELD])) return true;
  // Reuse current eligibility rules: completed uncertain checks do not become
  // an unlimited paid loop merely because fewer than 500 contacts were found.
  // With the calibrated triage enabled, saved uncertainty it has not read yet is
  // resumable work as well: one cheap pass per company, no sources or search.
  if (reserve.some(needsVeSavedEmailReview) || buildVeRelevanceReviewBatch({
    reserve, ready: [], source: readVeRelevanceSourceRows(info.relevance_reserve), automatic: true,
    triage: isVeRelevanceTriageEnabled(typeof base.project_id === 'string' ? base.project_id : null),
  }).rows.length > 0) return true;
  // Предел раундов не препятствие: продолжение само даёт новый бюджет
  // (grantVeResumeRoundBudget). Так b5934955 после круга повторной отправки
  // стояла на 100 из 100 раундов с живым реестром, и дособрать её было нельзя.
  if (!(Number(target.candidates_processed) < Number(target.max_candidates)) || !Array.isArray(info.tasks)) return false;
  // Старая задача карт (живой парсер до 16.09) тоже продолжаема: следующий
  // раунд читает её запросы из готового каталога.
  if (info.tasks.some((task) =>
    task && (task.status === 'pending' || task.status === 'dispatched' || isVeRenewableSourceTask(task)))) return true;
  // План выбран до дна, но база ещё не расширяла срез сама (вторая очередь
  // без придуманных порогов или подбор нового среза): её можно продолжить.
  // Так остались 33 базы аудита 22.09 — «Продолжить подготовку» их не брала.
  const planTasks = info.tasks.filter((task) => task && typeof task.task === 'object' && task.task)
    .map((task) => task.task as VeCollectTask);
  return target.status !== 'error'
    && veCanWidenPlan(planTasks, info.adaptive_collection as VeAdaptiveCollection | undefined);
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
    || isVeTransientDirectoryError(base.error))
    && progress.status === 'collecting'
    && typeof progress.round === 'number' && Number.isSafeInteger(progress.round) && progress.round > 0
    && (checkpoint?.completed_round ?? 0) === progress.round
      - (info.validation_retry || info.company_name_recovery || info.relevance_review_requested ? 0 : 1)) return 'interrupted';
  const discovery = info.source_contact_recovery as Record<string, unknown> | undefined;
  if (progress.status === 'error' && !construct && discovery?.version === 1
    && typeof progress.round === 'number' && Number.isSafeInteger(progress.round) && progress.round > 0
    && (checkpoint?.completed_round ?? 0) === progress.round - 1) return 'discovery';
  const pipeline = info.preview_pipeline as Record<string, unknown> | undefined;
  if (progress.status === 'error' && pipeline?.version === 1 && Array.isArray(pipeline.batches)
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
