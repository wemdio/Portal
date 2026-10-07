/**
 * Каталоги участников выставок: список экспонентов и карточка с сайтом.
 *
 * Площадки — в exhibitionCatalogs.ts. Обе отдают HTML без открытого API:
 *  - mvk: в списке у карточки id (data-exib / data-item), имя и страна; сайт и
 *    почта — в JSON карточки (exhibitorpopup.aspx или exhibitorview.aspx —
 *    у двух шаблонов сайтов МВК разные). Листание — ASP.NET-постбэк: POST той
 *    же страницы с __VIEWSTATE и номером страницы, с куками сессии.
 *  - expodat: /expositions/exposition/<id>?limit=100&start=N, сайт — в
 *    /companies/company/<id>.html.
 *
 * Вежливость: запросы строго по одному, пауза между ними, таймаут, повтор
 * один раз. Ошибка списка бросается (синк пропускает выставку целиком, ничего
 * не удаляя), ошибка карточки — null (компания догонится на следующем синке).
 */

import { htmlToText } from '../evidence';
import { normalizeDomain, siteUrl } from '../company';
import type { ExhibitionCatalog } from './exhibitionCatalogs';

const USER_AGENT = 'Mozilla/5.0 (Polza Portal)';
const TIMEOUT_MS = 25_000;
const DEFAULT_DELAY_MS = 800;
/** Предохранители: каталоги крупнейших выставок — до ~2 000 участников. */
const MAX_MVK_PAGES = 150;
const EXPODAT_PAGE = 100;
const MAX_EXPODAT_PAGES = 40;

/** Экспонент из списка — до карточки. */
export interface ListedExhibitor {
  /** `mvk:115406` / `expodat:118428` — ключ строки при повторных синках. */
  sourceKey: string;
  id: string;
  name: string;
  country: string | null;
  stand: string | null;
  description: string | null;
  cardUrl: string;
}

export interface ExhibitorCard {
  name: string | null;
  website: string | null;
  email: string | null;
  country: string | null;
  region: string | null;
  description: string | null;
}

export interface CatalogListing {
  exhibitors: ListedExhibitor[];
  /** mvk: год в заголовке «Список участников 2026»; expodat — год события. */
  catalogYear: number | null;
}

/** Последовательный fetch с паузой, таймаутом и куками — один на выставку. */
export class PoliteFetcher {
  private lastAt = 0;
  private readonly cookies = new Map<string, string>();

  constructor(private readonly delayMs = DEFAULT_DELAY_MS) {}

  async text(url: string, init: { method?: 'GET' | 'POST'; form?: Record<string, string>; accept?: string } = {}): Promise<string> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = this.lastAt + this.delayMs * (attempt + 1) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
      try {
        const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: init.accept ?? 'text/html,application/json;q=0.9,*/*;q=0.8' };
        if (this.cookies.size) headers.Cookie = Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join('; ');
        let body: string | undefined;
        if (init.form) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          body = new URLSearchParams(init.form).toString();
        }
        const res = await fetch(url, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
        for (const line of res.headers.getSetCookie?.() ?? []) {
          const m = line.match(/^([^=;\s]+)=([^;]*)/);
          if (m) this.cookies.set(m[1], m[2]);
        }
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`HTTP ${res.status} ${url}`);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        return await res.text();
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && /^HTTP 4\d\d/.test(err.message)) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`fetch failed: ${url}`);
  }
}

// ── общие мелочи ───────────────────────────────────────────────────────────

function clean(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = htmlToText(raw).replace(/\s+/g, ' ').trim();
  return text && text !== '-' ? text : null;
}

