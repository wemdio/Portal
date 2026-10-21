import { heEngBaseBudgetActive, isHeEngBaseBudgetPreflightFailure, rethrowHeEngBaseBudgetError } from './engBaseBudget';
import { z } from 'zod';

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
  heEngCompanyKey, heEngCompanyQualified, heEngQualificationVersion,
  type HeEngCompanyVerdict, type HeEngQualificationMemo,
  type HeEngQualificationRow, type HeEngQualificationScope,
  type HeEngCollectedCompanyEvidence, type HeEngCompanyQualificationAssessment,
} from './engCompanyQualificationPolicy';
import { callLLMText, heLlmFailureOf, isHeLlmTimeout } from './llm';
import {
  readHeEngQualificationBudget, reserveHeEngQualificationModel, settleHeEngQualificationModel,
  heEngQualificationBudgetHoldReason, HE_ENG_QUALIFICATION_REVIEW_MODEL, HE_ENG_QUALIFICATION_MODEL,
  HE_ENG_COLLECTION_QUALIFICATION_LIMIT_MICROUSD,
} from './engQualificationBudget';
import { heStageSignal, isHeSiteUnreachable, resolveFetchPage, type HeFetchedPage, type HeFetchPageFn } from './stages/io';
import type { HeStageContext } from './stages/shared';

const MAX_PAGES = 9;
const MAX_PAGE_DEPTH = 3;
const MAX_COMPANY_ATTEMPTS = 3;
const COMPANY_RETRY_MS = 30_000;
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

