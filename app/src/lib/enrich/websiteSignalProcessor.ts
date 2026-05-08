import { fetchHtmlWithRetry, fetchHtmlWithPlaywright } from '@/lib/enrich/websiteParser';
import { normalizeUrl } from '@/lib/enrich/urlUtils';
import { detectSignals, determineProfile, formatStack } from '@/lib/enrich/signalDetector';
import { discoverSubpaths } from '@/lib/enrich/subpathDiscovery';
import {
  ExtractorKey,
  ExtractedData,
  EXTRACTOR_TO_SUBPAGES,
  SubpageKind,
} from '@/lib/enrich/extractors/types';
import { extractCustomers } from '@/lib/enrich/extractors/customersExtractor';
import { extractCasesCount } from '@/lib/enrich/extractors/casesCountExtractor';
import { extractCaseIndustries } from '@/lib/enrich/extractors/caseIndustriesExtractor';
import { detectEnterpriseLogos } from '@/lib/enrich/extractors/enterpriseLogosDetector';
import { extractPricingModel } from '@/lib/enrich/extractors/pricingModelExtractor';
import { extractPricingDetails } from '@/lib/enrich/extractors/pricingDetailExtractor';
import { extractHiring } from '@/lib/enrich/extractors/hiringExtractor';
import { extractIntegrations } from '@/lib/enrich/extractors/integrationsExtractor';
import { extractFoundedYear } from '@/lib/enrich/extractors/foundedYearExtractor';
import { extractTeamSize } from '@/lib/enrich/extractors/teamSizeExtractor';
import { extractBlogLastPost } from '@/lib/enrich/extractors/blogActivityExtractor';

const DEFAULT_TIMEOUT_MS = 12_000;
const PLAYWRIGHT_TIMEOUT_MS = 18_000;
const DEFAULT_SUBPAGE_TIMEOUT_MS = 8_000;

const DEFAULT_EXTRACTORS: ExtractorKey[] = ['stack', 'profile'];

export type ProcessSignalsResult =
  | (ExtractedData & {
      stack: string;
      profile: string;
      signalIds: string[];
      method: 'http' | 'playwright';
    })
  | { error: string };

export interface ProcessSignalsOptions {
  timeout?: number;
  signal?: AbortSignal;
  /**
   * Which extractors to run. Each extractor maps to 0..N subpages
   * (see EXTRACTOR_TO_SUBPAGES) — only those subpages are fetched.
   * Defaults to ['stack','profile'] for backward compatibility with
   * existing job records that don't carry an `extractors` array.
   */
  extractors?: ExtractorKey[];
  /** Per-subpage timeout in ms. Defaults to 8 000. */
  subpageTimeout?: number;
}

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i, 'Домен не найден (DNS не резолвится)'],
  [/ERR_CONNECTION_REFUSED|ECONNREFUSED/i, 'Сервер отклонил соединение'],
  [/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|[Tt]imeout/i, 'Таймаут подключения'],
  [/ERR_CERT|ERR_SSL|certificate/i, 'Ошибка SSL-сертификата'],
  [/ERR_CONNECTION_RESET|ECONNRESET/i, 'Соединение сброшено'],
  [/ERR_TOO_MANY_REDIRECTS/i, 'Слишком много редиректов'],
];

function classifyFetchError(httpErr: unknown, pwErr: unknown): string {
  const messages = [httpErr, pwErr]
    .filter(Boolean)
    .map((e) => (e instanceof Error ? e.message : String(e)));

  const combined = messages.join(' ');
  if (!combined) return 'Сайт недоступен';

  for (const [pattern, label] of ERROR_PATTERNS) {
    if (pattern.test(combined)) return label;
  }
  return 'Сайт недоступен';
}

async function fetchMainHtml(
  normalized: string,
  httpTimeout: number,
  signal?: AbortSignal,
): Promise<{ html: string; method: 'http' | 'playwright' } | { error: string }> {
  let html: string | null = null;
  let method: 'http' | 'playwright' = 'http';
  let httpError: unknown = null;
  let pwError: unknown = null;

  try {
    const httpResult = await fetchHtmlWithRetry(normalized, {
      timeout: httpTimeout,
      signal,
      allowHttpErrors: false,
    });
    if (httpResult && httpResult.status >= 200 && httpResult.status < 300 && httpResult.html) {
      html = httpResult.html;
    }
  } catch (err) {
    httpError = err;
  }

  if (!html && !signal?.aborted) {
    try {
      const pwHtml = await fetchHtmlWithPlaywright(normalized, {
        timeout: PLAYWRIGHT_TIMEOUT_MS,
        signal,
      });
      if (pwHtml && pwHtml.length > 120) {
        html = pwHtml;
        method = 'playwright';
      }
    } catch (err) {
      pwError = err;
    }
  }

  if (!html) return { error: classifyFetchError(httpError, pwError) };
  return { html, method };
}

/**
 * Fetch a subpage with a short timeout. Failures are silent — subpage data
 * is always optional, so a single bad subpage must never break the rest.
 */
