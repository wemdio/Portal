/**
 * S5 — поиск корпоративной почты на сайте компании.
 *
 * Приоритет роли (спека §10): sales@ → business@ → businessdevelopment@ →
 * partnerships@ → growth@ → commercial@ → contact@ → hello@ → info@.
 * Жёстко запрещены: бесплатные домены, support/billing/legal/privacy/careers/
 * jobs/hr/recruiting/noreply и любые адреса НЕ на домене компании.
 *
 * Замер 22.09.2026: из 14 компаний, дошедших до этой стадии, почта нашлась у
 * двух. Разбор показал, что дело не в сайтах, а в двух самоограничениях:
 *
 * 1. Принимались ровно девять локальных частей. Живой сайт пишет «hi@»,
 *    «team@», «bd@», «newbusiness@», «enquiries@» — всё это отбрасывалось как
 *    будто почты нет вовсе. Список ролей расширен, а последним ярусом идёт
 *    любой незапрещённый адрес на домене компании: письмо живому человеку
 *    (firstname@) для холодного аутрича не хуже, а обычно лучше обезличенного.
 * 2. Общий потолок в 30 секунд обрывал обход раньше, чем очередь доходила до
 *    страницы контактов. Пять страниц за тридцать секунд — это в лучшем
 *    случае главная и пара разделов.
 *
 * Сетевые ошибки не валят запуск: нет почты → needs_review('no_corporate_email'),
 * компания при этом валидная.
 */

import { scrapeEmails } from '@/lib/enrich/emailScraper';

export interface PolzaEmailResult {
  email: string | null;
  emailType: 'generic_company' | 'department_company' | 'person_company' | null;
  emailSourceUrl: string | null;
}

/** Роли по убыванию пользы для холодного письма в отдел продаж. */
const ROLE_PRIORITY = [
  'sales',
  'business',
  'businessdevelopment',
  'bd',
  'newbusiness',
  'new.business',
  'partnerships',
  'partnership',
  'partners',
  'growth',
  'commercial',
  'enquiries',
  'inquiries',
  'enquiry',
  'contact',
  'contactus',
  'hello',
  'hallo',
  'hi',
  'hey',
  'team',
  'office',
  'info',
  'welcome',
  'ask',
] as const;

/** Обезличенные «общие» ящики — в отчёте отличаются от отдела продаж. */
const GENERIC_LOCALS = new Set([
  'contact', 'contactus', 'hello', 'hallo', 'hi', 'hey', 'team', 'office', 'info', 'welcome', 'ask',
]);

const FORBIDDEN_LOCALS = new Set([
  'support', 'billing', 'legal', 'privacy', 'careers', 'jobs', 'job',
  'hr', 'recruiting', 'recruitment', 'noreply', 'no-reply', 'no_reply',
  'admin', 'webmaster', 'marketing', 'abuse', 'postmaster', 'dpo', 'gdpr',
  'security', 'unsubscribe', 'press', 'media', 'invoice', 'invoices',
  'accounting', 'accounts', 'finance', 'donotreply', 'do-not-reply',
]);

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com',
  'proton.me', 'protonmail.com', 'icloud.com', 'me.com', 'gmx.com',
  'yandex.com', 'yandex.ru', 'mail.ru', 'aol.com', 'zoho.com', 'tutanota.com',
]);

// Обход стал длиннее ровно настолько, чтобы очередь успевала дойти до
// контактов: страниц больше, и общий потолок им под стать. Зависший хост
// по-прежнему не держит запуск дольше минуты.
const MAX_PAGES = 10;
const PAGE_TIMEOUT_MS = 15_000;
const COMPANY_TOTAL_TIMEOUT_MS = 60_000;

function emailDomain(email: string): string {
  return email.split('@')[1] ?? '';
}

/** Адрес обязан жить на домене компании (сам домен или его поддомен). */
function isOnCompanyDomain(email: string, companyDomain: string): boolean {
  const domain = emailDomain(email).toLowerCase();
  return domain === companyDomain || domain.endsWith(`.${companyDomain}`);
}

function isAllowed(email: string, companyDomain: string): boolean {
  const [local, domain] = email.split('@');
  if (!local || !domain) return false;
  if (FREE_MAIL_DOMAINS.has(domain.toLowerCase())) return false;
  const localKey = local.toLowerCase();
  if (FORBIDDEN_LOCALS.has(localKey)) return false;
  // Технические ящики вида no-reply-2024@, cron@, mailer-daemon@.
  if (/(^|[._-])(no[._-]?reply|mailer|daemon|bounce|postmaster)([._-]|\d*$)/.test(localKey)) return false;
  return isOnCompanyDomain(email, companyDomain);
}

function typeForLocal(local: string): 'generic_company' | 'department_company' | 'person_company' {
  if (GENERIC_LOCALS.has(local)) return 'generic_company';
  if (ROLE_PRIORITY.includes(local as (typeof ROLE_PRIORITY)[number])) return 'department_company';
  return 'person_company';
}

function pickByPriority(emails: string[]): { email: string; type: PolzaEmailResult['emailType'] } | null {
  for (const local of ROLE_PRIORITY) {
    const hit = emails.find((email) => email.split('@')[0].toLowerCase() === local);
    if (hit) return { email: hit, type: typeForLocal(local) };
  }
  // Ни одной знакомой роли: берём любой допустимый адрес на домене компании.
  // Порядок фиксируем сортировкой — иначе один и тот же сайт при повторном
  // прогоне давал бы разные адреса, и сверять результаты было бы нечем.
  const rest = [...emails].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  if (!rest) return null;
  return { email: rest, type: typeForLocal(rest.split('@')[0].toLowerCase()) };
}

/** Общий таймаут на компанию: даже зависший хост не тормозит запуск дольше минуты. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function findCompanyEmail(
  companyWebsite: string,
  normalizedDomain: string,
): Promise<PolzaEmailResult> {
  const result = await withTimeout(
    scrapeEmails(companyWebsite, {
      locale: 'en',
      maxPages: MAX_PAGES,
      timeout: PAGE_TIMEOUT_MS,
    }),
    COMPANY_TOTAL_TIMEOUT_MS,
    null,
  );

  if (!result) {
    return { email: null, emailType: null, emailSourceUrl: null };
  }

  const allowed = result.emails.filter((email) => isAllowed(email, normalizedDomain));
  const picked = pickByPriority(allowed);
  if (picked) {
    return {
      email: picked.email,
      emailType: picked.type,
      // scrapeEmails не отдаёт постраничную привязку адреса; корень обхода —
      // честный источник «сайт компании», страница-владелец не известна.
      emailSourceUrl: result.checkedUrls[0] ?? companyWebsite,
    };
  }
  return { email: null, emailType: null, emailSourceUrl: null };
}
