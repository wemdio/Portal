import 'server-only';

import {
  googleSearchDetailed,
  duckDuckGoSearchDetailed,
  type SearchResultItem,
} from '@/lib/parsers/searchScraper';
import type { ReputationCandidate, PrimarySource } from './scoring';

const SERP_DELAY_MS = 4_000;

const NEGATIVE_KEYWORDS_RU = [
  'мошенники', 'обман', 'кидают', 'лохотрон', 'развод', 'жалоба',
  'отзывы негативные', 'плохой сервис', 'не рекомендую', 'ужас',
  'скандал', 'суд', 'штраф', 'банкрот', 'арест', 'прокуратура',
  'фсб', 'мвд задерж', 'уголовное', 'возбужд',
];

const NEGATIVE_PLATFORMS = [
  'otzovik.com', 'irecommend.ru', 'flamp.ru', 'zoon.ru',
  'pravda-sotrudnikov.ru', 'antijob.net', 'glassdoor.com',
  'otzyvru.com', 'banki.ru/services/responses',
  'prodoctorov.ru', 'spr.ru',
];

function isNegativeResult(item: SearchResultItem): boolean {
  const text = `${item.title ?? ''} ${item.snippet ?? ''}`.toLowerCase();
  const link = (item.link ?? '').toLowerCase();

  for (const kw of NEGATIVE_KEYWORDS_RU) {
    if (text.includes(kw)) return true;
  }
  for (const platform of NEGATIVE_PLATFORMS) {
    if (link.includes(platform) && /отзыв|жалоб|негатив|плох|обман|развод|ужас/i.test(text)) {
      return true;
    }
  }
  return false;
}

export interface SerpScanResult {
  company: string;
  city: string | null;
  negativeCount: number;
  negativeItems: SearchResultItem[];
  totalResults: number;
}

async function freeSearch(query: string, num = 10): Promise<SearchResultItem[]> {
  try {
    const { results } = await googleSearchDetailed(query, num);
    if (results.length > 0) return results;
  } catch {
    // Google blocked — fall through to DDG
  }
  try {
    const { results } = await duckDuckGoSearchDetailed(query);
    return results;
  } catch {
    return [];
  }
}

/**
 * Scan Google/DDG SERP for brand reputation signals (free, no API key).
 * Queries: "[company] отзывы", "[company] жалобы".
 */
export async function scanBrandSerp(
  company: string,
  city: string | null,
): Promise<SerpScanResult> {
  const geo = city ? ` ${city}` : '';
  const queries = [
    `"${company}"${geo} отзывы`,
    `"${company}"${geo} жалобы`,
  ];

  const allItems: SearchResultItem[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < queries.length; i++) {
    const items = await freeSearch(queries[i], 10);
    for (const item of items) {
      const key = item.link.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        allItems.push(item);
      }
    }
    if (i < queries.length - 1) {
      await new Promise((r) => setTimeout(r, SERP_DELAY_MS));
    }
  }

  const negativeItems = allItems.filter(isNegativeResult);

  return {
    company,
    city,
    negativeCount: negativeItems.length,
    negativeItems,
    totalResults: allItems.length,
  };
}

export function serpResultToCandidate(
  jobId: string,
  scan: SerpScanResult,
): ReputationCandidate {
  return {
    id: crypto.randomUUID(),
    jobId,
    company: scan.company,
    city: scan.city,
    category: null,
    sourceMode: 'brand_serp',
    primarySource: 'serper' as PrimarySource,
    primarySourceUrl: scan.negativeItems[0]?.link ?? null,
    website: null,
    rating: 0,
    reviewsCount: 0,
    negativeReviews30d: 0,
    negativeReviews90d: 0,
    unansweredNegativeReviews: 0,
    negativeSerpResultsTop10: scan.negativeCount,
    issueThemes: extractThemes(scan.negativeItems),
    proofUrls: scan.negativeItems.map((i) => i.link).filter(Boolean).slice(0, 5),
    proofSnippets: scan.negativeItems.map((i) => i.snippet ?? '').filter(Boolean).slice(0, 5),
    collectedAt: new Date().toISOString(),
    secondSourceConfirmed: false,
  };
}

function extractThemes(items: SearchResultItem[]): string[] {
  const themes: string[] = [];
  const text = items.map((i) => `${i.title ?? ''} ${i.snippet ?? ''}`).join(' ').toLowerCase();

  const THEME_PATTERNS: [RegExp, string][] = [
    [/обман|мошенн|развод|кидал/i, 'мошенничество'],
    [/сервис|обслужив|грубость|хамство/i, 'плохой сервис'],
    [/качеств|бра[кг]|дефект/i, 'качество'],
    [/доставк|опоздан|сроки/i, 'сроки/доставка'],
    [/возврат|деньги|не верн/i, 'возврат средств'],
    [/зарплат|не плат|задерж.*зарплат/i, 'зарплата'],
    [/условия труда|переработк|увольн/i, 'условия труда'],
  ];

  for (const [re, label] of THEME_PATTERNS) {
    if (re.test(text)) themes.push(label);
  }
  return themes;
}
