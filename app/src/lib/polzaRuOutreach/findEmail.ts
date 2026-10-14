/**
 * Корпоративная почта на сайте компании (русские сайты).
 *
 * Приоритет: отдел продаж/коммерция/партнёры → общий ящик компании → личный
 * адрес на домене компании. Общий ящик (info@, office@ …) — это адрес, где
 * письмо читает не ЛПР, поэтому для него собирается routing-вариант первого
 * письма: «подскажите, кто отвечает за продажи» (INSTRUCTION_02/03 шаг 6/5).
 *
 * Запрещены: HR/резюме/поддержка/бухгалтерия/служебные адреса и чужие домены.
 * Свой домен — это и основной домен поддомена (kzn.firma.ru ↔ firma.ru), и
 * второй домен того же бренда (larvij.com ↔ larvij.ru). Бесплатная почта
 * (yandex.ru, mail.ru…) — только если адреса на домене компании нет, а
 * бесплатных у компании не больше трёх: 07.10.2026 58% отсевов «почты нет»
 * были компаниями, у которых на сайте один адрес, и он на бесплатной почте.
 *
 * Поиск и проверка — общие у аутричей (lib/outreachEmail/findAndVerify.ts):
 * обход сайта через портальный кэш и SMTP-проверка адресов. Вторым источником
 * адресов идут наши каталоги Яндекс Карт (sources/catalogEmail.ts): на сайте
 * почта есть не всегда, а правила выбора и проверка для обоих источников одни. Здесь только
 * правила выбора: проверенный адрес исключается, и pickRuEmail выбирает
 * следующий по тем же приоритетам. В работу — до трёх рабочих адресов
 * (emails), первый из них главный.
 */

import type { SitePageCache } from '@/lib/enrich/emailScraper';
import {
  findAndVerifyCompanyEmail,
  type EmailDomainCache,
  type OutreachEmailVerdict,
  type OutreachEmailVerification,
} from '@/lib/outreachEmail/findAndVerify';

/** Адрес по правилам выбора — без поиска и проверки. */
export interface RuEmailPick {
  email: string | null;
  emailType: 'department' | 'generic' | 'person' | null;
  isRouting: boolean;
  recipientRole: string | null;
}

/** Адрес компании в работе — элемент колонки emails строки. */
export interface RuFoundEmail {
  email: string;
  emailType: 'department' | 'generic' | 'person' | null;
  isRouting: boolean;
  recipientRole: string | null;
  verification: OutreachEmailVerification;
}

export interface RuEmailResult extends RuEmailPick {
  sourceUrl: string | null;
  /** Вердикт проверки — в email_verification строки; null — адреса нет. */
  verification: OutreachEmailVerification | null;
  /** ok / catch_all / unverified — адрес есть; invalid — кандидаты не прошли проверку; none — адресов нет. */
  verdict: OutreachEmailVerdict;
  /** Адреса, отбракованные проверкой, — пояснение в журнале. */
  triedInvalid: string[];
  /** Адреса в работу по приоритету (1–3), главный — первым; пусто — адреса нет. */
  emails: RuFoundEmail[];
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
  /^(hr|job|jobs|career|careers|rabota|resume|rezume|cv|vacancy|vacancies|kadry|personal|support|help|helpdesk|tech|buh|buhgalteria|accounting|finance|invoice|billing|legal|jurist|urist|privacy|security|abuse|postmaster|webmaster|noreply|no-reply|no_reply|donotreply|mailer-daemon|press|media|pr|smi|tender|tenders|zakupki|snab|snabzhenie|purchase|procurement|unsubscribe|claims|pretenzii)$/;

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'yandex.ru', 'ya.ru', 'yandex.com', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'internet.ru',
  'rambler.ru', 'outlook.com', 'hotmail.com', 'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com',
]);

const MAX_PAGES = 8;

/** Не больше стольких бесплатных адресов у компании: больше — это уже не её ящик, а список чужих контактов. */
const MAX_FREE_MAIL = 3;

/** Зоны второго уровня, где домен компании — третий уровень (firma.msk.ru). */
const SECOND_LEVEL_ZONES = new Set(['msk.ru', 'spb.ru', 'com.ru', 'net.ru', 'org.ru', 'pp.ru', 'co.uk', 'com.ua', 'com.kz']);

