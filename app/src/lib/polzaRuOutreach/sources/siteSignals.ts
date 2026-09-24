/**
 * Разбор сайта компании — один обход и один вызов LLM на компанию.
 *
 * Что достаём (всё с дословной цитатой, которую код сверяет со страницей):
 *  - B2B-продажи и что компания продаёт, кому продаёт;
 *  - бренд так, как он написан на сайте (для обращения в письме);
 *  - исключения: кадровое агентство, лидген-конкурент, B2C-only, маркетплейс;
 *  - события сайта: новый продукт/регион/офис/производство, экспорт, кейс,
 *    партнёрская или дилерская программа. Событие без даты не свежее;
 *  - ЦА-балл 0–10 с причиной — насколько компания похожа на клиента Polza;
 *  - отраслевую группу для роутера кейсов.
 * Отдельно, без LLM: счётчик Яндекс.Директа / рекламные пиксели на главной —
 * только баллы скоринга, в письмо не попадают.
 */

import { fetchSitePageHtml } from '@/lib/enrich/emailScraper';
import { detectSignals } from '@/lib/enrich/signalDetector';
import { acceptQuote, htmlToText } from '../evidence';
import { asBool, asString, callJson } from '../llm';
import { INDUSTRY_GROUPS, type IndustryGroup, type Signal, type SignalType } from '../types';

const PAGE_TIMEOUT_MS = 12_000;
const MAX_EXTRA_PAGES = 6;
const PAGE_TEXT_CHARS = 3500;

const SECTION_HINT =
  /(продук|услуг|решени|каталог|отрасл|направлен|партн[её]р|дилер|опт|франчайз|новост|пресс|события|блог|географ|регион|филиал|представительств|экспорт|кейсы|проекты|о-компании|about|products?|services?|solutions?|industr|partners?|dealers?|wholesale|news|press|blog|cases|export|regions?)/i;

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
  brand: string | null;
  isB2b: boolean;
  b2bQuote: string | null;
  productSummary: string | null;
  customerQuote: string | null;
  excludedCategory: string | null;
  taScore: number;
  taReason: string | null;
  industryGroup: IndustryGroup | null;
  hasAdPixel: boolean;
  facts: Signal[];
}

