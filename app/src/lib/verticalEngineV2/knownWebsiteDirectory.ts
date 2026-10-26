import type { VeCollectTask } from './prompts/sourcePlan';
import { readVeCollectionAudienceSnapshot, veAudienceNicheProfile, veSourceDiscoveryIsExistingOnly, type VeSourceAudienceHypothesis } from './sourceAudience';
import { readVeAudienceScope } from './audienceScope';
import { VE_COLLECTION_ROUND_CEILING } from './collectionTarget';
import { validVeAdaptiveCollection, type VeAdaptiveCollection } from './adaptiveCollection';
import { isVeTwoGisTask, veCountedPlanTasks } from './twoGisQuarantine';

export const VE_KNOWN_WEBSITE_CATALOG = 'adult-platforms-2026-10-19' as const;
/** Public official-page discovery hints reviewed 2026-10-08. These are NOT
 * approved leads, current ownership verdicts, emails or evidence of demand.
 * The ordinary constructor and relevance/ownership/email gates decide each. */
export const VE_KNOWN_ADULT_WEBSITES = [
  { brand: 'BongaCams', website: 'https://bongacams.com', source: 'https://bongacash.com/terms' },
  { brand: 'LiveJasmin', website: 'https://livejasmin.com', source: 'https://www.awempire.com/terms-of-service/' },
  { brand: 'CAM4', website: 'https://www.cam4.com/faq/business-document-requirements-to-apply-for-a-studio', source: 'https://www.cam4.com/faq/business-document-requirements-to-apply-for-a-studio' },
  { brand: 'LoyalFans', website: 'https://www.loyalfans.com/legal/terms-conditions', source: 'https://www.loyalfans.com/legal/terms-conditions' },
  { brand: 'Flirt4Free', website: 'https://www.flirt4free.com/support.php', source: 'https://www.flirt4free.com/terms.php' },
  { brand: 'Chaturbate', website: 'https://chaturbate.com/terms/', source: 'https://chaturbate.com/terms/' },
  { brand: 'iWantClips', website: 'https://iwantclips.com/customer_services/index', source: 'https://iwantclips.com/customer_services/index' },
  { brand: 'AdmireMe', website: 'https://ps.admireme.vip/contact-us/', source: 'https://ps.admireme.vip/about/' },
  { brand: 'MyFreeCams', website: 'https://wiki.myfreecams.com/wiki/Contact_Support', source: 'https://www.myfreecams.com/' },
  { brand: 'Stripchat', website: 'https://ru.stripchat.com/support/billing', source: 'https://ru.stripchat.com/support/billing' },
] as const;

interface SourceState {
  source: VeCollectTask['source']; task: VeCollectTask; status: 'pending' | 'dispatched' | 'done' | 'failed';
  child_job_id: string | null; rows: number; harvest?: unknown[]; exhausted?: boolean; unavailable?: boolean;
  note?: string; two_gis_pair_id?: string;
}
export interface VeKnownWebsiteSourceReceipt {
  catalog: typeof VE_KNOWN_WEBSITE_CATALOG; previous_task?: SourceState; previous_construct?: unknown;
  /** Exact legacy continuation may only consume this bounded source. */
  continuation_only?: true;
  held_review_companies?: string[];
}
interface SourceInfo {
  collection_mode?: string; refill?: boolean; campaign_id?: string; supply_batch_id?: string;
  hypotheses?: VeSourceAudienceHypothesis[]; audience_snapshot?: unknown; cost_policy?: unknown;
  niche_source_profile?: unknown; source_selection?: unknown;
  plan?: { tasks: VeCollectTask[] }; tasks?: SourceState[];
  construct?: { status?: string }; preview_pipeline?: { batches: unknown[] };
  adaptive_collection?: VeAdaptiveCollection;
  company_name_recovery?: unknown; validation_retry?: boolean; relevance_review_requested?: boolean;
  saved_email_recovery?: { batch?: unknown }; search_policy?: { phase?: string; construct_rows?: unknown[] };
  target_progress?: { round: number; max_rounds?: number; candidates_processed: number; max_candidates: number; ready_rows: number; ready_target: number };
  target_checkpoint?: { completed_round: number };
  known_website_source?: VeKnownWebsiteSourceReceipt;
}

/** This catalogue has no country proof. A language/TLD or RU source planner
 * does not establish company geography. Keep any explicit audience constraint
 * on the ordinary plan; do not substitute these international hints for it. */
export function veKnownWebsiteAudienceEligible(info: SourceInfo): boolean {
  const hypotheses = readVeCollectionAudienceSnapshot(info.audience_snapshot)?.hypotheses ?? info.hypotheses;
  if (!hypotheses || hypotheses.length !== 1 || hypotheses[0].status === 'rejected'
    || veAudienceNicheProfile(hypotheses) !== 'adult_platform') return false;
  const h = hypotheses[0], scope = readVeAudienceScope(h.audience_scope);
  if (scope?.required.length) return false;
  const text = [h.title, h.description, ...(scope?.any_of ?? []), ...(scope?.excluded ?? [])].join(' ');
  return !/(?:росси|россий|(?<![\p{L}\p{N}])рф(?![\p{L}\p{N}])|снг|москв|петербург|казахстан|беларус|украин|европ|евросоюз|сша|америк|британ|германи|франци|кипр|нидерланд|азии|азиат|африк|географ|юрисдикц|зарегистрирован|russia|cis\b|europe|\beu\b|\busa?\b|\buk\b|located|based in|registered in|country|countries|region)/iu.test(text);
}

