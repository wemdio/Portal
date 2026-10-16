/**
 * ДОМЕНЫ В СПИСКЕ DO NOT CONTACT ENG-КЛИЕНТА (решение владельца 16.10.2026; план
 * docs/handoff/2026-10-16-eng-countries/implementation-plan.md, §1B и F4).
 *
 * ХРАНЕНИЕ — та же таблица client_blocked_contacts (Instantly DB), тот же скоуп
 * client_user_id и тот же RPC client_blocklist_snapshot. Доменная запись —
 * `'@' + хост` в колонке email (`@waystone.com`), source 'manual'. Почему это
 * безопасно:
 *  - написать её сегодня нечем: и RU-роут (normalizeBlockedEmail), и
 *    ENG-вставка требуют локальную часть адреса;
 *  - каждый прежний читатель на ней падает (getBlockedEmailSet бросает на
 *    строке, которую не разобрал), то есть не обновлённый читатель отказывает
 *    отправке, а не пишет;
 *  - engDncRemoval её не трогает.
 * blockedContacts.ts остаётся байт в байт прежним.
 *
 * ПРАВИЛО СОВПАДЕНИЯ: запись D закрывает хост H, если H === D или H
 * оканчивается на '.' + D. Хост — домен адреса (после последней '@') или сайта
 * компании. Записи — никогда не суффиксы, поэтому notwaystone.com и
 * waystone.com.evil.io не совпадают.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { parse } from 'tldts';

import { BLOCKLIST_MAX_ENTRIES, normalizeBlockedEmail } from '@/lib/clientBlocklist/blockedContacts';
import { isDisposable, isFreeProvider } from '@/lib/emailValidation/shared';
import { normalizeLeadWebsite } from '@/lib/instantly/leadContactValues';

export type HeBlockedDomainRefusal = 'invalid' | 'personal' | 'not_company';

/**
 * Личные почтовые домены, которых нет в общем FREE_PROVIDERS. Общий список не
 * правим: им пользуется RU-валидация.
 */
const ENG_PERSONAL_SUPPLEMENT: ReadonlySet<string> = new Set([
  'googlemail.com',
  'ymail.com',
  'rocketmail.com',
  'comcast.net',
  'att.net',
  'sbcglobal.net',
  'verizon.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'optonline.net',
  'btinternet.com',
  'btopenworld.com',
  'sky.com',
  'talktalk.net',
  'virginmedia.com',
  'ntlworld.com',
  'blueyonder.co.uk',
  'eircom.net',
  'hey.com',
  'pm.me',
]);

/**
 * Платформы сайтов малого бизнеса, которых публичный список суффиксов не знает
 * (у всех их клиентов общий eTLD+1 — см. collectionIdentity.ts). Запись такого
 * домена закрыла бы тысячи чужих компаний.
 */
const SITE_BUILDER_HOSTS: ReadonlySet<string> = new Set([
  'weebly.com',
  'wordpress.com',
  'squarespace.com',
  'godaddysites.com',
  'business.site',
  'mail.google.com',
]);

/** Хост и все его родители: eu.waystone.com → [eu.waystone.com, waystone.com, com]. */
function hostChain(host: string): string[] {
  const labels = host.split('.');
  return labels.map((_, i) => labels.slice(i).join('.'));
}

/**
 * Ввод → хост: текст после последней '@', без схемы, пути, запроса, порта и
 * ведущего www., нижний регистр, IDN → punycode, без конечных точек. null —
 * это не хост.
 */
