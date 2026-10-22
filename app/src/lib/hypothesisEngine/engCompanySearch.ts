import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beginProviderUsage, type ProviderUsageDetails } from '@/lib/providerUsage';
import { addHeSite, heCompanySiteIdentity, heSameCompanySite, newHeSiteSet } from './collectionIdentity';
import { engCountryIso2, engCountryLabel, normalizeEngCountry } from './engCountries';
import { HeEngBaseBudgetError, openHeEngBaseBudget } from './engBaseBudgetLedger';
import type { HeEngRegistryCandidate } from './engPublicRegistryTypes';

const SEARCH_URL = 'https://google.serper.dev/search';
const RESULTS_PER_PAGE = 10;
const MAX_PAGES = 3;
const MAX_QUERIES = 160;
const MAX_RESPONSE_BYTES = 512 * 1024;
// User confirmed on 2026-10-21: this account buys 50,000 Serper credits for
// $50, i.e. $1 per 1,000 credits. This approved default belongs only to the new
// ENG company search adapter; legacy/RU/VE2 pricing is unchanged. An explicit
// account override below must be valid and positive, never silently ignored.
const APPROVED_SERPER_USD_PER_1000 = 1;
// Standard search is one query/credit (https://serper.dev/); reserve two at
// the approved account tariff before each physical request.
const RESERVED_CREDITS = 2;
const BLOCKED_DOMAINS = new Set(['linkedin.com', 'facebook.com', 'instagram.com', 'wikipedia.org',
  'crunchbase.com', 'zoominfo.com', 'dnb.com', 'glassdoor.com', 'indeed.com', 'youtube.com', 'reddit.com']);

export interface HeEngCompanySearchTask {
  id: string;
  query: string;
  country: string;
  gl: string;
}

export interface HeEngCompanySearchPlan {
  version: 1;
  fingerprint: string;
  tasks: HeEngCompanySearchTask[];
}

export interface HeEngCompanySearchCandidate {
  company: string;
  website: string;
  description: string;
  source: 'eng_search';
  source_url: string;
  /** Search targeting is NOT country evidence. No country proof is created. */
  search_country: string;
}

export type HeEngCompanySearchUnavailable = 'search_key_missing' | 'search_tariff_missing' |
  'search_billing' | 'search_configuration' | 'search_transient';

export interface HeEngCompanySearchCheckpoint {
  version: 1;
  planFingerprint: string;
  /** Round-robin task offset; each task retains its own next page. */
  nextTask: number;
  pages: Record<string, number>;
  exhaustedTaskIds: string[];
  calls: number;
  actualMicrousd: number;
  unavailable?: HeEngCompanySearchUnavailable;
  /** A restart must never resend this physical attempt. */
  inFlight?: { taskId: string; page: number; requestId: string };
}

export interface HeEngCompanySearchPageResult {
  checkpoint: HeEngCompanySearchCheckpoint;
  candidates: HeEngCompanySearchCandidate[];
  status: 'more' | 'exhausted' | 'unavailable';
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** A legal name without its trailing legal form: «ACME UK LTD.» → «ACME UK». */
export function heEngLegalNameCore(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '');
  const core = trimmed.replace(/(?:[\s,]+(?:public limited company|limited liability partnership|limited liability company|limited company|ltd|limited|plc|llp|lp|llc|inc|incorporated|corp|corporation|gmbh|ag|sa|sas|sarl|bv|nv|as|asa|ab|oy|oyj|aps)\.?)+$/i, '').trim();
  return core.length >= 2 ? core : trimmed;
}

