/**
 * Новости о компании: Google News RSS по бренду, пять свежих заголовков в окне
 * свежести, один вызов LLM на компанию. Модель только классифицирует; цитата —
 * дословный заголовок, сверенный кодом (acceptQuote). Заголовок не про эту
 * компанию или не повод — отбрасывается.
 */

import { acceptQuote } from '../evidence';
import { asBool, asString, callJson } from '../llm';
import type { Signal, SignalType } from '../types';

const TIMEOUT_MS = 10_000;
const MAX_ITEMS = 5;

export interface NewsItem {
  title: string;
  link: string | null;
  date: string | null;
}

const NEWS_TYPES: Record<string, SignalType> = {
  investment: 'investment',
  product_launch: 'product_launch',
  new_region: 'new_region',
  new_office: 'new_office',
  new_production: 'new_production',
  contract_won: 'contract_won',
  export_launch: 'export_launch',
};

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, c: string) => String.fromCodePoint(Number(c)))
    .replace(/&#x([0-9a-f]+);/gi, (_, c: string) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decode(m[1]) : null;
}

/** RSS Google News → заголовки. Хвост « - Источник» у заголовка снимаем. */
export function parseNewsRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const raw = tag(block, 'title');
    if (!raw) continue;
    const source = tag(block, 'source');
    const title = source && raw.endsWith(` - ${source}`) ? raw.slice(0, -(source.length + 3)).trim() : raw;
    const pub = tag(block, 'pubDate');
    const d = pub ? new Date(pub) : null;
    out.push({ title, link: tag(block, 'link'), date: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null });
  }
  return out;
}

async function fetchNews(brand: string): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`"${brand}"`)}&hl=ru&gl=RU&ceid=RU:ru`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Polza Portal)' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Google News ответил HTTP ${res.status}`);
  return parseNewsRss(await res.text());
}

const SYSTEM = `Ты классифицируешь новостные заголовки о российской компании для B2B-аутрича. Верни СТРОГИЙ JSON:
{"items":[{"n":number,"about_company":boolean,"type":string}]}
type — одно из: "investment" (компания получила инвестиции/раунд), "product_launch" (запустила продукт/сервис), "new_region" (вышла в новый регион/город), "new_office" (открыла офис/филиал/точку), "new_production" (запустила производство/завод/цех), "contract_won" (заключила крупный контракт/выиграла тендер), "export_launch" (вышла на экспорт), "none" (иное: отчётность, суды, кадровые новости, реклама, рейтинг).
about_company = true только если заголовок именно про эту компанию, а не про тёзку или отрасль. Не угадывай.`;

export async function findNewsSignals(brand: string, freshnessDays: number): Promise<Signal[]> {
  if (brand.replace(/[^\p{L}\d]/gu, '').length < 4) return [];
  const since = Date.now() - freshnessDays * 86_400_000;
  const items = (await fetchNews(brand))
    .filter((it) => it.date && new Date(it.date).getTime() >= since)
    .slice(0, MAX_ITEMS);
  if (!items.length) return [];

  const user = [`КОМПАНИЯ: ${brand}`, '', ...items.map((it, i) => `${i + 1}. ${it.title}`)].join('\n');
  const raw = await callJson(SYSTEM, user, 'news', 400);
  const verdicts = Array.isArray(raw.items) ? (raw.items as Array<Record<string, unknown>>) : [];
  const out: Signal[] = [];
  for (const v of verdicts) {
    const item = items[Number(v.n) - 1];
    const type = NEWS_TYPES[asString(v.type)];
    if (!item || !type || !asBool(v.about_company)) continue;
    const quote = acceptQuote(item.title, item.title);
    if (!quote) continue;
    out.push({ type, source: 'news', title: item.title, date: item.date, url: item.link, quote, level: 'A', meta: { news: true } });
  }
  return out;
}
