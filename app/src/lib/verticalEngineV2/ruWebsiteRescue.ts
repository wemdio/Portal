import type { VeCollectionTargetProgress } from './collectionTarget';
import { normalizeVeCompanyName } from './collectionIdentity';
import { veRelevanceCompanyKey } from './relevanceReserve';

export const VE_RU_WEBSITE_RESCUE_LIMIT = 100;
export function buildVeRuRescueQueries(input: { title: string; description?: string; geography?: string }): string[] {
  const clean = (text: string | undefined, limit: number) => (text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  const title = clean(input.title, 300);
  const description = clean(input.description, 600);
  const geo = clean(input.geography, 200);
  if (!title) return [];
  return [...new Set([
    [title, description, geo, 'официальный сайт компании'],
    [title, geo, 'компании контакты'],
    [title, geo, 'организации реквизиты'],
    [title, description, geo, 'о компании'],
    [title, geo, 'официальный сайт контакты'],
  ].map((parts) => parts.filter(Boolean).join(' ')))].slice(0, 5);
}
export type VeRuWebsiteRescueReason = 'sources_exhausted' | 'low_yield';
export interface VeRuWebsiteRescue {
  version: 1;
  phase: 'discovering' | 'reserved' | 'running' | 'gates' | 'done';
  id: string;
  started_at: string;
  /** Discovery/paused time is not constructor execution/queue time. */
  child_dispatched_at?: string;
  reason: VeRuWebsiteRescueReason;
  ready_before: number;
  target: number;
  completed_round: number;
  rows: Array<Record<string, string>>;
  discovery?: {
    queries: string[];
    /** Advanced BEFORE each provider request; uncertain outcomes are not retried. */
    next_query: number;
    urls: string[];
    /** Advanced BEFORE a bounded wave of guarded site reads. */
    next_site: number;
  };
  /** Ordinary collection has already accounted for its last round. The rescue
   * may add checked contacts, but must not grant source/round budget. */
  resume_target: VeCollectionTargetProgress;
  outcome?: 'complete' | 'constructor_unavailable' | 'gates_incomplete';
}

/** Missing goals, outages and an unfinished ordinary batch never buy a Fetch. */
export function veRuWebsiteRescueReason(input: {
  market: string; enabled: boolean; ready: number; target: number;
  completedRound: number; ordinaryComplete: boolean; pending: boolean;
  sourcesExhausted: boolean; lowYield: boolean;
}): VeRuWebsiteRescueReason | null {
  if (input.market !== 'ru' || !input.enabled || !input.ordinaryComplete || input.pending
    || !Number.isSafeInteger(input.ready) || input.ready < 0
    || !Number.isSafeInteger(input.target) || input.target <= input.ready
    || !Number.isSafeInteger(input.completedRound) || input.completedRound < 1) return null;
  return input.sourcesExhausted ? 'sources_exhausted' : input.lowYield ? 'low_yield' : null;
}

/** Existing companies only. A missing/invalid address is never guessed, and a
 * company that already has an address is not sent through the constructor. */
export function selectVeRuWebsiteRescueRows<T extends Record<string, unknown>>(rows: T[], addressedCompanies: Set<string>): T[] {
  const selected = new Map<string, T>();
  for (const row of rows) {
    if (!normalizeVeCompanyName(row.company) || String(row.email ?? '').trim()) continue;
    try {
      const raw = String(row.website ?? '').trim();
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (!raw || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
    } catch { continue; }
    const key = veRelevanceCompanyKey(row);
    if (!addressedCompanies.has(key) && !selected.has(key)) selected.set(key, row);
    if (selected.size >= VE_RU_WEBSITE_RESCUE_LIMIT) break;
  }
  return [...selected.values()];
}

export function readVeRuWebsiteRescue(value: unknown): VeRuWebsiteRescue | null {
  if (value === undefined) return null;
  const state = value as VeRuWebsiteRescue | null;
  const whole = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  const target = state?.resume_target;
  const discovery = state?.discovery;
  if (!state || state.version !== 1 || !['discovering', 'reserved', 'running', 'gates', 'done'].includes(state.phase)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.id)
    || !Number.isFinite(Date.parse(state.started_at)) || !['sources_exhausted', 'low_yield'].includes(state.reason)
    || (state.child_dispatched_at !== undefined && !Number.isFinite(Date.parse(state.child_dispatched_at)))
    || !whole(state.ready_before) || !whole(state.target) || state.target <= state.ready_before
    || !whole(state.completed_round) || state.completed_round < 1 || !Array.isArray(state.rows)
    || state.rows.length > VE_RU_WEBSITE_RESCUE_LIMIT
    || state.rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row)
      || Object.values(row).some((v) => typeof v !== 'string') || !String(row.company ?? '').trim()
      || !String(row.website ?? '').trim() || String(row.email ?? '').trim())
    || (state.phase === 'discovering' && !discovery)
    || (discovery && (!Array.isArray(discovery.queries) || discovery.queries.length > 5
      || discovery.queries.some((query) => typeof query !== 'string' || !query.trim() || query.length > 2000)
      || !whole(discovery.next_query) || discovery.next_query > discovery.queries.length
      || !Array.isArray(discovery.urls) || discovery.urls.length > 100
      || discovery.urls.some((url) => typeof url !== 'string' || !url.startsWith('https://') || url.length > 2000)
      || !whole(discovery.next_site) || discovery.next_site > discovery.urls.length))
    || !target || !['preview', 'supply'].includes(target.mode)
    || !whole(target.ready_target) || target.ready_target !== state.target || !whole(target.ready_rows)
    || !whole(target.candidates_processed) || !whole(target.round) || !whole(target.max_rounds)
    || !whole(target.max_candidates) || !['collecting', 'target_reached', 'exhausted', 'limited', 'error'].includes(target.status)) {
    throw new Error('Invalid RU website rescue checkpoint');
  }
  return state;
}
