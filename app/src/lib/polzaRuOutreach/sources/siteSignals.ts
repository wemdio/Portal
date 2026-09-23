/**
 * Факты с сайта компании: B2B-продукт, несколько продуктов и регионов,
 * партнёрская/дилерская программа, свежие события из новостей.
 *
 * Обход ограничен: главная и до шести разделов, найденных по ссылкам главной
 * (продукты/услуги/решения/отрасли/партнёрам/дилерам/новости/география).
 * Модель возвращает факты с дословной цитатой и адресом страницы; код
 * сверяет каждую цитату с текстом именно этой страницы. Событие без даты на
 * странице не считается свежим (SOURCE_CONNECTORS §10), а «мы продолжаем
 * расти» не подтверждает ни регион, ни продукт (SPEC §6.3).
 */

import { fetchSitePageHtml } from '@/lib/enrich/emailScraper';
import { acceptQuote, htmlToText } from '../evidence';
import { asBool, asString, asStringArray, callJson } from '../llm';
import type { Signal, SignalType } from '../types';

const PAGE_TIMEOUT_MS = 12_000;
const MAX_EXTRA_PAGES = 6;
const PAGE_TEXT_CHARS = 3500;

const SECTION_HINT =
  /(продук|услуг|решени|каталог|отрасл|направлен|партн[её]р|дилер|опт|франчайз|новост|пресс|события|блог|географ|регион|филиал|представительств|экспорт|кейсы|проекты|products?|services?|solutions?|industr|partners?|dealers?|wholesale|news|press|blog|cases|export|regions?)/i;

export type SiteMode = 'automation' | 'signals';

const AUTOMATION_TYPES: SignalType[] = ['multiple_products', 'multiple_regions', 'partner_program'];
const EVENT_TYPES: SignalType[] = [
  'product_launch', 'new_region', 'new_office', 'new_production', 'partner_program', 'dealer_search',
  'export_launch', 'new_case',
];

export interface SitePage {
  url: string;
  text: string;
}

export interface SiteAnalysis {
  reachable: boolean;
  isB2b: boolean;
  b2bQuote: string | null;
  b2bUrl: string | null;
  /** Что продаёт компания, 3–10 слов — только для гипотезы сегментов. */
  productSummary: string | null;
  /** Кому продаёт — только если прямо написано на сайте (цитата сверена). */
  customerQuote: string | null;
  tags: string[];
  facts: Signal[];
  excludedCategory: string | null;
}

const EMPTY: SiteAnalysis = {
  reachable: false,
  isB2b: false,
  b2bQuote: null,
  b2bUrl: null,
  productSummary: null,
  customerQuote: null,
  tags: [],
  facts: [],
  excludedCategory: null,
};

