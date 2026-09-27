/**
 * Нормализация компании и общий дедуп трёх офферов.
 *
 * company_brand идёт в тему и текст писем: убираем только юридическую форму и
 * технический мусор, бренд не переводим и не сокращаем по догадке (правила RU §3).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const LEGAL_FORMS =
  /(^|\s)(ооо|оао|зао|пао|ао|ип|нко|ано|гк|пк|llc|ltd\.?|inc\.?|gmbh|corp\.?|общество с ограниченной ответственностью|акционерное общество|публичное акционерное общество|индивидуальный предприниматель)(?=\s|$|[,.])/gi;

export function companyBrand(name: string): string {
  const cleaned = name
    .replace(LEGAL_FORMS, ' ')
    .replace(/[«»"“”„]/g, ' ')
    .replace(/\s*,\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || name.trim();
}

/** Ключ компании для дедупа внутри запуска, когда домена ещё нет. */
export function companyKey(name: string): string {
  return companyBrand(name).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
}

/** Сайты-агрегаторы и соцсети — не сайт компании. */
const NOT_A_COMPANY_SITE = [
  'hh.ru', 'headhunter.ru', 'vk.com', 'vk.ru', 't.me', 'telegram.me', 'instagram.com', 'facebook.com',
  'ok.ru', 'youtube.com', 'rutube.ru', 'dzen.ru', 'zen.yandex.ru', 'yandex.ru', 'google.com',
  'sites.google.com', 'wixsite.com', 'tilda.ws', 'taplink.cc', 'avito.ru', 'ozon.ru', 'wildberries.ru',
  '2gis.ru', 'rusprofile.ru', 'list-org.com', 'zakupki.gov.ru', 'superjob.ru', 'habr.com',
];

export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.+$/, '');
  if (!domain || !domain.includes('.') || /\s/.test(domain)) return null;
  if (NOT_A_COMPANY_SITE.some((bad) => domain === bad || domain.endsWith(`.${bad}`))) return null;
  return domain;
}

export function siteUrl(domain: string): string {
  return `https://${domain}`;
}

/** Домен из корпоративной почты (личные ящики — не домен компании). */
const FREE_MAIL = new Set([
  'gmail.com', 'yandex.ru', 'ya.ru', 'yandex.com', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'rambler.ru',
  'outlook.com', 'hotmail.com', 'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com',
]);

export function domainFromEmail(email: string | null | undefined): string | null {
  const domain = email?.split('@')[1]?.trim().toLowerCase();
  if (!domain || FREE_MAIL.has(domain)) return null;
  return normalizeDomain(domain);
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL.has(domain.toLowerCase());
}

export function normalizeInn(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length === 10 || digits.length === 12 ? digits : null;
}

export interface ExportedIndex {
  domains: Set<string>;
  inns: Set<string>;
}

/**
 * Компании, уже попадавшие в готовую выгрузку любого оффера. Страницы — в
 * порядке id: без порядка Postgres отдаёт строки как придётся, и соседние
 * страницы могли бы пропустить или повторить строки.
 */
export async function loadPreviouslyExported(db: SupabaseClient, excludeJobId: string): Promise<ExportedIndex> {
  const domains = new Set<string>();
  const inns = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('polza_ru_outreach_companies')
      .select('normalized_domain,inn')
      .eq('row_status', 'ready')
      .neq('job_id', excludeJobId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`previously exported lookup failed: ${error.message}`);
    for (const row of data ?? []) {
      if (row.normalized_domain) domains.add(String(row.normalized_domain));
      if (row.inn) inns.add(String(row.inn));
    }
    if (!data || data.length < PAGE) break;
  }
  return { domains, inns };
}

/**
 * Стоп-лист «Рассылки»: отписки, жалобы, жёсткие отказы, ручные.
 *
 * Сбой запроса — не «адреса в стоп-листе нет»: так отписавшийся молча прошёл
 * бы дальше, до писем и выгрузки. Бросаем ошибку — раннер (RU и EN) помечает
 * строку сбойной, запуск идёт дальше.
 */
export async function isSuppressed(db: SupabaseClient, email: string): Promise<boolean> {
  const { data, error } = await db
    .from('sender_suppressions')
    .select('email')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`Не удалось проверить стоп-лист рассылки: ${error.message}`);
  return Boolean(data);
}
