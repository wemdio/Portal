import { parse } from 'tldts';
import { FEDERAL_DISTRICTS } from '@/lib/companiesSearch/regions';
import { normalizeVeWebsiteHost } from './collectionIdentity';
import { veGeographyNameKey } from './collectionGeography';
import { VE_TWO_GIS_ROW_FIELD, VE_TWO_GIS_SOURCE_DETAIL } from './twoGisMarker';
import type { VeUnifiedRow } from './stages/baseCollect';

/**
 * Сайт и строка карточки 2ГИС (план 26.10, R3 «Строка», «Фильтры»). Чистый модуль:
 * без pg, supabase и node:crypto — его берут и VE2, и сборщик Ш5 (ve2.card_features),
 * и офлайн-проверки, поэтому ключ домена, вид сайта и строка не расходятся.
 */

/**
 * Конструкторы сайтов: компания на них — это весь поддомен, а не общий домен
 * платформы (иначе правило «меньше 10 карточек на домен» выбросило бы всех её
 * клиентов, а журнал линии пустил бы один сайт tilda.ws на гипотезу).
 * Затравка — COMPANY_SITE_BUILDERS (src/lib/enrich/companySiteAlias.ts) и замер
 * 26.10 (500 доменов; scratchpad norm.py). Окончательный список — по отчёту Ш5
 * (004_ve2_features.sql, шаг report: домены с наибольшим числом поддоменов).
 */
export const VE_TWO_GIS_SITE_BUILDERS: readonly string[] = [
  // COMPANY_SITE_BUILDERS.
  'wixsite.com', 'squarespace.com', 'webflow.io', 'tilda.ws', 'weebly.com',
  'wordpress.com', 'godaddysites.com', 'myshopify.com', 'business.site',
  // Замер 26.10: русские конструкторы и сайты школ и садов на общих платформах.
  'tilda.website', 'ucoz.ru', 'ucoz.net', 'ucoz.com', 'ucoz.org', 'ucoz.ua', 'ucoz.site', 'ucoz.club', 'at.ua',
  'my1.ru', '3dn.ru', 'narod.ru', 'narod2.ru', 'nethouse.ru', 'blogspot.com', 'turbo.site', 'webnode.ru',
  'jimdofree.com', 'mya5.ru', 'ukit.me', 'ukit.site', 'tb.ru', 'sites.google.com', 'mskobr.ru', 'edusite.ru',
  'gosuslugi.ru', 'tvoysadik.ru', 'tvoyashkola.ru', 'okis.ru', 'umi.ru', 'flexbe.online', 'nubex.ru', 'clients.site',
];

/** Хосты только для 2ГИС: ссылки-заглушки справочника, не сайты компаний. Общий список
 * isVeNonOfficialWebsiteHost (relevanceEvidence.ts) вызывающие проверяют отдельно. */
export const VE_TWO_GIS_CATALOG_HOSTS: readonly string[] = ['2gis.biz', 'onelink.me', 'info2gis.tilda.ws'];

const onHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const LABELS = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Хост сайта: punycode, без схемы, www, пути и запроса; несколько сайтов — первый годный.
 * Повтор «www.www.» (опечатка справочника) снимается весь: хост в ve2 — без www.
 */
export function veTwoGisWebsiteHost(raw: unknown): string | null {
  const host = normalizeVeWebsiteHost(raw).replace(/^(?:www\.)+/, '');
  return host && LABELS.test(host) ? host : null;
}

export type VeTwoGisSiteKind = 'own' | 'builder' | 'catalog';

/** Вид сайта: свой домен, поддомен конструктора или не сайт компании (корень платформы, ссылка справочника). */
export function veTwoGisSiteKind(raw: unknown): VeTwoGisSiteKind | null {
  const host = veTwoGisWebsiteHost(raw);
  if (!host) return null;
  if (VE_TWO_GIS_CATALOG_HOSTS.some((domain) => onHost(host, domain))) return 'catalog';
  const builder = VE_TWO_GIS_SITE_BUILDERS.find((domain) => onHost(host, domain));
  if (builder) return host === builder ? 'catalog' : 'builder';
  const parsed = parse(host, { allowPrivateDomains: true });
  return parsed.isIp || !parsed.domain ? null : 'own';
}

/**
 * Ключ домена для журнала линии и правила «меньше 10 карточек»: на конструкторе —
 * весь хост (компания — поддомен), иначе зарегистрированный домен по tldts.
 */