async function fetchSubpageHtml(
  url: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetchHtmlWithRetry(url, { timeout, signal, allowHttpErrors: false });
    if (res && res.status >= 200 && res.status < 300 && res.html) return res.html;
  } catch {
    /* ignore subpage failures */
  }
  return null;
}

export async function processSignalsForUrl(
  rawUrl: string,
  options?: ProcessSignalsOptions,
): Promise<ProcessSignalsResult> {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return { error: 'Пустой URL' };

  let normalized: string;
  try {
    normalized = normalizeUrl(trimmed);
    if (!normalized) throw new Error('Невалидный URL');
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Невалидный URL' };
  }

  const httpTimeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const signal = options?.signal;
  const extractors = options?.extractors ?? DEFAULT_EXTRACTORS;
  const subpageTimeout = options?.subpageTimeout ?? DEFAULT_SUBPAGE_TIMEOUT_MS;

  const main = await fetchMainHtml(normalized, httpTimeout, signal);
  if ('error' in main) return main;

  const out: ExtractedData & { stack: string; profile: string; signalIds: string[]; method: 'http' | 'playwright' } = {
    stack: '',
    profile: '',
    signalIds: [],
    method: main.method,
  };

  if (extractors.includes('stack') || extractors.includes('profile')) {
    const signals = detectSignals(main.html);
    if (extractors.includes('stack')) out.stack = formatStack(signals);
    if (extractors.includes('profile')) out.profile = determineProfile(signals);
    out.signalIds = signals.map((s) => s.id);
  }

  // Determine which subpages we need based on selected extractors.
  const requestedSubpages = new Set<SubpageKind>();
  for (const key of extractors) {
    for (const sp of EXTRACTOR_TO_SUBPAGES[key] ?? []) requestedSubpages.add(sp);
  }

  const subpageHtml: Partial<Record<SubpageKind, string>> = {};

  if (requestedSubpages.size > 0) {
    const discovered = discoverSubpaths(main.html, normalized, Array.from(requestedSubpages));
    await Promise.all(
      Array.from(requestedSubpages).map(async (kind) => {
        const url = discovered[kind];
        if (!url) return;
        const html = await fetchSubpageHtml(url, subpageTimeout, signal);
        if (html) subpageHtml[kind] = html;
      }),
    );
  }

  // Cases-related extractors (share /cases HTML)
  if (extractors.includes('customers')) {
    out.customers = subpageHtml.cases ? extractCustomers(subpageHtml.cases) : [];
  }
  if (extractors.includes('cases_count')) {
    out.cases_count = subpageHtml.cases ? extractCasesCount(subpageHtml.cases) : 0;
  }
  if (extractors.includes('case_industries')) {
    out.case_industries = subpageHtml.cases ? extractCaseIndustries(subpageHtml.cases) : [];
  }
  if (extractors.includes('enterprise_logos')) {
    const cust = out.customers ?? (subpageHtml.cases ? extractCustomers(subpageHtml.cases) : []);
    out.enterprise_logos = detectEnterpriseLogos(cust);
  }

  // Pricing-related extractors (share /pricing HTML)
  if (extractors.includes('pricing_model')) {
    out.pricing_model = subpageHtml.pricing ? extractPricingModel(subpageHtml.pricing) : 'unknown';
  }
  if (extractors.includes('pricing_min') || extractors.includes('free_trial')) {
    if (subpageHtml.pricing) {
      const details = extractPricingDetails(subpageHtml.pricing);
      if (extractors.includes('pricing_min')) out.pricing_min = details.pricing_min;
      if (extractors.includes('free_trial')) out.free_trial = details.free_trial;
    } else {
      if (extractors.includes('free_trial')) out.free_trial = false;
    }
  }

  // Careers-related extractors (share /careers HTML)
  if (extractors.includes('vacancies_count') || extractors.includes('hiring_roles')) {
    if (subpageHtml.careers) {
      const hiring = extractHiring(subpageHtml.careers);
      if (extractors.includes('vacancies_count')) out.vacancies_count = hiring.vacancies_count;
      if (extractors.includes('hiring_roles')) {
        out.hiring_roles = {
          marketing: hiring.has_marketing,
          engineering: hiring.has_engineering,
          sales: hiring.has_sales,
        };
      }
    } else {
      if (extractors.includes('vacancies_count')) out.vacancies_count = 0;
      if (extractors.includes('hiring_roles')) {
        out.hiring_roles = { marketing: false, engineering: false, sales: false };
      }
    }
  }

  // Single-extractor subpages
  if (extractors.includes('integrations')) {
    out.integrations = subpageHtml.integrations ? extractIntegrations(subpageHtml.integrations) : [];
  }
  if (extractors.includes('founded_year')) {
    out.founded_year = subpageHtml.about ? extractFoundedYear(subpageHtml.about) : undefined;
  }
  if (extractors.includes('team_size')) {
    out.team_size = subpageHtml.about ? extractTeamSize(subpageHtml.about) : 0;
  }
  if (extractors.includes('blog_last_post')) {
    out.blog_last_post = subpageHtml.blog ? extractBlogLastPost(subpageHtml.blog) : undefined;
  }

  return out;
}
