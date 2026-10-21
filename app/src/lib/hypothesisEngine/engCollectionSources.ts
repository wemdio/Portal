import type { HeCollectTask } from './prompts/sourcePlan';

export interface HeEngSourceHistoryEntry {
  sourceKey: string;
  source: string;
  candidates: number;
  readyContacts: number;
  exhausted: boolean;
  failed: boolean;
  constructorId?: string;
}

export interface HeEngTargetSourceOptions {
  searchExhausted?: boolean;
  searchUnavailable?: boolean;
  /** Frozen server-generated registry slices, kept outside reusable source plans. */
  registryTasks?: readonly HeCollectTask[];
}

interface Choice {
  task: HeCollectTask;
  sourceKey: string;
}

type InactiveReason = 'sources_exhausted' | 'low_yield' | 'error';

function assertHistory(history: readonly HeEngSourceHistoryEntry[]): void {
  for (const round of history) {
    if (!round || typeof round.sourceKey !== 'string' || !round.sourceKey ||
        typeof round.source !== 'string' || !round.source ||
        !Number.isSafeInteger(round.candidates) || round.candidates < 0 ||
        !Number.isSafeInteger(round.readyContacts) || round.readyContacts < 0 ||
        typeof round.exhausted !== 'boolean' || typeof round.failed !== 'boolean') {
      throw new Error('ENG collection: invalid saved source history');
    }
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, stable(v)]));
  }
  return value;
}

/** A wording-only rationale change cannot reset an exhausted/paid source slice. */
export function heEngTargetSourceKey(task: HeCollectTask): string {
  const { rationale: _rationale, ...criteria } = task;
  return JSON.stringify(stable(criteria));
}

function sourceHistory(choice: Choice, history: readonly HeEngSourceHistoryEntry[]): HeEngSourceHistoryEntry[] {
  return history.filter((round) => round.sourceKey === choice.sourceKey);
}

/** A weak slice is suspended; this never claims that its whole market is empty. */
function inactiveReason(
  choice: Choice,
  history: readonly HeEngSourceHistoryEntry[],
  options: HeEngTargetSourceOptions,
): InactiveReason | null {
  if (choice.task.source === 'web_search') {
    if (options.searchUnavailable) return 'error';
    if (options.searchExhausted) return 'sources_exhausted';
  }
  const rounds = sourceHistory(choice, history);
  if (rounds.some((round) => round.exhausted)) return 'sources_exhausted';
  if (rounds.some((round) => round.failed)) return 'error';
  if (choice.task.source === 'eng_registry') {
    // Public APIs serve smaller pages. Four weak pages are enough to suspend
    // this slice, without changing the legacy catalogue/search thresholds.
    const pages = rounds.slice(-4);
    if (pages.length === 4 && pages.every(round => round.candidates >= 20 &&
        round.readyContacts / round.candidates < 0.05) &&
        pages.reduce((sum, round) => sum + round.candidates, 0) >= 100) return 'low_yield';
  }
  const recent = rounds.slice(-2);
  if (recent.length === 2 && recent.every((round) => round.candidates >= 50 &&
      round.readyContacts / round.candidates < 0.05) &&
      recent.reduce((sum, round) => sum + round.candidates, 0) >= 100) return 'low_yield';
  return null;
}

function choices(planTasks: readonly HeCollectTask[], options: HeEngTargetSourceOptions): Choice[] {
  // The Maps child job does not yet inherit the base's $5 ledger. Keep it out
  // of new adaptive collections until every physical request is guarded;
  // existing plans and the legacy dispatcher remain unchanged.
  const allowed = new Set(['pdl', 'funded', 'eng_hiring', 'web_search']);
  const tasks: HeCollectTask[] = [
    ...(options.registryTasks ?? []).filter(task => task.source === 'eng_registry' && task.registry_query),
    ...planTasks.filter((task) => allowed.has(task.source)),
    { source: 'web_search', rationale: 'Discover companies through ordinary search within the frozen target and countries.' },
  ];
  const seen = new Set<string>();
  return tasks.flatMap((task) => {
    const sourceKey = heEngTargetSourceKey(task);
    if (seen.has(sourceKey)) return [];
    seen.add(sourceKey);
    return [{ task, sourceKey }];
  });
}

function priority(choice: Choice): number {
  if (choice.task.source === 'eng_registry') return 0;
  if (choice.task.source === 'pdl' && choice.task.pdl_filters?.name?.trim()) return 1;
  if (['pdl', 'funded', 'eng_hiring'].includes(choice.task.source)) return 2;
  return 3;
}

/**
 * Chooses one unchanged source slice. It does not widen countries, company
 * size or audience, issue requests, overwrite a plan, or reset source cursors.
 * Ordinary search alternates with catalogue waves while both remain usable.
 */
export function pickHeEngTargetSource(
  planTasks: readonly HeCollectTask[],
  history: readonly HeEngSourceHistoryEntry[],
  options: HeEngTargetSourceOptions = {},
): Choice | null {
  assertHistory(history);
  const available = choices(planTasks, options).filter((choice) => !inactiveReason(choice, history, options));
  const web = available.find((choice) => choice.task.source === 'web_search');
  const catalogues = available.filter((choice) => choice.task.source !== 'web_search');
  const last = history.at(-1);
  if (web && (catalogues.length === 0 || (last && last.source !== 'web_search'))) return web;
  const ordered = catalogues.map((choice, index) => ({ choice, index, rounds: sourceHistory(choice, history).length }))
    .sort((a, b) => a.rounds - b.rounds || priority(a.choice) - priority(b.choice) || a.index - b.index);
  return ordered[0]?.choice ?? web ?? null;
}

/** Only use when pickHeEngTargetSource returned null. Mixed causes stay honest. */
export function heEngTargetSourceStopReason(
  planTasks: readonly HeCollectTask[],
  history: readonly HeEngSourceHistoryEntry[],
  options: HeEngTargetSourceOptions = {},
): InactiveReason {
  assertHistory(history);
  const reasons = choices(planTasks, options).map((choice) => inactiveReason(choice, history, options));
  if (reasons.some((reason) => reason === null)) {
    throw new Error('ENG collection: an available source cannot be reported as exhausted');
  }
  if (reasons.includes('error')) return 'error';
  if (reasons.includes('low_yield')) return 'low_yield';
  return 'sources_exhausted';
}
