import { heEngBaseBudgetActive, isHeEngBaseBudgetPreflightFailure, rethrowHeEngBaseBudgetError } from './engBaseBudget';
import { z } from 'zod';

import { companySiteAlias } from '@/lib/enrich/companySiteAlias';
import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';
import { normalizeLeadWebsite } from '@/lib/instantly/leadContactValues';
import { heCompanySiteIdentity } from './collectionIdentity';
import { heEngSourceCountry } from './engCompanyCountry';
import {
  buildHeEngCompanyFitClassifierRequest, buildHeEngCompanyFitReviewRequest,
  parseHeEngCompanyFitResponse, finalizeHeEngCompanyFit, validateHeEngCompanyFitDecision, heEngCompanyFitNeedsReview,
  type HeEngCompanyFitInput, type HeEngCompanyFitDecision, type HeEngCompanyFitRequest,
} from './engCompanyFit';
import {
  HE_ENG_COMPANY_QUALIFICATION_VERSION, HeEngQualificationScopeError,
  heEngCatalogDirectHypothesis, heEngCompanyKey, heEngCompanyQualified, heEngQualificationVersion,
  type HeEngCompanyVerdict, type HeEngQualificationInFlight, type HeEngQualificationMemo,
  type HeEngQualificationRow, type HeEngQualificationScope,
  type HeEngCollectedCompanyEvidence, type HeEngCompanyQualificationAssessment,
} from './engCompanyQualificationPolicy';
import { callLLMText, heLlmFailureOf, isHeLlmTimeout } from './llm';
import {
  readHeEngQualificationBudget, reserveHeEngQualificationModel, settleHeEngQualificationModel,
  type HeEngQualificationModelReservation, heEngQualificationBudgetHoldReason, HE_ENG_QUALIFICATION_REVIEW_MODEL, HE_ENG_QUALIFICATION_MODEL,
  HE_ENG_COLLECTION_QUALIFICATION_LIMIT_MICROUSD,
} from './engQualificationBudget';
import { heStageSignal, isHeSiteUnreachable, resolveFetchPage, type HeFetchedPage, type HeFetchPageFn } from './stages/io';
import type { HeStageContext } from './stages/shared';

const MAX_PAGES = 9;
const MAX_PAGE_DEPTH = 3;
// A page that does not answer costs two attempts of ~8 s, and a site has up to
// nine pages: one such company held a whole run for minutes while every other
// company was already read (berkleyah.com, 22.10.2026: 12 unanswered pages, a
// 136 s run against a 50 s median). Once the site has answered, two unanswered
// pages in a row end its crawl; no site is read for more than 60 s. The models
// assess the pages already read.
const MAX_UNANSWERED_PAGES_IN_ROW = 2;
const SITE_READ_BUDGET_MS = 60_000;
const MAX_COMPANY_ATTEMPTS = 3;
// Pause before re-reading sites that failed transiently, when only such
// companies are left. 30 s until 23.10.2026: retries rarely recover a site
// (3 of ~90 in two collections), so the wait mostly delayed the next wave.
const COMPANY_RETRY_MS = 10_000;
// Per run: sites read at once and paid model requests in flight at once.
// Measured 22.10.2026: a run of 16 companies spent ~76 s reading sites four at
// a time, then ~28 s on one model request after another, with the worker
// mostly idle (CPU 0–30%). Models now start as soon as a company is read.
const SITE_READERS = 8;
const MODEL_REQUESTS_IN_PARALLEL = 4;
/** One request per company, at most 16 companies per run: a longer saved list is corrupt. */
const MAX_LOST_FLIGHTS = 16;
// Model failures in a row before this run pauses; billing/key failures pause at once.
const MAX_MODEL_FAILURES_IN_RUN = 3;
const MODEL_PAUSE_MS = 60_000;
const MAX_PAGE_TEXT = 6000;
const MODEL_BATCH_SIZE = 1;
const MAX_COMPANY_SOURCE_CHARS = 6000;
const MAX_COMPANY_QUOTES = 24;
const EMAIL = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const AssessmentSchema = z.object({ model: z.string().max(100), status: z.enum(['match', 'mismatch', 'unverified']),
  reason: z.string().max(100), hypothesisId: z.string().max(200).nullable(), quoteIds: z.array(z.string().max(200)).max(2),
  exclusionCause: z.string().min(1).max(1000).nullable().optional(),
  explanation: z.string().max(400) });
