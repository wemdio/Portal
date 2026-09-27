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
 * Поиск и проверка — общие у аутричей (lib/outreachEmail/findAndVerify.ts):
 * обход сайта через портальный кэш и SMTP-проверка выбранного адреса. Здесь
 * только правила выбора: нерабочий адрес исключается, и pickCompanyEmail берёт
 * следующий по тем же приоритетам.
 *
 * Сетевые ошибки не валят запуск: сайт не открылся — почты нет, компания
 * отсеивается с причиной no_corporate_email.
 */

import {
  findAndVerifyCompanyEmail,
  type EmailDomainCache,
  type OutreachEmailVerdict,
  type OutreachEmailVerification,
} from '@/lib/outreachEmail/findAndVerify';

export type PolzaEmailType = 'generic_company' | 'department_company' | 'person_company';

export interface PolzaEmailResult {
  email: string | null;
  emailType: PolzaEmailType | null;
  emailSourceUrl: string | null;
  /** Вердикт проверки — в email_verification строки; null — адреса нет. */
  verification: OutreachEmailVerification | null;
  /** ok / catch_all / unverified — адрес есть; invalid — кандидаты не прошли проверку; none — адресов нет. */
  verdict: OutreachEmailVerdict;
  /** Адреса, отбракованные проверкой, — для журнала. */
  triedInvalid: string[];
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
  'inquiry',
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

/**
 * Обезличенные «общие» ящики — в отчёте отличаются от отдела продаж, и письмо 1
 * им идёт в варианте «кто у вас за это отвечает?» (renderTemplate): читает его
 * не ЛПР. enquiries@ и inquiries@ — тот же общий ящик для входящих вопросов.
 */
const GENERIC_LOCALS = new Set([
  'enquiries', 'inquiries', 'enquiry', 'inquiry',
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
// контактов: страниц больше, чем у русского аутрича (8). Общий потолок на сайт
// (минута) держит findAndVerify — зависший хост не тормозит запуск дольше.
const MAX_PAGES = 10;

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

function typeForLocal(local: string): PolzaEmailType {
  if (GENERIC_LOCALS.has(local)) return 'generic_company';
  if (ROLE_PRIORITY.includes(local as (typeof ROLE_PRIORITY)[number])) return 'department_company';
  return 'person_company';
}

function pickByPriority(emails: string[]): { email: string; type: PolzaEmailType } | null {
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

/**
 * Выбор адреса — чистая функция. excluded — адреса в нижнем регистре, которые
 * проверка признала нерабочими: выбор идёт по тем же приоритетам среди остальных.
 */
export function pickCompanyEmail(
  emails: string[],
  normalizedDomain: string,
  excluded: ReadonlySet<string> = new Set(),
): { email: string; emailType: PolzaEmailType } | null {
  const allowed = emails.filter((email) => !excluded.has(email.toLowerCase()) && isAllowed(email, normalizedDomain));
  const picked = pickByPriority(allowed);
  return picked ? { email: picked.email, emailType: picked.type } : null;
}

/** domainCache — один на запуск (MX и catch-all доменов для SMTP-проверки). */
export async function findCompanyEmail(
  companyWebsite: string,
  normalizedDomain: string,
  domainCache: EmailDomainCache,
): Promise<PolzaEmailResult> {
  const search = await findAndVerifyCompanyEmail({
    website: companyWebsite,
    domain: normalizedDomain,
    locale: 'en',
    maxPages: MAX_PAGES,
    domainCache,
    pick: (emails, excluded) => pickCompanyEmail(emails, normalizedDomain, excluded),
  });
  const found = search.result;
  return {
    email: found?.email ?? null,
    emailType: found?.emailType ?? null,
    // scrapeEmails не отдаёт постраничную привязку адреса; корень обхода —
    // честный источник «сайт компании», страница-владелец не известна.
    emailSourceUrl: search.sourceUrl,
    verification: found?.verification ?? null,
    verdict: search.verdict,
    triedInvalid: search.triedInvalid,
  };
}