/** Основной домен: kzn.stores-apple.com → stores-apple.com, firma.msk.ru остаётся собой. */
function baseDomain(domain: string): string {
  const parts = domain.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return SECOND_LEVEL_ZONES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/** Имя бренда в домене: larvij.com и larvij.ru → larvij. */
function brandOf(domain: string): string {
  return baseDomain(domain).split('.')[0];
}

/** Адрес на домене компании: тот же основной домен или второй домен того же бренда. */
function isCompanyDomain(emailDomain: string, companyDomain: string): boolean {
  if (baseDomain(emailDomain) === baseDomain(companyDomain)) return true;
  const brand = brandOf(companyDomain);
  return brand.length >= 4 && brandOf(emailDomain) === brand;
}

function usableLocal(local: string): boolean {
  if (FORBIDDEN_LOCAL.test(local)) return false;
  return !/(^|[._-])(no[._-]?reply|mailer|daemon|bounce|robot|notify|notification)([._-]|\d*$)/.test(local);
}

function isAllowed(email: string, companyDomain: string): boolean {
  const [local, domain] = email.toLowerCase().split('@');
  if (!local || !domain) return false;
  if (FREE_MAIL_DOMAINS.has(domain)) return false;
  if (!usableLocal(local)) return false;
  return isCompanyDomain(domain, companyDomain);
}

/** Бесплатный адрес с допустимым началом — запасной вариант, когда своего домена нет. */
function isFreeFallback(email: string): boolean {
  const [local, domain] = email.toLowerCase().split('@');
  return Boolean(local && domain && FREE_MAIL_DOMAINS.has(domain) && usableLocal(local));
}

/**
 * Выбор адреса — чистая функция: один и тот же набор всегда даёт один результат.
 * excluded — адреса в нижнем регистре, которые проверка признала нерабочими:
 * их нет среди кандидатов, и выбор идёт по тем же приоритетам среди остальных.
 */
export function pickRuEmail(emails: string[], companyDomain: string, excluded: ReadonlySet<string> = new Set()): RuEmailPick {
  const allowed = Array.from(new Set(emails.map((e) => e.toLowerCase()))).filter((e) => !excluded.has(e) && isAllowed(e, companyDomain));
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

  // Своего домена нет — бесплатная почта компании, если адресов немного.
  // Счёт — по всем найденным, а не по оставшимся после проверки: компания с
  // пятью адресами на mail.ru не становится «с одним», когда четыре отбракованы.
  // Адрес на домене компании был, но не прошёл проверку, — бесплатный вместо
  // него не подставляем: правило только для компаний без своего адреса.
  const all = Array.from(new Set(emails.map((e) => e.toLowerCase())));
  const free = all.filter(isFreeFallback);
  if (free.length && free.length <= MAX_FREE_MAIL && !all.some((e) => isAllowed(e, companyDomain))) {
    const brand = brandOf(companyDomain);
    const left = free
      .filter((e) => !excluded.has(e))
      .sort((a, b) => Number(localOf(b).includes(brand)) - Number(localOf(a).includes(brand)) || a.length - b.length || a.localeCompare(b));
    if (left[0]) return { email: left[0], emailType: 'generic', isRouting: true, recipientRole: 'Общий ящик (бесплатная почта)' };
  }
  return { email: null, emailType: null, isRouting: false, recipientRole: null };
}

/** domainCache — один на запуск (MX и catch-all доменов для SMTP-проверки). */
export async function findRuCompanyEmail(
  website: string,
  companyDomain: string,
  domainCache: EmailDomainCache,
  /** Адреса из наших каталогов — проверяются наравне с найденными на сайте. */
  catalog?: { emails: string[]; sourceUrl: string | null },
  /** Скачанные страницы сайта — их же потом читает разбор сайта (analyzeSite). */
  pageCache?: SitePageCache,
): Promise<RuEmailResult> {
  const search = await findAndVerifyCompanyEmail({
    website,
    domain: companyDomain,
    locale: 'ru',
    maxPages: MAX_PAGES,
    domainCache,
    extra: catalog,
    pageCache,
    pick: (emails, excluded) => {
      const picked = pickRuEmail(emails, companyDomain, excluded);
      return picked.email ? { ...picked, email: picked.email } : null;
    },
  });
  const found = search.result;
  return {
    email: found?.email ?? null,
    emailType: found?.emailType ?? null,
    isRouting: found?.isRouting ?? false,
    recipientRole: found?.recipientRole ?? null,
    sourceUrl: search.sourceUrl,
    verification: found?.verification ?? null,
    verdict: search.verdict,
    triedInvalid: search.triedInvalid,
    emails: search.results.map((item) => ({
      email: item.email,
      emailType: item.emailType,
      isRouting: item.isRouting,
      recipientRole: item.recipientRole,
      verification: item.verification,
    })),
  };
}
