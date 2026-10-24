import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beginProviderUsage, type ProviderUsageDetails } from '@/lib/providerUsage';
import { addHeSite, heCompanySiteIdentity, heSameCompanySite, newHeSiteSet } from './collectionIdentity';
import { engCountryIso2, engCountryLabel, normalizeEngCountry } from './engCountries';
import { HeEngBaseBudgetError, openHeEngBaseBudget, type HeEngBaseBudgetLedger } from './engBaseBudgetLedger';
import type { HeEngRegistryCandidate } from './engPublicRegistryTypes';

const SEARCH_URL = 'https://google.serper.dev/search';
const RESULTS_PER_PAGE = 10;
const MAX_PAGES = 3;
const MAX_QUERIES = 160;
/** A saved plan with a longer query is rejected as invalid before any paid call. */
export const HE_ENG_SEARCH_QUERY_MAX = 300;
const MAX_RESPONSE_BYTES = 512 * 1024;
// User confirmed on 2026-10-21: this account buys 50,000 Serper credits for
// $50, i.e. $1 per 1,000 credits. This approved default belongs only to the new
// ENG company search adapter; legacy/RU/VE2 pricing is unchanged. An explicit
// account override below must be valid and positive, never silently ignored.
const APPROVED_SERPER_USD_PER_1000 = 1;
// Standard search is one query/credit (https://serper.dev/); reserve two at
// the approved account tariff before each physical request.
const RESERVED_CREDITS = 2;
// A request is paid whether or not its answer arrives in time, so wait long
// enough for a slow answer; three unanswered requests in a row stop searching.
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_UNANSWERED = 3;
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
  /**
   * Consecutive sent requests that brought no billing receipt (timeout, broken
   * connection, error body). Each is charged at its full reserve; three in a
   * row make the search unavailable for this checkpoint. Absent after a page
   * that answered.
   */
  unanswered?: number;
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
const LEGAL_FORMS_V2 = 'public limited company|limited liability partnership|limited liability company|limited company|ltd|limited|plc|llp|lp|llc|inc|incorporated|corp|corporation|gmbh|ag|sa|sas|sarl|bv|nv|as|asa|ab|oy|oyj|aps';
// v3 adds continental forms as GLEIF writes them: «GmbH & Co. KG», «N.V.», «S.p.A.», «A/S», «UG (haftungsbeschränkt)».
const LEGAL_FORMS_V3 = `gmbh\\s*&\\s*co\\.?\\s*kg|ag\\s*&\\s*co\\.?\\s*kg|ug\\s*\\(haftungsbeschränkt\\)|co\\.?\\s*kg|kg|mbh|se|eg|vvag|dac|`
  + `aktiengesellschaft|kommanditgesellschaft|gesellschaft mit beschränkter haftung|`
  + `b\\.v|n\\.v|s\\.a|s\\.p\\.a|spa|s\\.r\\.l|srl|s\\.l|sl|a\\/s|${LEGAL_FORMS_V2}`;
