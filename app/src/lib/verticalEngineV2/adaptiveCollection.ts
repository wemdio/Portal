import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeCollectTask } from './prompts/sourcePlan';
import { collectionRoundLimit, type VeCollectionTargetProgress } from './collectionTarget';
import { veContactLimitKey } from './companyContactCap';

export const VE_ADAPTIVE_BATCH_SIZE = 100;
/** Candidates are not recipients. Near the goal retain a useful 50-company
 * sample; otherwise one missing email causes dozens of tiny paid rounds. */
export function veAdaptiveCandidateLimit(progress: VeCollectionTargetProgress, reserved = 0): number {
  if (progress.ready_rows >= progress.ready_target) return 0;
  return Math.max(0, Math.min(VE_ADAPTIVE_BATCH_SIZE, Math.max(50, collectionRoundLimit(progress)),
    progress.max_candidates - progress.candidates_processed - reserved));
}
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
  /** Новые контакты в единицах цели (не больше K адресов на компанию). У партий до 23.09.2026 поля нет. */
  new_target?: number;
  started_at: string; finished_at: string; spend: VeBatchSpend; poor: boolean;
}
export interface VeAdaptiveCollection {
  version: 1; started_at: string; active_source?: string; replan_attempts: number; replan_needed?: boolean;
  replan_error?: string; switches: number; note?: string; completed: VeAdaptiveResult[];
  /** Сколько раз раунд открывался заново, потому что план кончился раньше цели. */
  widenings?: number;
  /** Повод перепланирования: низкий выход или исчерпанный план. */
  replan_reason?: 'low_yield' | 'plan_exhausted';
  /** Private baseline: never return recipient hashes through project polling. */
  pending?: { id: string; source_key: string; source: string; candidates: number; ready_before: string[]; started_at: string };
  last_completed_at?: string;
}
export function validVeAdaptiveCollection(state: VeAdaptiveCollection): boolean {
  const count = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  return state?.version === 1 && date(state.started_at) && count(state.replan_attempts, 2)
    && (state.widenings === undefined || count(state.widenings, 2))
    && count(state.switches, 1000) && Array.isArray(state.completed) && state.completed.length <= 100
    && state.completed.every((batch) => batch && typeof batch.id === 'string' && typeof batch.source_key === 'string'
      && count(batch.candidates, 100) && count(batch.new_ready, 1_000_000) && typeof batch.poor === 'boolean'
      && (batch.new_target === undefined || count(batch.new_target, 1_000_000)))
    && (!state.pending || (typeof state.pending.id === 'string' && typeof state.pending.source_key === 'string'
      && count(state.pending.candidates, 100) && state.pending.candidates > 0 && date(state.pending.started_at)
      && Array.isArray(state.pending.ready_before) && state.pending.ready_before.every((key) => /^[a-f0-9]{64}$/.test(key))));
}
export function newVeAdaptiveCollection(): VeAdaptiveCollection {
  return { version: 1, started_at: new Date().toISOString(), replan_attempts: 0, switches: 0, completed: [] };
}
/** Evidence window: a verdict needs at least this many checked companies. */
export const VE_ADAPTIVE_WINDOW_CANDIDATES = 50;
export interface VeAdaptiveYieldWindow { candidates: number; new_ready: number; spend_usd: number; spend_complete: boolean; poor: boolean }
/** Latest-first windows of one source's batches, each of at least 50 companies.
 * A narrow slice's tail comes in batches of 1–25 companies: judged one by one,
 * no batch was ever large enough to count as poor and the source never changed. */
export function veAdaptiveYieldWindows(completed: VeAdaptiveResult[], sourceKey: string, limit = 2): VeAdaptiveYieldWindow[] {
  const windows: VeAdaptiveYieldWindow[] = [];
  let current: Omit<VeAdaptiveYieldWindow, 'poor'> | null = null;
  for (let index = completed.length - 1; index >= 0 && windows.length < limit; index--) {
    const batch = completed[index];
    if (batch.source_key !== sourceKey) continue;
    current ??= { candidates: 0, new_ready: 0, spend_usd: 0, spend_complete: true };
    current.candidates += batch.candidates;
    current.new_ready += batch.new_ready;
    current.spend_usd += Number.isFinite(batch.spend?.estimated_total_usd) ? batch.spend.estimated_total_usd : 0;
    current.spend_complete &&= batch.spend?.complete === true;
    if (current.candidates < VE_ADAPTIVE_WINDOW_CANDIDATES) continue;
    const poor = current.new_ready / current.candidates < VE_ADAPTIVE_MIN_YIELD
      || (current.spend_complete && current.spend_usd > 0 && current.spend_usd / Math.max(1, current.new_ready) > VE_ADAPTIVE_MAX_COST_PER_CONTACT);
    windows.push({ ...current, poor });
    current = null;
  }
  return windows;
}
/** Two consecutive poor windows of at least 50 companies each. */
export function veAdaptiveLowYield(completed: VeAdaptiveResult[], sourceKey: string): boolean {
  const windows = veAdaptiveYieldWindows(completed, sourceKey);
  return windows.length === 2 && windows.every((window) => window.poor);
}
/**
 * Сколько новых контактов партия добавила к цели: цель считает не больше K
 * адресов одной компании (K — лимит специалиста, без него 3; null — без
 * ограничения). Шестой адрес компании, у которой уже три, цели не прибавляет.
 */
