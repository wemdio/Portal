/**
 * Корпоративная почта на сайте компании (русские сайты).
 *
 * Приоритет: отдел продаж/коммерция/партнёры → общий ящик компании → личный
 * адрес на домене компании. Общий ящик (info@, office@ …) — это адрес, где
 * письмо читает не ЛПР, поэтому для него собирается routing-вариант первого
 * письма: «подскажите, кто отвечает за продажи» (INSTRUCTION_02/03 шаг 6/5).
 *
 * Запрещены: бесплатные домены, HR/резюме/поддержка/бухгалтерия/служебные и
 * любые адреса НЕ на домене компании.
 */

import { scrapeEmails } from '@/lib/enrich/emailScraper';

export interface RuEmailResult {
  email: string | null;
  emailType: 'department' | 'generic' | 'person' | null;
  isRouting: boolean;
  recipientRole: string | null;
  sourceUrl: string | null;
}

const DEPARTMENT_LOCALS: Array<[string, string]> = [
  ['sales', 'Отдел продаж'],
  ['prodazhi', 'Отдел продаж'],
  ['prodaji', 'Отдел продаж'],
  ['sale', 'Отдел продаж'],
  ['b2b', 'Отдел продаж'],
  ['commerce', 'Коммерческий отдел'],
  ['commercial', 'Коммерческий отдел'],
  ['kommerc', 'Коммерческий отдел'],
  ['kd', 'Коммерческий отдел'],
  ['bd', 'Развитие бизнеса'],
  ['business', 'Развитие бизнеса'],
  ['partners', 'Партнёрства'],
  ['partner', 'Партнёрства'],
  ['opt', 'Оптовый отдел'],
  ['dealer', 'Дилерский отдел'],
  ['director', 'Руководство'],
  ['ceo', 'Руководство'],
];

const GENERIC_LOCALS = [
  'info', 'office', 'mail', 'contact', 'contacts', 'hello', 'zakaz', 'order', 'orders', 'client',
  'clients', 'welcome', 'post', 'company', 'main', 'secretary', 'reception', 'priem',
];

const FORBIDDEN_LOCAL =
  /^(hr|job|jobs|career|careers|rabota|resume|rezume|cv|vacancy|vacancies|kadry|personal|support|help|helpdesk|tech|buh|buhgalteria|accounting|finance|invoice|billing|legal|jurist|urist|privacy|security|abuse|postmaster|webmaster|admin|noreply|no-reply|no_reply|donotreply|mailer-daemon|press|media|pr|smi|marketing|reklama|tender|tenders|zakupki|snab|snabzhenie|purchase|procurement|unsubscribe|claims|pretenzii)$/;

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'yandex.ru', 'ya.ru', 'yandex.com', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'internet.ru',
  'rambler.ru', 'outlook.com', 'hotmail.com', 'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com',
]);

const MAX_PAGES = 8;
const PAGE_TIMEOUT_MS = 15_000;
const COMPANY_TOTAL_TIMEOUT_MS = 60_000;

function isAllowed(email: string, companyDomain: string): boolean {
  const [local, domain] = email.toLowerCase().split('@');
  if (!local || !domain) return false;
  if (FREE_MAIL_DOMAINS.has(domain)) return false;
  if (FORBIDDEN_LOCAL.test(local)) return false;
  if (/(^|[._-])(no[._-]?reply|mailer|daemon|bounce|robot|notify|notification)([._-]|\d*$)/.test(local)) return false;
  return domain === companyDomain || domain.endsWith(`.${companyDomain}`);
}

/** Выбор адреса — чистая функция: один и тот же набор всегда даёт один результат. */
export function pickRuEmail(emails: string[], companyDomain: string): Omit<RuEmailResult, 'sourceUrl'> {
  const allowed = Array.from(new Set(emails.map((e) => e.toLowerCase()))).filter((e) => isAllowed(e, companyDomain));
  const localOf = (e: string) => e.split('@')[0];

  for (const [local, role] of DEPARTMENT_LOCALS) {
    const hit = allowed.find((e) => localOf(e) === local || localOf(e).startsWith(`${local}.`) || localOf(e).startsWith(`${local}-`));
    if (hit) return { email: hit, emailType: 'department', isRouting: false, recipientRole: role };
  }
  const nonGeneric = allowed
    .filter((e) => !GENERIC_LOCALS.includes(localOf(e)))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  // Личный адрес на домене компании (ivanov@, a.petrov@) — живой человек лучше
  // обезличенного ящика, но роль неизвестна: письмо остаётся routing-вариантом.
  const person = nonGeneric.find((e) => /^[a-z]+([._-][a-z]+)?$/.test(localOf(e)));
  for (const local of GENERIC_LOCALS) {
    const hit = allowed.find((e) => localOf(e) === local);
    if (hit && !person) return { email: hit, emailType: 'generic', isRouting: true, recipientRole: 'Общий ящик' };
  }
  if (person) return { email: person, emailType: 'person', isRouting: true, recipientRole: 'Сотрудник (роль неизвестна)' };
  const rest = nonGeneric[0];
  if (rest) return { email: rest, emailType: 'generic', isRouting: true, recipientRole: 'Общий ящик' };
  return { email: null, emailType: null, isRouting: false, recipientRole: null };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function findRuCompanyEmail(website: string, companyDomain: string): Promise<RuEmailResult> {
  const result = await withTimeout(
    scrapeEmails(website, { locale: 'ru', maxPages: MAX_PAGES, timeout: PAGE_TIMEOUT_MS }),
    COMPANY_TOTAL_TIMEOUT_MS,
    null,
  );
  if (!result) return { email: null, emailType: null, isRouting: false, recipientRole: null, sourceUrl: null };
  const picked = pickRuEmail(result.emails, companyDomain);
  return { ...picked, sourceUrl: picked.email ? (result.checkedUrls[0] ?? website) : null };
}
