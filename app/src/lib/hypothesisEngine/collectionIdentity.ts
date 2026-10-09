/**
 * «ТА ЖЕ КОМПАНИЯ» И «ТОТ ЖЕ АДРЕС» — ключи, по которым сборка узнаёт, что
 * компания или ящик уже лежат в ДРУГОЙ базе того же проекта. Чистый модуль:
 * без БД и без состояния. Идея — у V2 (verticalEngineV2/collectionIdentity.ts),
 * код написан заново: движки друг друга не импортируют.
 *
 * ТРИ КЛЮЧА:
 *  1. ИМЯ — normalizeCompanyForDedup, перенесена сюда из stages/baseCollect.ts
 *     ДОСЛОВНО (там остался реэкспорт, все прежние импорты работают). Правило
 *     совпадения по имени не менялось ни в одну сторону: где оно было, там и
 *     осталось, нового слияния по одному имени нет.
 *  2. СОБСТВЕННЫЙ ДОМЕН — heCompanySiteIdentity: хост сайта (как раньше) плюс
 *     РЕГИСТРИРУЕМЫЙ домен (eTLD+1 по публичному списку суффиксов, tldts с
 *     приватными суффиксами). См. heSameCompanySite — какие пары считаются
 *     одним сайтом и почему не любые с общим eTLD+1.
 *  3. АДРЕС — heEmailIdentities: нормализованные (lowercase) адреса ячейки.
 *     Один и тот же ящик в двух базах проекта — это одно и то же письмо дважды
 *     одному получателю, кому бы ни принадлежало имя строки.
 *
 * ДОМЕН И АДРЕС — ТОЛЬКО market='us' (решает вызывающий: HeBaseExclusionKeys
 * .useWebsite в stages/baseCollect.ts). У RU удостоверение — ИНН, а один
 * корпоративный сайт держат несколько юрлиц холдинга; включение этих ключей
 * для RU поменяло бы ежедневный staff-инструмент, и это отдельное решение.
 */

import { parse } from 'tldts';

import { normalizeLeadWebsite } from '@/lib/instantly/leadContactValues';
import { extractEmails } from '@/lib/tools/dfybUtils';

/**
 * Нормализация названия компании для дедупа: lowercase, срез юрформ
 * (ООО/ИП/АО/ПАО/ЗАО/ОАО/АНО/НКО и латинские LLC/LTD/INC/OOO/CORP/CORPORATION/
 * LLP/LP/LIMITED/GMBH/PLC/SARL/SA/AG/BV/NV/PTY/PTE — отдельными словами, в
 * любых кавычках; латинское IP НЕ срезаем — слишком коллизионно:
 * «IP Solutions»), удаление кавычек («»„“""'') и прочей пунктуации,
 * схлопывание пробелов. Иначе «ООО "ТЕРАБАЙТ"» из реестра и «ТЕРАБАЙТ»
 * из hh жили в базе обе, как и «Acme, Inc.» из pdl и «ACME LLC» из eng_hiring.
 */