export function veTwoGisSiteDomain(raw: unknown): string | null {
  const host = veTwoGisWebsiteHost(raw);
  if (!host) return null;
  if (VE_TWO_GIS_SITE_BUILDERS.some((domain) => host !== domain && host.endsWith(`.${domain}`))) return host;
  const parsed = parse(host, { allowPrivateDomains: true });
  return parsed.isIp || !parsed.domain ? null : parsed.domain.toLowerCase();
}

/** Сайт строки: голый хост (читатель сайта начнёт с https); http — только если Ш5 нашёл, что работает лишь он. */
export function veTwoGisWebsite(host: string, scheme: 'https' | 'http'): string {
  return scheme === 'http' ? `http://${host}` : host;
}

/**
 * Название до первой запятой вне кавычек «», "", “” и „“ и скобок () и []:
 * «Ромашка, мебельная фабрика» → «Ромашка». Апострофы (' и ’) — не кавычки:
 * «О’КЕЙ, гипермаркет» → «О’КЕЙ». Пусто — всё название.
 */
export function veTwoGisCompanyName(name: unknown): string {
  const full = String(name ?? '').trim();
  let guillemets = 0, brackets = 0, quoted = false, curly = false;
  for (let index = 0; index < full.length; index += 1) {
    const char = full[index];
    if (char === '«') guillemets += 1;
    else if (char === '»') guillemets = Math.max(0, guillemets - 1);
    else if (char === '(' || char === '[') brackets += 1;
    else if (char === ')' || char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === '"') quoted = !quoted;
    else if (char === '“' || char === '”' || char === '„') curly = !curly;
    else if (char === ',' && !guillemets && !brackets && !quoted && !curly) return full.slice(0, index).trim() || full;
  }
  return full;
}

const REGION_NAMES = new Map(FEDERAL_DISTRICTS.flatMap((district) => district.regions)
  .map((region) => [region.code, region.name.replace(/^г\.\s*/u, '')] as const));

/** Название региона по коду FEDERAL_DISTRICTS (как в ve2.card_features.region_code). */
export function veTwoGisRegionName(code: string | null | undefined): string | null {
  return code ? REGION_NAMES.get(code) ?? null : null;
}

/** Адрес строки — только «город, регион» (без улицы, дома и индекса); повтор города и региона — один раз. */
export function veTwoGisAddress(city: unknown, regionCode: string | null | undefined): string {
  const seen = new Set<string>();
  return [String(city ?? '').trim(), veTwoGisRegionName(regionCode) ?? ''].filter((part) => {
    const partKey = veGeographyNameKey(part);
    if (!part || seen.has(partKey)) return false;
    seen.add(partKey);
    return true;
  }).join(', ');
}

/** Ключ города: тот же, что у географии брифа (collectionGeography); им же Ш5 пишет city_key. */
export const veTwoGisCityKey = (city: string) => veGeographyNameKey(city);

/** Карточка, как её отдаёт страница (twoGisPage.ts): телефона, почты и сырого сайта карточки в ней нет. */
export interface VeTwoGisCardRow {
  card_id: string;
  registrable_domain: string;
  host: string;
  site_scheme: 'https' | 'http';
  region_code: string | null;
  name: string;
  city_name: string;
}

/** Приватная метка строки: только ссылка на карточку, полного адреса в строке нет. */
export interface VeTwoGisRowMarker { card_id: string; snapshot_id: number }
export type VeTwoGisRow = VeUnifiedRow & { _ve_two_gis: VeTwoGisRowMarker };

/** Карточка → строка VE2: название до запятой, сайт, «город, регион», метка; телефона, почты и рубрики нет. */
export function mapTwoGisRow(card: VeTwoGisCardRow, snapshotId: number): VeTwoGisRow {
  const host = veTwoGisWebsiteHost(card.host);
  return {
    company: veTwoGisCompanyName(card.name),
    website: host ? veTwoGisWebsite(host, card.site_scheme === 'http' ? 'http' : 'https') : '',
    email: '', phone: '', vacancy_title: '',
    address: veTwoGisAddress(card.city_name, card.region_code),
    category: '', employees: '', revenue: '', inn: '',
    source_detail: VE_TWO_GIS_SOURCE_DETAIL,
    [VE_TWO_GIS_ROW_FIELD]: { card_id: card.card_id, snapshot_id: snapshotId },
  };
}
