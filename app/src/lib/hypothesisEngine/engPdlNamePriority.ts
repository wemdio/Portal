import { heCatalogSliceKey } from './catalogCursor';
import type { HeCollectTask, HeSourcePlan } from './prompts/sourcePlan';

type SelectedHypothesis = { id: string; title: string; status?: string | null };
type FundRole = 'administration' | 'custody';

/** Only these free additions belong to one manual base, never its refill plan. */
export interface HeEngPdlNamePriority {
  version: 1;
  addedSliceKeys: string[];
  originalSliceKeys: string[];
}

/** Whole company-type titles only: a service mentioned in a buyer's pain is not a selection. */
function titleRoles(title: string): FundRole[] | null {
  const parts = title.normalize('NFKC').toLowerCase().split(/\s*(?:,|\/|&|\band\b)\s*/);
  const roles = new Set<FundRole>();
  for (const part of parts) {
    const words = part.replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^(?:(?:independent|third party) )?fund (?:administrators?|administration(?: (?:providers?|firms?|companies))?)$/.test(words)) {
      roles.add('administration');
    } else if (/^(?:custodians?|custodian banks?|custody(?: (?:banks?|providers?|services))?|(?:fund )?depositar(?:y|ies))$/.test(words)) {
      roles.add('custody');
    } else return null;
  }
  return [...roles];
}

/** Comparison only; never rewrite the filters or bookmark keys of existing tasks. */
function comparableSliceKey(task: HeCollectTask): string | null {
  if (task.source !== 'pdl' || !task.pdl_filters) return heCatalogSliceKey(task);
  const filters = task.pdl_filters;
  const list = (values: string[] | undefined) => values?.map((value) => value.trim().toLowerCase()).filter(Boolean).sort();
  return heCatalogSliceKey({
    ...task,
    pdl_filters: {
      ...filters,
      industries: list(filters.industries), sizes: list(filters.sizes), countries: list(filters.countries),
      name: filters.name?.replace(/[%_]/g, '').toLowerCase(),
    },
  });
}

/**
 * Free candidate ordering for explicitly selected ENG fund-service roles.
 * The caller verifies the ENG owner and invokes this only before a base has
 * its own plan. Name matches are candidates, never company-fit evidence.
 */
export function prioritizeHeEngPdlNameSlices(input: {
  plan: HeSourcePlan;
  selectedHypotheses: readonly SelectedHypothesis[];
  requestedHypothesisIds: readonly string[] | null;
  maxTasks: number;
}): { plan: HeSourcePlan; addedNames: string[]; priority?: HeEngPdlNamePriority } {
  const unchanged = { plan: input.plan, addedNames: [] as string[] };
  const requested = new Set(input.requestedHypothesisIds ?? []);
  const selected = new Set(input.selectedHypotheses.map((hypothesis) => hypothesis.id));
  if (requested.size === 0 || requested.has('') || selected.size !== input.selectedHypotheses.length
    || requested.size !== selected.size || [...requested].some((id) => !selected.has(id))) return unchanged;
  const roles = new Set<FundRole>();
  for (const hypothesis of input.selectedHypotheses) {
    const found = hypothesis.status === 'rejected' ? null : titleRoles(hypothesis.title);
    if (!found) return unchanged;
    for (const role of found) roles.add(role);
  }
  const slots = Math.min(4, Math.floor(input.maxTasks)) - input.plan.tasks.length;
  if (!Number.isFinite(slots) || slots <= 0) return unchanged;
  // Keep every original task, including the mandatory broad fallback. A
  // pre-existing name filter must never be replaced by a different substring.
  const broad = input.plan.tasks.find((task) => task.source === 'pdl'
    && !task.pdl_filters?.name && (task.pdl_filters?.industries?.length ?? 0) > 0);
  if (!broad?.pdl_filters) return unchanged;

  const groups = [
    ...(roles.has('administration') ? [['fund services', 'fund administration']] : []),
    ...(roles.has('custody') ? [['custod', 'depositar']] : []),
  ];
  const names = Array.from({ length: 2 }, (_, i) => groups.flatMap((group) => group[i] ? [group[i]] : [])).flat();
  const known = new Set(input.plan.tasks.map(comparableSliceKey));
  const added: HeCollectTask[] = [];
  for (const name of names) {
    if (added.length >= slots) break;
    const task: HeCollectTask = {
      ...broad,
      rationale: `Prioritize company-name matches for selected fund-service roles (${name}); the original broad slice remains and company fit still requires qualification.`,
      pdl_filters: { ...broad.pdl_filters, name },
    };
    const key = comparableSliceKey(task);
    if (!key || known.has(key)) continue;
    known.add(key);
    added.push(task);
  }
  return added.length ? {
    plan: { ...input.plan, tasks: [...added, ...input.plan.tasks] },
    addedNames: added.map((task) => task.pdl_filters!.name!),
    priority: {
      version: 1,
      addedSliceKeys: added.map((task) => heCatalogSliceKey(task)!),
      originalSliceKeys: input.plan.tasks.map((task) => heCatalogSliceKey(task)).filter((key): key is string => key !== null),
    },
  } : unchanged;
}

/** Keep purchased widening and every original task; strip only this base's free additions. */
export function heEngPdlPlanForCache(plan: HeSourcePlan, priority?: HeEngPdlNamePriority): HeSourcePlan {
  if (priority?.version !== 1 || !Array.isArray(priority.addedSliceKeys) || !Array.isArray(priority.originalSliceKeys)) return plan;
  const original = new Set(priority.originalSliceKeys);
  const added = new Set(priority.addedSliceKeys.filter((key) => !original.has(key)));
  const tasks = plan.tasks.filter((task) => task.source !== 'pdl' || !added.has(heCatalogSliceKey(task)!));
  return tasks.length > 0 && tasks.length !== plan.tasks.length ? { ...plan, tasks } : plan;
}