async function companyPages(ctx: HeStageContext, fetchPage: HeFetchPageFn, website: string, scope: HeEngQualificationScope): Promise<PageRead> {
  const pages: HeFetchedPage[] = [];
  const attempted = new Set<string>();
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
  while (queue.length && attempted.size < MAX_PAGES) {
    interrupted(ctx);
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
    if (!key || attempted.has(key) || !sameSite(candidate.url, website)) continue;
    attempted.add(key);
    attemptedKinds.push(candidate.kind);
    let page: HeFetchedPage | null;
    try { page = await fetchPage(candidate.url); }
    catch (error) {
      interrupted(ctx, error);
      retryableFailure ||= !(isHeSiteUnreachable(error) && error.kind === 'dns');
      if (candidate.depth === 0 && !fallbackOrigin()) break;
      continue;
    }
    interrupted(ctx);
    if (!page || !sameSite(page.url, website) || (website.startsWith('https:') && !page.url.startsWith('https:'))) {
      unverifiedRedirect ||= !!page && !sameSite(page.url, website);
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
      if (!linkKey || attempted.has(linkKey) || !sameSite(link.url, website) || (website.startsWith('https:') && !link.url.startsWith('https:')) || queue.some((item) => urlKey(item.url) === linkKey)) continue;
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
    if (!sameSite(page.url, website)) continue;
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
    retryableFailure: z.boolean(), collectedJobId: z.string().uuid().optional(), excerptVersion: z.literal(2).optional() });
  if (Object.keys(saved?.prepared ?? {}).length > 16 || Object.keys(saved?.proposals ?? {}).length > 16) throw new HeEngQualificationScopeError('too many cached companies');
  const preparedHistory = new Set<string>();
  for (const [key, raw] of Object.entries(saved?.prepared ?? {})) {
    const item = preparedSchema.safeParse(raw);
    if (!/^[a-f0-9]{64}$/.test(key) || !item.success || !normalizeLeadWebsite(item.data.website) || item.data.pages.some((page) =>
      !sameSite(page.url, item.data.website) || (item.data.website.startsWith('https:') && !page.url.startsWith('https:')) || withoutEmails(page.text) !== page.text)) throw new HeEngQualificationScopeError('invalid cached company evidence');
    preparedHistory.add(key);
    const row = pending.get(key);
    if (!row) continue;
    const normalized = normalizeLeadWebsite(row.website);
    const website = normalized && (/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
    if (item.data.website !== website) throw new HeEngQualificationScopeError('invalid cached company identity');
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
  if (saved?.inFlight) {
    const flight = saved.inFlight;
    if (!['classifier', 'review'].includes(flight.phase ?? '') || typeof flight.reservationId !== 'string' || !Object.hasOwn(budget.reservations, flight.reservationId) ||
        !Array.isArray(flight.companyKeys) || !flight.companyKeys.length || flight.companyKeys.length > MODEL_BATCH_SIZE ||
        new Set(flight.companyKeys).size !== flight.companyKeys.length || flight.companyKeys.some((key) =>
          typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || (!preparedHistory.has(key) && !Object.hasOwn(memo.verdicts, key)))) throw new HeEngQualificationScopeError('invalid interrupted request');
    // Unknown response/charge: preserve its reserve and stop the remaining run.
    // Do not re-purchase a lost classifier or review on worker restart.
    budget.holdReason ??= 'model_cost_unknown';
    for (const key of flight.companyKeys) if (!memo.verdicts[key]) finish(key, unverified(scope, key, 'model_response_unavailable'));
    finishRemaining('model_response_unavailable');
    await save();
    return output();
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
  let cursor = 0;
  let readFailure: unknown;
  let failed = false;
  async function prepare(): Promise<void> {
    while (!failed && cursor < candidates.length) {
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
          : await companyPages(ctx, fetchPage, website, scope);
        const pages: QualificationPage[] = [...reused, ...read.pages.map(({ url, text }) => ({ url, text, evidenceSource: 'website' as const }))];
        if (!pages.length) {
          const attempts = Math.min(MAX_COMPANY_ATTEMPTS, (memo.attempts![key]?.attempts ?? 0) + 1);
          memo.attempts![key] = { attempts, kind: read.retryableFailure ? 'site_transient' : 'site_unavailable' };
          if (!read.retryableFailure || attempts >= MAX_COMPANY_ATTEMPTS) finish(key, unverified(scope, key, read.unverifiedRedirect ? 'website_redirect_unverified' : 'site_unavailable_exhausted'));
        } else memo.economy!.prepared[key] = { website, pages, retryableFailure: read.retryableFailure, excerptVersion: 2,
          ...(reused.length ? { collectedJobId: collected!.jobId } : {}) };
        await save();
      } catch (error) { if (!failed) { failed = true; readFailure = error; } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => prepare()));
  if (failed) throw readFailure;
  const ready = candidates.flatMap(([key, row]) => {
    const company = memo.economy!.prepared[key];
    if (!company || memo.verdicts[key]) return [];
    const evidence = fitInput(key, row, company.website, company.pages, scope, company.excerptVersion);
    if (evidence.quotes.length) return [evidence];
    finish(key, unverified(scope, key, 'activity_unverified'));
    return [];
  });
  await save();
  let purchaseHold: string | null = null;
  // Budget, selected company keys and phase are durable before each paid request.
  async function purchase(request: HeEngCompanyFitRequest, companies: HeEngCompanyFitInput[], review: boolean): Promise<Map<string, HeEngCompanyFitDecision> | null> {
    const reservation = reserveHeEngQualificationModel(budget, request.messages, review ? 2500 : 1100, { review, jsonSchema: request.jsonSchema });
    if (!reservation) { finishRemaining(heEngQualificationBudgetHoldReason(budget) ?? 'model_budget_exhausted'); await save(); return null; }
    memo.economy!.inFlight = { reservationId: reservation.id, companyKeys: companies.map((company) => company.id), phase: review ? 'review' : 'classifier' };
    await save();
    interrupted(ctx);
    try {
      const response = await callLLMText(request.messages, { ...reservation, market: 'us', jsonMode: true });
      tokensUsed += response.tokensUsed; costUsd += response.costUsd;
      const reportedCost = knownResponseCost(response.rawResponse);
      settleHeEngQualificationModel(budget, reservation, reportedCost);
      const result = parseHeEngCompanyFitResponse(response.finishReason === 'length' ? '' : response.text, companies, safeScope, request);
      delete memo.economy!.inFlight;
      if (reportedCost === undefined) budget.holdReason ??= 'model_cost_unknown';
      purchaseHold = heEngQualificationBudgetHoldReason(budget);
      if (purchaseHold && !review) {
        finishRemaining(purchaseHold); await save(); return null;
      }
      return result;
    } catch (error) {
      // This purchase is a single callLLMText attempt, transportRetries: 0,
      // with no model/schema fallback. Only a live transport receipt can prove
      // zero provider work. Clear our local marker before propagating the stop,
      // so a future approved resume does not discard all remaining companies.
      // Global ledger holds/reservations and historical inFlight stay intact.
      if (isHeEngBaseBudgetPreflightFailure(error)) {
        settleHeEngQualificationModel(budget, reservation, 0);
        delete memo.economy!.inFlight;
        await save();
      }
      rethrowHeEngBaseBudgetError(error);
      // Unknown implementation errors/abort keep the durable in-flight marker.
      interrupted(ctx, error);
      if (!heLlmFailureOf(error) && !isHeLlmTimeout(error)) throw error;
      budget.holdReason ??= 'model_cost_unknown';
      finishRemaining('model_provider_unavailable'); delete memo.economy!.inFlight;
      await save(); return null;
    }
  }
  for (let start = 0; start < ready.length; start += MODEL_BATCH_SIZE) {
    interrupted(ctx);
    const companies = ready.slice(start, start + MODEL_BATCH_SIZE);
    const fresh = companies.filter((company) => !memo.economy!.proposals![company.id]);
    if (fresh.length) {
      const proposals = await purchase(buildHeEngCompanyFitClassifierRequest(fresh, safeScope), fresh, false);
      if (!proposals) return output();
      for (const company of fresh) {
        const proposal = proposals.get(company.id)!;
        if (!heEngCompanyFitNeedsReview(proposal)) finish(company.id, fitVerdict(pending.get(company.id)!, company, scope,
          finalizeHeEngCompanyFit(new Map([[company.id, proposal]]), new Map()).get(company.id)!), proposal);
        else memo.economy!.proposals![company.id] = proposal;
      }
      await save(); // Persist the first paid answer before buying independent review.
    }
    const remaining = companies.filter((company) => !memo.verdicts[company.id]);
    if (!remaining.length) continue;
    const proposals = new Map(remaining.map((company) => [company.id, memo.economy!.proposals![company.id]]));
    const request = buildHeEngCompanyFitReviewRequest(remaining, proposals, safeScope);
    if (!request) throw new HeEngQualificationScopeError('missing independent review request');
    const reviews = await purchase(request, request.companies, true);
    if (!reviews) return output();
    const final = finalizeHeEngCompanyFit(proposals, reviews);
    for (const company of remaining) finish(company.id, fitVerdict(pending.get(company.id)!, company, scope, final.get(company.id)!),
      proposals.get(company.id), reviews.get(company.id));
    // Keep a completed, independently checked result even if its charge is unknown.
    // The same durable hold prevents any further purchase in this base.
    if (purchaseHold) finishRemaining(purchaseHold);
    await save();
    if (purchaseHold) return output();
  }
  return output();
}