function legalNameCore(value: string, forms: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '');
  const core = trimmed.replace(new RegExp(`(?:[\\s,]+(?:${forms})\\.?)+$`, 'i'), '').trim();
  return core.length >= 2 ? core : trimmed;
}
/** A legal name without its trailing legal form: «ACME UK LTD.» → «ACME UK», «Acme B.V.» → «Acme». */
export function heEngLegalNameCore(value: string): string {
  return legalNameCore(value, LEGAL_FORMS_V3);
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

/**
 * One exact-entity lookup plan; its caller permits only one paid result page:
 * the search for a registry company's website. v2 searches the name
 * without its legal form: the exact «… LTD.» string is what directories carry,
 * while the company's own site uses «Limited» or the bare brand. It also drops
 * «official website» and excludes the registers and directories that filled
 * most of the ten results in October collections. v1 stays buildable so a
 * paid v1 checkpoint is still recognised.
 */
export function createHeEngRegistryWebsiteSearchPlan(
  candidate: Pick<HeEngRegistryCandidate, 'provider' | 'recordId' | 'company' | 'country'>,
  version: 1 | 2 | 3 = 3,
): HeEngCompanySearchPlan {
  const country = normalizeEngCountry(candidate.country);
  const legal = cleanText(candidate.company, 250);
  // v3 differs from v2 only in which trailing legal forms it drops.
  const term = searchTerm(version === 1 ? legal : legalNameCore(legal, version === 2 ? LEGAL_FORMS_V2 : LEGAL_FORMS_V3));
  if (!country || !engCountryIso2(country) || term.length < 3 || !candidate.recordId) {
    throw new Error('ENG registry website search requires a legal name, registry ID and country.');
  }
  const tasks: HeEngCompanySearchTask[] = [{
    id: createHash('sha256').update(JSON.stringify([`registry-website-v${version === 3 ? 2 : version}`, candidate.provider, candidate.recordId, term, country])).digest('hex').slice(0, 24),
    query: version === 1
      ? `"${term}" ${engCountryLabel(country)} official website -site:linkedin.com -site:facebook.com -site:crunchbase.com`
      : fittedRegistryWebsiteQuery(term, engCountryLabel(country)),
    country, gl: engCountryIso2(country)!,
  }];
  return { version: 1, fingerprint: companySearchPlanFingerprint(tasks), tasks };
}

/**
 * One paid result page: the current site of a catalogue company whose own
 * domain no longer exists or is parked (engCompanyQualification). The query is
 * the registry website search v3 shape; the task id names the catalogue
 * company (its 64-hex company key), not a registry record.
 */
export function createHeEngCatalogWebsiteSearchPlan(input: { companyKey: string; company: string; country: string }): HeEngCompanySearchPlan {
  const country = normalizeEngCountry(input.country);
  const term = searchTerm(legalNameCore(cleanText(input.company, 250), LEGAL_FORMS_V3));
  if (!country || !engCountryIso2(country) || term.length < 3 || !/^[a-f0-9]{64}$/.test(input.companyKey)) {
    throw new Error('ENG catalogue website search requires a company name, its key and a country.');
  }
  const tasks: HeEngCompanySearchTask[] = [{
    id: createHash('sha256').update(JSON.stringify(['catalog-website-v1', input.companyKey, term, country])).digest('hex').slice(0, 24),
    query: fittedRegistryWebsiteQuery(term, engCountryLabel(country)), country, gl: engCountryIso2(country)!,
  }];
  return { version: 1, fingerprint: companySearchPlanFingerprint(tasks), tasks };
}

const REGISTRY_WEBSITE_EXCLUDED_SITES = [
  'linkedin.com', 'facebook.com', 'crunchbase.com', 'company-information.service.gov.uk', 'register.fca.org.uk',
  'kompass.com', 'endole.co.uk', 'companycheck.co.uk', 'opencorporates.com', 'cylex-uk.co.uk',
];

/**
 * A long legal name («RGA INTERNATIONAL REINSURANCE COMPANY DESIGNATED ACTIVITY
 * COMPANY», GLEIF) pushed the query past HE_ENG_SEARCH_QUERY_MAX, the saved plan
 * failed validation and the whole collection stopped (23.10.2026). Exclusions go
 * first from the end, then trailing words of the name; a query that already
 * fits is unchanged, so no paid checkpoint changes its plan.
 */
function fittedRegistryWebsiteQuery(term: string, countryLabel: string): string {
  const excluded = [...REGISTRY_WEBSITE_EXCLUDED_SITES];
  let words = term.split(' ');
  const query = () => [`"${words.join(' ')}"`, countryLabel, ...excluded.map(site => `-site:${site}`)].join(' ');
  while (query().length > HE_ENG_SEARCH_QUERY_MAX && excluded.length > 3) excluded.pop();
  while (query().length > HE_ENG_SEARCH_QUERY_MAX && words.length > 1) words = words.slice(0, -1);
  return query().slice(0, HE_ENG_SEARCH_QUERY_MAX);
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
        typeof task.query !== 'string' || !task.query || task.query.length > HE_ENG_SEARCH_QUERY_MAX ||
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
      Object.entries(state.pages).some(([id, page]) => page > MAX_PAGES && !state.exhaustedTaskIds.includes(id)) ||
      (state.unanswered !== undefined && (!Number.isSafeInteger(state.unanswered) || state.unanswered < 1 || state.unanswered > state.calls))) {
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
  /**
   * The stage's already open ledger (activeHeEngBaseBudgetLedger). Required
   * when other paid requests of the stage may be unanswered at the same time;
   * absent, the ledger is opened here, which is only safe for sequential work.
   */
  ledger?: HeEngBaseBudgetLedger;
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
  if (input.ledger && (input.ledger.baseId !== input.baseId || input.ledger.projectId !== input.projectId)) {
    throw new HeEngBaseBudgetError('invalid_ledger');
  }
  const ledger = input.ledger ?? await openHeEngBaseBudget(input.db, input.baseId, input.projectId);
  const reservation = await ledger.reserve({ requestId: randomUUID(), provider: 'serper', stage: 'base_collect',
    model: 'google-search', reservedMicrousd: Math.max(1, Math.ceil(tariff * 1000 * RESERVED_CREDITS)) });
  state.inFlight = { taskId: task.id, page, requestId: reservation.requestId };
  let dispatched = false;
  let unanswered = false;
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
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS);
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
    if (!dispatched) {
      // Proven pre-dispatch failures cost zero.
      await ledger.settle(reservation, { actualMicrousd: 0 });
      delete state.inFlight;
      await input.onCheckpoint(state, []);
      throw error;
    }
    unanswered = true;
  } finally {
    if (metering) await metering.finish(usage);
  }
  // A sent request without a receipt (timeout, broken connection, an error body
  // without credits) is charged at its full reserve: Serper bills at most one
  // credit per page and two are reserved, so the ledger never under-counts. An
  // unknown charge used to hold the whole base; one slow answer stopped it.
  const charged = actualMicrousd ?? reservation.reservedMicrousd;
  await ledger.settle(reservation, { actualMicrousd: charged });
  state.actualMicrousd += charged;
  state.calls += 1;
  delete state.inFlight;
  if (unanswered) {
    // This page is paid and its results are lost: move on instead of buying it again now.
    state.unanswered = (state.unanswered ?? 0) + 1;
    state.pages[task.id] = page + 1;
    state.nextTask = (taskIndex + 1) % input.plan.tasks.length;
    if (page >= MAX_PAGES) state.exhaustedTaskIds.push(task.id);
    if (state.unanswered >= MAX_UNANSWERED) state.unavailable = 'search_transient';
    await input.onCheckpoint(state, []);
    // A cancelled job still stops here; its spend is already settled.
    input.signal?.throwIfAborted();
    return { checkpoint: state, candidates: [], status: state.unavailable ? 'unavailable'
      : state.exhaustedTaskIds.length === input.plan.tasks.length ? 'exhausted' : 'more' };
  }
  delete state.unanswered;
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
