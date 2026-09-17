/**
 * S5 — поиск корпоративной почты на сайте компании.
 *
 * Приоритет роли (спека §10): sales@ → business@ → businessdevelopment@ →
 * partnerships@ → growth@ → commercial@ → contact@ → hello@ → info@.
 * Жёстко запрещены: бесплатные домены, support/billing/legal/privacy/careers/
 * jobs/hr/recruiting/noreply и любые адреса НЕ на домене компании.
 *
 * Сетевые ошибки не валят запуск: нет почты → needs_review('no_corporate_email'),
 * компания при этом валидная.
 */

import { scrapeEmails } from '@/lib/enrich/emailScraper';

export interface PolzaEmailResult {
  email: string | null;
  emailType: 'generic_company' | 'department_company' | null;
  emailSourceUrl: string | null;
}

const ROLE_PRIORITY = [
  'sales',
  'business',
  'businessdevelopment',
  'partnerships',
  'growth',
  'commercial',
  'contact',
  'hello',
  'info',
] as const;

const GENERIC_LOCALS = new Set(['contact', 'hello', 'info']);

const FORBIDDEN_LOCALS = new Set([
  'support', 'billing', 'legal', 'privacy', 'careers', 'jobs', 'job',
  'hr', 'recruiting', 'recruitment', 'noreply', 'no-reply', 'no_reply',
  'admin', 'office', 'mail', 'webmaster', 'marketing',
]);

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com',
  'proton.me', 'protonmail.com', 'icloud.com', 'me.com', 'gmx.com',
  'yandex.com', 'yandex.ru', 'mail.ru', 'aol.com', 'zoho.com', 'tutanota.com',
]);

const MAX_PAGES = 5;
const PAGE_TIMEOUT_MS = 15_000;
const COMPANY_TOTAL_TIMEOUT_MS = 30_000;

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
  if (FORBIDDEN_LOCALS.has(local.toLowerCase())) return false;
  return isOnCompanyDomain(email, companyDomain);
}

function pickByPriority(emails: string[]): { email: string; type: 'generic_company' | 'department_company' } | null {
  for (const local of ROLE_PRIORITY) {
    const hit = emails.find((email) => email.split('@')[0] === local);
    if (hit) {
      return {
        email: hit,
        type: GENERIC_LOCALS.has(local) ? 'generic_company' : 'department_company',
      };
    }
  }
  return null;
}

/** Общий таймаут на компанию: даже зависший хост не тормозит запуск дольше 30 с. */
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