function cut(text: string | null, max = 600): string | null {
  return text && text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Первый годный домен из «a.ru; www.b.ru http://c.ru». */
export function pickWebsite(raw: string | null | undefined): string | null {
  for (const part of String(raw ?? '').split(/[\s;,]+/)) {
    const domain = normalizeDomain(part);
    if (domain) return siteUrl(domain);
  }
  return null;
}

function pickEmail(raw: string | null | undefined): string | null {
  for (const part of String(raw ?? '').split(/[\s;,]+/)) {
    const email = part.replace(/^mailto:/i, '').trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return email;
  }
  return null;
}

const RUSSIA = /^(россия|российская федерация|рф|russia|russian federation)$/i;
const RU_TLD = /\.(ru|su|рф|xn--p1ai)$/i;

/**
 * Иностранец ли: страна известна и не Россия, и сайт не в .ru/.su/.рф.
 * Российский дистрибьютор иностранного бренда (страна «Китай», сайт .ru) остаётся.
 */
export function isForeignExhibitor(country: string | null, website: string | null): boolean {
  const c = (country ?? '').trim();
  if (!c || RUSSIA.test(c)) return false;
  const domain = normalizeDomain(website);
  return !(domain && RU_TLD.test(domain));
}

// ── МВК ────────────────────────────────────────────────────────────────────

const MVK_CARD = /data-exib='(\d+)'|data-item="(\d+)"/g;

/** Карточки одной страницы списка МВК: оба шаблона сайтов. */
export function parseMvkListPage(html: string, listUrl: string): ListedExhibitor[] {
  const out: ListedExhibitor[] = [];
  const matches = Array.from(html.matchAll(MVK_CARD));
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const id = m[1] ?? m[2];
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(html.length, (m.index ?? 0) + 6000);
    const chunk = html.slice(m.index, end);
    const name = clean(chunk.match(/class="h6 mb-1">([\s\S]*?)<\/div>/)?.[1]);
    if (!name) continue;
    out.push({
      sourceKey: `mvk:${id}`,
      id,
      name,
      country: clean(chunk.match(/<small class="d-block mb-\d">([^<]*)<\/small>/)?.[1]),
      stand: clean(chunk.match(/stand-number">([\s\S]*?)<\/span>/)?.[1]),
      description: null,
      cardUrl: listUrl,
    });
  }
  return out;
}

/** Год списка: из <title>/<h1>, иначе самый частый в меню «Список участников 20XX». */
export function parseMvkListYear(html: string): number | null {
  const head = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const h1 = html.match(/<h1[^>]*>([^<]*Список участников[^<]*)<\/h1>/i)?.[1] ?? '';
  const direct = `${head} ${h1}`.match(/Список участников[^<]*?(20\d\d)/i)?.[1];
  if (direct) return Number(direct);
  const counts = new Map<number, number>();
  for (const m of html.matchAll(/Список участников (20\d\d)/g)) counts.set(Number(m[1]), (counts.get(Number(m[1])) ?? 0) + 1);
  let best: number | null = null;
  for (const [year, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = year;
  return best;
}

function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"/g)) {
    out[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  }
  return out;
}

/** Адрес JSON-карточки: тот, что зовёт скрипт страницы; иначе по шаблону. */
function mvkCardEndpoint(html: string, listUrl: string): string {
  const url = new URL(listUrl);
  const fromScript = html.match(/["'`](\/[^"'`]*?exhibitor(?:popup|view)\.aspx\?id=)/)?.[1];
  if (fromScript) return `${url.origin}${fromScript}`;
  const base = url.pathname.replace(/\.aspx$/i, '');
  return `${url.origin}${base}/${html.includes('data-exib=') ? 'exhibitorpopup' : 'exhibitorview'}.aspx?id=`;
}

async function listMvk(cfg: ExhibitionCatalog, http: PoliteFetcher): Promise<CatalogListing & { cardEndpoint: string }> {
  let html = await http.text(cfg.catalogUrl);
  const catalogYear = parseMvkListYear(html);
  const cardEndpoint = mvkCardEndpoint(html, cfg.catalogUrl);
  const byKey = new Map<string, ListedExhibitor>();
  for (const e of parseMvkListPage(html, cfg.catalogUrl)) byKey.set(e.sourceKey, e);
  // Первая цель пейджера: у шаблона с мобильной версией их две, номера страниц общие.
  const pager = html.match(/__doPostBack\(&#39;([^&]*pagerElem)&#39;/)?.[1];
  for (let page = 2; pager && page <= MAX_MVK_PAGES; page++) {
    const form = { ...hiddenFields(html), __EVENTTARGET: pager, __EVENTARGUMENT: String(page) };
    const next = await http.text(cfg.catalogUrl, { method: 'POST', form });
    const items = parseMvkListPage(next, cfg.catalogUrl);
    const fresh = items.filter((e) => !byKey.has(e.sourceKey));
    // За последней страницей пейджер отдаёт первую — новых id нет, конец.
    if (!fresh.length) break;
    for (const e of fresh) byKey.set(e.sourceKey, e);
    html = next;
  }
  return { exhibitors: Array.from(byKey.values()), catalogYear, cardEndpoint };
}

async function cardMvk(endpoint: string, e: ListedExhibitor, http: PoliteFetcher): Promise<ExhibitorCard> {
  const raw = await http.text(`${endpoint}${e.id}`, { accept: 'application/json' });
  const parsed = JSON.parse(raw) as unknown;
  const item = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
  if (!item) throw new Error(`пустая карточка ${e.sourceKey}`);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    name: clean(str(item.Name)),
    website: pickWebsite(str(item.Site)),
    email: pickEmail(str(item.Email)),
    country: clean(str(item.Country)),
    region: clean(str(item.Region)),
    description: cut(clean(str(item.Description))),
  };
}

// ── Expodat ────────────────────────────────────────────────────────────────

/** Карточки одной страницы списка экспозиции Expodat (оба шаблона: expodat.com и catalog.*). */
export function parseExpodatListPage(html: string, base: string): ListedExhibitor[] {
  const out: ListedExhibitor[] = [];
  const parts = html.split('<a href="/companies/company/');
  for (const part of parts.slice(1)) {
    const id = part.match(/^(\d+)/)?.[1];
    // Ссылки на компании бывают и вне списка (спонсоры в подвале) — у них нет блока имени.
    if (!id || !/class="(?:comp_name|exh_name)/.test(part)) continue;
    const name =
      clean(part.match(/class="(?:comp_name|exh_name)">([\s\S]*?)<\/div>/)?.[1]?.replace(/<img[^>]*>/g, '')) ??
      clean(part.match(/^[^"]*"\s+title="([^"]*)"/)?.[1]);
    if (!name) continue;
    out.push({
      sourceKey: `expodat:${id}`,
      id,
      name,
      country: clean(part.match(/class="img_country[^"]*"\s+title="([^"]*)"/)?.[1]),
      stand: clean(part.match(/Стенд:&nbsp;<b>([^<]*)<\/b>/)?.[1] ?? part.match(/class="stand_num[^"]*"\s+title="[^"]*?:\s*([^"]*)"/)?.[1]),
      description: cut(clean(part.match(/class="short_opis">([\s\S]*?)<\/div>/)?.[1])),
      cardUrl: `${base}/companies/company/${id}.html`,
    });
  }
  return out;
}

export function parseExpodatCard(html: string): ExhibitorCard {
  const site = html.match(/class="company_site">[\s\S]*?<a href="([^"]+)"/)?.[1] ?? null;
  const email = html.match(/class="company_email">[\s\S]*?href="mailto:([^"]+)"/)?.[1] ?? null;
  const country = html.match(/class="company_img_country">(?:<img[^>]*>)?\s*([^<]*)<\/div>/)?.[1] ?? null;
  const descBlock = html.match(/class="company_desc">([\s\S]*?)(?:class="wrap_rubr"|<div id="tab_)/)?.[1] ?? '';
  const desc = descBlock.match(/<p>([\s\S]*?)(?:<\/p>|<\/div>)/)?.[1] ?? null;
  return {
    name: clean(html.match(/class="company_site">[\s\S]*?title="([^"]*)"/)?.[1]),
    website: pickWebsite(site),
    email: pickEmail(email),
    country: clean(country),
    region: null,
    description: cut(clean(desc)),
  };
}

async function listExpodat(cfg: ExhibitionCatalog, http: PoliteFetcher): Promise<CatalogListing> {
  if (!cfg.expositionId) throw new Error(`${cfg.slug}: нет expositionId`);
  const base = cfg.catalogUrl.replace(/\/+$/, '');
  const byKey = new Map<string, ListedExhibitor>();
  for (let page = 0; page < MAX_EXPODAT_PAGES; page++) {
    const html = await http.text(`${base}/expositions/exposition/${cfg.expositionId}?limit=${EXPODAT_PAGE}&start=${page * EXPODAT_PAGE}`);
    const items = parseExpodatListPage(html, base);
    const fresh = items.filter((e) => !byKey.has(e.sourceKey));
    for (const e of fresh) byKey.set(e.sourceKey, e);
    // Конец — по сырым ссылкам, не по разобранным: безымянные заглушки «-» мы
    // отбрасываем, и неполная по разбору страница ещё не последняя (БИОТ: 96 из 246).
    const onPage = new Set(Array.from(html.matchAll(/href="\/companies\/company\/(\d+)/g), (m) => m[1])).size;
    if (onPage < EXPODAT_PAGE || !fresh.length) break;
  }
  return { exhibitors: Array.from(byKey.values()), catalogYear: Number(cfg.eventStart.slice(0, 4)) };
}

// ── вход ───────────────────────────────────────────────────────────────────

export interface CatalogSession {
  listing: CatalogListing;
  card(e: ListedExhibitor): Promise<ExhibitorCard>;
}

/** Список экспонентов выставки + загрузчик карточек той же сессии (куки, паузы). */
export async function openCatalog(cfg: ExhibitionCatalog, delayMs = DEFAULT_DELAY_MS): Promise<CatalogSession> {
  const http = new PoliteFetcher(delayMs);
  if (cfg.platform === 'mvk') {
    const { cardEndpoint, ...listing } = await listMvk(cfg, http);
    return { listing, card: (e) => cardMvk(cardEndpoint, e, http) };
  }
  const listing = await listExpodat(cfg, http);
  return { listing, card: async (e) => parseExpodatCard(await http.text(e.cardUrl)) };
}