export function normalizeCompanyForDedup(name: string): string {
  let s = ` ${name.trim().toLowerCase()} `;
  // Пунктуация → пробел: кавычки всех стилей, дефисы, точки — всё небуквенное.
  s = s.replace(/[^0-9a-zа-яё\s]+/gi, ' ');
  // Юрформы отдельными словами (длинные формы раньше коротких: «пао» до «ао»).
  s = s.replace(
    /(^|\s)(ооо|ип|пао|зао|оао|ано|нко|ао|llc|ltd|inc|ooo|corporation|corp|limited|llp|lp|gmbh|plc|sarl|sa|ag|bv|nv|pty|pte)(?=\s|$)/g,
    ' ',
  );
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Нормализация сайта для дедупа: только хост, lowercase, без www и пути
 * (https://www.x.ru/about → x.ru), срез конечной точки (x.ru. → x.ru).
 * Мусорные значения («не-сайт», localhost, произвольный текст) → пустой
 * ключ: хост без «точки + TLD» — не сайт, а punycode-мусор в ключе склеивал
 * бы разные строки одной компании не хуже пустого сайта. В строке
 * сохраняется полный website — хост используется только в ключе.
 */
export function normalizeWebsiteForDedup(website: string): string {
  const raw = website.trim().toLowerCase();
  if (!raw) return '';
  let host: string;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    host = url.hostname;
  } catch {
    // Кривая строка (пробелы, мусор): грубый срез схемы/пути руками.
    host = raw.replace(/^[a-z]+:\/\//, '').split(/[\s/?#]/)[0];
  }
  host = host.replace(/^www\./, '').replace(/\.+$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : '';
}

/** Ячейка → строка без пробелов по краям (число — как есть, мусор — пусто). */
function text(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value).trim();
}

/** Собственный сайт компании: хост и его регистрируемый домен. */
export interface HeSiteIdentity {
  /** Хост без www (normalizeWebsiteForDedup) — прежний ключ домена. */
  host: string;
  /**
   * Регистрируемый домен хоста (eTLD+1): shop.acme.com → acme.com,
   * www.acme.co.uk → acme.co.uk. Приватные суффиксы списка считаются
   * суффиксами (x.myshopify.com, x.github.io, x.wixsite.com — сами себе
   * регистрируемые), иначе все магазины одной платформы слиплись бы в одну
   * «компанию». Хост, который сам — суффикс (myshopify.com), — сам себе домен.
   */
  registrable: string;
}

/**
 * Домен как удостоверение компании: только СОБСТВЕННЫЙ сайт. Соцсети,
 * сокращатели и бесплатные почтовые домены в колонке «сайт» (обычное дело у
 * google maps) принадлежат многим компаниям сразу — по ним исключение
 * вымывало бы всех, кроме первой. Отсев берём готовый: normalizeLeadWebsite
 * (instantly/leadContactValues) уже содержит этот список и поддерживается — он
 * возвращает null для не-компанейского хоста. Тот же фильтр, что у прежнего
 * ключа домена (companySiteKey в stages/baseCollect.ts), — набор строк, у
 * которых домен вообще есть, не изменился.
 */
export function heCompanySiteIdentity(website: unknown): HeSiteIdentity | null {
  const raw = text(website);
  if (!raw || !normalizeLeadWebsite(raw)) return null;
  const host = normalizeWebsiteForDedup(raw);
  if (!host) return null;
  const parsed = parse(host, { allowPrivateDomains: true });
  const registrable = parsed.domain && !parsed.isIp ? parsed.domain : host;
  return { host, registrable };
}

/**
 * Набор собственных сайтов (других баз проекта либо компаний под одним именем):
 * хосты и регистрируемые домены ПОДДОМЕНОВ.
 */
export interface HeSiteSet {
  hosts: Set<string>;
  /** Регистрируемые домены хостов, которые сами им НЕ равны (поддомены). */
  subdomainOf: Set<string>;
}

export function newHeSiteSet(): HeSiteSet {
  return { hosts: new Set<string>(), subdomainOf: new Set<string>() };
}

export function addHeSite(set: HeSiteSet, site: HeSiteIdentity): void {
  set.hosts.add(site.host);
  if (site.registrable !== site.host) set.subdomainOf.add(site.registrable);
}

/**
 * Сайт уже есть в наборе — та же компания. Правило: совпал ХОСТ, ЛИБО один из
 * двух сайтов — регистрируемый домен другого (acme.com ↔ shop.acme.com,
 * acme.com ↔ www2.acme.com). Отношение симметричное: какая из двух баз
 * собиралась первой, роли не играет.
 *
 * ПОЧЕМУ НЕ «общий eTLD+1 у любых двух хостов». Публичный список суффиксов не
 * знает большинства конструкторов сайтов малого бизнеса: x.weebly.com,
 * x.wordpress.com, x.godaddysites.com, x.squarespace.com, x.business.site —
 * у всех eTLD+1 общий (weebly.com, …), а за каждым хостом своя фирма; у
 * местного бизнеса из google maps такие сайты обычны. Слияние по общему
 * домену выбросило бы чужую компанию как «уже собранную» — до конструктора
 * это потерянный лид, после него — оплаченная строка. Поэтому два поддомена
 * одного домена (x.weebly.com и y.weebly.com, shop.acme.com и blog.acme.com)
 * остаются разными; сливаются только поддомен и сам домен. Цена — редкий
 * случай, когда в другой базе лежит САМА платформа (weebly.com): её
 * поддомен-клиент тогда тоже будет считаться собранным.
 */
export function heSameCompanySite(set: HeSiteSet, site: HeSiteIdentity): boolean {
  if (set.hosts.has(site.host) || set.hosts.has(site.registrable)) return true;
  return site.host === site.registrable && set.subdomainOf.has(site.registrable);
}

/**
 * Адреса ячейки email как ключи: lowercase, все адреса ячейки (у старых баз и
 * у RU-сетки ячейка бывает склеенной «a@x.com, b@y.com»). Пустая ячейка или
 * текст без адреса — пустой список.
 */
export function heEmailIdentities(value: unknown): string[] {
  const raw = text(value);
  return raw ? extractEmails(raw) : [];
}
