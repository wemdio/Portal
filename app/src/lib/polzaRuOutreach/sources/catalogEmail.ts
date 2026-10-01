/**
 * Почта компании из наших каталогов Яндекс Карт — второй источник адреса,
 * помимо обхода сайта.
 *
 * Зачем: в запуске 01.10.2026 из 433 просмотренных компаний 131 выбыла с
 * причиной EMAIL_NOT_FOUND — на сайте адреса не нашлось. В каталоге почта
 * есть у 9,4% карточек, а у карточек с сайтом — у 29%.
 *
 * Адреса отдаются как кандидаты наравне с найденными на сайте: выбор (отдел
 * продаж → общий ящик → личный, бесплатные домены и адреса не на домене
 * компании запрещены) и SMTP-проверка остаются прежними, в findEmail.ts и
 * findAndVerify.ts. В каталоге много mail.ru и ящиков чужих доменов — их
 * отбросят те же правила, что и для сайта.
 *
 * Сбой запроса компанию не роняет: вернём пусто, останется обход сайта.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Адреса из каталога и ссылка на карточку — честный источник для журнала. */
export interface CatalogEmails {
  emails: string[];
  sourceUrl: string | null;
}

const EMPTY: CatalogEmails = { emails: [], sourceUrl: null };
/** Больше одной карточки на домен бывает (филиалы сети) — адресов хватит и этого. */
const MAX_EMAILS = 10;

export async function lookupCatalogEmails(db: SupabaseClient, domain: string): Promise<CatalogEmails> {
  if (!domain) return EMPTY;
  const { data, error } = await db.rpc('polza_ru_catalog_emails', { p_domain: domain });
  if (error) {
    console.warn(`[polzaRuOutreach] catalog email lookup failed for ${domain}: ${error.message}`);
    return EMPTY;
  }
  const emails: string[] = [];
  const seen = new Set<string>();
  let sourceUrl: string | null = null;
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    // Поле email в каталоге — список через запятую.
    for (const raw of String(row.emails ?? '').split(',')) {
      const email = raw.trim().toLowerCase();
      if (!email || !email.includes('@') || seen.has(email)) continue;
      seen.add(email);
      emails.push(email);
      if (!sourceUrl && typeof row.card_url === 'string' && row.card_url) sourceUrl = row.card_url;
      if (emails.length >= MAX_EMAILS) return { emails, sourceUrl };
    }
  }
  return emails.length ? { emails, sourceUrl } : EMPTY;
}
