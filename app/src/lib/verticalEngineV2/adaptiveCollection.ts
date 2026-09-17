import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeCollectTask } from './prompts/sourcePlan';

export const VE_ADAPTIVE_BATCH_SIZE = 100;
export const VE_ADAPTIVE_MIN_YIELD = 0.05;
export const VE_ADAPTIVE_MAX_COST_PER_CONTACT = 0.05;
export const VE_SERPER_CREDIT_ESTIMATE_USD = 50 / 49_999;
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
export const veSourceStrategyKey = (task: VeCollectTask) => {
  const filters = task.source === 'companies_directory' ? { ...task.directory_filters, includeIp: task.directory_filters?.includeIp ?? false }
    : task.source === 'hh_live' ? task.hh_query : task.source === 'pdl' ? task.pdl_filters
      : task.source === 'funded' ? task.funded_filters : task.source === 'eng_hiring' ? task.eng_hiring_query : task.maps_query;
  return createHash('sha256').update(JSON.stringify(stable({ source: task.source, filters }))).digest('hex');
};
export const veReadyContactKeys = (rows: Array<Record<string, unknown>>) => [...new Set(rows.map((row) => String(row.email ?? '').trim().toLowerCase()).filter(Boolean))]
  .map((email) => createHash('sha256').update(email).digest('hex'));
export interface VeBatchSpend { ai_usd: number; serper_credits: number; estimated_total_usd: number; unknown_attempts: number; complete: boolean }
export interface VeAdaptiveResult {
  id: string; source_key: string; source: string; candidates: number; new_ready: number;
  started_at: string; finished_at: string; spend: VeBatchSpend; poor: boolean;
}
export interface VeAdaptiveCollection {
  version: 1; started_at: string; active_source?: string; replan_attempts: number; replan_needed?: boolean;
  replan_error?: string; switches: number; note?: string; completed: VeAdaptiveResult[];
  /** Private baseline: never return recipient hashes through project polling. */
  pending?: { id: string; source_key: string; source: string; candidates: number; ready_before: string[]; started_at: string };
  last_completed_at?: string;
}
export function validVeAdaptiveCollection(state: VeAdaptiveCollection): boolean {
  const count = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  return state?.version === 1 && date(state.started_at) && count(state.replan_attempts, 2)
    && count(state.switches, 1000) && Array.isArray(state.completed) && state.completed.length <= 100
    && state.completed.every((batch) => batch && typeof batch.id === 'string' && typeof batch.source_key === 'string'
      && count(batch.candidates, 100) && count(batch.new_ready, 1_000_000) && typeof batch.poor === 'boolean')
    && (!state.pending || (typeof state.pending.id === 'string' && typeof state.pending.source_key === 'string'
      && count(state.pending.candidates, 100) && state.pending.candidates > 0 && date(state.pending.started_at)
      && Array.isArray(state.pending.ready_before) && state.pending.ready_before.every((key) => /^[a-f0-9]{64}$/.test(key))));
}
export function newVeAdaptiveCollection(): VeAdaptiveCollection {
  return { version: 1, started_at: new Date().toISOString(), replan_attempts: 0, switches: 0, completed: [] };
}
export function finishVeAdaptiveBatch(state: VeAdaptiveCollection, readyRows: Array<Record<string, unknown>>, spend: VeBatchSpend, now = new Date().toISOString()): VeAdaptiveCollection {
  if (!state.pending) return state;
  const pending = state.pending;
  if (state.completed.some((item) => item.id === pending.id)) return { ...state, pending: undefined };
  const before = new Set(pending.ready_before);
  const added = veReadyContactKeys(readyRows).filter((key) => !before.has(key)).length;
  const poor = pending.candidates >= 50 && (added / pending.candidates < VE_ADAPTIVE_MIN_YIELD
    || (spend.complete && spend.estimated_total_usd > 0 && spend.estimated_total_usd / Math.max(1, added) > VE_ADAPTIVE_MAX_COST_PER_CONTACT));
  const result: VeAdaptiveResult = { id: pending.id, source_key: pending.source_key, source: pending.source,
    candidates: pending.candidates, new_ready: added, started_at: pending.started_at, finished_at: now, spend, poor };
  const completed = [...state.completed, result].slice(-100);
  const recent = completed.filter((item) => item.source_key === pending.source_key).slice(-2);
  const needsSwitch = recent.length === 2 && recent.every((item) => item.poor);
  return { ...state, pending: undefined, completed, last_completed_at: now, replan_needed: needsSwitch,
    note: needsSwitch ? 'Низкий выход двух партий подряд: выбираем другой источник или поисковый срез.'
      : `Партия проверена: ${added} новых готовых контактов из ${pending.candidates} компаний.` };
}
/** Prefer an untried alternative after two poor complete batches, then the
 * best observed yield. Never discard the old source or its unprocessed rows. */
