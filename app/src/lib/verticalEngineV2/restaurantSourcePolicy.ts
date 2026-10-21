import { validVeAdaptiveCollection, veSourceStrategyKey, type VeAdaptiveCollection } from './adaptiveCollection';
import { VE_COLLECTION_ROUND_CEILING } from './collectionTarget';
import type { VeCollectTask, VeSourcePlan } from './prompts/sourcePlan';

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const clean = (value: unknown) => typeof value === 'string' ? value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim() : '';
const alternatives = (value: string) => value.split(/\s*(?:[,;]|\s+и\s+|\s+или\s+)\s*/).filter(Boolean);
const restaurant = /^(?:(?:сетевые )?ресторанные (?:сети|холдинги|альянсы)|сети (?:концептуальных )?(?:кафе|ресторанов)|гастромаркеты|фудмоллы)$/;
// A legacy free-text definition cannot be treated as an unconstrained sector.
// Recognize only an explicit restaurant list and optional commercial context;
// unknown words/constraints keep the original plan (including manual scopes).
const benefitWords = new Set('необходимость нужно потребность привлекать трафик гостей в непиковые часы и презентовать сезонные меню продвигать показывать атмосферу заведений бронирования рост посещаемости'.split(' '));
export function isVeRestaurantCatalogAudience(value: unknown): boolean {
  const h = record(value);
  if (!h || h.origin !== 'generated' || h.broad !== false || h.audience_scope != null || h.status === 'rejected') return false;
  const title = alternatives(clean(h.title));
  const [audience, ...context] = clean(h.description).split(/[.!?]/).filter(Boolean).map((s) => s.trim());
  const types = alternatives(audience ?? '');
  return title.length > 0 && title.every((s) => restaurant.test(s)) && types.length > 0 && types.every((s) => restaurant.test(s))
    && context.every((s) => s.split(/[\s,;:—–-]+/).every((word) => benefitWords.has(word)));
}

/** Replace one incidental hiring slot, never add a task or change eligibility.
 * Exact local rubric names avoid paid rubric discovery. Network/holding proof
 * remains the responsibility of the unchanged relevance gate. */
export function normalizeVeRestaurantSourcePlan(plan: VeSourcePlan, input: { market: string; hypotheses: readonly unknown[] }): { plan: VeSourcePlan; changed: boolean } {
  if (input.market !== 'ru' || input.hypotheses.length !== 1 || !isVeRestaurantCatalogAudience(input.hypotheses[0])
    || !plan.tasks.length || plan.tasks.length > 6 || plan.tasks.some((t) => !['companies_directory', 'hh_live'].includes(t.source))
    || plan.tasks.some((t) => t.directory_filters?.regionCodes?.length || (t.hh_query?.area && t.hh_query.area !== '113'))) return { plan, changed: false };
  const index = plan.tasks.findIndex((t) => t.source === 'hh_live' && !!t.hh_query?.text);
  if (index < 0) return { plan, changed: false };
  const h = record(input.hypotheses[0])!;
  const audience = `${clean(h.title)} ${clean(h.description).split(/[.!?]/)[0]}`;
  const queries = [/(?:ресторан)/.test(audience) ? 'Рестораны' : '', /кафе/.test(audience) ? 'Кафе' : '',
    /фудмолл|гастромаркет/.test(audience) ? 'Фудмоллы' : ''].filter(Boolean);
  const task: VeCollectTask = { source: 'yandex_maps', maps_query: { queries, geo: 'Россия' },
    rationale: 'Готовый каталог названных типов заведений; сеть, холдинг и остальные условия проверяются отдельно.' };
  return { plan: { ...plan, tasks: plan.tasks.map((old, i) => i === index ? task : old) }, changed: true };
}

export interface VeRestaurantSourceRefresh {
  version: 1; source_key: string; previous_task: Record<string, unknown>; previous_construct?: unknown;
  held_review_companies: string[];
}

/** Explicit preview continuation only. All old work is terminal and both
 * original budgets have room. A new title cannot rewrite a frozen audience. */