export const EMPTY_SITE: SiteAnalysis = {
  reachable: false,
  brand: null,
  isB2b: false,
  b2bQuote: null,
  productSummary: null,
  customerQuote: null,
  excludedCategory: null,
  taScore: 0,
  taReason: null,
  industryGroup: null,
  hasAdPixel: false,
  facts: [],
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
    if (seen.has(key) || key === base.origin) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export async function crawlSite(website: string): Promise<{ pages: SitePage[]; homeHtml: string | null }> {
  let base: URL;
  try {
    base = new URL(/^https?:\/\//.test(website) ? website : `https://${website}`);
  } catch {
    return { pages: [], homeHtml: null };
  }
  const homeHtml = await fetchSitePageHtml(base.toString(), { timeout: PAGE_TIMEOUT_MS });
  if (!homeHtml) return { pages: [], homeHtml: null };
  const pages: SitePage[] = [{ url: base.toString(), text: htmlToText(homeHtml) }];
  const links = sameSiteLinks(homeHtml, base).slice(0, MAX_EXTRA_PAGES);
  const fetched = await Promise.all(
    links.map(async (url) => {
      const html = await fetchSitePageHtml(url, { timeout: PAGE_TIMEOUT_MS });
      return html ? { url, text: htmlToText(html) } : null;
    }),
  );
  for (const page of fetched) if (page && page.text.length > 50) pages.push(page);
  return { pages, homeHtml };
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

/** Портрет клиента Polza для ЦА-балла (как ta_scoring конструктора баз, но с брифом Polza). */
const POLZA_ICP_BRIEF = `Клиент Polza Agency — российская компания, которая продаёт продукт или услугу ОРГАНИЗАЦИЯМ (B2B):
понятный продукт и достаточный чек, чтобы окупать холодные продажи; несколько различимых сегментов
будущих клиентов; есть кому обрабатывать входящие заявки. Лучше всего подходят: IT и SaaS, производство
и оборудование, дистрибуция, логистика, B2B-услуги, агентства. Не подходят: розница и продажи только
частным лицам, общепит и услуги для населения, кадровые агентства, агентства лидогенерации и
колл-центры продаж, маркетплейсы и агрегаторы, компании без понятного продукта.`;

const SYSTEM = `Ты разбираешь страницы сайта российской компании для B2B-аутрича Polza Agency. Верни СТРОГИЙ JSON:
{
  "brand": string,              // название компании ДОСЛОВНО как на сайте (без ООО/АО); "" если не видно
  "is_b2b": boolean,            // продаёт организациям
  "b2b_quote": string,          // ДОСЛОВНАЯ цитата, подтверждающая продажи организациям; ""
  "product_summary": string,    // что продаёт компания, 3–10 слов, по-русски; ""
  "customer_quote": string,     // ДОСЛОВНАЯ цитата: кому продаёт (отрасли, тип клиентов); "" если прямо не написано
  "excluded_category": string,  // "recruitment_agency" | "leadgen_agency" | "b2c_only" | "marketplace" | "" — только если явно
  "ta_score": number,           // 0–10: насколько компания похожа на клиента Polza (портрет ниже). Будь строг: большинство 3–6; мало данных — не выше 5
  "ta_reason": string,          // одна фраза до 150 символов, почему такой балл
  "industry_group": string,     // одна из ${JSON.stringify(INDUSTRY_GROUPS)} или ""
  "facts": [                    // коммерческие события и программы на сайте
    { "type": ${JSON.stringify(EVENT_TYPES.join(' | '))},
      "quote": string,          // ДОСЛОВНАЯ цитата со страницы, до 30 слов
      "url": string,            // адрес страницы с цитатой
      "date_text": string }     // ДОСЛОВНЫЙ фрагмент с датой события; "" если даты нет
  ]
}
Портрет клиента Polza:
${POLZA_ICP_BRIEF}
Группы отраслей: it_saas — SaaS, IT, автоматизация; manufacturing — производство, оборудование, стройка;
hr_education — HR, рекрутинговые сервисы, обучение; horeca — HoReCa, локальные сети; auto_logistics —
маркетплейсы, авто, логистика; digital_agency — digital, event, маркетинг, продакшн, агентства.
Типы фактов: product_launch — новый продукт; new_region — выход в новый регион; new_office — новый офис/филиал;
new_production — запуск производства/мощности; partner_program — действующий раздел для партнёров/дилеров/оптовиков;
dealer_search — ищут дилеров/дистрибьюторов; export_launch — начало экспорта; new_case — новый проект с конкретным клиентом.
Жёсткие правила: цитаты и бренд копируются символ в символ со страницы; «мы растём» — не факт; не угадывай.`;

export async function analyzeSite(website: string): Promise<SiteAnalysis> {
  const { pages, homeHtml } = await crawlSite(website);
  if (!pages.length) return EMPTY_SITE;
  const hasAdPixel = homeHtml ? detectSignals(homeHtml).some((s) => s.category === 'ad_pixel') : false;

  const user = pages.map((p) => `=== СТРАНИЦА ${p.url} ===\n${p.text.slice(0, PAGE_TEXT_CHARS)}`).join('\n\n');
  const raw = await callJson(SYSTEM, user, 'site', 1600);

  const allText = pages.map((p) => p.text).join('\n');
  const pageByUrl = new Map(pages.map((p) => [p.url.replace(/\/+$/, ''), p]));
  const findPage = (url: string) => pageByUrl.get(asString(url).replace(/\/+$/, ''));

  const facts: Signal[] = [];
  for (const item of Array.isArray(raw.facts) ? raw.facts : []) {
    const f = (item ?? {}) as Record<string, unknown>;
    const type = asString(f.type) as SignalType;
    if (!EVENT_TYPES.includes(type) || facts.some((x) => x.type === type)) continue;
    const page = findPage(asString(f.url));
    if (!page) continue;
    const quote = acceptQuote(page.text, asString(f.quote));
    if (!quote) continue;
    const dateText = asString(f.date_text);
    const date = dateText && acceptQuote(page.text, dateText, 12) ? parseRuDate(dateText) : null;
    facts.push({ type, source: 'site_news', title: quote, date, url: page.url, quote, level: 'A' });
  }

  const brandRaw = asString(raw.brand).replace(/^[«"]|[»"]$/g, '');
  const brand = brandRaw && brandRaw.length <= 60 && allText.toLowerCase().includes(brandRaw.toLowerCase()) ? brandRaw : null;
  const excluded = asString(raw.excluded_category);
  const group = asString(raw.industry_group) as IndustryGroup;
  const b2bQuote = acceptQuote(allText, asString(raw.b2b_quote));
  const ta = Number(raw.ta_score);
  return {
    reachable: true,
    brand,
    isB2b: asBool(raw.is_b2b) && Boolean(b2bQuote),
    b2bQuote,
    productSummary: asString(raw.product_summary).slice(0, 120) || null,
    customerQuote: acceptQuote(allText, asString(raw.customer_quote)),
    excludedCategory: ['recruitment_agency', 'leadgen_agency', 'b2c_only', 'marketplace'].includes(excluded) ? excluded : null,
    taScore: Number.isFinite(ta) ? Math.max(0, Math.min(10, Math.round(ta))) : 0,
    taReason: asString(raw.ta_reason).slice(0, 150) || null,
    industryGroup: INDUSTRY_GROUPS.includes(group) ? group : null,
    hasAdPixel,
    facts,
  };
}