function veAddedTargetContacts(rows: Array<Record<string, unknown>>, before: Set<string>, perCompany: number | null): number {
  const companies = new Map<string, Map<string, boolean>>();
  for (const row of rows) {
    const email = String(row.email ?? '').trim().toLowerCase();
    if (!email) continue;
    const key = createHash('sha256').update(email).digest('hex');
    const company = veContactLimitKey(row);
    const emails = companies.get(company) ?? new Map<string, boolean>();
    emails.set(key, before.has(key));
    companies.set(company, emails);
  }
  const cap = perCompany ?? Number.POSITIVE_INFINITY;
  let added = 0;
  for (const emails of companies.values()) {
    const old = [...emails.values()].filter(Boolean).length;
    added += Math.min(cap, emails.size) - Math.min(cap, old);
  }
  return added;
}
export function finishVeAdaptiveBatch(state: VeAdaptiveCollection, readyRows: Array<Record<string, unknown>>, spend: VeBatchSpend,
  now = new Date().toISOString(), perCompany: number | null = null): VeAdaptiveCollection {
  if (!state.pending) return state;
  const pending = state.pending;
  if (state.completed.some((item) => item.id === pending.id)) return { ...state, pending: undefined };
  const before = new Set(pending.ready_before);
  const added = veReadyContactKeys(readyRows).filter((key) => !before.has(key)).length;
  const result: VeAdaptiveResult = { id: pending.id, source_key: pending.source_key, source: pending.source,
    candidates: pending.candidates, new_ready: added,
    new_target: Math.min(added, veAddedTargetContacts(readyRows, before, perCompany)),
    started_at: pending.started_at, finished_at: now, spend, poor: false };
  // The batch is judged together with its predecessors until 50 companies.
  result.poor = veAdaptiveYieldWindows([...state.completed, result], pending.source_key, 1)[0]?.poor === true;
  const completed = [...state.completed, result].slice(-100);
  const needsSwitch = veAdaptiveLowYield(completed, pending.source_key);
  const next: VeAdaptiveCollection = { ...state, pending: undefined, completed, last_completed_at: now, replan_needed: needsSwitch,
    replan_reason: 'low_yield',
    note: needsSwitch ? 'Низкий выход двух партий подряд: выбираем другой источник или поисковый срез.'
      : `Партия проверена: ${added} новых готовых контактов из ${pending.candidates} компаний.` };
  if (!needsSwitch) delete next.replan_reason;
  return next;
}

/**
 * Сухой источник (решение владельца 23.09.2026: останавливать сухую базу
 * должен движок, а не специалист). Источник — стратегия выборки (source_key):
 * тот же источник с другим запросом или срезом меряется отдельно. Сухой — если
 * его последние не меньше VE_DRY_SOURCE_MIN_COMPANIES проверенных компаний
 * дали меньше VE_DRY_SOURCE_MIN_CONTACTS новых готовых контактов в единицах цели.
 *
 * Замер 23.09.2026 по партиям Когнитуса (adaptive_collection.completed):
 *
 *   Фонды помощи аутизму, карты    1 814 компаний → 47 контактов (2,6 %)
 *   Инклюзивные школы, карты       3 376 → 4 (два запроса)
 *   Центры диагностики РАС, реестр 4 275 → 2
 *   Фонды помощи аутизму, реестр   3 786 → 0
 *
 * Окно 1 500, а не меньше: у рабочих карт Фондов худшие 500 подряд компаний
 * дали 4 контакта, худшие 1 000 — 13, худшие 1 500 — 36. На окне в 500 правило
 * выключило бы единственный рабочий источник базы. Порог 5 на 1 500 — это
 * 0,33 %: при таком выходе сотня контактов (порог узкого рынка) стоила бы
 * 30 000 проверенных компаний, а у сухих источников замера окно даёт 0–4.
 * История — последние 100 партий: если в них у источника меньше 1 500
 * компаний (партии по 1–15 компаний), приговора нет и источник живой.
 */