function hostOf(raw: string): string | null {
  let text = raw.replace(/\p{Cf}/gu, '').trim().replace(/^mailto:/i, '');
  const at = text.lastIndexOf('@');
  if (at >= 0) text = text.slice(at + 1);
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#\s]/)[0] ?? '';
  text = text.replace(/:\d*$/, '');
  if (!text) return null;
  let host: string;
  try {
    host = new URL(`https://${text}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.+$/, '').replace(/^www\./, '');
  if (!host || host.length > 253) return null;
  if (!host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return host;
}

/**
 * Ввод клиента → доменная запись или отказ. Хост хранится как набран (без
 * тихого расширения): shop.acme.com остаётся shop.acme.com, а `subdomainOf`
 * подсказывает добавить acme.com.
 */
export function normalizeBlockedDomain(
  raw: unknown,
): { ok: true; domain: string; subdomainOf: string | null } | { ok: false; refused: HeBlockedDomainRefusal; input: string } {
  const input = typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
  const host = typeof raw === 'string' ? hostOf(raw) : null;
  if (!host || !host.includes('.') || host === 'localhost') return { ok: false, refused: 'invalid', input };
  const parsed = parse(host, { allowPrivateDomains: true });
  if (parsed.isIp) return { ok: false, refused: 'invalid', input };
  // Нет настоящего TLD (суффикс не из публичного списка).
  if (!parsed.isIcann && !parsed.isPrivate) return { ok: false, refused: 'invalid', input };
  const chain = hostChain(host);
  if (chain.some((h) => isFreeProvider(h) || isDisposable(h) || ENG_PERSONAL_SUPPLEMENT.has(h))) {
    return { ok: false, refused: 'personal', input };
  }
  // Сам хост — публичный или приватный суффикс (co.uk, myshopify.com, github.io).
  if (!parsed.domain) return { ok: false, refused: 'not_company', input };
  if (!normalizeLeadWebsite(host) || chain.some((h) => SITE_BUILDER_HOSTS.has(h))) {
    return { ok: false, refused: 'not_company', input };
  }
  return { ok: true, domain: host, subdomainOf: parsed.domain !== host ? parsed.domain : null };
}

const DOMAIN_ENTRY_RE = /^@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * Сохранённая строка списка → запись. Доменная — только проверка синтаксиса,
 * без списков политики: правка списков не должна делать прежние строки
 * нечитаемыми. Остальное — через normalizeBlockedEmail.
 */
export function parseBlockedEntry(stored: unknown): { kind: 'email'; email: string } | { kind: 'domain'; domain: string } | null {
  if (typeof stored !== 'string') return null;
  const value = stored.trim().toLowerCase();
  if (value.startsWith('@')) return DOMAIN_ENTRY_RE.test(value) ? { kind: 'domain', domain: value.slice(1) } : null;
  const email = normalizeBlockedEmail(value);
  return email ? { kind: 'email', email } : null;
}

export interface BlockedContactSnapshot {
  emails: ReadonlySet<string>;
  domains: ReadonlySet<string>;
}

/** Список больше лимита — отдельный класс: у кабинета на него свой код причины. */
export class BlockedContactsOverCapError extends Error {
  constructor() {
    super(`Чёрный список превышает лимит ${BLOCKLIST_MAX_ENTRIES}`);
    this.name = 'BlockedContactsOverCapError';
  }
}

/**
 * Снимок списка: адреса и домены. ВСЕ проверки полноты — копия
 * getBlockedEmailSet (blockedContacts.ts): ошибка, форма ответа, счётчик сверх
 * лимита, длина ≠ счётчику, нечитаемая строка, повторы. Две копии могут
 * разойтись — правьте обе вместе. Ошибку не глотаем: не знаем список — не
 * отправляем.
 */
export async function getBlockedContactSnapshot(db: SupabaseClient, userId: string): Promise<BlockedContactSnapshot> {
  const { data, error } = await db.rpc('client_blocklist_snapshot', { p_client_user_id: userId });
  if (error) throw new Error(`Не удалось загрузить чёрный список: ${error.message}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Не удалось подтвердить полноту чёрного списка');
  }
  const snapshot = data as { count?: unknown; emails?: unknown };
  const count = snapshot.count;
  const rows = snapshot.emails;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(rows)) {
    throw new Error('Не удалось подтвердить полноту чёрного списка');
  }
  if (count > BLOCKLIST_MAX_ENTRIES) throw new BlockedContactsOverCapError();
  if (rows.length !== count) throw new Error('Чёрный список загружен не полностью');
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const row of rows) {
    const entry = parseBlockedEntry(row);
    if (!entry) throw new Error('Чёрный список содержит некорректный email');
    if (entry.kind === 'email') emails.add(entry.email);
    else domains.add(entry.domain);
  }
  if (emails.size + domains.size !== count) throw new Error('Чёрный список содержит дубликаты');
  return { emails, domains };
}

/** Хост адреса (после последней '@') или сайта; punycode, без www. Не хост — null. */
export function contactHost(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return hostOf(value);
}

/** Первая запись списка, закрывающая адрес или сайт; null — не закрыт. */
export function blockedDomainHit(domains: ReadonlySet<string>, value: unknown): string | null {
  if (domains.size === 0) return null;
  const host = contactHost(value);
  if (!host) return null;
  for (const h of hostChain(host)) {
    if (domains.has(h)) return h;
  }
  return null;
}

/**
 * Лиды без адресов и компаний из списка. Порядок проверок: точный адрес; затем
 * домен адреса, lead.website и siteOf(lead, i) — сайт строки базы, когда он у
 * вызывающего есть. `kept` — те же объекты в исходном порядке; пустой снимок —
 * тот же массив.
 */
export function filterBlockedContacts<T extends { email: string; website?: string | null }>(
  leads: readonly T[],
  snapshot: BlockedContactSnapshot,
  siteOf?: (lead: T, index: number) => unknown,
): { kept: T[]; blockedCount: number; blockedByEmail: number; blockedByDomain: number } {
  if (snapshot.emails.size === 0 && snapshot.domains.size === 0) {
    return { kept: leads as T[], blockedCount: 0, blockedByEmail: 0, blockedByDomain: 0 };
  }
  const kept: T[] = [];
  let blockedByEmail = 0;
  let blockedByDomain = 0;
  leads.forEach((lead, i) => {
    const email = normalizeBlockedEmail(lead.email);
    if (email && snapshot.emails.has(email)) {
      blockedByEmail += 1;
      return;
    }
    if (
      blockedDomainHit(snapshot.domains, lead.email) ||
      blockedDomainHit(snapshot.domains, lead.website) ||
      (siteOf ? blockedDomainHit(snapshot.domains, siteOf(lead, i)) : null)
    ) {
      blockedByDomain += 1;
      return;
    }
    kept.push(lead);
  });
  return { kept, blockedCount: blockedByEmail + blockedByDomain, blockedByEmail, blockedByDomain };
}