export function needsVeRestaurantSourceContinuation(base: Record<string, unknown>, current?: Record<string, unknown> | null): boolean {
  const info = record(base.collect_info), target = record(info?.target_progress), checkpoint = record(info?.target_checkpoint);
  const saved = Array.isArray(info?.hypotheses) && info.hypotheses.length === 1 ? record(info.hypotheses[0]) : null;
  if (base.source !== 'auto' || base.status !== 'analyzed' || !base.hypothesis_id || !current || current.collection_market !== 'ru'
    || current.id !== base.hypothesis_id || !saved || saved.id !== base.hypothesis_id || !isVeRestaurantCatalogAudience(saved)
    || !isVeRestaurantCatalogAudience(current) || ['title', 'description', 'broad', 'origin'].some((k) => saved[k] !== current[k])
    || !info || info.collection_mode !== 'preview' || info.refill || info.campaign_id || info.supply_batch_id
    || info.restaurant_source_refresh || info.known_website_source || info.audience_source_refresh || info.audience_snapshot
    || (info.construct && record(info.construct)?.status !== 'done') || info.company_name_recovery || info.validation_retry
    || info.relevance_review_requested || record(info.saved_email_recovery)?.batch
    || (Array.isArray(record(info.preview_pipeline)?.batches) && (record(info.preview_pipeline)!.batches as unknown[]).length)
    || (info.adaptive_collection && (!validVeAdaptiveCollection(info.adaptive_collection as VeAdaptiveCollection) || record(info.adaptive_collection)?.pending))
    || !target || !['limited', 'exhausted'].includes(String(target.status)) || checkpoint?.completed_round !== target.round
    || ![target.round, target.max_rounds, target.candidates_processed, target.max_candidates, target.ready_rows, target.ready_target].every(Number.isSafeInteger)
    || Number(target.round) < 1 || Number(target.round) >= Number(target.max_rounds) || Number(target.max_rounds) > VE_COLLECTION_ROUND_CEILING
    || Number(target.candidates_processed) < 0 || Number(target.candidates_processed) >= Number(target.max_candidates)
    || Number(target.ready_rows) < 0 || Number(target.ready_rows) >= Number(target.ready_target)) return false;
  const states = Array.isArray(info.tasks) ? info.tasks.map(record) : [];
  const plan = record(info.plan);
  const planTasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (!states.length || planTasks.length !== states.length
    || states.some((s, i) => !s || s.status !== 'done' || s.error || !record(s.task) || s.source !== record(s.task)?.source
      || !record(planTasks[i]) || veSourceStrategyKey(s.task as VeCollectTask) !== veSourceStrategyKey(planTasks[i] as VeCollectTask))) return false;
  const decision = normalizeVeRestaurantSourcePlan({ tasks: states.map((s) => s!.task as VeCollectTask) }, { market: 'ru', hypotheses: [saved] });
  const index = decision.plan.tasks.findIndex((t, i) => t !== states[i]!.task);
  const old = states[index];
  // HH is a one-shot child, unlike renewable catalogue cursors: done is its
  // exhaustion marker. Preserve the completed child's entire receipt below.
  return decision.changed && !!old && old.source === 'hh_live' && old.rows === 0 && typeof old.child_job_id === 'string'
    && !!old.child_job_id && (!old.harvest || (Array.isArray(old.harvest) && old.harvest.length === 0));
}

/** Caller performs the same-base CAS and opens exactly one round. No budget,
 * candidate, receipt or saved-verdict reset is performed here. */
export function applyVeRestaurantSourceContinuation(info: Record<string, unknown>, current: Record<string, unknown>, heldReviewCompanies: string[]): void {
  const states = info.tasks as Array<Record<string, unknown>>;
  const decision = normalizeVeRestaurantSourcePlan({ tasks: states.map((s) => s.task as VeCollectTask) }, { market: 'ru', hypotheses: [current] });
  const index = decision.plan.tasks.findIndex((t, i) => t !== states[i].task);
  if (!decision.changed || index < 0) throw new Error('Restaurant source correction is unavailable');
  const task = decision.plan.tasks[index];
  info.restaurant_source_refresh = { version: 1, source_key: veSourceStrategyKey(task), previous_task: structuredClone(states[index]),
    ...(info.construct ? { previous_construct: structuredClone(info.construct) } : {}), held_review_companies: heldReviewCompanies } satisfies VeRestaurantSourceRefresh;
  info.cost_policy = { version: 1, website_discovery: 'existing_only' };
  info.tasks = states.map((s, i) => i === index ? { source: task.source, task, status: 'pending', child_job_id: null, rows: 0 } : s);
  info.plan = { ...record(info.plan), tasks: decision.plan.tasks };
  if (info.adaptive_collection) info.adaptive_collection = { ...record(info.adaptive_collection), active_source: veSourceStrategyKey(task), replan_needed: false };
  delete info.construct;
  if (info.search_policy) { info.search_policy = { ...record(info.search_policy) }; delete (info.search_policy as Record<string, unknown>).construct_rows; }
}