export const VE_DRY_SOURCE_MIN_COMPANIES = 1_500;
export const VE_DRY_SOURCE_MIN_CONTACTS = 5;
export interface VeDrySource { source_key: string; source: string; companies: number; contacts: number }
/** Итог последних ≥1 500 компаний источника, если он сухой; иначе null (в том числе пока компаний меньше). */
export function veAdaptiveSourceDry(completed: VeAdaptiveResult[], sourceKey: string): VeDrySource | null {
  let companies = 0, contacts = 0, source = '';
  for (let index = completed.length - 1; index >= 0; index--) {
    const batch = completed[index];
    if (batch.source_key !== sourceKey) continue;
    companies += batch.candidates;
    contacts += Number.isSafeInteger(batch.new_target) ? batch.new_target! : batch.new_ready;
    source ||= batch.source;
    if (companies >= VE_DRY_SOURCE_MIN_COMPANIES) {
      return contacts < VE_DRY_SOURCE_MIN_CONTACTS ? { source_key: sourceKey, source, companies, contacts } : null;
    }
  }
  return null;
}
/** Все живые источники базы сухие: их итоги; иначе null. Без живых источников решает другое правило. */
export function veDryLiveSources(completed: VeAdaptiveResult[], liveKeys: Iterable<string>): VeDrySource[] | null {
  const keys = [...new Set(liveKeys)];
  if (!keys.length) return null;
  const dry: VeDrySource[] = [];
  for (const key of keys) {
    const verdict = veAdaptiveSourceDry(completed, key);
    if (!verdict) return null;
    dry.push(verdict);
  }
  return dry;
}
const VE_DRY_SOURCE_FROM: Record<string, string> = {
  companies_directory: 'реестра', yandex_maps: 'Яндекс Карт', google_maps: 'Google Maps', hh_live: 'вакансий hh.ru',
  eng_hiring: 'вакансий', pdl: 'каталога PDL', funded: 'каталога стартапов',
};
const ruPlural = (value: number, one: string, few: string, many: string) => {
  const tens = value % 100, units = value % 10;
  return tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many;
};
/** «последние 1568 компаний из Яндекс Карт дали 4 контакта»; срезы одного источника сложены. */
export function veDrySourcesSummary(dry: VeDrySource[]): string {
  const bySource = new Map<string, { companies: number; contacts: number }>();
  for (const item of dry) {
    const label = VE_DRY_SOURCE_FROM[item.source] ?? item.source;
    const total = bySource.get(label) ?? { companies: 0, contacts: 0 };
    total.companies += item.companies; total.contacts += item.contacts;
    bySource.set(label, total);
  }
  return [...bySource].map(([label, { companies, contacts }]) =>
    `последние ${companies} ${ruPlural(companies, 'компания', 'компании', 'компаний')} из ${label} `
      + `дали ${contacts} ${ruPlural(contacts, 'контакт', 'контакта', 'контактов')}`).join('; ');
}
/** Prefer an untried alternative after two poor complete batches, then the
 * best observed yield. Never discard the old source or its unprocessed rows.
 * A dry source is never chosen; when every source is dry there is no choice. */
export function chooseVeAdaptiveSource(state: VeAdaptiveCollection, available: string[]): string | undefined {
  const live = available.filter((key) => !veAdaptiveSourceDry(state.completed, key));
  if (!live.length) return undefined;
  if (state.active_source && live.includes(state.active_source) && !state.replan_needed) return state.active_source;
  const stats = (key: string) => state.completed.filter((item) => item.source_key === key);
  const candidates = live.filter((key) => !state.replan_needed || key !== state.active_source);
  return candidates.sort((a, b) => {
    const left = stats(a), right = stats(b);
    const rank = (key: string, items: VeAdaptiveResult[]) => !items.length ? 2 : veAdaptiveLowYield(state.completed, key) ? -1
      : items.reduce((sum, item) => sum + item.new_ready, 0) / Math.max(1, items.reduce((sum, item) => sum + item.candidates, 0));
    return rank(b, right) - rank(a, left);
  })[0] ?? live[0];
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
    } else if (finish?.provider === 'typesafe') {
      // The triage provider reports tokens, not money: its packet estimate is the charge.
      const cost = amount(finish.estimatedCostUsd);
      if (cost === undefined) missing = true; else ai += cost;
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