function sameSiteLinks(html: string, base: URL): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 40) {
    let url: URL;
    try {
      url = new URL(m[1], base);
    } catch {
      continue;
    }
    if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?)$/i.test(url.pathname)) continue;
    const anchor = m[2].replace(/<[^>]+>/g, ' ');
    if (!SECTION_HINT.test(url.pathname) && !SECTION_HINT.test(anchor)) continue;
    const key = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    if (seen.has(key) || key === `${base.origin}`) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export async function crawlSite(website: string): Promise<SitePage[]> {
  let base: URL;
  try {
    base = new URL(/^https?:\/\//.test(website) ? website : `https://${website}`);
  } catch {
    return [];
  }
  const homeHtml = await fetchSitePageHtml(base.toString(), { timeout: PAGE_TIMEOUT_MS });
  if (!homeHtml) return [];
  const pages: SitePage[] = [{ url: base.toString(), text: htmlToText(homeHtml) }];
  const links = sameSiteLinks(homeHtml, base).slice(0, MAX_EXTRA_PAGES);
  const fetched = await Promise.all(
    links.map(async (url) => {
      const html = await fetchSitePageHtml(url, { timeout: PAGE_TIMEOUT_MS });
      return html ? { url, text: htmlToText(html) } : null;
    }),
  );
  for (const page of fetched) if (page && page.text.length > 50) pages.push(page);
  return pages;
}

const MONTHS: Record<string, number> = {
  январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
};

/** Дата из дословного фрагмента страницы: «12.09.2026», «2026-09-12», «12 сентября 2026». */
export function parseRuDate(text: string): string | null {
  const dmy = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const words = text.toLowerCase().match(/(\d{1,2})\s+([а-я]+)\s+(\d{4})/);
  if (words) {
    const key = Object.keys(MONTHS).find((k) => words[2].startsWith(k));
    if (key) return `${words[3]}-${String(MONTHS[key]).padStart(2, '0')}-${words[1].padStart(2, '0')}`;
  }
  return null;
}

function buildPrompt(mode: SiteMode, tagVocabulary: string[]): string {
  const types = mode === 'automation' ? AUTOMATION_TYPES : EVENT_TYPES;
  return `Ты разбираешь страницы сайта российской компании для B2B-аутрича. Верни СТРОГИЙ JSON:
{
  "is_b2b": boolean,                 // продаёт организациям (не только частным лицам)
  "b2b_quote": string,               // ДОСЛОВНАЯ цитата со страницы, подтверждающая продажи организациям; "" если нет
  "b2b_url": string,                 // адрес страницы с этой цитатой
  "product_summary": string,         // что продаёт компания, 3–10 слов, по-русски; "" если непонятно
  "customer_quote": string,          // ДОСЛОВНАЯ цитата: кому продаёт (отрасли, тип клиентов); "" если прямо не написано
  "excluded_category": string,       // "recruitment_agency" | "leadgen_agency" | "b2c_only" | "marketplace" | "" — только если явно
  "tags": string[],                  // теги отрасли/продукта ТОЛЬКО из словаря: ${JSON.stringify(tagVocabulary)}
  "facts": [                         // ${mode === 'automation' ? 'признаки для параллельных кампаний' : 'коммерческие события'}
    { "type": ${JSON.stringify(types.join(' | '))},
      "quote": string,               // ДОСЛОВНАЯ цитата со страницы, до 30 слов
      "url": string,                 // адрес страницы, откуда цитата
      "date_text": string }          // ДОСЛОВНЫЙ фрагмент с датой события со страницы; "" если даты нет
  ]
}
Типы фактов:
- multiple_products: на сайте несколько отдельных продуктов/линеек/услуг для бизнеса (цитата перечисляет их);
- multiple_regions: прямо перечислены регионы/страны продаж, филиалы или представительства;
- partner_program: действующий раздел/призыв для партнёров, дилеров, оптовиков;
- product_launch: запуск нового продукта; new_region: выход в новый регион; new_office: открытие офиса/филиала;
- new_production: запуск производства/мощности; dealer_search: ищут дилеров/дистрибьюторов;
- export_launch: начало экспорта; new_case: новый проект/кейс с конкретным клиентом.
Жёсткие правила:
- Каждая цитата копируется символ в символ из текста страницы. Не перефразируй и не переводи.
- «Мы растём», «динамично развиваемся» — НЕ факт.
- Не угадывай: лучше пустая строка и пустой список, чем догадка.`;
}

export async function analyzeSite(
  website: string,
  mode: SiteMode,
  tagVocabulary: string[],
  preloaded?: SitePage[],
): Promise<SiteAnalysis> {
  const pages = preloaded ?? (await crawlSite(website));
  if (!pages.length) return EMPTY;

  const user = pages
    .map((p) => `=== СТРАНИЦА ${p.url} ===\n${p.text.slice(0, PAGE_TEXT_CHARS)}`)
    .join('\n\n');
  const raw = await callJson(buildPrompt(mode, tagVocabulary), user, `site-${mode}`, 1500);

  const pageByUrl = new Map(pages.map((p) => [p.url.replace(/\/+$/, ''), p]));
  const allText = pages.map((p) => p.text).join('\n');
  const findPage = (url: string) => pageByUrl.get(asString(url).replace(/\/+$/, ''));

  const b2bPage = findPage(asString(raw.b2b_url));
  const b2bQuote = acceptQuote(b2bPage?.text ?? allText, asString(raw.b2b_quote));
  const allowedTypes = new Set<SignalType>(mode === 'automation' ? AUTOMATION_TYPES : EVENT_TYPES);
  const vocabulary = new Set(tagVocabulary);

  const facts: Signal[] = [];
  for (const item of Array.isArray(raw.facts) ? raw.facts : []) {
    const f = (item ?? {}) as Record<string, unknown>;
    const type = asString(f.type) as SignalType;
    if (!allowedTypes.has(type)) continue;
    const page = findPage(asString(f.url));
    if (!page) continue;
    const quote = acceptQuote(page.text, asString(f.quote));
    if (!quote) continue;
    const dateText = asString(f.date_text);
    const date = dateText && acceptQuote(page.text, dateText, 12) ? parseRuDate(dateText) : null;
    if (facts.some((x) => x.type === type)) continue;
    facts.push({ type, source: 'site_news', title: quote, date, url: page.url, quote, level: 'A' });
  }

  const excluded = asString(raw.excluded_category);
  return {
    reachable: true,
    isB2b: asBool(raw.is_b2b) && Boolean(b2bQuote),
    b2bQuote,
    b2bUrl: b2bQuote ? (b2bPage?.url ?? pages[0].url) : null,
    productSummary: asString(raw.product_summary).slice(0, 120) || null,
    customerQuote: acceptQuote(allText, asString(raw.customer_quote)),
    tags: asStringArray(raw.tags).map((t) => t.toLowerCase()).filter((t) => vocabulary.has(t)),
    facts,
    excludedCategory: ['recruitment_agency', 'leadgen_agency', 'b2c_only', 'marketplace'].includes(excluded) ? excluded : null,
  };
}