function searchTerm(value: string): string {
  // User/model text is data: no search operators or URL/email fragments survive.
  return value.replace(/https?:\S+|\S+@\S+/gi, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(?:OR|AND|NOT)\b/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function companySearchPlanFingerprint(tasks: readonly HeEngCompanySearchTask[]): string {
  // JSONB can reorder object keys when a paid plan is read back. Rebuild the
  // original v1 field order so existing fingerprints and page cursors survive.
  // Task order and every supported field remain part of the fingerprint.
  return createHash('sha256').update(JSON.stringify(tasks.map(({ id, query, country, gl }) =>
    ({ id, query, country, gl })))).digest('hex');
}

/** Deterministic discovery, using only the selected hypotheses, never broad ICP. */
export function createHeEngCompanySearchPlan(input: {
  hypotheses: ReadonlyArray<{ title: string; description?: string }>;
  allowedCountries: readonly string[];
}): HeEngCompanySearchPlan {
  if (!input.hypotheses.length || !input.allowedCountries.length) {
    throw new Error('ENG company search requires selected hypotheses and explicit countries.');
  }
  const countries = [...new Set(input.allowedCountries.map(value => {
    const country = normalizeEngCountry(value);
    if (!country || !engCountryIso2(country)) throw new Error('ENG company search has an unsupported country.');
    return country;
  }))].sort();
  const terms = new Map<string, string>();
  const add = (raw: string) => {
    const term = searchTerm(raw);
    if (term.length >= 3 && term.split(' ').length <= 10) terms.set(term.toLowerCase(), term);
  };
  for (const hypothesis of input.hypotheses.slice(0, 20)) {
    add(cleanText(hypothesis.title, 120));
    // Enumerated types before firmographic/persona clauses expose alternatives
    // such as ManCos. This expands discovery only; every candidate is still gated.
    const prefix = cleanText(hypothesis.description, 800)
      .replace(/^(?:these are|targets? (?:are|include)|companies include)\s+/i, '')
      .split(/\b(?:with|where|whose|which|that)\b|[.;]/i)[0];
    for (const part of prefix.split(/,|\s+(?:or|and)\s+/i)) add(part);
  }
  const tasks: HeEngCompanySearchTask[] = [];
  // Countries are interleaved before spending on deeper pages of one country.
  for (const term of [...terms.values()].slice(0, 16)) {
    for (const country of countries) {
      if (tasks.length >= MAX_QUERIES) break;
      const query = `${term} ${engCountryLabel(country)} -jobs -careers -site:linkedin.com -site:wikipedia.org`;
      tasks.push({ id: createHash('sha256').update(JSON.stringify([term.toLowerCase(), country])).digest('hex').slice(0, 24),
        query, country, gl: engCountryIso2(country)! });
    }
  }
  if (!tasks.length) throw new Error('ENG company search has no usable selected terms.');
  return { version: 1, fingerprint: companySearchPlanFingerprint(tasks), tasks };
}

export function createHeEngCompanySearchCheckpoint(plan: HeEngCompanySearchPlan): HeEngCompanySearchCheckpoint {
  return { version: 1, planFingerprint: plan.fingerprint, nextTask: 0, pages: {}, exhaustedTaskIds: [], calls: 0, actualMicrousd: 0 };
}

/** One exact-entity lookup plan; its caller permits only one paid result page. */
/**
 * One search page for a registry company's website. v2 searches the name
 * without its legal form: the exact «… LTD.» string is what directories carry,
 * while the company's own site uses «Limited» or the bare brand. It also drops
 * «official website» and excludes the registers and directories that filled
 * most of the ten results in October collections. v1 stays buildable so a
 * paid v1 checkpoint is still recognised.
 */
export function createHeEngRegistryWebsiteSearchPlan(
  candidate: Pick<HeEngRegistryCandidate, 'provider' | 'recordId' | 'company' | 'country'>,
  version: 1 | 2 = 2,
): HeEngCompanySearchPlan {
  const country = normalizeEngCountry(candidate.country);
  const legal = cleanText(candidate.company, 250);
  const term = searchTerm(version === 1 ? legal : heEngLegalNameCore(legal));
  if (!country || !engCountryIso2(country) || term.length < 3 || !candidate.recordId) {
    throw new Error('ENG registry website search requires a legal name, registry ID and country.');
  }
  const tasks: HeEngCompanySearchTask[] = [{
    id: createHash('sha256').update(JSON.stringify([`registry-website-v${version}`, candidate.provider, candidate.recordId, term, country])).digest('hex').slice(0, 24),
    query: version === 1
      ? `"${term}" ${engCountryLabel(country)} official website -site:linkedin.com -site:facebook.com -site:crunchbase.com`
      : `"${term}" ${engCountryLabel(country)} -site:linkedin.com -site:facebook.com -site:crunchbase.com -site:company-information.service.gov.uk -site:register.fca.org.uk -site:kompass.com -site:endole.co.uk -site:companycheck.co.uk -site:opencorporates.com -site:cylex-uk.co.uk`,
    country, gl: engCountryIso2(country)!,
  }];
  return { version: 1, fingerprint: companySearchPlanFingerprint(tasks), tasks };
}

function searchTariff(env: NodeJS.ProcessEnv): number | null {
  const tariff = env.HE_US_SERPER_USD_PER_1000 === undefined
    ? APPROVED_SERPER_USD_PER_1000 : Number(env.HE_US_SERPER_USD_PER_1000);
  return Number.isFinite(tariff) && tariff > 0 && Number.isSafeInteger(Math.ceil(tariff * 1000 * RESERVED_CREDITS))
    ? tariff : null;
}

/** Configuration metadata only: never return/log keys. No implicit zero tariff. */
export function heEngCompanySearchAvailability(env: NodeJS.ProcessEnv = process.env): HeEngCompanySearchUnavailable | null {
  if (!(env.HE_US_SERPER_API_KEY ?? '').trim() && !(env.SERPER_API_KEY ?? '').trim()) return 'search_key_missing';
  if (searchTariff(env) === null) return 'search_tariff_missing';
  return null;
}

function validateCheckpoint(plan: HeEngCompanySearchPlan, saved?: HeEngCompanySearchCheckpoint): HeEngCompanySearchCheckpoint {
  if (plan.version !== 1 || !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > MAX_QUERIES ||
      plan.tasks.some(task => !record(task) || Object.keys(task).length !== 4 ||
        !['id', 'query', 'country', 'gl'].every(key => Object.hasOwn(task, key)) ||
        typeof task.id !== 'string' || !/^[a-f0-9]{24}$/.test(task.id) ||
        typeof task.query !== 'string' || !task.query || task.query.length > 300 ||
        typeof task.country !== 'string' || typeof task.gl !== 'string' ||
        normalizeEngCountry(task.country) !== task.country || engCountryIso2(task.country) !== task.gl) ||
      plan.fingerprint !== companySearchPlanFingerprint(plan.tasks)) {
    throw new Error('ENG company search plan is invalid.');
  }
  const state = saved ? structuredClone(saved) : createHeEngCompanySearchCheckpoint(plan);
  const ids = new Set(plan.tasks.map(task => task.id));
  if (state.version !== 1 || state.planFingerprint !== plan.fingerprint || !Number.isSafeInteger(state.nextTask) ||
      state.nextTask < 0 || state.nextTask >= plan.tasks.length || !Number.isSafeInteger(state.calls) || state.calls < 0 || state.calls > plan.tasks.length * MAX_PAGES ||
      !Number.isSafeInteger(state.actualMicrousd) || state.actualMicrousd < 0 ||
      !record(state.pages) || Object.entries(state.pages).some(([id, page]) => !ids.has(id) || !Number.isInteger(page) || page < 1 || page > MAX_PAGES + 1) ||
      !Array.isArray(state.exhaustedTaskIds) || state.exhaustedTaskIds.some(id => !ids.has(id)) ||
      new Set(state.exhaustedTaskIds).size !== state.exhaustedTaskIds.length || ids.size !== plan.tasks.length ||
      Object.entries(state.pages).some(([id, page]) => page > MAX_PAGES && !state.exhaustedTaskIds.includes(id))) {
    throw new Error('ENG company search checkpoint is invalid or belongs to a different audience.');
  }
  if (state.inFlight) throw new HeEngBaseBudgetError('unknown_cost');
  return state;
}

/**
 * Read-only coverage of the frozen term/country plan. A next-page cursor of 2
 * proves the first response was saved, including an empty response. Exhausted
 * IDs alone do not prove a page was read. Invalid or in-flight checkpoints keep
 * their normal errors; coverage must never hide an unknown paid attempt.
 */
export function heEngCompanySearchFirstPassComplete(
  plan: HeEngCompanySearchPlan,
  checkpoint?: HeEngCompanySearchCheckpoint,
): boolean {
  const state = validateCheckpoint(plan, checkpoint);
  return plan.tasks.every(task => (state.pages[task.id] ?? 1) >= 2);
}

/** Returned search hits are untrusted candidates, not qualified companies. */
export function heEngCompanySearchCandidates(input: {
  items: readonly unknown[]; task: HeEngCompanySearchTask; seenWebsites?: readonly string[];
}): HeEngCompanySearchCandidate[] {
  const seen = newHeSiteSet();
  for (const website of input.seenWebsites ?? []) {
    const identity = heCompanySiteIdentity(website);
    if (identity) addHeSite(seen, identity);
  }
  const out: HeEngCompanySearchCandidate[] = [];
  for (const raw of input.items.slice(0, RESULTS_PER_PAGE)) {
    const item = record(raw);
    const link = cleanText(item?.link, 2048);
    let url: URL;
    try { url = new URL(link); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        /\.(?:pdf|docx?|xlsx?|zip|jpe?g|png)$/i.test(url.pathname)) continue;
    const identity = heCompanySiteIdentity(url.href);
    if (!identity || BLOCKED_DOMAINS.has(identity.registrable) || heSameCompanySite(seen, identity)) continue;
    const company = cleanText(item?.title, 250) || identity.host;
    url.hash = '';
    addHeSite(seen, identity);
    out.push({ company, website: url.origin, description: cleanText(item?.snippet, 1000),
      source: 'eng_search', source_url: url.href, search_country: input.task.country });
  }
  return out;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('ENG search response missing.');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body.cancel();
    throw new Error('ENG search response too large.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('ENG search response too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const parsed = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (!parsed) throw new Error('ENG search response invalid.');
  return parsed;
}

/**
 * Exactly one physical search page, no transport retries. onCheckpoint must
 * durably save the cursor AND its candidate rows together before resolving.
 * A crash after dispatch leaves an in-flight marker; it never licenses replay.
 * This adapter has its own entry to the SAME durable $5 base ledger; callers
 * must use it only inside confirmed ENG client collection, never legacy/RU.
 */
export async function runHeEngCompanySearchPage(input: {
  db: SupabaseClient; baseId: string; projectId: string;
  plan: HeEngCompanySearchPlan; checkpoint?: HeEngCompanySearchCheckpoint;
  seenWebsites?: readonly string[]; signal?: AbortSignal;
  onCheckpoint: (checkpoint: HeEngCompanySearchCheckpoint, candidates: HeEngCompanySearchCandidate[]) => Promise<void>;
}): Promise<HeEngCompanySearchPageResult> {
  input.signal?.throwIfAborted();
  const state = validateCheckpoint(input.plan, input.checkpoint);
  if (state.unavailable) return { checkpoint: state, candidates: [], status: 'unavailable' };
  const availability = heEngCompanySearchAvailability();
  if (availability) {
    state.unavailable = availability;
    await input.onCheckpoint(state, []);
    return { checkpoint: state, candidates: [], status: 'unavailable' };
  }
  let task: HeEngCompanySearchTask | undefined;
  let taskIndex = state.nextTask;
  for (let i = 0; i < input.plan.tasks.length; i++) {
    const index = (state.nextTask + i) % input.plan.tasks.length;
    const candidate = input.plan.tasks[index];
    if (!state.exhaustedTaskIds.includes(candidate.id)) { task = candidate; taskIndex = index; break; }
  }
  if (!task) return { checkpoint: state, candidates: [], status: 'exhausted' };
  const page = state.pages[task.id] ?? 1;
  // Availability above has already rejected an invalid explicit override.
  const tariff = searchTariff(process.env)!;
  const ledger = await openHeEngBaseBudget(input.db, input.baseId, input.projectId);
  const reservation = await ledger.reserve({ requestId: randomUUID(), provider: 'serper', stage: 'base_collect',
    model: 'google-search', reservedMicrousd: Math.max(1, Math.ceil(tariff * 1000 * RESERVED_CREDITS)) });
  state.inFlight = { taskId: task.id, page, requestId: reservation.requestId };
  let dispatched = false;
  let actualMicrousd: number | null = null;
  let responseData: Record<string, unknown> | undefined;
  let responseStatus = 0;
  const usage: ProviderUsageDetails = { status: 'ambiguous' };
  let metering: Awaited<ReturnType<typeof beginProviderUsage>> | undefined;
  try {
    await input.onCheckpoint(state, []);
    input.signal?.throwIfAborted();
    metering = await beginProviderUsage('serper');
    input.signal?.throwIfAborted();
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
    const apiKey = (process.env.HE_US_SERPER_API_KEY ?? '').trim() || (process.env.SERPER_API_KEY ?? '').trim();
    dispatched = true;
    const response = await fetch(SEARCH_URL, { method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: task.query, num: RESULTS_PER_PAGE, page, gl: task.gl, hl: 'en' }), signal });
    responseStatus = response.status;
    usage.httpStatus = response.status;
    usage.status = response.ok ? 'success' : 'http_error';
    responseData = await boundedJson(response);
    const credits = responseData.credits;
    if (typeof credits === 'number' && Number.isFinite(credits) && credits >= 0) {
      usage.serperCredits = credits;
      actualMicrousd = Math.ceil(credits * tariff * 1000);
      if (!Number.isSafeInteger(actualMicrousd)) actualMicrousd = null;
      else usage.estimatedCostUsd = credits * tariff / 1000;
    }
  } catch (error) {
    // Proven pre-dispatch failures cost zero. After dispatch, an absent receipt
    // is unknown, including HTTP errors and timeouts: retain reserve and stop.
    if (!dispatched) actualMicrousd = 0;
    await ledger.settle(reservation, { actualMicrousd });
    if (!dispatched) {
      delete state.inFlight;
      await input.onCheckpoint(state, []);
    }
    throw error;
  } finally {
    if (metering) await metering.finish(usage);
  }
  await ledger.settle(reservation, { actualMicrousd });
  // A missing receipt above throws and keeps the persistent in-flight marker.
  state.actualMicrousd += actualMicrousd!;
  state.calls += 1;
  delete state.inFlight;
  const embeddedStatus = typeof responseData?.statusCode === 'number' ? responseData.statusCode : responseStatus;
  if (responseStatus < 200 || responseStatus >= 300 || embeddedStatus >= 400 || responseData?.error) {
    const errorPhrase = [responseData?.error, responseData?.message].filter(v => typeof v === 'string').join(' ');
    state.unavailable = responseStatus === 402 || embeddedStatus === 402 || /insufficient|not enough credits|payment required/i.test(errorPhrase)
      ? 'search_billing' : [401, 403].includes(responseStatus) || [401, 403].includes(embeddedStatus)
        ? 'search_configuration' : 'search_transient';
    await input.onCheckpoint(state, []);
    return { checkpoint: state, candidates: [], status: 'unavailable' };
  }
  if (!Array.isArray(responseData?.organic)) {
    state.unavailable = 'search_transient';
    await input.onCheckpoint(state, []);
    return { checkpoint: state, candidates: [], status: 'unavailable' };
  }
  const candidates = heEngCompanySearchCandidates({ items: responseData.organic, task, seenWebsites: input.seenWebsites });
  state.pages[task.id] = page + 1;
  state.nextTask = (taskIndex + 1) % input.plan.tasks.length;
  if (page >= MAX_PAGES || responseData.organic.length < RESULTS_PER_PAGE) state.exhaustedTaskIds.push(task.id);
  await input.onCheckpoint(state, candidates);
  return { checkpoint: state, candidates, status: state.exhaustedTaskIds.length === input.plan.tasks.length ? 'exhausted' : 'more' };
}