/** A new plan stays <=4; a six-task legacy plan replaces one exhausted free
 * zero-row source. Never remove a child receipt, live cursor or unconsumed
 * harvest. The complete retired state is archived, not reconstructed. */
function replacementIndex(info: SourceInfo): number | null {
  // Близнецы two_gis вне потолка плана; индекс добавления — реальная длина info.tasks,
  // иначе запись ниже перезаписала бы близнеца.
  const counted = veCountedPlanTasks(info.tasks ?? []).length;
  if (!info.plan || !info.tasks?.length || counted > 6
    || info.plan.tasks.length !== info.tasks.length) return null;
  const newPlan = info.target_progress?.candidates_processed === 0 && info.target_progress.round === 1 && !info.construct;
  const i = info.tasks.findIndex((state) => ['companies_directory', 'yandex_maps'].includes(state.source)
    && !state.child_job_id && state.rows === 0 && !state.harvest?.length
    && ((newPlan && state.status === 'pending') || (state.status === 'done' && (state.exhausted || state.unavailable))));
  return i >= 0 ? i : newPlan && counted < 4 ? info.tasks.length : null;
}

export function canAddVeKnownWebsiteSource(info: SourceInfo): boolean {
  const t = info.target_progress;
  return info.collection_mode === 'preview' && !info.refill && !info.campaign_id && !info.supply_batch_id
    && !info.known_website_source && !info.tasks?.some((s) => s.source === 'known_websites')
    && !!t && Number.isSafeInteger(t.round) && t.round >= 1
    && Number.isSafeInteger(t.max_rounds) && Number(t.max_rounds) > t.round && Number(t.max_rounds) <= VE_COLLECTION_ROUND_CEILING
    && Number.isSafeInteger(t.max_candidates) && t.max_candidates > 0
    && Number.isSafeInteger(t.candidates_processed) && t.candidates_processed >= 0 && t.candidates_processed < t.max_candidates
    && Number.isSafeInteger(t.ready_rows) && t.ready_rows >= 0 && Number.isSafeInteger(t.ready_target) && t.ready_target > 0
    && t.ready_rows < t.ready_target && (!info.construct || info.construct.status === 'done')
    && !info.preview_pipeline?.batches.length && !info.adaptive_collection?.pending
    && (!info.adaptive_collection || validVeAdaptiveCollection(info.adaptive_collection))
    && !info.company_name_recovery && !info.validation_retry && !info.relevance_review_requested && !info.saved_email_recovery?.batch
    && !info.tasks?.some((s) => s.status === 'dispatched')
    && veSourceDiscoveryIsExistingOnly(info) && veKnownWebsiteAudienceEligible(info) && replacementIndex(info) !== null;
}

/** Caller controls new-plan vs exact explicit continuation. This never starts
 * a job, opens a round, clears a verdict, or raises any budget. */
export function addVeKnownWebsiteSource(info: SourceInfo): boolean {
  if (!canAddVeKnownWebsiteSource(info)) return false;
  const index = replacementIndex(info)!;
  const task: VeCollectTask = { source: 'known_websites', known_websites: { catalog: VE_KNOWN_WEBSITE_CATALOG },
    rationale: 'Официальные сайты профильных платформ; контакты и соответствие проверяются обычным порядком.' };
  info.known_website_source = { catalog: VE_KNOWN_WEBSITE_CATALOG,
    ...(info.tasks![index] ? { previous_task: structuredClone(info.tasks![index]) } : {}),
    ...(info.construct ? { previous_construct: structuredClone(info.construct) } : {}) };
  const replaced = info.tasks![index];
  info.tasks = [...info.tasks!];
  info.tasks[index] = { source: task.source, task, status: 'pending', child_job_id: null, rows: 0 };
  // Близнец заменённой Яндекс-задачи остался без пары: закрыт как недоступный, не failed; harvest сохраняется.
  if (replaced?.two_gis_pair_id) info.tasks = info.tasks.map((state): SourceState => isVeTwoGisTask(state)
    && state.two_gis_pair_id === replaced.two_gis_pair_id
    ? { ...state, status: 'done', unavailable: true, child_job_id: null, note: 'Пара близнеца заменена официальными сайтами платформ' } : state);
  info.plan = { tasks: info.tasks.map((s) => s.task) };
  return true;
}

export function needsVeKnownWebsiteContinuation(base: Record<string, unknown>, current?: Record<string, unknown> | null): boolean {
  if (base.source !== 'auto' || base.status !== 'analyzed' || !base.hypothesis_id || !current
    || current.id !== base.hypothesis_id || current.status === 'rejected') return false;
  const info = base.collect_info as SourceInfo | undefined;
  if (!info || info.hypotheses?.length !== 1 || info.hypotheses[0].id !== base.hypothesis_id
    || !info.target_progress || info.target_checkpoint?.completed_round !== info.target_progress.round) return false;
  // Both current and frozen audience must still be eligible; a changed title
  // cannot broaden the existing snapshot through this source-only action.
  return veKnownWebsiteAudienceEligible({ hypotheses: [current as unknown as VeSourceAudienceHypothesis] })
    && canAddVeKnownWebsiteSource(info);
}