const AuditSchema = z.object({ version: z.literal(1),
  quotes: z.array(z.object({ id: z.string().max(200), url: z.string().max(2000), text: z.string().min(12).max(1400),
    source: z.enum(['constructor_website', 'website']) })).max(MAX_COMPANY_QUOTES),
  compaction: z.object({ version: z.literal(1), strategy: z.literal('decision_quotes'),
    originalQuoteCount: z.number().int().min(1).max(MAX_COMPANY_QUOTES),
    originalQuotesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  collectedJobId: z.string().uuid().optional(), classifier: AssessmentSchema.optional(), review: AssessmentSchema.optional(),
}).refine((audit) => audit.quotes.reduce((sum, quote) => sum + quote.text.length, 0) <= MAX_COMPANY_SOURCE_CHARS &&
  (!audit.compaction || audit.quotes.length < audit.compaction.originalQuoteCount));
const StoredVerdictSchema = z.object({
  version: z.union([z.literal(2), z.literal(3)]),
  scopeKey: z.string(), companyKey: z.string(),
  status: z.enum(['accepted', 'rejected', 'unverified']),
  reason: z.string().max(300), country: z.string().nullable(), hypothesisId: z.string().nullable(),
  evidence: z.array(z.object({ kind: z.enum(['identity', 'activity', 'country']),
    url: z.string().min(1).max(2000), quote: z.string().min(12).max(1400) })).max(12),
  checkedAt: z.string().datetime(), countryProof: z.unknown().optional(),
  fitReview: z.object({ model: z.literal(HE_ENG_QUALIFICATION_REVIEW_MODEL), status: z.literal('match'), hypothesisId: z.string() }).optional(),
  catalogFit: z.object({ source: z.literal('pdl'), industry: z.string().min(1).max(100), hypothesisId: z.string().min(1).max(200) }).optional(),
  audit: AuditSchema.optional(),
});

function withoutEmails(value: string): string { return value.replace(EMAIL, '[email removed]'); }
function quoteText(value: string): string { return value.replace(/\s+/gu, ' ').trim(); }
function urlKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}

const QUALIFICATION_SITE_BUILDERS = [
  'wixsite.com', 'squarespace.com', 'webflow.io', 'tilda.ws', 'weebly.com',
  'wordpress.com', 'godaddysites.com', 'myshopify.com', 'business.site',
];

/** Shared hosting is not company ownership, even when the PSL omits the platform. */
function siteBoundary(raw: string): string | null {
  const site = heCompanySiteIdentity(raw);
  if (!site) return null;
  return QUALIFICATION_SITE_BUILDERS.some((host) => site.host === host || site.host.endsWith(`.${host}`))
    ? site.host : site.registrable;
}

function sameSite(raw: string, website: string): boolean {
  const expected = siteBoundary(website);
  const actual = siteBoundary(raw);
  return !!expected && !!actual && expected === actual;
}

/**
 * Own site, or a domain of the same brand (companySiteAlias). Pages of such a
 * domain are read only after the company's own page redirected there; stored
 * evidence is re-checked with this same deterministic rule.
 */
function companySite(raw: string, website: string, company: string): boolean {
  return sameSite(raw, website) || (!!company && companySiteAlias(raw, website, company) !== null);
}

function interrupted(ctx: HeStageContext, error?: unknown): void {
  heStageSignal(ctx)?.throwIfAborted();
  const candidate = error as { name?: unknown; heJobInterruption?: unknown } | undefined;
  if (candidate?.name === 'AbortError' || candidate?.heJobInterruption === true) throw error;
}

type PageRead = { pages: HeFetchedPage[]; retryableFailure: boolean; unverifiedRedirect: boolean };
type QualificationPage = { url: string; text: string; evidenceSource?: 'constructor_website' | 'website' };

/** Country proof is checked separately. A constructor description never supplies geography. */
function collectedPages(row: HeEngQualificationRow, evidence: HeEngCollectedCompanyEvidence | undefined, website: string): QualificationPage[] {
  if (!evidence || evidence.version !== 1 || evidence.source !== 'constructor_website' ||
      !z.string().uuid().safeParse(evidence.jobId).success || typeof evidence.website !== 'string' ||
      heEngCompanyKey(evidence) !== heEngCompanyKey(row) || !Array.isArray(evidence.pages) ||
      !evidence.pages.length || evidence.pages.length > 3 || evidence.pages.some((page) =>
        !page || typeof page.text !== 'string' || typeof page.url !== 'string' || page.url.length > 2000 ||
        !sameSite(page.url, website) || (website.startsWith('https:') && !page.url.startsWith('https:'))) ||
      evidence.pages.reduce((sum, page) => sum + page.text.length, 0) > MAX_PAGE_TEXT) return [];
  return evidence.pages.flatMap((page) => {
    const text = stripUnstorableJsonChars(withoutEmails(page.text)).trim();
    return text ? [{ url: page.url, text, evidenceSource: 'constructor_website' as const }] : [];
  });
}

/** This only decides whether another free site read is useful; the models still decide eligibility. */
function enoughCollectedText(company: HeEngCompanyFitInput, scope: HeEngQualificationScope): boolean {
  const specific = new Set([...hypothesisWords(scope, true)].filter((word) => word.length >= 5 &&
    !['provid', 'servic', 'financ', 'busines', 'solut'].includes(word)));
  return company.quotes.reduce((sum, quote) => sum + quote.text.length, 0) >= 250 &&
    // A generic full homepage can still hide a relevant business unit. Only
    // a substantive passage naming the selected activity can avoid the crawl;
    // the two model assessments remain mandatory for acceptance.
    company.quotes.some((quote) => quote.text.length >= 80 &&
      (quote.text.toLowerCase().match(/[a-z]{4,}/g) ?? []).some((word) => specific.has(serviceStem(word)))) &&
    company.quotes.some((quote) => quote.text.length >= 80 &&
      /\b(?:provides?|offers?|deliver\w*|speciali[sz]\w*|administ\w*|our (?:services|business)|we (?:are|help|manage))\b/i.test(quote.text)) &&
    !company.quotes.some((quote) => /(?:verify (?:you are|that you are) human|access denied|enable javascript|checking your browser)/i.test(quote.text));
}

function serviceStem(word: string): string {
  return word.toLowerCase().replace(/ies$/, 'y').replace(/s$/, '').replace(/(?:ors?|ion|ian|ing|y)$/, '');
}

function hypothesisWords(scope: HeEngQualificationScope, titlesOnly = false): Set<string> {
  const generic = new Set(['company', 'companies', 'service', 'services', 'provider', 'providers', 'with', 'their', 'that', 'this', 'they', 'from', 'into', 'have', 'using', 'need', 'needs', 'business', 'industry', 'industries', 'customer', 'customers']);
  return new Set(scope.hypotheses.flatMap((h) => `${h.title} ${titlesOnly ? '' : h.description}`.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter((word) => !generic.has(word)).map(serviceStem));
}

async function companyPages(ctx: HeStageContext, fetchPage: HeFetchPageFn, website: string, company: string, scope: HeEngQualificationScope): Promise<PageRead> {
  const pages: HeFetchedPage[] = [];
  const attempted = new Set<string>();
  // Same-brand domains the company's own pages redirected to (companySiteAlias).
  const aliasSites = new Set<string>();
  const own = (url: string) => sameSite(url, website) || aliasSites.has(siteBoundary(url) ?? '');
  const words = hypothesisWords(scope);
  const titleWords = hypothesisWords(scope, true);
  type Candidate = { url: string; depth: number; priority: number; kind: string; specificService?: boolean };
  const queue: Candidate[] = [{ url: website, depth: 0, priority: 1000, kind: 'home' }];
  let retryableFailure = false;
  let unverifiedRedirect = false;
  const attemptedKinds: string[] = [];
  let readSpecificService = false;
  let fallbackTried = false;
  function fallbackOrigin(): boolean {
    if (fallbackTried) return false;
    fallbackTried = true;
    const alternative = new URL(website);
    if (alternative.hostname.startsWith('www.')) return false;
    alternative.protocol = 'https:';
    alternative.hostname = `www.${alternative.hostname}`;
    alternative.pathname = '/'; alternative.search = ''; alternative.hash = '';
    if (!sameSite(alternative.href, website)) return false;
    queue.unshift({ url: alternative.href, depth: 0, priority: 1000, kind: 'home' });
    return true;
  }
  const readStarted = Date.now();
  let answered = false;
  let unansweredInRow = 0;
  while (queue.length && attempted.size < MAX_PAGES) {
    interrupted(ctx);
    if (Date.now() - readStarted >= SITE_READ_BUDGET_MS || (answered && unansweredInRow >= MAX_UNANSWERED_PAGES_IN_ROW)) break;
    // Activity and company overview pages take priority over legal boilerplate.
    const count = (kind: string) => attemptedKinds.filter((value) => value === kind).length;
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      // A large site can require a business hub and a service hub before the
      // actual service page. Keep the total nine-page limit, not a two-hop cutoff.
      if (queue[i].kind === 'legal' && count('legal') >= 2
        || queue[i].kind === 'services' && count('services') >= 5) queue.splice(i, 1);
    }
    if (!queue.length) break;
    const preferred = attempted.size <= 1 ? ['services', 'about']
      : count('services') === 0 && queue.some((item) => item.kind === 'services') ? ['services', 'about', 'contact', 'locations']
        : !readSpecificService && queue.some((item) => item.specificService) ? ['services', 'about', 'contact', 'locations']
        : count('about') === 0 ? ['about', 'contact', 'locations']
          : count('contact') + count('locations') === 0 ? ['contact', 'locations'] : [];
    let next = -1;
    for (const kind of preferred) { next = queue.findIndex((item) => item.kind === kind); if (next >= 0) break; }
    const candidate = queue.splice(next >= 0 ? next : 0, 1)[0];
    const key = urlKey(candidate.url);
    if (!key || attempted.has(key) || !own(candidate.url)) continue;
    attempted.add(key);
    attemptedKinds.push(candidate.kind);
    let page: HeFetchedPage | null;
    try { page = await fetchPage(candidate.url); }
    catch (error) {
      interrupted(ctx, error);
      retryableFailure ||= !(isHeSiteUnreachable(error) && error.kind === 'dns');
      unansweredInRow += 1;
      if (candidate.depth === 0 && !fallbackOrigin()) break;
      continue;
    }
    // Any answer, even a missing page, shows the site responds.
    answered = true;
    unansweredInRow = 0;
    interrupted(ctx);
    if (page && !own(page.url) && companySiteAlias(page.url, website, company)) {
      aliasSites.add(siteBoundary(page.url) ?? page.url);
    }
    if (!page || !own(page.url) || (website.startsWith('https:') && !page.url.startsWith('https:'))) {
      unverifiedRedirect ||= !!page && !own(page.url);
      if (candidate.depth === 0) { retryableFailure ||= !page; if (!fallbackOrigin()) break; }
      continue;
    }
    if (page.text.trim() && !pages.some((saved) => urlKey(saved.url) === urlKey(page!.url))) {
      pages.push({ ...page, text: sliceWholeChars(stripUnstorableJsonChars(withoutEmails(page.text)), 0, MAX_PAGE_TEXT) });
      readSpecificService ||= candidate.specificService === true;
    }
    if (candidate.depth >= MAX_PAGE_DEPTH) continue;
    for (const link of page.companyEvidenceLinks ?? []) {
      const linkKey = urlKey(link.url);
      if (!linkKey || attempted.has(linkKey) || !own(link.url) || (website.startsWith('https:') && !link.url.startsWith('https:')) || queue.some((item) => urlKey(item.url) === linkKey)) continue;
      const path = new URL(link.url).pathname;
      const labelWords = `${link.label ?? ''} ${path}`.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      const stemmed = labelWords.map(serviceStem);
      const titleHits = new Set(stemmed.filter((word) => titleWords.has(word)));
      const overlap = new Set(stemmed.filter((word) => words.has(word))).size;
      // A real service hub may have no niche word until its next-level links.
      // A generic "funds" payment page must not outrank a custody/service match.
      const purpose = `${path.split('/').filter(Boolean).at(-1) ?? ''} ${link.label ?? ''}`.replace(/[-_]/g, ' ');
      const editorial = /\/(?:news(?:-and-views)?|articles?|blog|insights?|press|media|case-studies|customer-stories)(?:\/|$)/i.test(path)
        || /\/(?:[^/]*-)?sustainability\/[^/]*(?:partnership|report|news)/i.test(path);
      const kind = editorial && link.kind === 'services' ? 'supporting' : link.kind;
      const specificService = kind === 'services' && ([...titleHits].some((word) => word.length >= 6) || titleHits.size >= 2);
      const businessHub = kind === 'services' && (/\/(?:businesses[-_]institutions|our[-_]business(?:es)?|business[-_]areas)(?:\/|\.html?)?$/i.test(path)
        || /\b(?:business(?:es)? (?:and |& )?institutions|our businesses|business areas)\b/i.test(purpose)
        || /^(?:www\.)?(?:business|commercial|corporate|institutional)\./i.test(new URL(link.url).hostname) && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/i.test(path));
      const companyOverview = /\b(?:company overview|about (?:us|our company)|who we are|get to know|corporate profile)\b/i.test(purpose);
      const peripheral = editorial || /\b(?:suppliers?|careers?|vacancies|leadership|privacy|security|cookies?|testimonials|media contacts?|press contacts?|journalists?)\b/i.test(purpose);
      const priority = (kind === 'legal' ? 100 : kind === 'contact' ? 300 : kind === 'locations' ? 300 : kind === 'services' ? 700 : 500)
        + (specificService ? 150 : businessHub ? 100 : 0) + Math.min(overlap, 2) * 2 + (companyOverview ? 120 : 0) - (peripheral ? 250 : 0)
        + Math.min(Math.max(link.priority ?? 0, 0), 150);
      queue.push({ url: link.url, depth: candidate.depth + 1, priority, kind, specificService });
    }
    queue.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
  }
  // Only official-site links are followed. Qualification never buys search credits.
  return { pages, retryableFailure, unverifiedRedirect };
}

/** Remove only obvious short site chrome; activity and brand relationships remain evidence. */
function evidenceNoise(text: string): boolean {
  if (text.length > 180) return false;
  const chrome = /^(?:(?:get in touch|contact us|contact|learn more|read more|find out more|view all|view reports|request a call back|sorry we are closed|registered addresses|employee information|investor settings|about cookies|privacy (?:policy|notice)|data privacy notice|terms (?:and|&) conditions|data protection|legal information|all rights reserved|copyright|additional links|menu|home|search|login|log in|sign in|downloads|download|follow us|cookie settings|cookie einstellungen|datenschutz(?: und| &)? cookies|rechtliche informationen|kontakt aufnehmen)[.!?:,\s]*)+$/i;
  if (chrome.test(text)) return true;
  return /(?:copyright|©)/i.test(text) &&
    !/\b(?:provides?|offers?|deliver\w*|speciali[sz]\w*|administ\w*|our (?:services|business)|we (?:are|help|manage))\b/i.test(text) &&
    !/\b(?:is (?:a |the )?(?:brand|division|part) of|wholly[- ]owned|is now|eine marke|gehört zu)\b/i.test(text);
}

/** Contiguous excerpts: punctuation touching the next heading cannot erase text. */
function boundedParagraphExcerpts(raw: string): string[] {
  const text = quoteText(raw);
  const result: string[] = [];
  let start = 0;
  const safeEnd = (end: number) => end > start && /[\uD800-\uDBFF]/u.test(text[end - 1])
    && /[\uDC00-\uDFFF]/u.test(text[end] ?? '') ? end - 1 : end;
  while (start < text.length) {
    let end = safeEnd(Math.min(start + 1400, text.length));
    if (end < text.length) {
      // Prefer a complete sentence, including minified ".Next heading" HTML.
      // A long sentence/word still gets bounded excerpts rather than disappearing.
      const minimum = start + 700;
      const window = text.slice(start, end);
      let sentenceEnd = -1;
      for (const match of window.matchAll(/[.!?]+["'’”)\]]*(?=\s|[\p{Lu}]|$)/gu)) {
        const candidate = start + match.index + match[0].length;
        if (candidate >= minimum) sentenceEnd = candidate;
      }
      const wordEnd = text.lastIndexOf(' ', end - 1);
      if (sentenceEnd >= minimum) end = sentenceEnd;
      else if (wordEnd >= minimum) end = wordEnd;
      // Do not leave a final fragment below the evidence minimum.
      if (text.length - end < 24) {
        const tailStart = text.length - 24;
        const beforeTailWord = text.lastIndexOf(' ', tailStart);
        end = beforeTailWord >= minimum ? beforeTailWord : tailStart;
      }
      end = safeEnd(end);
    }
    const excerpt = text.slice(start, end).trim();
    if (excerpt) result.push(excerpt);
    start = end;
  }
  return result;
}

/** Whole service/about passages, deduplicated across pages before buying a model request. */
function fitInput(key: string, row: HeEngQualificationRow, website: string, pages: QualificationPage[], scope: HeEngQualificationScope, excerptVersion?: 2): HeEngCompanyFitInput {
  const name = withoutEmails(typeof row.company === 'string' ? row.company : '').slice(0, 300);
  const words = hypothesisWords(scope);
  const candidates: Array<{ id: string; url: string; text: string; source: 'constructor_website' | 'website'; normalized: string; score: number; order: number }> = [];
  for (const [pageIndex, page] of pages.entries()) {
    if (!companySite(page.url, website, typeof row.company === 'string' ? row.company : '')) continue;
    const add = (raw: string) => {
      const text = quoteText(raw);
      if (text.length < 12 || text.length > 1400 || (!page.evidenceSource && text.includes('[email removed]')) ||
          candidates.some((quote) => quote.url === page.url && quote.text === text)) return;
      const hits = new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).map(serviceStem).filter((word) => words.has(word))).size;
      const substantive = /\b(?:provides?|offers?|deliver\w*|speciali[sz]\w*|administ\w*|our (?:services|business)|we (?:are|help|manage))\b/i.test(text);
      const boilerplate = /\b(?:privacy policy|cookie policy|all rights reserved|registered office|regulated by|copyright)\b/i.test(text);
      const named = name.length > 2 && text.toLowerCase().includes(name.toLowerCase());
      candidates.push({ id: `p${pageIndex + 1}q${candidates.length + 1}`, url: page.url, text, source: page.evidenceSource ?? 'website',
        normalized: text.normalize('NFKC').toLocaleLowerCase(),
        score: Math.min(hits, 6) * 5 + Number(substantive) * 12 + Number(named) * 5 - Number(boilerplate) * 15,
        order: candidates.length });
    };
    for (const section of page.text.split(/\[(?:source section|excerpt omitted)\]/u)) {
      const paragraphs = section.split(/\n\s*\n/u).map((value) => value.trim()).filter(Boolean);
      for (const [index, paragraph] of paragraphs.entries()) {
        add(paragraph);
        const heading = quoteText(paragraph);
        const next = paragraphs[index + 1] && quoteText(paragraphs[index + 1]);
        // Pair a heading with substantive context, not two navigation labels.
        if (heading.length < 120 && next && next.length >= 80 && !evidenceNoise(heading) && !evidenceNoise(next)) {
          add(`${paragraph} ${paragraphs[index + 1]}`);
        }
        if (heading.length > 1400) {
          // Missing version means an existing paid checkpoint: preserve its
          // exact quote IDs/text for proposal validation and independent review.
          const excerpts = excerptVersion === 2 ? boundedParagraphExcerpts(paragraph)
            : paragraph.match(/[^.!?]+(?:[.!?](?=\s|$)|$)/gu) ?? [];
          for (const excerpt of excerpts) add(excerpt);
        }
      }
    }
  }
  const unique = new Map<string, typeof candidates[number]>();
  for (const item of candidates) {
    if (!evidenceNoise(item.text) && !unique.has(item.normalized)) unique.set(item.normalized, item);
  }
  let characters = 0;
  const selected: typeof candidates = [];
  for (const item of [...unique.values()].sort((a, b) => b.score - a.score || a.order - b.order)) {
    if (selected.some((other) => other.normalized.includes(item.normalized))) continue;
    const covered = selected.filter((other) => item.normalized.includes(other.normalized));
    const replacedChars = covered.reduce((sum, other) => sum + other.text.length, 0);
    if (selected.length - covered.length >= MAX_COMPANY_QUOTES || characters - replacedChars + item.text.length > MAX_COMPANY_SOURCE_CHARS) continue;
    for (const old of covered) selected.splice(selected.indexOf(old), 1);
    selected.push(item); characters += item.text.length - replacedChars;
  }
  return { id: key, name, website, quotes: selected.sort((a, b) => a.order - b.order).map(({ id, url, text, source }) => ({ id, url, text, source })) };
}

function unverified(scope: HeEngQualificationScope, key: string, reason: string): HeEngCompanyVerdict {
  return { version: HE_ENG_COMPANY_QUALIFICATION_VERSION, scopeKey: scope.key, companyKey: key,
    status: 'unverified', reason, country: null, hypothesisId: null, evidence: [], checkedAt: new Date().toISOString() };
}

function fitVerdict(row: HeEngQualificationRow, company: HeEngCompanyFitInput, scope: HeEngQualificationScope, decision: HeEngCompanyFitDecision): HeEngCompanyVerdict {
  const base = unverified(scope, company.id, decision.reason);
  const location = heEngSourceCountry(row, scope.countries);
  if (location.status !== 'confirmed') return { ...base, reason: 'country_unverified' };
  const quotes = new Map(company.quotes.map((quote) => [quote.id, quote]));
  const evidence = (['identity', 'activity'] as const).flatMap((kind) =>
    (kind === 'identity' ? decision.identity.quoteIds : decision.activityQuoteIds).flatMap((id) => {
      const quote = quotes.get(id);
      return quote ? [{ kind, url: quote.url, quote: quote.text }] : [];
    }));
  return { ...base, status: decision.status === 'match' ? 'accepted' : decision.status === 'mismatch' ? 'rejected' : 'unverified',
    country: location.country, countryProof: location.proof, hypothesisId: decision.hypothesisId, evidence,
    ...(decision.status === 'match' && decision.hypothesisId ? { fitReview: {
      model: HE_ENG_QUALIFICATION_REVIEW_MODEL, status: 'match' as const, hypothesisId: decision.hypothesisId,
    } } : {}) };
}

/**
 * Softer acceptance (heEngCatalogDirectHypothesis) when the company's own site
 * gave the models no evidence either way. Only for pages read from the
 * catalogue site itself — a page from another domain proves its identity
 * through the models — and only with a proven source country.
 */
function catalogVerdict(row: HeEngQualificationRow, key: string, scope: HeEngQualificationScope, crossSite: boolean): HeEngCompanyVerdict | null {
  const direct = crossSite ? null : heEngCatalogDirectHypothesis(row, scope);
  const location = heEngSourceCountry(row, scope.countries);
  if (!direct || location.status !== 'confirmed') return null;
  return { ...unverified(scope, key, 'catalog_industry_match'), status: 'accepted', country: location.country,
    countryProof: location.proof, hypothesisId: direct.hypothesisId,
    catalogFit: { source: 'pdl', industry: direct.industry, hypothesisId: direct.hypothesisId } };
}

/** INSUFFICIENT or a NOT_TARGET without quotes: the models found no contrary evidence. */
function withoutContraryEvidence(decision: HeEngCompanyFitDecision | undefined): boolean {
  return decision?.status === 'unverified' && ['activity_unverified', 'hypothesis_unconfirmed'].includes(decision.reason);
}

function knownResponseCost(response: unknown): number | undefined {
  const usage = (response as { usage?: { cost?: unknown } } | null)?.usage;
  return typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
}

/** Caller has confirmed ENG ownership and selected only OK/catch-all rows. */
export async function runHeEngCompanyQualification<T extends HeEngQualificationRow>(
  ctx: HeStageContext,
  input: { rows: T[]; scope: HeEngQualificationScope; memo?: HeEngQualificationMemo; maxCompanies?: number;
    collectedEvidence?: Readonly<Record<string, HeEngCollectedCompanyEvidence>>;
    /** Only a new manual target base may opt in, under the same global $5 ledger. */
    collectionTargetBudget?: true;
    onCheckpoint: (memo: HeEngQualificationMemo) => Promise<void> },
): Promise<{ rows: T[]; memo: HeEngQualificationMemo; tokensUsed: number; costUsd: number; complete: boolean; retryAfterMs?: number; pendingCompanyCount: number }> {
  if (input.collectionTargetBudget && !heEngBaseBudgetActive()) {
    throw new HeEngQualificationScopeError('adaptive qualification requires the global base budget');
  }
  const { scope } = input;
  const version = heEngQualificationVersion(scope);
  if (!version || !scope.hypotheses.length) throw new HeEngQualificationScopeError('valid selected hypotheses and country policy are required');
  if (input.memo && (input.memo.version !== version || input.memo.scopeKey !== scope.key)) throw new HeEngQualificationScopeError('saved memo version/scope mismatch');
  const memo: HeEngQualificationMemo = { version, scopeKey: scope.key, verdicts: {}, attempts: {}, partial: {} };
  for (const [key, raw] of Object.entries(input.memo?.verdicts ?? {})) {
    const parsed = StoredVerdictSchema.safeParse(raw);
    if (!parsed.success || parsed.data.version !== version || parsed.data.scopeKey !== scope.key || parsed.data.companyKey !== key) throw new HeEngQualificationScopeError('invalid saved verdict');
    memo.verdicts[key] = parsed.data;
  }
  const pending = new Map<string, T>();
  const countryByKey = new Map<string, Set<string>>();
  for (const row of input.rows) {
    const key = heEngCompanyKey(row);
    const verdict = memo.verdicts[key];
    if (verdict?.status === 'accepted' && !heEngCompanyQualified({ ...row, _eng_company_qualification: verdict }, scope)) throw new HeEngQualificationScopeError('invalid saved acceptance');
    if (!verdict && !pending.has(key)) pending.set(key, row);
    if (version === 3) {
      const country = heEngSourceCountry(row, scope.countries);
      const values = countryByKey.get(key) ?? new Set<string>();
      values.add(country.status === 'confirmed' || country.status === 'outside' ? country.country! : country.status);
      countryByKey.set(key, values);
    }
  }
  let tokensUsed = 0;
  let costUsd = 0;
  const output = () => {
    const rows = input.rows.flatMap((row) => {
      const savedVerdict = memo.verdicts[heEngCompanyKey(row)];
      // Audit belongs once in collect_info, not duplicated into every contact/export.
      const proof = savedVerdict ? Object.fromEntries(Object.entries(savedVerdict).filter(([key]) => key !== 'audit')) : undefined;
      const qualified = { ...row, _eng_company_qualification: proof };
      return heEngCompanyQualified(qualified, scope) ? [qualified] : [];
    });
    const remaining = [...pending.keys()].filter((key) => !memo.verdicts[key]);
    return { rows, memo, tokensUsed, costUsd, complete: remaining.length === 0, pendingCompanyCount: remaining.length,
      ...(remaining.length ? { retryAfterMs: remaining.some((key) => !memo.attempts![key]) ? 1000 : COMPANY_RETRY_MS } : {}) };
  };
  // Completed historical proofs keep their exact version, scope and budget. No v2
  // run can silently restart with a new model, allowance or weaker country policy.
  if (version === 2) {
    if (pending.size) throw new HeEngQualificationScopeError('legacy qualification is incomplete; automatic migration is disabled');
    if (input.memo) Object.assign(memo, structuredClone(input.memo));
    return output();
  }
  for (const [key, raw] of Object.entries(input.memo?.attempts ?? {})) {
    const parsed = z.object({ attempts: z.number().int().min(1).max(MAX_COMPANY_ATTEMPTS), kind: z.enum(['site_transient', 'model_transient', 'model_invalid', 'site_unavailable']) }).safeParse(raw);
    if (!parsed.success) throw new HeEngQualificationScopeError('invalid saved attempts');
    memo.attempts![key] = parsed.data;
  }
  const saved = input.memo?.economy;
  // Completed proofs retain their paid history across the request-format change.
  // An unfinished older workflow must be reviewed, never silently repurchased.
  if (saved?.workflow === 'fit_review_v3' && pending.size === 0) {
    Object.assign(memo, structuredClone(input.memo));
    return output();
  }
  if (saved && (saved.version !== 1 || saved.workflow !== 'fit_review_v3_single' || !Object.hasOwn(saved, 'budget') || saved.budget === undefined ||
      !saved.prepared || typeof saved.prepared !== 'object' || Array.isArray(saved.prepared) ||
      !saved.proposals || typeof saved.proposals !== 'object' || Array.isArray(saved.proposals))) throw new HeEngQualificationScopeError('invalid saved economy state');
  const budget = readHeEngQualificationBudget(saved?.budget, {
    hasPaidHistory: !!input.memo && !saved && (Object.keys(memo.verdicts).length > 0 || Object.keys(memo.attempts!).length > 0 || Object.keys(input.memo.partial ?? {}).length > 0),
    ...(input.collectionTargetBudget ? { freshLimitMicrousd: HE_ENG_COLLECTION_QUALIFICATION_LIMIT_MICROUSD } : {}),
  });
  if (budget.limitMicrousd === HE_ENG_COLLECTION_QUALIFICATION_LIMIT_MICROUSD &&
      (!input.collectionTargetBudget || !heEngBaseBudgetActive())) {
    throw new HeEngQualificationScopeError('adaptive qualification budget cannot run outside its global base ledger');
  }
  memo.economy = { version: 1, workflow: 'fit_review_v3_single', budget, prepared: {}, proposals: {} };
  const preparedSchema = z.object({ website: z.string().min(1).max(2000), pages: z.array(z.object({ url: z.string().max(2000), text: z.string().max(MAX_PAGE_TEXT),
    evidenceSource: z.enum(['constructor_website', 'website']).optional() })).max(MAX_PAGES + 3),
    retryableFailure: z.boolean(), collectedJobId: z.string().uuid().optional(), excerptVersion: z.literal(2).optional(),
    // Present only when a page came from a same-brand domain (companySiteAlias).
    company: z.string().min(1).max(1000).optional() });
  if (Object.keys(saved?.prepared ?? {}).length > 16 || Object.keys(saved?.proposals ?? {}).length > 16) throw new HeEngQualificationScopeError('too many cached companies');
  const preparedHistory = new Set<string>();
  for (const [key, raw] of Object.entries(saved?.prepared ?? {})) {
    const item = preparedSchema.safeParse(raw);
    if (!/^[a-f0-9]{64}$/.test(key) || !item.success || !normalizeLeadWebsite(item.data.website) || item.data.pages.some((page) =>
      !companySite(page.url, item.data.website, item.data.company ?? '') || (item.data.website.startsWith('https:') && !page.url.startsWith('https:')) || withoutEmails(page.text) !== page.text)) throw new HeEngQualificationScopeError('invalid cached company evidence');
    preparedHistory.add(key);
    const row = pending.get(key);
    if (!row) continue;
    const normalized = normalizeLeadWebsite(row.website);
    const website = normalized && (/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
    if (item.data.website !== website || (item.data.company !== undefined && item.data.company !== row.company)) {
      throw new HeEngQualificationScopeError('invalid cached company identity');
    }
    memo.economy.prepared[key] = item.data;
  }
  const safeScope = JSON.parse(withoutEmails(JSON.stringify(scope))) as HeEngQualificationScope;
  for (const [key, proposal] of Object.entries(saved?.proposals ?? {})) {
    if (!preparedHistory.has(key)) throw new HeEngQualificationScopeError('saved proposal has no source evidence');
    const row = pending.get(key), cached = memo.economy.prepared[key];
    if (!row || !cached) continue;
    const company = fitInput(key, row, cached.website, cached.pages, scope, cached.excerptVersion);
    const parsed = validateHeEngCompanyFitDecision(proposal, company, safeScope);
    if (!parsed || parsed.status === 'unverified') throw new HeEngQualificationScopeError('invalid saved review proposal');
    if (heEngCompanyFitNeedsReview(parsed)) memo.economy.proposals![key] = parsed;
    else finish(key, fitVerdict(row, company, scope, finalizeHeEngCompanyFit(new Map([[key, parsed]]), new Map()).get(key)!), parsed);
  }
  let checkpoint = Promise.resolve();
  async function save(): Promise<void> {
    const snapshot = structuredClone(memo);
    checkpoint = checkpoint.catch(() => undefined).then(() => input.onCheckpoint(snapshot));
    await checkpoint;
  }
  function assessment(model: string, decision: HeEngCompanyFitDecision): HeEngCompanyQualificationAssessment {
    return { model, status: decision.status, reason: decision.reason, hypothesisId: decision.hypothesisId, exclusionCause: decision.exclusionCause,
      quoteIds: [...decision.activityQuoteIds], explanation: withoutEmails(decision.explanation).slice(0, 400) };
  }
  function finish(key: string, verdict: HeEngCompanyVerdict, classifier?: HeEngCompanyFitDecision, review?: HeEngCompanyFitDecision): void {
    const prepared = memo.economy!.prepared[key];
    const row = pending.get(key);
    if (prepared && row) {
      const company = fitInput(key, row, prepared.website, prepared.pages, scope, prepared.excerptVersion);
      const proposal = classifier ?? memo.economy!.proposals![key];
      verdict.audit = { version: 1, quotes: company.quotes.map((quote) => ({ ...quote, source: quote.source ?? 'website' })),
        ...(prepared.collectedJobId ? { collectedJobId: prepared.collectedJobId } : {}),
        ...(proposal ? { classifier: assessment(HE_ENG_QUALIFICATION_MODEL, proposal) } : {}),
        ...(review ? { review: assessment(HE_ENG_QUALIFICATION_REVIEW_MODEL, review) } : {}) };
    }
    memo.verdicts[key] = verdict;
    delete memo.economy!.prepared[key];
    delete memo.economy!.proposals![key];
  }
  function finishRemaining(reason: string): void {
    for (const key of pending.keys()) if (!memo.verdicts[key]) finish(key, unverified(scope, key, reason));
  }
  /** One more failed model attempt for a company; true once it has used all of them. */
  function modelAttemptFailed(key: string): boolean {
    const attempts = Math.min(MAX_COMPANY_ATTEMPTS, (memo.attempts![key]?.attempts ?? 0) + 1);
    memo.attempts![key] = { attempts, kind: 'model_transient' };
    return attempts >= MAX_COMPANY_ATTEMPTS;
  }
  // Requests lost to a restart or a cancelled job: the marker of the old
  // one-at-a-time format and the current list. Each reserve stays booked as
  // spent (the reservation keeps it), its company gets a later attempt, and
  // checking goes on with everyone else instead of stopping the base.
  const savedFlights = saved?.inFlights;
  if (savedFlights !== undefined && !Array.isArray(savedFlights)) throw new HeEngQualificationScopeError('invalid interrupted request');
  const lostFlights = [...(saved?.inFlight ? [saved.inFlight] : []), ...(savedFlights ?? [])];
  const validFlight = (flight: HeEngQualificationInFlight | undefined): boolean => !!flight &&
    ['classifier', 'review'].includes(flight.phase ?? '') && typeof flight.reservationId === 'string' && Object.hasOwn(budget.reservations, flight.reservationId) &&
    Array.isArray(flight.companyKeys) && flight.companyKeys.length > 0 && flight.companyKeys.length <= MODEL_BATCH_SIZE &&
    new Set(flight.companyKeys).size === flight.companyKeys.length && flight.companyKeys.every((key) =>
      typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) && (preparedHistory.has(key) || Object.hasOwn(memo.verdicts, key)));
  const lostKeys = lostFlights.flatMap((flight) => validFlight(flight) ? flight.companyKeys : []);
  if (lostFlights.length > MAX_LOST_FLIGHTS || !lostFlights.every(validFlight) ||
      new Set(lostFlights.map((flight) => flight.reservationId)).size !== lostFlights.length ||
      new Set(lostKeys).size !== lostKeys.length) throw new HeEngQualificationScopeError('invalid interrupted request');
  if (lostFlights.length) {
    for (const key of lostKeys) {
      if (!memo.verdicts[key] && modelAttemptFailed(key)) finish(key, unverified(scope, key, 'model_response_unavailable'));
    }
    await save();
  }
  const hold = heEngQualificationBudgetHoldReason(budget);
  if (hold) { finishRemaining(hold); await save(); return output(); }
  for (const [key, row] of pending) {
    const country = heEngSourceCountry(row, scope.countries);
    const conflict = (countryByKey.get(key)?.size ?? 0) > 1 || country.status === 'conflict';
    if (country.status !== 'confirmed' || conflict) finish(key, {
      ...unverified(scope, key, conflict ? 'country_conflict' : country.status === 'outside' ? 'country_outside_target' : 'country_unverified'),
      status: country.status === 'outside' && !conflict ? 'rejected' : 'unverified', country: country.country, countryProof: country.proof,
    });
  }
  await save();
  const fetchPage = resolveFetchPage({ ...ctx, market: 'us' }, { companyEvidence: true, companyEvidenceTerms: [...hypothesisWords(scope, true)].slice(0, 32) });
  const limit = Number.isFinite(input.maxCompanies) && input.maxCompanies! >= 1 ? Math.min(16, Math.floor(input.maxCompanies!)) : 16;
  const candidates = [...pending].filter(([key]) => !memo.verdicts[key]).sort(([a], [b]) =>
    Number(!!memo.economy!.proposals![b]) - Number(!!memo.economy!.proposals![a]) ||
    Number(!!memo.economy!.prepared[b]) - Number(!!memo.economy!.prepared[a]) || (memo.attempts![a]?.attempts ?? 0) - (memo.attempts![b]?.attempts ?? 0)).slice(0, limit);
  // Companies whose evidence is ready for the models, in candidate order: the
  // models start on the first one while the other sites are still being read.
  const ready = candidates.filter(([key]) => memo.economy!.prepared[key]).map(([key]) => key);
  // Assessors wait here for a newly read company, a finished request or a stop.
  const waiters: Array<() => void> = [];
  const wakeAll = () => { for (const wake of waiters.splice(0)) wake(); };
  const changed = () => new Promise<void>((resolve) => { waiters.push(resolve); });
  let readersDone = false;
  // Why this run stops buying; set from inside the readers and the assessors.
  const run: { failure?: { error: unknown }; holdReason?: string; modelPaused?: boolean } = {};
  let modelFailures = 0;
  const stopped = () => !!run.failure || !!run.holdReason || !!run.modelPaused;
  const fail = (error: unknown) => { run.failure ??= { error }; wakeAll(); };
  let cursor = 0;
  async function prepare(): Promise<void> {
    while (!stopped() && cursor < candidates.length) {
      const [key, row] = candidates[cursor++];
      try {
        interrupted(ctx);
        if (memo.economy!.prepared[key]) continue;
        const normalized = normalizeLeadWebsite(row.website);
        const website = normalized ? (/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`) : '';
        if (!website || typeof row.company !== 'string' || !row.company.trim()) {
          finish(key, unverified(scope, key, website ? 'company_name_missing' : 'website_invalid')); await save(); continue;
        }
        const collected = input.collectedEvidence?.[key];
        const reused = collectedPages(row, collected, website);
        const sufficient = reused.length > 0 && !collected!.pages.some((page) => page.truncated) &&
          enoughCollectedText(fitInput(key, row, website, reused, scope, 2), scope);
        const read: PageRead = sufficient ? { pages: [], retryableFailure: false, unverifiedRedirect: false }
          : await companyPages(ctx, fetchPage, website, row.company, scope);
        const pages: QualificationPage[] = [...reused, ...read.pages.map(({ url, text }) => ({ url, text, evidenceSource: 'website' as const }))];
        if (!pages.length) {
          const attempts = Math.min(MAX_COMPANY_ATTEMPTS, (memo.attempts![key]?.attempts ?? 0) + 1);
          memo.attempts![key] = { attempts, kind: read.retryableFailure ? 'site_transient' : 'site_unavailable' };
          if (!read.retryableFailure || attempts >= MAX_COMPANY_ATTEMPTS) finish(key, unverified(scope, key, read.unverifiedRedirect ? 'website_redirect_unverified' : 'site_unavailable_exhausted'));
        } else memo.economy!.prepared[key] = { website, pages, retryableFailure: read.retryableFailure, excerptVersion: 2,
          ...(pages.some((page) => !sameSite(page.url, website)) ? { company: row.company } : {}),
          ...(reused.length ? { collectedJobId: collected!.jobId } : {}) };
        await save();
        if (memo.economy!.prepared[key] && !memo.verdicts[key]) { ready.push(key); wakeAll(); }
      } catch (error) { fail(error); }
    }
  }
  // Paid requests that have not answered yet. Each one is durable before it is
  // sent; a restart treats every one listed here as lost (see above).
  const flights: HeEngQualificationInFlight[] = [];
  function syncFlights(): void {
    if (flights.length) memo.economy!.inFlights = [...flights];
    else delete memo.economy!.inFlights;
  }
  function dropFlight(flight: HeEngQualificationInFlight): void {
    const index = flights.indexOf(flight);
    if (index >= 0) flights.splice(index, 1);
    syncFlights();
    wakeAll();
  }
  // Budget, selected company keys and phase are durable before each paid request.
  // null stops buying in this run; 'failed' means the company waits for a later attempt.
  async function purchase(request: HeEngCompanyFitRequest, companies: HeEngCompanyFitInput[], review: boolean): Promise<Map<string, HeEngCompanyFitDecision> | 'failed' | null> {
    let reservation: HeEngQualificationModelReservation | null = null;
    while (!reservation) {
      // After a failed request, buy one at a time until one succeeds: a failing
      // provider must not burn the attempts of several companies at once.
      while (modelFailures > 0 && flights.length > 0 && !stopped()) await changed();
      if (stopped()) return null;
      // A request that does not fit while others are unanswered waits for their
      // settlement, which returns unused reserve. Alone, it is a real hold, as
      // in the one-at-a-time order: parallel requests never end the budget early.
      const others = flights.length > 0;
      reservation = reserveHeEngQualificationModel(budget, request.messages, review ? 2500 : 1100,
        { review, jsonSchema: request.jsonSchema, ...(others ? { holdIfShort: false as const } : {}) });
      if (reservation) break;
      if (!others) {
        run.holdReason ??= heEngQualificationBudgetHoldReason(budget) ?? 'model_budget_exhausted';
        wakeAll();
        return null;
      }
      await changed();
    }
    const flight: HeEngQualificationInFlight = { reservationId: reservation.id, companyKeys: companies.map((company) => company.id), phase: review ? 'review' : 'classifier' };
    flights.push(flight);
    syncFlights();
    await save();
    interrupted(ctx);
    try {
      const response = await callLLMText(request.messages, { ...reservation, market: 'us', jsonMode: true });
      tokensUsed += response.tokensUsed; costUsd += response.costUsd;
      const reportedCost = knownResponseCost(response.rawResponse);
      // An answer without a reported price keeps its full reserve booked as spent.
      settleHeEngQualificationModel(budget, reservation, reportedCost);
      const result = parseHeEngCompanyFitResponse(response.finishReason === 'length' ? '' : response.text, companies, safeScope, request);
      dropFlight(flight);
      modelFailures = 0;
      const purchaseHold = heEngQualificationBudgetHoldReason(budget);
      if (purchaseHold) { run.holdReason ??= purchaseHold; wakeAll(); }
      // A first answer under a fresh hold is not used; an independent review is kept (see assess).
      if (purchaseHold && !review) { await save(); return null; }
      return result;
    } catch (error) {
      // This purchase is a single callLLMText attempt, transportRetries: 0,
      // with no model/schema fallback. Only a live transport receipt can prove
      // zero provider work. Clear our local marker before propagating the stop,
      // so a future approved resume does not discard all remaining companies.
      // Global ledger holds/reservations and historical in-flight markers stay intact.
      if (isHeEngBaseBudgetPreflightFailure(error)) {
        settleHeEngQualificationModel(budget, reservation, 0);
        dropFlight(flight);
        await save();
      }
      rethrowHeEngBaseBudgetError(error);
      // Unknown implementation errors/abort keep the durable in-flight marker.
      interrupted(ctx, error);
      const llmFailure = heLlmFailureOf(error);
      if (!llmFailure && !isHeLlmTimeout(error)) throw error;
      // The model did not answer: the reserve stays booked as spent and this
      // company gets a later attempt (three in all). Checking goes on with the
      // next company; repeated failures, or a billing/key problem, pause this
      // run for a minute instead of stopping the base.
      dropFlight(flight);
      for (const company of companies) {
        if (!memo.verdicts[company.id] && modelAttemptFailed(company.id)) finish(company.id, unverified(scope, company.id, 'model_provider_unavailable'));
      }
      modelFailures += 1;
      if (modelFailures >= MAX_MODEL_FAILURES_IN_RUN || llmFailure?.kind === 'billing' || llmFailure?.kind === 'configuration') {
        run.modelPaused = true;
        wakeAll();
      }
      await save();
      return run.modelPaused ? null : 'failed';
    }
  }
  async function assess(key: string): Promise<void> {
    const row = pending.get(key)!;
    const prepared = memo.economy!.prepared[key];
    if (!prepared || memo.verdicts[key]) return;
    const company = fitInput(key, row, prepared.website, prepared.pages, scope, prepared.excerptVersion);
    const catalog = () => catalogVerdict(row, key, scope, prepared.company !== undefined);
    if (!company.quotes.length) { finish(key, catalog() ?? unverified(scope, key, 'activity_unverified')); await save(); return; }
    if (!memo.economy!.proposals![key]) {
      const proposals = await purchase(buildHeEngCompanyFitClassifierRequest([company], safeScope), [company], false);
      if (!proposals || proposals === 'failed') return;
      const proposal = proposals.get(key)!;
      if (!heEngCompanyFitNeedsReview(proposal)) finish(key, (withoutContraryEvidence(proposal) ? catalog() : null) ??
        fitVerdict(row, company, scope, finalizeHeEngCompanyFit(new Map([[key, proposal]]), new Map()).get(key)!), proposal);
      else memo.economy!.proposals![key] = proposal;
      await save(); // Persist the first paid answer before buying independent review.
      if (memo.verdicts[key]) return;
    }
    const proposals = new Map([[key, memo.economy!.proposals![key]]]);
    const request = buildHeEngCompanyFitReviewRequest([company], proposals, safeScope);
    if (!request) throw new HeEngQualificationScopeError('missing independent review request');
    const reviews = await purchase(request, request.companies, true);
    if (!reviews || reviews === 'failed') return;
    const final = finalizeHeEngCompanyFit(proposals, reviews);
    // A proposed match the reviewer found too little to confirm is no contrary evidence either.
    const softened = proposals.get(key)?.status === 'match' && final.get(key)?.reason === 'review_disagreement' &&
      withoutContraryEvidence(reviews.get(key)) ? catalog() : null;
    finish(key, softened ?? fitVerdict(row, company, scope, final.get(key)!), proposals.get(key), reviews.get(key));
    // Keep a completed, independently checked result even if its charge is unknown.
    // The same durable hold prevents any further purchase in this base.
    await save();
  }
  async function nextReady(): Promise<string | null> {
    for (;;) {
      if (stopped()) return null;
      const key = ready.shift();
      if (key !== undefined) return key;
      if (readersDone) return null;
      await changed();
    }
  }
  async function assessReady(): Promise<void> {
    for (let key = await nextReady(); key !== null; key = await nextReady()) {
      try { interrupted(ctx); await assess(key); } catch (error) { fail(error); return; }
    }
  }
  const readers = Promise.all(Array.from({ length: Math.min(SITE_READERS, candidates.length) }, () => prepare()))
    .finally(() => { readersDone = true; wakeAll(); });
  // Nothing outlives this call: every reader and assessor settles before it returns or throws.
  await Promise.allSettled([readers, ...Array.from({ length: MODEL_REQUESTS_IN_PARALLEL }, () => assessReady())]);
  if (run.failure) throw run.failure.error;
  const paused = () => {
    const result = output();
    return result.complete ? result : { ...result, retryAfterMs: Math.max(result.retryAfterMs ?? 0, MODEL_PAUSE_MS) };
  };
  if (run.holdReason) { finishRemaining(run.holdReason); await save(); }
  return run.modelPaused ? paused() : output();
}