export function chooseVeAdaptiveSource(state: VeAdaptiveCollection, available: string[]): string | undefined {
  if (!available.length) return undefined;
  if (state.active_source && available.includes(state.active_source) && !state.replan_needed) return state.active_source;
  const stats = (key: string) => state.completed.filter((item) => item.source_key === key);
  const candidates = available.filter((key) => !state.replan_needed || key !== state.active_source);
  return candidates.sort((a, b) => {
    const left = stats(a), right = stats(b);
    const rank = (items: VeAdaptiveResult[]) => !items.length ? 2 : items.length >= 2 && items.slice(-2).every((item) => item.poor) ? -1
      : items.reduce((sum, item) => sum + item.new_ready, 0) / Math.max(1, items.reduce((sum, item) => sum + item.candidates, 0));
    return rank(right) - rank(left);
  })[0] ?? available[0];
}

/** Provider charges for the serial acquisition/checking window, including
 * retries and search, not a misleading division of lifetime spend. Unknown
 * charges stay unknown and cannot make an expensive source look cheap. */
export function summarizeVeBatchSpend(logs: Array<{ event: string; context: Record<string, unknown> }>, complete = true): VeBatchSpend {
  const attempts = new Map<string, { start?: Record<string, unknown>; finish?: Record<string, unknown> }>();
  for (const row of logs) {
    if (!['started', 'finished'].includes(row.event)) continue;
    if (!row.context || typeof row.context !== 'object' || typeof row.context.attemptId !== 'string') { complete = false; continue; }
    const attempt = attempts.get(row.context.attemptId) ?? {};
    if (row.event === 'started') attempt.start = row.context;
    else if (attempt.finish && JSON.stringify(attempt.finish) !== JSON.stringify(row.context)) complete = false;
    else attempt.finish = row.context;
    attempts.set(row.context.attemptId, attempt);
  }
  let ai = 0, credits = 0, unknown = 0;
  const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  for (const attempt of attempts.values()) {
    const finish = attempt.finish;
    let missing = !attempt.start || !finish || finish.status === 'ambiguous';
    if (finish?.provider === 'requesty') {
      const cost = amount(finish.reportedCostUsd) ?? amount(finish.estimatedCostUsd);
      if (cost === undefined) missing = true; else ai += cost;
    } else if (finish?.provider === 'serper') {
      const cost = amount(finish.serperCredits);
      if (cost === undefined) missing = true; else credits += cost;
    } else if (finish) missing = true;
    if (missing) unknown++;
  }
  return { ai_usd: ai, serper_credits: credits, estimated_total_usd: ai + credits * VE_SERPER_CREDIT_ESTIMATE_USD,
    unknown_attempts: unknown, complete: complete && unknown === 0 };
}
export async function readVeBatchSpend(db: SupabaseClient, projectId: string, baseId: string, from: string, to: string): Promise<VeBatchSpend> {
  const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
  try {
    for (let offset = 0; offset < 10_000; offset += 1000) {
      const { data, error } = await db.from('application_logs').select('event,context')
        .eq('source', 've_provider_usage').eq('context->>projectId', projectId).eq('context->>baseId', baseId)
        .eq('context->>stage', 'base_collect').in('event', ['started', 'finished'])
        .gte('created_at', from).lt('created_at', to).order('created_at').order('id').range(offset, offset + 999)
        .abortSignal(AbortSignal.timeout(3000));
      if (error) return summarizeVeBatchSpend(logs, false);
      logs.push(...(data ?? []));
      if (!data || data.length < 1000) return summarizeVeBatchSpend(logs, logs.length > 0);
    }
  } catch { /* Keep known subtotal; never label missing accounting as zero. */ }
  return summarizeVeBatchSpend(logs, false);
}
