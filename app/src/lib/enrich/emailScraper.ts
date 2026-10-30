/**
 * Professional-grade email scraper for bulk email extraction from websites.
 *
 * Crawls multiple page types (main, contacts, about, team, privacy/imprint),
 * uses advanced deobfuscation, JSON-LD parsing, data-attribute scanning,
 * and smart junk filtering.
 *
 * This is a standalone module — does NOT modify existing enrichment code.
 */

import iconv from 'iconv-lite';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { Agent } from 'undici';
import { companySiteAlias, companySiteBoundary, sameCompanySiteBoundary } from '@/lib/enrich/companySiteAlias';
import {
  getNonPriorityProxyDispatcher,
  getProxyDispatcher,
  tryAcquireProxySlot,
} from '@/lib/enrich/proxyPool';
import { normalizeUrl } from '@/lib/enrich/urlUtils';
import type { WebsiteFetchGuard } from '@/lib/enrich/websiteParser';

// ── Configuration ──────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_RETRIES = 1;
const FETCH_RETRY_DELAY_MS = 400;
const DEFAULT_MAX_PAGES = 12;

// Проверку сертификата для скрапа выключаем намеренно. Российские
// производственные сайты массово живут на цепочках, которые Node не
// валидирует: сертификаты Минцифры, просрочки, altname не на тот хост,
// self-signed. Замер 21.09.2026 на базе 2ГИС (1294 строки): из 191 домена,
// оставшегося без почты, 37 падали ровно здесь — fetch рвал соединение до
// отправки запроса, и наверх это уходило неотличимо от «почты на сайте нет».
// Читаем мы публичные страницы и ничего не отправляем, так что подлинность
// сертификата на результат не влияет.
// undici грузится лениво: его index тянет web-fetch рантайм, которому в
// jsdom-окружении тестов не хватает TextDecoder. Тот же приём, что с cheerio
// ниже. Не получилось — идём без dispatcher'а, как до правки.
let insecureTlsAgent: Agent | null = null;
let insecureTlsAgentTried = false;

async function getInsecureTlsDispatcher(): Promise<Agent | undefined> {
  if (insecureTlsAgent) return insecureTlsAgent;
  if (insecureTlsAgentTried) return undefined;
  insecureTlsAgentTried = true;
  try {
    const { Agent: UndiciAgent } = await import('undici');
    insecureTlsAgent = new UndiciAgent({ connect: { rejectUnauthorized: false } });
    return insecureTlsAgent;
  } catch {
    return undefined;
  }
}

/**
 * Прямой маршрут под защитой чтения (опция guard): такой же undici.Agent без
 * проверки сертификата, как выше, но с проверкой адреса в момент
 * соединения. Каждый адрес ответа DNS, по которому undici соединяется,
 * проверяет checkUrl самой защиты — как адрес-литерал (непубличный, адрес
 * нашего сервера), так что своей копии политики здесь нет. Хоть один адрес
 * отклонён или ответ пуст — соединение не открывается. Это закрывает подмену
 * ответа DNS между проверкой адреса и запросом. Адрес-литерал undici не
 * резолвит, его закрывает checkUrl перед запросом.
 *
 * Диспетчер защиты (guard.directDispatcher) сюда не подходит: он проверяет
 * сертификат, а обход почты намеренно идёт без этой проверки (см. выше) —
 * с ним сайты с невалидной цепочкой перестали бы читаться. Он остаётся
 * запасным, если undici не загрузился. Агент один на объект защиты, и пул
 * соединений у него общий для всех вызовов с ней (EN-джобы конструктора берут
 * одну защиту на процесс — enSiteGuard в tools/processingSteps.ts).
 */
const guardedDirectDispatchers = new WeakMap<WebsiteFetchGuard, Promise<unknown>>();

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function addressRefusal(error: unknown): error is Error {
  return (
    typeof error === 'object' && error !== null
    && (error as { websiteAddressRefused?: unknown }).websiteAddressRefused === true
  );
}

/** Ошибка отказа (WebsiteAddressRefusedError) или null — все адреса ответа прошли checkUrl защиты. */
async function refusedResolvedAddress(
  guard: WebsiteFetchGuard,
  hostname: string,
  addresses: LookupAddress[],
  refuse: (reason: string) => Error,
): Promise<Error | null> {
  if (addresses.length === 0) return refuse(`${hostname}: пустой ответ DNS`);
  for (const entry of addresses) {
    try {
      await guard.checkUrl(new URL(`http://${entry.family === 6 ? `[${entry.address}]` : entry.address}/`));
    } catch (error) {
      // Что угодно, кроме отказа защиты (невалидный адрес в ответе DNS) —
      // тоже отказ: соединение с непроверенным адресом не открываем.
      return addressRefusal(error) ? error : refuse(`${hostname} ведёт на непроверяемый адрес ${entry.address}`);
    }
  }
  return null;
}

function guardCheckedLookup(
  guard: WebsiteFetchGuard,
  dnsLookup: typeof import('node:dns').lookup,
  refuse: (reason: string) => Error,
) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, '');
        return;
      }
      void refusedResolvedAddress(guard, hostname, addresses, refuse).then((refused) => {
        if (refused) callback(refused, '');
        else if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      });
    });
  };
}

function getGuardedDirectDispatcher(
  guard: WebsiteFetchGuard,
  refuse: (reason: string) => Error,
): Promise<unknown> {
  let dispatcher = guardedDirectDispatchers.get(guard);
  if (!dispatcher) {
    dispatcher = (async () => {
      try {
        const [{ Agent: UndiciAgent }, dns] = await Promise.all([import('undici'), import('node:dns')]);
        return new UndiciAgent({
          connect: { rejectUnauthorized: false, lookup: guardCheckedLookup(guard, dns.lookup, refuse) },
          // Corporate sites behind Akamai/F5 send cookie headers over undici's
          // 16 KiB default; the whole page was lost as "fetch failed".
          maxHeaderSize: 64 * 1024,
        });
      } catch {
        return guard.directDispatcher;
      }
    })();
    guardedDirectDispatchers.set(guard, dispatcher);
  }
  return dispatcher;
}

/**
 * Защита чтения и потолок тела для обхода почты — опции scrapeEmails guard и
 * maxBytes (см. там). Объект один на вызов scrapeEmails: в нём же счётчики,
 * которые вызов возвращает в readLimits.
 */
type PageReadLimits = {
  guard?: WebsiteFetchGuard;
  maxBytes?: number;
  counts: { refused: number; capped: number };
};

/** Причина для failureReason, когда адрес отклонён защитой чтения. */
const ADDRESS_REFUSED_FAILURE: PageFetchFailure = 'Адрес отклонён защитой чтения';

/** Человекочитаемая причина, по которой страница не открылась. */
export type PageFetchFailure = string;

function describeFetchError(err: unknown): PageFetchFailure {
  const code = String(
    (err as { cause?: { code?: string } })?.cause?.code
      ?? (err as { code?: string })?.code
      ?? (err as { name?: string })?.name
      ?? '',
  );
  if (/^(CERT_|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|DEPTH_ZERO|SELF_SIGNED|ERR_TLS_CERT)/.test(code)) {
    return 'Сертификат сайта не прошёл проверку';
  }
  if (code.includes('TLS') || code.includes('SSL')) return 'Ошибка TLS-соединения';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Домен не резолвится';
  if (code === 'ECONNREFUSED') return 'Соединение отклонено';
  if (code === 'ECONNRESET') return 'Соединение разорвано';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Хост недоступен';
  if (code.includes('TIMEOUT') || code === 'TimeoutError' || code === 'AbortError') {
    return 'Сайт не ответил за отведённое время';
  }
  return 'Сайт не открылся';
}

/**
 * Ретрай через прокси имеет смысл только на бот-защите: сайт нас увидел и
 * отказал по IP. Замер 21.09.2026 — из 14 доменов базы 2ГИС, отдавших 403
 * нашему US-egress'у, российский прокси открыл 6. Таймауты и отказы
 * соединения так НЕ лечатся: те же 24 домена не открылись ни через RU, ни
 * через EU-прокси, поэтому на них ретрай не тратим.
 */
const PROXY_RETRY_STATUSES = new Set([403, 429]);
const PROXY_RETRY_ENABLED = process.env.EMAIL_SCRAPER_PROXY_RETRY !== '0';
/** Ретраю даём меньше времени, чем прямому запросу: он не должен удлинять строку. */
const PROXY_RETRY_TIMEOUT_MS = 8_000;

function describeFetchStatus(status: number): PageFetchFailure {
  if (status === 403 || status === 429) return `Сайт блокирует автоматические запросы (${status})`;
  if (status === 404) return 'Страница не найдена (404)';
  if (status >= 500) return `Сайт вернул ошибку ${status}`;
  return `Сайт вернул ${status}`;
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Accept-Language по локали джобы: RU (default, прежнее поведение) и EN
// (конструктор баз ENG-локали — англоязычные сайты иногда отдают другой
// контент/редирект по языку).
const DEFAULT_ACCEPT_LANGUAGE = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';
const EN_ACCEPT_LANGUAGE = 'en-US,en';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Contact / About / Team page paths ──────────────────────────

const CONTACT_PATHS = [
  '/contacts', '/contact', '/contact-us', '/contactus',
  '/kontakty', '/kontakt', '/kontakti',
  '/контакты', '/контакт',
  '/obratnaya-svyaz', '/feedback',
  '/support',
];

const ABOUT_PATHS = [
  '/about', '/about-us', '/about-company', '/aboutus',
  '/o-nas', '/o-kompanii', '/company', '/company/about',
  '/о-компании', '/о-нас',
  '/kompaniya', '/info',
];

const TEAM_PATHS = [
  '/team', '/our-team', '/staff', '/people', '/employees',
  '/komanda', '/команда', '/наша-команда', '/sotrudniki',
];

const LEGAL_PATHS = [
  '/imprint', '/impressum', '/legal', '/privacy', '/datenschutz',
];

// Russian B2B sites often keep company emails on pages with bank/payment requisites
// or delivery terms (юр. отдел, согласование договоров), not on /contacts.
const BUSINESS_PATHS = [
  '/rekvizity', '/реквизиты', '/requisites',
  '/oplata', '/payment', '/payments', '/pay',
  '/dostavka', '/delivery', '/shipping',
  '/dogovor', '/договор',
];

const ALL_STATIC_PATHS = [
  ...CONTACT_PATHS,
  ...ABOUT_PATHS,
  ...TEAM_PATHS,
  ...LEGAL_PATHS,
  ...BUSINESS_PATHS,
];

// При locale='en' эти пути идут в обходе ПЕРВЫМИ (до общего списка):
// англоязычные сайты чаще всего держат почту именно на них. RU-пути не
// убираем — они остаются доступными дальше по очереди (часть EN-баз
// содержит RU-сайты). Все пути уже есть в ALL_STATIC_PATHS, дубли при
// склейке отсекает candidateSeen в scrapeEmails.
const EN_PRIORITY_PATHS = ['/contact', '/contact-us', '/about', '/team', '/company'];

// ── Link discovery patterns ────────────────────────────────────

const LINK_HREF_PATTERN =
  /\/(contact|contacts|kontakty|kontakt|kontakti|about|about[_-]?us|o[_-]?nas|o[_-]?kompanii|team|our[_-]?team|staff|people|komanda|imprint|impressum|legal|feedback|support|контакты|о-компании|о-нас|команда|наша-команда)(\/|$|\?|#)/i;

const LINK_TEXT_PATTERN =
  /\b(contact|contacts|контакты|about(\s+us)?|о\s*компании|о\s*нас|команда|team|staff|наша\s+команда|сотрудники|связаться|написать|обратн(ая|ой)\s+связ(ь|и)|email|почта|impressum|imprint)\b/i;

// ── Email validation ───────────────────────────────────────────

// Адрес в тексте — совпадение /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi,
// но ищем его через matchEmails ниже: сам регексп на длинном слове без '@'
// квадратичный. Здесь — его доменная часть, она проверяется с позиции после '@'.
const EMAIL_DOMAIN_STICKY = /[a-z0-9.\-]+\.[a-z]{2,}/iy;
const STRICT_EMAIL_REGEX = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

// ── Linear scanning ────────────────────────────────────────────
//
// Почему ниже ручные циклы вместо одного регекспа. Глобальный регексп, не
// нашедший совпадения с позиции i, пробует снова с i+1. Если попытка пробегает
// длинный хвост строки (`[^>]+` до конца без '>', ленивое `[\s\S]*?` без
// закрывающего тега, `[a-z0-9...]+` по слову без '@', `\s*` по полосе
// пробелов), попыток столько же, сколько символов, и время растёт квадратично:
// 80 000 символов — около 10 секунд, всё это время event loop воркера стоит.
// Функции ниже дают тот же результат байт в байт (те же регекспы или их части,
// те же совпадения в том же порядке), но каждую позицию строки смотрят O(1) раз.

/** Символ локальной части адреса: [a-z0-9._%+\-] с флагом i (без юникода — только ASCII). */
function isEmailLocalChar(code: number): boolean {
  return (code >= 97 && code <= 122) // a-z
    || (code >= 65 && code <= 90) // A-Z
    || (code >= 48 && code <= 57) // 0-9
    || code === 46 || code === 95 || code === 37 || code === 43 || code === 45; // . _ % + -
}

/**
 * То же, что `text.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? []`.
 *
 * Совпадение всегда устроено так: локальная часть — вся полоса символов адреса,
 * которая кончается прямо перед '@' (но не левее конца прошлого совпадения:
 * `+` жадный, а '@' в полосу не входит), дальше домен, и он от начала локальной
 * части не зависит. Поэтому идём от '@' к '@': полосу отматываем назад, домен
 * проверяем sticky-регекспом ровно с позиции после '@'. Не подошёл домен — этот
 * '@' не годится ни одному началу из его полосы; регексп перебрал бы их все.
 * Полосы перед разными '@' и домены после них не пересекаются — линейно.
 */
function matchEmails(text: string): string[] {
  const matches: string[] = [];
  let lastEnd = 0;
  let at = text.indexOf('@');
  while (at !== -1) {
    let start = at;
    while (start > lastEnd && isEmailLocalChar(text.charCodeAt(start - 1))) start -= 1;
    EMAIL_DOMAIN_STICKY.lastIndex = at + 1;
    if (start < at && EMAIL_DOMAIN_STICKY.test(text)) {
      lastEnd = EMAIL_DOMAIN_STICKY.lastIndex;
      matches.push(text.slice(start, lastEnd));
      at = text.indexOf('@', lastEnd);
    } else {
      at = text.indexOf('@', at + 1);
    }
  }
  return matches;
}

/** Конец последнего вхождения `token` (глобальный регексп) в `s`; 0 — вхождений нет. */
function lastMatchEnd(s: string, token: RegExp): number {
  let end = 0;
  token.lastIndex = 0;
  for (let m = token.exec(s); m; m = token.exec(s)) end = token.lastIndex;
  return end;
}

/**
 * `s.replace(rule, replacement)` для правила, каждое совпадение которого
 * кончается закрывающим токеном ('>' или '</script>'), где `end` — конец
 * последнего такого токена в `s`. Правее `end` совпадений нет, и как раз там
 * `<[^>]+>` и `<script[\s\S]*?<\/script>` квадратичны: с каждого '<' без '>'
 * (с каждого <script> без </script>) пробегают строку до конца. Левее `end` у
 * любого начала токен впереди есть — совпадение находится и съедает
 * просмотренное. Попытки левее `end` читают только символы до ближайшего
 * токена, поэтому на обрезанной строке они дают то же, что на целой.
 */
function replaceBefore(s: string, end: number, rule: RegExp, replacement: string): string {
  return s.slice(0, end).replace(rule, replacement) + s.slice(end);
}

/**
 * Первое совпадение sticky-регекспа `rule` вида `<tag[^>]+…` / `<tag[^>]*…`,
 * где `opening` (/<tag/gi) — его начало и всё совпадение лежит до первого '>'
 * после начала (`needsGt`: совпадение обязано на этом '>' кончаться).
 *
 * Сам регексп пробует каждое '<tag', и на '<meta' без '>' до конца строки
 * каждая попытка пробегает её до конца — квадратично. Здесь после неудачи
 * следующее начало ищется за '>': начало внутри того же тега видит те же
 * символы до того же '>', а `[^>]` с первого начала дотягивается до всего, до
 * чего дотянулся бы с него, — значит, и оно не совпадёт. Если '>' дальше нет,
 * по той же причине после неудачи совпадений нет вовсе.
 */
function firstTagMatch(s: string, opening: RegExp, rule: RegExp, needsGt: boolean): RegExpExecArray | null {
  opening.lastIndex = 0;
  for (let open = opening.exec(s); open; open = opening.exec(s)) {
    const gt = s.indexOf('>', opening.lastIndex);
    // Без '>' такое правило не совпадёт, а его откаты на хвосте тоже квадратичны.
    if (gt === -1 && needsGt) return null;
    rule.lastIndex = open.index;
    const hit = rule.exec(s);
    if (hit || gt === -1) return hit;
    opening.lastIndex = gt + 1;
  }
  return null;
}

/**
 * `u.replace(/[#?].*$/, '').replace(/\/+$/, '')`: адрес без хвоста после '#'/'?'
 * и без завершающих '/'. `/\/+$/` на длинной полосе '/' не в конце строки
 * пробует снова с каждого её '/', `/[#?].*$/` — с каждого '#' строки, за которой
 * идёт перевод строки. `.` перевод строки не пересекает, поэтому `[#?].*$` — это
 * первый '#' или '?' после последнего перевода строки.
 */
function stripUrlTail(u: string): string {
  const lineStart = Math.max(
    u.lastIndexOf('\n'), u.lastIndexOf('\r'), u.lastIndexOf('\u2028'), u.lastIndexOf('\u2029'),
  ) + 1;
  const hash = u.indexOf('#', lineStart);
  const query = u.indexOf('?', lineStart);
  let end = hash === -1 ? query : query === -1 ? hash : Math.min(hash, query);
  if (end === -1) end = u.length;
  while (end > 0 && u.charCodeAt(end - 1) === 47) end -= 1; // '/'
  return u.slice(0, end);
}

// ── Junk email filters ─────────────────────────────────────────

const JUNK_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'mailer_daemon', 'postmaster', 'hostmaster',
  'abuse', 'root', 'webmaster', 'daemon', 'bounce', 'devnull',
  'null', 'unsubscribe', 'subscribe',
]);

const JUNK_DOMAIN_PATTERNS = [
  /^example\.(com|org|net)$/,
  /^test\.(com|org|net)$/,
  /^localhost$/,
  /^(mail|email)\.(example|test)\./,
  /sentry\.io$/,
  /wixpress\.com$/,
  /cloudflare\.com$/,
  // Парковки/хостинги: их служебные почты (support@beget.com и т.п.) оседают
  // на заглушках припаркованных доменов и попадают в базы как «живые».
  /^beget\.(com|ru|net|pro)$/,
  /^timeweb\.(ru|com)$/,
  /^(reg|nic|jino|sprinthost|hostiman|activeby|valuehost|setup|names|1gb|hc)\.(ru|com|net)$/,
  /^hosting\./,
  /^park(ing)?\./,
  /googleapis\.com$/,
  /gstatic\.com$/,
  /wpengine\.com$/,
  /wordpress\.(com|org)$/,
  /gravatar\.com$/,
  /schema\.org$/,
  /w3\.org$/,
  /jquery\.com$/,
  /bootstrap(cdn)?\.com$/,
  /googletagmanager\.com$/,
  /google-analytics\.com$/,
  /facebook\.com$/,
  /twitter\.com$/,
  /instagram\.com$/,
  /linkedin\.com$/,
  /youtube\.com$/,
];

const IMAGE_EXT_IN_LOCAL = /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|tiff?)$/i;

// ── HTML entity decoding for emails ────────────────────────────

export function decodeHtmlEntitiesInEmail(text: string): string {
  return text
    .replace(/&#64;/g, '@')
    .replace(/&#x40;/gi, '@')
    .replace(/&#46;/g, '.')
    .replace(/&#x2e;/gi, '.')
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.');
}

// ── Cloudflare Email Protection ────────────────────────────────
//
// Сайты за Cloudflare часто прячут email через feature "Email Address
// Obfuscation": в HTML вместо адреса рендерится
//   <a class="__cf_email__" data-cfemail="abcdef1234..."
//      href="/cdn-cgi/l/email-protection">[email&#160;protected]</a>
// hex-строка это email XOR-нутый одним байтом. Формат: первый байт — ключ,
// каждый следующий байт — символ email XOR ключа.

const CFEMAIL_REGEX = /data-cfemail=["']([0-9a-fA-F]+)["']/gi;

export function decodeCloudflareEmail(hex: string): string | null {
  if (!hex || hex.length < 4 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) {
      const byte = parseInt(hex.slice(i, i + 2), 16) ^ key;
      // сразу отсеиваем управляющие символы — чаще всего это неверная hex-строка,
      // не email; иначе получим мусор вида "x@y"
      if (byte < 0x20 || byte === 0x7f) return null;
      out += String.fromCharCode(byte);
    }
    if (!out.includes('@') || !out.includes('.')) return null;
    return out;
  } catch {
    return null;
  }
}

// ── Deobfuscation ──────────────────────────────────────────────

function deobfuscateText(text: string): string {
  return text
    // Полосы пробельных символов — сначала в один пробел. Шаблоны ниже
    // начинаются с `\s*` / `\s+`, и на длинной полосе пробелов, за которой нет
    // '[', '(', '{' или «at»/«dot», регексп пробует снова с каждого её символа —
    // квадратично (80 000 пробелов ≈ 10 с на каждый шаблон). Адреса от схлопывания
    // не меняются. Каждый шаблон съедает полосу целиком или не трогает её:
    // `\s*`/`\s+` жадные, а полоса слева начинается не раньше конца прошлой
    // замены, которая свою правую полосу уже съела. Все пробельные символы для
    // шаблонов одинаковы, длина полосы роли не играет, поэтому на схлопнутом
    // тексте срабатывают ровно те же замены, а замена всегда непробельная и
    // полос не склеивает. Сами адреса пробелов не содержат, пробел остаётся
    // разделителем — matchEmails находит те же адреса в том же порядке.
    // Результат — как у .replace(/\s+/g, ' '), только одиночный ' ' не
    // переписывается: обычный текст из одиночных пробелов не копируется зря.
    .replace(/\s{2,}|[^\S ]/g, ' ')
    // Bracket variants: [at] [dot]
    .replace(/\s*\[\s*at\s*]\s*/gi, '@')
    .replace(/\s*\[\s*dot\s*]\s*/gi, '.')
    // Parenthesis variants: (at) (dot)
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.')
    // Curly bracket variants: {at} {dot}
    .replace(/\s*\{\s*at\s*\}\s*/gi, '@')
    .replace(/\s*\{\s*dot\s*\}\s*/gi, '.')
    // Dash variants: -at- -dot-
    .replace(/-at-/gi, '@')
    .replace(/-dot-/gi, '.')
    // Angle bracket variants: <at> <dot>
    .replace(/<at>/gi, '@')
    .replace(/<dot>/gi, '.')
    // Space variants: " at " " dot " (with word boundaries)
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s+dot\s+/gi, '.')
    // HTML entities
    .replace(/&#64;/g, '@')
    .replace(/&#x40;/gi, '@')
    .replace(/&#46;/g, '.')
    .replace(/&#x2e;/gi, '.')
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.');
}

// ── Core extraction functions ──────────────────────────────────

function normalizeEmail(raw: string): string | null {
  const decoded = decodeHtmlEntitiesInEmail(raw);
  const email = decoded.trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254) return null;
  if (!email.includes('@')) return null;
  if (!STRICT_EMAIL_REGEX.test(email)) return null;
  // Reject emails starting/ending with dots or having double dots
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  if (domain.split('.').pop()!.length < 2) return null;
  return email;
}

/**
 * Extract emails from plain text with advanced deobfuscation.
 */
export function extractEmailsAdvanced(text: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const deobfuscated = deobfuscateText(text);
  for (const m of matchEmails(deobfuscated)) {
    const email = normalizeEmail(m);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    results.push(email);
  }
  return results;
}

/**
 * Extract emails from JSON-LD structured data (Schema.org).
 */
export function extractJsonLdEmails(html: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  // Совпадения /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  // по частям того же регекспа: открывающий тег — sticky с каждого '<script'
  // (он кончается на первом '>' после начала), содержимое — до первого
  // '</script>' после этого '>'. Целиком регексп с каждого '<script' без '>' или
  // без '</script>' дальше пробегает строку до конца. Здесь такой '<script'
  // заканчивает поиск: у следующих '>' и '</script>' искались бы правее той же
  // точки и тоже не нашлись бы. Тег, не подошедший как JSON-LD, пропускаем до
  // его '>' — см. firstTagMatch.
  const opening = /<script/gi;
  const jsonLdTag = /<script[^>]+type=["']application\/ld\+json["'][^>]*>/iy;
  const closing = /<\/script>/gi;
  for (let open = opening.exec(html); open; open = opening.exec(html)) {
    const gt = html.indexOf('>', opening.lastIndex);
    if (gt === -1) break;
    jsonLdTag.lastIndex = open.index;
    if (!jsonLdTag.test(html)) {
      opening.lastIndex = gt + 1;
      continue;
    }
    closing.lastIndex = gt + 1;
    const close = closing.exec(html);
    if (!close) break;
    try {
      const data = JSON.parse(html.slice(gt + 1, close.index)) as Record<string, unknown>;
      collectJsonLdEmails(data, seen, results);
    } catch {
      // Invalid JSON — skip
    }
    opening.lastIndex = closing.lastIndex;
  }
  return results;
}

function collectJsonLdEmails(
  obj: unknown,
  seen: Set<string>,
  results: string[],
  depth = 0,
): void {
  if (depth > 5 || !obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectJsonLdEmails(item, seen, results, depth + 1);
    }
    return;
  }

  const record = obj as Record<string, unknown>;

  // Direct email field
  if (typeof record.email === 'string') {
    const email = normalizeEmail(record.email);
    if (email && !seen.has(email)) {
      seen.add(email);
      results.push(email);
    }
  }

  // contactPoint (single or array)
  if (record.contactPoint) {
    collectJsonLdEmails(record.contactPoint, seen, results, depth + 1);
  }

  // member / employee
  if (record.member) collectJsonLdEmails(record.member, seen, results, depth + 1);
  if (record.employee) collectJsonLdEmails(record.employee, seen, results, depth + 1);

  // @graph (array of entities)
  if (Array.isArray(record['@graph'])) {
    collectJsonLdEmails(record['@graph'], seen, results, depth + 1);
  }
}

/**
 * Extract emails from raw HTML using all available methods:
 * 1. JSON-LD structured data
 * 2. mailto: links (including encoded)
 * 3. data-email / data-mail attributes
 * 4. Visible text (with deobfuscation)
 */
export function extractEmailsFromHtmlAdvanced(html: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const addEmail = (raw: string) => {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) return;
    seen.add(email);
    results.push(email);
  };

  // 1. JSON-LD
  for (const e of extractJsonLdEmails(html)) addEmail(e);

  // 2. mailto: links (handle encoded entities)
  // Совпадения /href=["']mailto:([^"'?\s>]+)[^"'>]*["']/gi по частям. Целиком
  // регексп на `href="mailto:` + длинный адрес без закрывающей кавычки
  // квадратичен уже на одном начале: каждую длину адреса он пробует с хвостом
  // `[^"'>]*` заново. А хвост от длины адреса не зависит — он всегда кончается
  // на первой кавычке или '>' после адреса, поэтому достаточно одной попытки.
  const mailtoStart = /href=["']mailto:/gi;
  const mailtoAddress = /[^"'?\s>]+/iy;
  const mailtoTail = /[^"'>]*/iy;
  for (let start = mailtoStart.exec(html); start; start = mailtoStart.exec(html)) {
    mailtoAddress.lastIndex = mailtoStart.lastIndex;
    const address = mailtoAddress.exec(html);
    let quoteAt = -1;
    if (address) {
      mailtoTail.lastIndex = mailtoAddress.lastIndex;
      mailtoTail.test(html); // `[^"'>]*` совпадает всегда, хотя бы пустой строкой
      if (html[mailtoTail.lastIndex] === '"' || html[mailtoTail.lastIndex] === "'") quoteAt = mailtoTail.lastIndex;
    }
    if (!address || quoteAt === -1) {
      // Как у регекспа: следующая попытка — со следующего символа.
      mailtoStart.lastIndex = start.index + 1;
      continue;
    }
    addEmail(decodeHtmlEntitiesInEmail(decodeURIComponent(address[0])));
    mailtoStart.lastIndex = quoteAt + 1;
  }

  // 3. data-email / data-mail / data-e attributes
  let m: RegExpExecArray | null;
  const dataEmailRegex = /data-(?:email|mail|e)=["']([^"']+)["']/gi;
  while ((m = dataEmailRegex.exec(html)) !== null) {
    addEmail(m[1] ?? '');
  }

  // 3b. Cloudflare Email Protection: <a data-cfemail="hex..."> ...
  CFEMAIL_REGEX.lastIndex = 0;
  while ((m = CFEMAIL_REGEX.exec(html)) !== null) {
    const decoded = decodeCloudflareEmail(m[1] ?? '');
    if (decoded) addEmail(decoded);
  }

  // 4. Strip scripts/styles, then extract from visible text
  // Те же правила, что html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  // .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '), но каждое —
  // только до последнего закрывающего токена (см. replaceBefore).
  let stripped = replaceBefore(html, lastMatchEnd(html, /<\/script>/gi), /<script[\s\S]*?<\/script>/gi, ' ');
  stripped = replaceBefore(stripped, lastMatchEnd(stripped, /<\/style>/gi), /<style[\s\S]*?<\/style>/gi, ' ');
  stripped = replaceBefore(stripped, stripped.lastIndexOf('>') + 1, /<[^>]+>/g, ' ');
  stripped = stripped.replace(/\s+/g, ' ');

  for (const e of extractEmailsAdvanced(stripped)) addEmail(e);

  return results;
}

// ── Company name extraction from page ──────────────────────────

const BASIC_HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&laquo;': '«',
  '&raquo;': '»',
};

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => BASIC_HTML_ENTITIES[m.toLowerCase()] ?? m);
}

/**
 * Группа первого совпадения /<title[^>]*>([\s\S]*?)<\/title>/i. Регексп на
 * странице из '<title>' без '</title>' с каждого из них пробегает строку до
 * конца. Но если первое '<title' не совпало — нет '>' после него или нет
 * '</title>' после этого '>', — то не совпадёт и любое следующее: его '>' не
 * левее, и закрывающего тега правее тоже нет.
 */
function firstTitleText(html: string): string | undefined {
  const open = /<title/i.exec(html);
  if (!open) return undefined;
  const gt = html.indexOf('>', open.index + 6);
  if (gt === -1) return undefined;
  const closing = /<\/title>/gi;
  closing.lastIndex = gt + 1;
  const close = closing.exec(html);
  return close ? html.slice(gt + 1, close.index) : undefined;
}

/**
 * Кандидат-название компании со страницы: og:site_name (чистый бренд) →
 * <title> (шумный, но почти всегда есть). Сырое — финальная чистка отдельно
 * (AI cleanCompanyNames: обрежет после -|/,:, снимет ООО/«» и т.п.).
 */
export function extractSiteName(html: string): string | null {
  const candidates: string[] = [];

  // Первое совпадение /<meta[^>]*\bproperty=["']og:site_name["'][^>]*>/i.
  const ogTag = firstTagMatch(html, /<meta/gi, /<meta[^>]*\bproperty=["']og:site_name["'][^>]*>/iy, true)?.[0];
  const ogContent = ogTag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
  if (ogContent) candidates.push(ogContent);

  const title = firstTitleText(html);
  if (title) candidates.push(title);

  for (const raw of candidates) {
    const v = decodeBasicEntities(raw).replace(/\s+/g, ' ').trim();
    if (v.length >= 2 && v.length <= 200) return v;
  }
  return null;
}

// ── Junk email filtering ───────────────────────────────────────

/**
 * Filter out junk/system/placeholder emails.
 */
export function filterJunkEmails(emails: string[]): string[] {
  return emails.filter((email) => {
    const [local, domain] = email.split('@');
    if (!local || !domain) return false;

    // Too long local part
    if (local.length > 64) return false;

    // Known junk local parts
    if (JUNK_LOCAL_PARTS.has(local.toLowerCase())) return false;

    // Image extensions in local part (e.g. banner.png@images.com)
    if (IMAGE_EXT_IN_LOCAL.test(local)) return false;

    // Junk domains
    for (const pattern of JUNK_DOMAIN_PATTERNS) {
      if (pattern.test(domain.toLowerCase())) return false;
    }

    return true;
  });
}

// ── HTML fetching with encoding support ────────────────────────

function extractCharsetFromMeta(html: string): string | null {
  // Первое совпадение /<meta[^>]+charset=["']?([^"'>\s]+)/i.
  const metaCharset = firstTagMatch(html, /<meta/gi, /<meta[^>]+charset=["']?([^"'>\s]+)/iy, false);
  if (metaCharset?.[1]) return metaCharset[1].trim().toLowerCase();
  const metaContentType = matchHttpEquivCharset(html);
  if (metaContentType) return metaContentType.trim().toLowerCase();
  return null;
}

/**
 * Группа первого совпадения
 *   /<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["'][^"']*charset=([^"'>\s]+)/i
 * или null. Сам регексп с двумя `[^>]+` подряд перебирает пары
 * «http-equiv × content=» внутри тега — квадратично уже на одном длинном теге,
 * и ещё раз с каждого '<meta' внутри него.
 *
 * Разбор того, что регексп находит первым с начала '<meta' (tagEnd — первый '>'
 * после него или конец строки):
 * - `[^>]+` откатывается с конца, но для ответа важно лишь, есть ли
 *   `http-equiv=["']?content-type` в теге (не раньше start+6 — `+` хочет символ);
 *   самое левое такое вхождение даёт самую широкую область для content=;
 * - content= + кавычка — в теге хотя бы на символ правее конца content-type
 *   (кавычка после content-type достаётся либо `["']?`, либо второму `[^>]+`);
 *   регексп берёт самое правое такое content=, у которого дальше есть charset=;
 * - `[^"']*` после кавычки доходит до следующей кавычки (может выйти за '>'),
 *   и в этом отрезке берётся самый правый charset= с непустым значением.
 * Какое из http-equiv выберет откат, на ответ не влияет: ответ определяет
 * самое правое подходящее content=, и оно доступно с любого http-equiv левее.
 * Начала внутри того же тега видят подмножество того же — как в firstTagMatch.
 * Отрезки после разных content= не пересекаются (каждый кончается на кавычке
 * следующего), теги тоже, поэтому всё вместе линейно.
 */
function matchHttpEquivCharset(html: string): string | null {
  const opening = /<meta/gi;
  for (let open = opening.exec(html); open; open = opening.exec(html)) {
    const gt = html.indexOf('>', opening.lastIndex);
    const value = httpEquivCharsetAt(html, open.index, gt === -1 ? html.length : gt);
    if (value !== null || gt === -1) return value;
    opening.lastIndex = gt + 1;
  }
  return null;
}

function httpEquivCharsetAt(html: string, start: number, tagEnd: number): string | null {
  const equiv = /http-equiv=["']?content-type/i.exec(html.slice(start + 6, tagEnd));
  if (!equiv) return null;
  const contentFrom = start + 6 + equiv.index + equiv[0].length + 1;
  const contentAttrs: number[] = [];
  const contentAttr = /content=["']/gi;
  const inTag = html.slice(contentFrom, tagEnd);
  for (let m = contentAttr.exec(inTag); m; m = contentAttr.exec(inTag)) contentAttrs.push(contentFrom + m.index);

  const charsetValue = /[^"'>\s]+/iy;
  for (let i = contentAttrs.length - 1; i >= 0; i -= 1) {
    const valueFrom = contentAttrs[i] + 'content="'.length; // или content=' — длина та же
    const noQuotes = /[^"']*/iy;
    noQuotes.lastIndex = valueFrom;
    noQuotes.test(html); // совпадает всегда, хотя бы пустой строкой
    const attrValue = html.slice(valueFrom, noQuotes.lastIndex);
    const charsets: number[] = [];
    const charsetWord = /charset=/gi;
    for (let m = charsetWord.exec(attrValue); m; m = charsetWord.exec(attrValue)) charsets.push(valueFrom + m.index);
    for (let j = charsets.length - 1; j >= 0; j -= 1) {
      charsetValue.lastIndex = charsets[j] + 'charset='.length;
      const value = charsetValue.exec(html);
      if (value) return value[0];
    }
  }
  return null;
}

function looksLikeBrokenUtf8(text: string): boolean {
  const sample = text.slice(0, 2000);
  const bad = (sample.match(/�/g) ?? []).length;
  return bad >= 8 || sample.includes('����');
}

function decodeHtml(body: ArrayBuffer, contentType: string | null): string {
  const buffer = Buffer.from(body);
  const headerMatch = contentType?.match(/charset=([^;]+)/i);
  const headerCharset = headerMatch ? headerMatch[1].trim().toLowerCase() : null;

  const tryDecode = (charset: string) =>
    iconv.encodingExists(charset) ? iconv.decode(buffer, charset) : '';

  if (headerCharset) {
    const decoded = tryDecode(headerCharset);
    if (decoded) return decoded;
  }

  const decoded = new TextDecoder('utf-8').decode(buffer);
  const metaCharset = extractCharsetFromMeta(decoded);
  if (metaCharset && metaCharset !== 'utf-8' && metaCharset !== 'utf8') {
    const metaDecoded = tryDecode(metaCharset);
    if (metaDecoded) return metaDecoded;
  }

  if (!looksLikeBrokenUtf8(decoded)) return decoded;

  // Russian encoding fallbacks
  const cp1251 = tryDecode('windows-1251');
  if (cp1251) return cp1251;
  const koi8 = tryDecode('koi8-r');
  if (koi8) return koi8;

  return decoded;
}

function isHtmlLikeContentType(contentType: string | null, acceptXml = false): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml') || ct.startsWith('text/plain')
    || (acceptXml && ct.includes('xml'));
}

type PageFetchResult = {
  html: string | null;
  failure: PageFetchFailure | null;
  /** HTTP-статус, когда ответ был получен. Нужен чтобы отличить 403 от обрыва. */
  status?: number;
  /**
   * Только с опцией guard: адрес страницы или шага её редиректа отклонён
   * защитой чтения — на него запрос не уходил. Повтор не нужен: адрес тот же.
   */
  refused?: true;
  /** Requested only by explicit website fallback callers. */
  finalUrl?: string;
  readMethod?: 'browser' | 'tinyfish';
  blocked?: true;
};

async function fetchPage(
  url: string,
  options?: {
    timeout?: number;
    signal?: AbortSignal;
    acceptLanguage?: string;
    dispatcher?: unknown;
    limits?: PageReadLimits;
    trackFinalUrl?: boolean;
    /** ENG sitemap read: XML answers are documents too. */
    acceptXml?: boolean;
  },
): Promise<PageFetchResult> {
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  if (options?.signal?.aborted) return { html: null, failure: null };
  // Hard outer cap: даже если внутренний fetch() зависнет (видели на проде
  // 2026-06-19, undici assert(!this.paused) — body-stream после ассерта
  // может никогда не resolve'иться), эта race гарантирует возврат в
  // bounded time. Цена — потенциально утёкший in-progress сокет, который
  // отвалится сам по своему таймауту; зато processInPool слот свободен.
  // worker'ы Node-process'а параллельно ловят сам ассерт через
  // installUndiciAssertGuard() в app/worker/baseConstructor.ts.
  // Abort/timer снимаем в finally (правка Sergey от 2026-09): без этого
  // на отменённых джобах копились слушатели и таймеры.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const bounded = new Promise<PageFetchResult>((resolve) => {
    onAbort = () => resolve({ html: null, failure: 'Сайт не ответил за отведённое время' });
    timer = setTimeout(onAbort, timeout + 5_000);
    options?.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      fetchPageInner(url, {
        timeout,
        signal: options?.signal,
        acceptLanguage: options?.acceptLanguage,
        dispatcher: options?.dispatcher,
        limits: options?.limits,
        trackFinalUrl: options?.trackFinalUrl,
        acceptXml: options?.acceptXml,
      }),
      bounded,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) options?.signal?.removeEventListener('abort', onAbort);
  }
}

async function fetchPageInner(
  url: string,
  options: {
    timeout: number;
    signal?: AbortSignal;
    acceptLanguage?: string;
    dispatcher?: unknown;
    limits?: PageReadLimits;
    trackFinalUrl?: boolean;
    acceptXml?: boolean;
  },
): Promise<PageFetchResult> {
  const { timeout } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const externalSignal = options.signal;
  const onExternalAbort = () => { clearTimeout(timer); controller.abort(); };
  if (externalSignal?.aborted) onExternalAbort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const dispatcher = await getInsecureTlsDispatcher();

  try {
    // Основной запрос идёт напрямую из воркера. Общий пул PROXY_URLS
    // использовался с 21.07 по 30.07.2026 и был снят: медленные ноды
    // съедали per-page таймаут и джоба на 1000 строк шла час. Прокси
    // остался только как разовый ретрай на 403 — см. fetchWithProxyRetry.
    const init = {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': options.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE,
      },
      signal: controller.signal,
      redirect: 'follow',
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : dispatcher ? { dispatcher } : {}),
    } as RequestInit;
    if (options.limits) return await fetchPageLimited(url, init, options.limits, options.dispatcher, controller.signal, options.trackFinalUrl, options.acceptXml);
    const res = await fetch(url, init);
    const finalUrl = options.trackFinalUrl ? { finalUrl: res.url || url } : {};
    if (res.status >= 400) {
      return { html: null, failure: describeFetchStatus(res.status), status: res.status, ...finalUrl };
    }
    const contentType = res.headers.get('content-type');
    if (!isHtmlLikeContentType(contentType, options.acceptXml)) {
      return { html: null, failure: 'Страница не отдала HTML', status: res.status, ...finalUrl };
    }
    const body = await res.arrayBuffer();
    return { html: decodeHtml(body, contentType), failure: null, status: res.status, ...finalUrl };
  } catch (err) {
    return { html: null, failure: describeFetchError(err) };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Запрос страницы с опциями scrapeEmails guard и/или maxBytes. Без них сюда не
 * заходим: fetchPageInner идёт прежним путём. Заголовки, срок попытки (signal)
 * и выбор маршрута (прямой или прокси) — те же, что у прежнего пути.
 *  - guard: редиректы ведёт вручную fetchFollowingGuarded парсера (та же
 *    функция, что у движка гипотез): checkUrl перед первым запросом и перед
 *    каждым шагом, не больше guard.maxRedirects шагов, схема только
 *    http/https, https → http только при allowHttpDowngrade, Location
 *    перечитывается как UTF-8 так же, как в follow-режиме. Прямой маршрут
 *    идёт через getGuardedDirectDispatcher: адрес проверяется ещё раз при
 *    соединении. Прокси-маршрут (ретрай главной на 403/429) соединяется
 *    нодой прокси, и имя она резолвит сама: проверки при соединении у него
 *    нет, остаётся checkUrl каждого шага нашим резолвером. Наш резолвер не
 *    ответил — checkUrl пропускает, и адрес выбирает прокси; непубличный
 *    адрес на его стороне — сеть провайдера прокси, не наша.
 *  - maxBytes: тело читается потоком и обрывается на потолке (readBodyCapped
 *    парсера); разбираются первые maxBytes байт, как у движка гипотез.
 * Отказ адреса — исход refused (страница не читается), а не исключение.
 * Остальные ошибки уходят в catch fetchPageInner, как у прежнего пути.
 */
async function fetchPageLimited(
  url: string,
  init: RequestInit,
  limits: PageReadLimits,
  proxyDispatcher: unknown,
  signal: AbortSignal,
  trackFinalUrl = false,
  acceptXml = false,
): Promise<PageFetchResult> {
  const parser = await import('@/lib/enrich/websiteParser');
  let res: Response;
  let responseUrl = url;
  try {
    if (limits.guard) {
      const route = proxyDispatcher
        ?? await getGuardedDirectDispatcher(limits.guard, (reason) => new parser.WebsiteAddressRefusedError(reason));
      const guardedInit = { ...init, redirect: 'manual' } as RequestInit & { dispatcher?: unknown };
      if (route) guardedInit.dispatcher = route;
      else delete guardedInit.dispatcher;
      ({ res, url: responseUrl } = await parser.fetchFollowingGuarded(url, guardedInit, limits.guard, signal));
    } else {
      res = await fetch(url, init);
      responseUrl = res.url || url;
    }
  } catch (err) {
    // Отказ при соединении fetch отдаёт как cause своей ошибки.
    if (!addressRefusal(err) && !addressRefusal((err as { cause?: unknown } | null)?.cause)) throw err;
    limits.counts.refused += 1;
    return { html: null, failure: ADDRESS_REFUSED_FAILURE, refused: true };
  }
  const finalUrl = trackFinalUrl ? { finalUrl: responseUrl } : {};
  if (res.status >= 400) {
    return { html: null, failure: describeFetchStatus(res.status), status: res.status, ...finalUrl };
  }
  const contentType = res.headers.get('content-type');
  if (!isHtmlLikeContentType(contentType, acceptXml)) {
    return { html: null, failure: 'Страница не отдала HTML', status: res.status, ...finalUrl };
  }
  const body = limits.maxBytes ? await parser.readBodyCapped(res, limits.maxBytes, url) : await res.arrayBuffer();
  // Ровно maxBytes байт тоже считается: тело дошло до потолка.
  if (limits.maxBytes && body.byteLength >= limits.maxBytes) limits.counts.capped += 1;
  return { html: decodeHtml(body, contentType), failure: null, status: res.status, ...finalUrl };
}

async function fetchPageWithRetry(
  url: string,
  options?: { timeout?: number; signal?: AbortSignal; acceptLanguage?: string; limits?: PageReadLimits },
): Promise<PageFetchResult> {
  let last: PageFetchResult = { html: null, failure: null };
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    if (options?.signal?.aborted) return last;
    last = await fetchPage(url, options);
    if (last.html) return last;
    // Отклонённый адрес (только с опцией guard) второй попыткой не станет другим.
    if (last.refused) return last;
    if (options?.signal?.aborted) return last;
    if (attempt < FETCH_RETRIES) await sleep(FETCH_RETRY_DELAY_MS * (attempt + 1));
  }
  return last;
}

/**
 * Скачанные страницы одного сайта: адрес без хвоста (#, ?, /) → HTML. Заводит
 * вызывающий на компанию — поиск почты и разбор сайта тогда качают сайт один
 * раз, а не дважды. Хранятся только открывшиеся страницы.
 */
export type SitePageCache = Map<string, string>;

export function sitePageKey(url: string): string {
  return stripUrlTail(url);
}

/**
 * HTML одной страницы с той же обработкой кодировок (cp1251/koi8-r) и
 * ретраями, что и обход в scrapeEmails. Нужен тем, кто читает сайт компании
 * ради текста, а не почты (сигналы «Нашего автоаутрича»).
 */
export async function fetchSitePageHtml(
  url: string,
  options?: { timeout?: number; signal?: AbortSignal; pageCache?: SitePageCache },
): Promise<string | null> {
  const cached = options?.pageCache?.get(sitePageKey(url));
  if (cached !== undefined) return cached;
  const result = await fetchPageWithRetry(url, options);
  if (result.html) options?.pageCache?.set(sitePageKey(url), result.html);
  return result.html;
}

/**
 * Один ретрай через прокси, если сайт отказал нам по IP (403/429). Прямой
 * запрос к этому моменту уже отработал и провалился быстро — ответ пришёл,
 * просто отказной, так что удлинения строки почти нет.
 *
 * Пропуск в пул берём без ожидания: прокси общие с парсерами Яндекс.Карт,
 * и вставать к ним в очередь ради одного домена дороже, чем этот домен
 * пропустить. Не досталось слота — возвращаем исходный 403 как есть.
 */
async function fetchPageWithProxyRetry(
  url: string,
  direct: PageFetchResult,
  options?: { timeout?: number; signal?: AbortSignal; acceptLanguage?: string; limits?: PageReadLimits },
): Promise<PageFetchResult> {
  if (!PROXY_RETRY_ENABLED) return direct;
  if (direct.html || direct.status === undefined) return direct;
  if (!PROXY_RETRY_STATUSES.has(direct.status)) return direct;
  if (options?.signal?.aborted) return direct;

  const release = tryAcquireProxySlot();
  if (!release) return direct;

  const viaProxy = async (dispatcher: unknown): Promise<PageFetchResult | null> => {
    if (!dispatcher || options?.signal?.aborted) return null;
    const res = await fetchPage(url, {
      timeout: Math.min(options?.timeout ?? FETCH_TIMEOUT_MS, PROXY_RETRY_TIMEOUT_MS),
      signal: options?.signal,
      acceptLanguage: options?.acceptLanguage,
      dispatcher,
      limits: options?.limits,
    });
    return res.html ? res : null;
  };

  try {
    // Сначала RU: для RU-сайтов это основной шанс. Не вышло — одна попытка
    // через ноду из другой подсети. Сайты режут прокси блоками по подсетям
    // провайдера (замер 23.09.2026, 98 сайтов × 8 нод), поэтому вторая нода
    // из той же RU-подсети почти ничего не добавила бы, а другая подсеть
    // открывает то, что RU не открывает (eksis.ru). Слот один на обе
    // попытки — лимит одновременных проксированных запросов не растёт.
    return (
      (await viaProxy(await getProxyDispatcher(true)))
      ?? (await viaProxy(await getNonPriorityProxyDispatcher()))
      ?? direct
    );
  } catch {
    return direct;
  } finally {
    release();
  }
}

// ── Link discovery from HTML ───────────────────────────────────

async function discoverEmailPageLinks(html: string, baseUrl: string, ruFallback = false): Promise<string[]> {
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const results: string[] = [];

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;

    const linkText = ($(el).text() ?? '').trim();
    const contactLink = LINK_HREF_PATTERN.test(href) || LINK_TEXT_PATTERN.test(linkText);
    if (!contactLink && !ruFallback) return;

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, baseUrl).href;
    } catch {
      return;
    }

    if (ruFallback) {
      // JavaScript \b does not recognize Cyrillic words. Resolve relative
      // contact paths against the actual page URL before classifying them.
      if (!contactLink && !LINK_HREF_PATTERN.test(new URL(absoluteUrl).pathname)
        && !/(?:контакты|о\s*компании|о\s*нас|команда|сотрудники|связаться|написать|обратн(?:ая|ой)\s+связ(?:ь|и)|почта)/iu.test(linkText)) return;
      if (new URL(absoluteUrl).origin !== origin) return;
    } else if (!absoluteUrl.startsWith(origin)) return;
    const normalized = stripUrlTail(absoluteUrl);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    results.push(absoluteUrl);
  });

  return results;
}

type EngContactFailure =
  | 'invalid_url' | 'http_error' | 'timeout' | 'dns' | 'tls' | 'connection'
  | 'network_error' | 'address_refused' | 'cross_site_redirect' | 'non_html' | 'parse_error';
type EngContactPageKind = 'home' | 'contact' | 'legal' | 'about' | 'team' | 'fallback';
type EngContactPageSource = 'input' | 'discovered' | 'static' | 'www_fallback' | 'http_fallback' | 'sitemap';

/** Operational counts and bounded, redacted URLs; never mailbox values or response bodies. */
export type EngContactDiagnostics = {
  version: 1;
  strategy: 'eng_contact_first';
  maxPages: number;
  maxAttempts: number;
  attempts: number;
  stopReason: 'completed' | 'page_limit' | 'attempt_limit' | 'deadline' | 'usable_email';
  failure?: EngContactFailure;
  pagesRead: number;
  emailsFound: number;
  rawEmailsFound: number;
  pages: Array<{
    url: string;
    finalUrl?: string;
    kind: EngContactPageKind;
    source: EngContactPageSource;
    route: 'direct' | 'proxy' | 'browser' | 'tinyfish';
    status?: number;
    outcome: 'read' | 'http_error' | 'timeout' | 'network_error' | 'address_refused' | 'non_html' | 'parse_error';
    failure?: EngContactFailure;
    emailsFound: number;
  }>;
};

type EngContactCandidate = {
  url: string;
  kind: EngContactPageKind;
  source: EngContactPageSource;
  priority: number;
  depth: number;
};

function contactDiagnosticUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Paths can occasionally contain mailboxes, too; do not retain those in diagnostics.
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* Keep the bounded encoded path. */ }
    path = path.replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]');
    return `${url.protocol}//${url.host}${path.slice(0, 240)}`;
  } catch { return '[invalid-url]'; }
}

function plainWebUrl(candidate: string): boolean {
  try {
    const a = new URL(candidate);
    return (a.protocol === 'https:' || a.protocol === 'http:')
      && !a.username && !a.password
      && (!a.port || a.port === '80' || a.port === '443');
  } catch { return false; }
}

function sameContactSite(candidate: string, root: string): boolean {
  try {
    return plainWebUrl(candidate)
      && new URL(candidate).hostname.toLowerCase().replace(/^www\./, '') === new URL(root).hostname.toLowerCase().replace(/^www\./, '');
  } catch { return false; }
}

/** Sitemap entries worth a page read; the rest of a large sitemap is ignored. */
const SITEMAP_MAX_LOCS = 5000;
/** Per page kind: a sitemap with ten «contact-…» pages must not crowd out the legal page. */
const SITEMAP_PAGES_PER_KIND = 2;
/** Contact pages read per site, whatever their source; the legal page often holds the address. */
const MAX_CONTACT_PAGE_ATTEMPTS = 3;
/** Enough for thousands of entries; a site map of a big portal is not read whole. */
const SITEMAP_MAX_BYTES = 1024 * 1024;

function sitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    locs.push(match[1].replace(/&amp;/g, '&'));
    if (locs.length >= SITEMAP_MAX_LOCS) break;
  }
  return locs;
}

/** ENG pages may route by query; the shared legacy cache key intentionally does not. */
function engContactPageKey(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  let end = url.pathname.length;
  while (end > 0 && url.pathname.charCodeAt(end - 1) === 47) end -= 1;
  return `${url.origin}${url.pathname.slice(0, end)}${url.search}`;
}

function contactCandidateKind(href: string, text: string): { kind: EngContactPageKind; priority: number } | null {
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(href).pathname); } catch { /* Label may still identify the page. */ }
  const words = `${pathname.replace(/[/_.-]+/g, ' ')} ${text}`.toLowerCase();
  if (/\b(contact(?:s|ez)?|kontakt(?:e|ieren)?|contatti|contato|contacto)\b/.test(words)) {
    return { kind: 'contact', priority: 100 };
  }
  if (/\b(imprint|impressum|legal|rechtliches|mentions legales)\b/.test(words)) {
    return { kind: 'legal', priority: 90 };
  }
  if (/\b(privacy|datenschutz|confidentialit[eé]|data protection)\b/.test(words)) {
    return { kind: 'legal', priority: 80 };
  }
  if (/\b(about|company|über uns|uber uns)\b/.test(words)) return { kind: 'about', priority: 30 };
  if (/\b(team|staff|people)\b/.test(words)) return { kind: 'team', priority: 20 };
  return null;
}

async function discoverEngContactPages(html: string, baseUrl: string, ownSite: (url: string) => boolean, depth: number): Promise<EngContactCandidate[]> {
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const candidates: EngContactCandidate[] = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;
    let url: string;
    try { url = new URL(href, baseUrl).href; } catch { return; }
    if (!ownSite(url)) return;
    const normalized = engContactPageKey(url);
    if (seen.has(normalized)) return;
    const kind = contactCandidateKind(url, ($(el).text() ?? '').trim());
    if (!kind) return;
    seen.add(normalized);
    candidates.push({ url, ...kind, source: 'discovered', depth });
  });
  // HTML order is only a tie-breaker, so an early About menu cannot hide footer contacts.
  return candidates.sort((a, b) => b.priority - a.priority).slice(0, 40);
}

function contactFetchFailure(result: PageFetchResult): EngContactFailure {
  if (result.refused) return 'address_refused';
  if (result.blocked) return 'http_error';
  if (result.status !== undefined && result.status >= 400) return 'http_error';
  if (result.failure === 'Страница не отдала HTML') return 'non_html';
  if (result.failure === 'Сайт не ответил за отведённое время') return 'timeout';
  if (result.failure === 'Домен не резолвится') return 'dns';
  if (result.failure === 'Сертификат сайта не прошёл проверку' || result.failure === 'Ошибка TLS-соединения') return 'tls';
  if (result.failure === 'Соединение отклонено' || result.failure === 'Соединение разорвано' || result.failure === 'Хост недоступен') return 'connection';
  return 'network_error';
}

/** Separate opt-in path: callers without the strategy keep the legacy crawler below. */
async function scrapeEngContactEmails(
  rawUrl: string,
  options: NonNullable<Parameters<typeof scrapeEmails>[1]>,
): Promise<ScrapeEmailsResult> {
  const maxPages = Math.max(1, Math.min(20, Math.floor(Number(options.maxPages) || DEFAULT_MAX_PAGES)));
  const maxAttempts = Math.min(2 * maxPages, 12);
  const diagnostics: EngContactDiagnostics = {
    version: 1, strategy: 'eng_contact_first', maxPages, maxAttempts, attempts: 0,
    stopReason: 'completed', pagesRead: 0, emailsFound: 0, rawEmailsFound: 0, pages: [],
  };
  const allEmails = new Set<string>();
  const checkedUrls: string[] = [];
  let siteName: string | null = null;
  let description: string | undefined;
  const websiteEvidencePages: Array<{ url: string; text: string; truncated?: boolean; readMethod?: 'browser' | 'tinyfish' }> = [];
  let mainFailure: PageFetchFailure | null = null;
  const limits: PageReadLimits | undefined = options.guard || options.maxBytes
    ? { guard: options.guard, maxBytes: options.maxBytes, counts: { refused: 0, capped: 0 } } : undefined;
  const finish = (): ScrapeEmailsResult => {
    const allEmailsRaw = [...allEmails];
    const emails = filterJunkEmails(allEmailsRaw);
    diagnostics.rawEmailsFound = allEmailsRaw.length;
    diagnostics.emailsFound = emails.length;
    return {
      emails, allEmailsRaw, checkedUrls, pagesScanned: checkedUrls.length, siteName,
      ...(description ? { description } : {}),
      ...(websiteEvidencePages.length ? { websiteEvidencePages } : {}),
      failureReason: mainFailure,
      ...(limits ? { readLimits: { ...limits.counts } } : {}),
      contactDiagnostics: diagnostics,
    };
  };
  let root: string;
  try {
    root = normalizeUrl(rawUrl);
    if (!sameContactSite(root, root)) throw new Error('invalid_url');
  } catch {
    diagnostics.failure = 'invalid_url';
    mainFailure = 'Некорректный адрес сайта';
    return finish();
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const deadline = setTimeout(abort, 30_000);
  const seen = new Set<string>();
  const readFinalUrls = new Set<string>();
  const queue: EngContactCandidate[] = [];
  const queued = new Set<string>();
  // The company's own site: the catalog host with its subdomains, plus a
  // domain of the same brand that one of its pages redirected to.
  const aliasSites = new Set<string>();
  const ownSite = (url: string) => sameContactSite(url, root)
    || (plainWebUrl(url) && (sameCompanySiteBoundary(url, root) || aliasSites.has(companySiteBoundary(url) ?? '')));
  const canFetch = () => !controller.signal.aborted && diagnostics.attempts < maxAttempts && diagnostics.pagesRead < maxPages;
  const enqueue = (candidate: EngContactCandidate) => {
    const key = engContactPageKey(candidate.url);
    if (!ownSite(candidate.url) || seen.has(key) || queued.has(key)) return;
    queued.add(key);
    queue.push(candidate);
    queue.sort((a, b) => b.priority - a.priority);
    if (queue.length > 40) queue.length = 40;
  };
  const read = async (candidate: EngContactCandidate, dispatcher?: unknown): Promise<PageFetchResult> => {
    diagnostics.attempts += 1;
    if (!seen.has(engContactPageKey(candidate.url))) checkedUrls.push(candidate.url);
    seen.add(engContactPageKey(candidate.url));
    const cached = dispatcher ? undefined : options.pageCache?.get(engContactPageKey(candidate.url));
    let result: PageFetchResult;
    try {
      result = cached !== undefined
        ? { html: cached, failure: null, finalUrl: candidate.url }
        : await fetchPage(candidate.url, {
          timeout: Math.min(Math.max(1, options.timeout ?? FETCH_TIMEOUT_MS), 8_000),
          signal: controller.signal, acceptLanguage: EN_ACCEPT_LANGUAGE, limits, dispatcher, trackFinalUrl: true,
        });
    } catch {
      result = { html: null, failure: 'Сайт не открылся' };
    }
    // ENG contact crawl only. A proxy/cache/unknown/blocked response never starts a renderer.
    if (!dispatcher && cached === undefined && !controller.signal.aborted && process.env.ENG_BROWSER_ENABLED === '1') {
      try {
        const { isEngHtmlBlocked } = await import('./engPageFallbackPolicy');
        if (result.html && isEngHtmlBlocked(result.html)) result = { ...result, html: null, failure: 'Страница закрыта проверкой доступа', blocked: true };
        const { fetchEngPageFallback } = await import('./engPageFallback');
        const fallback = await fetchEngPageFallback({ url: result.finalUrl || candidate.url, companyUrl: candidate.url,
          html: result.html, status: result.status, signal: controller.signal });
        if (fallback) {
          // Rendering can remove a footer: retain addresses literally present in the direct response too.
          if (result.html) for (const email of extractEmailsFromHtmlAdvanced(result.html)) allEmails.add(email);
          result = { html: fallback.html, finalUrl: fallback.url, failure: null, status: 200, readMethod: fallback.source };
        }
      } catch { /* The crawl's deadline preserves results already collected. */ }
    }
    const page: EngContactDiagnostics['pages'][number] = {
      url: contactDiagnosticUrl(candidate.url),
      ...(result.finalUrl ? { finalUrl: contactDiagnosticUrl(result.finalUrl) } : {}),
      kind: candidate.kind, source: candidate.source, route: result.readMethod ?? (dispatcher ? 'proxy' : 'direct'),
      ...(result.status !== undefined ? { status: result.status } : {}),
      outcome: 'read', emailsFound: 0,
    };
    diagnostics.pages.push(page);
    const finalUrl = result.finalUrl || candidate.url;
    if (!ownSite(finalUrl)) {
      // Only an observed redirect introduces another domain, and only one of the same brand.
      const alias = options.companyName && plainWebUrl(finalUrl) ? companySiteAlias(finalUrl, root, options.companyName) : null;
      if (!alias) {
        page.outcome = 'address_refused';
        page.failure = 'cross_site_redirect';
        return { html: null, failure: ADDRESS_REFUSED_FAILURE, refused: true };
      }
      aliasSites.add(companySiteBoundary(finalUrl) ?? finalUrl);
    }
    if (!result.html) {
      const failure = contactFetchFailure(result);
      page.failure = failure;
      page.outcome = failure === 'address_refused' || failure === 'http_error' || failure === 'timeout' || failure === 'non_html'
        ? failure : 'network_error';
      return result;
    }
    const finalKey = engContactPageKey(finalUrl);
    if (!readFinalUrls.has(finalKey)) {
      diagnostics.pagesRead += 1;
      readFinalUrls.add(finalKey);
    }
    seen.add(finalKey);
    // String-only caches cannot preserve provenance; fallback pages have a typed evidence record instead.
    if (!result.readMethod) options.pageCache?.set(engContactPageKey(finalUrl), result.html);
    try {
      const emails = extractEmailsFromHtmlAdvanced(result.html);
      for (const email of emails) allEmails.add(email);
      page.emailsFound = filterJunkEmails(emails).length;
    } catch {
      page.outcome = 'parse_error';
      page.failure = 'parse_error';
    }
    if (candidate.kind === 'home') {
      siteName = extractSiteName(result.html);
      if (options.includeDescription) {
        try { description = (await import('@/lib/enrich/websiteParser')).reusableMainPageDescription(result.html); }
        catch { /* Email results remain available if optional description parsing fails. */ }
      }
    }
    // ENG only: preserve the actual source already read while finding contacts.
    // A generic Description cell cannot prove where its text came from.
    if (options.includeDescription && websiteEvidencePages.length < 3) {
      try {
        const text = (await import('@/lib/enrich/websiteParser')).extractTextFromHtml(result.html);
        if (text.trim()) websiteEvidencePages.push({ url: finalUrl, text: text.slice(0, 6000), ...(text.length > 6000 ? { truncated: true } : {}),
          ...(result.readMethod ? { readMethod: result.readMethod } : {}) });
      } catch { /* Optional evidence must not discard collected addresses. */ }
    }
    if (candidate.depth < 2) {
      try {
        for (const link of await discoverEngContactPages(result.html, finalUrl, ownSite, candidate.depth + 1)) enqueue(link);
      } catch {
        page.outcome = 'parse_error';
        page.failure = 'parse_error';
      }
    }
    return result;
  };
  const readHome = async (candidate: EngContactCandidate): Promise<PageFetchResult> => {
    let result = await read(candidate);
    if (PROXY_RETRY_ENABLED && process.env.ENG_BROWSER_ENABLED !== '1' && !result.html && result.status !== undefined && PROXY_RETRY_STATUSES.has(result.status) && canFetch()) {
      const release = tryAcquireProxySlot();
      if (release) {
        try {
          // Existing configured website proxies only. Every route consumes the same attempt budget.
          for (const getDispatcher of [getNonPriorityProxyDispatcher, () => getProxyDispatcher(true)]) {
            if (!canFetch()) break;
            const dispatcher = await getDispatcher();
            if (!dispatcher || !canFetch()) continue;
            result = await read(candidate, dispatcher);
            if (result.html || result.refused) break;
          }
        } catch { /* Keep the recorded direct/proxy result. */ }
        finally { release(); }
      }
    }
    return result;
  };
  // Contact pages that a script menu hides from the HTML are often listed in
  // sitemap.xml. One index hop at most; every read spends the attempt budget.
  const readSitemap = async (base: string): Promise<void> => {
    let url: string | null = new URL('/sitemap.xml', base).href;
    const sitemapLimits: PageReadLimits = {
      ...(limits ?? { counts: { refused: 0, capped: 0 } }),
      maxBytes: Math.min(limits?.maxBytes ?? SITEMAP_MAX_BYTES, SITEMAP_MAX_BYTES),
    };
    for (let hop = 0; url && hop < 2 && canFetch(); hop += 1) {
      diagnostics.attempts += 1;
      let result: PageFetchResult;
      try {
        result = await fetchPage(url, {
          timeout: Math.min(Math.max(1, options.timeout ?? FETCH_TIMEOUT_MS), 8_000),
          signal: controller.signal, acceptLanguage: EN_ACCEPT_LANGUAGE, limits: sitemapLimits, trackFinalUrl: true, acceptXml: true,
        });
      } catch { return; }
      if (!result.html || !ownSite(result.finalUrl || url)) return;
      const locs = sitemapLocs(result.html).filter(ownSite);
      if (/<sitemapindex/i.test(result.html)) {
        url = locs.find((loc) => /page/i.test(new URL(loc).pathname)) ?? locs[0] ?? null;
        continue;
      }
      const perKind = new Map<EngContactPageKind, number>();
      const pages = locs.flatMap((loc) => {
        const kind = contactCandidateKind(loc, '');
        return kind ? [{ url: loc, ...kind }] : [];
      }).sort((a, b) => b.priority - a.priority || a.url.length - b.url.length)
        .filter((page) => {
          const taken = perKind.get(page.kind) ?? 0;
          perKind.set(page.kind, taken + 1);
          return taken < SITEMAP_PAGES_PER_KIND;
        });
      for (const page of pages) enqueue({ ...page, source: 'sitemap', depth: 1 });
      return;
    }
  };
  try {
    let home: PageFetchResult = { html: null, failure: null };
    if (canFetch()) home = await readHome({ url: root, kind: 'home', source: 'input', priority: 200, depth: 0 });
    if (process.env.ENG_BROWSER_ENABLED === '1' && (home.blocked || [401, 403, 407, 429, 451].includes(home.status ?? 0))) {
      mainFailure = home.failure;
      diagnostics.failure = 'http_error';
      return finish();
    }
    const rootUrl = new URL(root);
    if (!home.html && !home.refused && !rootUrl.hostname.startsWith('www.')
      && !/^[\d.]+$|:/.test(rootUrl.hostname) && canFetch()) {
      const www = new URL(root);
      www.hostname = `www.${www.hostname}`;
      home = await readHome({ url: www.href, kind: 'home', source: 'www_fallback', priority: 200, depth: 0 });
    }
    // TLS that Node cannot negotiate, or a closed 443, often still leaves the site on plain http.
    const homeFailure = home.html || home.refused ? null : contactFetchFailure(home);
    if (rootUrl.protocol === 'https:' && (homeFailure === 'tls' || homeFailure === 'connection') && canFetch()) {
      const plain = new URL(root);
      plain.protocol = 'http:';
      home = await readHome({ url: plain.href, kind: 'home', source: 'http_fallback', priority: 200, depth: 0 });
    }
    mainFailure = home.html ? null : home.failure;
    const base = home.html && home.finalUrl ? home.finalUrl : root;
    if (home.html) await readSitemap(base);
    const staticPaths = ['/contact', '/contact-us', '/kontakt', '/impressum', '/imprint', '/privacy', '/datenschutz', '/legal'];
    for (const path of staticPaths) {
      enqueue({ url: new URL(path, base).href, kind: 'fallback', source: 'static', priority: 10, depth: 1 });
    }
    let contactAttempts = 0;
    while (queue.length > 0 && canFetch()) {
      if (options.stopAtFirstUsableEmail && filterJunkEmails([...allEmails]).length > 0) break;
      const candidate = queue.shift()!;
      if (seen.has(engContactPageKey(candidate.url))) continue;
      if (candidate.kind === 'contact' && contactAttempts >= MAX_CONTACT_PAGE_ATTEMPTS) continue;
      if (candidate.kind === 'contact') contactAttempts += 1;
      await read(candidate);
    }
    if (controller.signal.aborted) diagnostics.stopReason = 'deadline';
    else if (options.stopAtFirstUsableEmail && filterJunkEmails([...allEmails]).length > 0) diagnostics.stopReason = 'usable_email';
    else if (diagnostics.pagesRead >= maxPages) diagnostics.stopReason = 'page_limit';
    else if (diagnostics.attempts >= maxAttempts) diagnostics.stopReason = 'attempt_limit';
    if (diagnostics.pagesRead === 0) diagnostics.failure = diagnostics.pages[0]?.failure ?? 'timeout';
    return finish();
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
  }
}

// ── Main scraper function ──────────────────────────────────────

export type ScrapeEmailsResult = {
  emails: string[];
  allEmailsRaw: string[];
  checkedUrls: string[];
  pagesScanned: number;
  /** Кандидат-название компании с главной страницы (og:site_name / <title>).
   *  Сырое — финальная чистка делается отдельно (AI cleanCompanyNames). */
  siteName: string | null;
  /** Opt-in, extracted with the description parser's existing sufficiency rule. */
  description?: string;
  /** ENG contact-first only: actual fetched URLs, before display-description truncation. */
  websiteEvidencePages?: Array<{ url: string; text: string; truncated?: boolean; readMethod?: 'browser' | 'tinyfish' }>;
  /**
   * Почему не удалось прочитать главную страницу: сертификат, 403, таймаут,
   * DNS. null — главная открылась (адресов на сайте может всё равно не быть).
   * Нужен чтобы отличать «сайт не открылся» от «почты на сайте нет»: раньше
   * оба случая приходили одинаковой пустой строкой.
   */
  failureReason: PageFetchFailure | null;
  /**
   * Только с опцией guard или maxBytes (без них поля нет): refused — сколько
   * раз защита чтения отклонила адрес страницы или шага её редиректа, на
   * отклонённый адрес запрос не уходил; capped — сколько ответов дочитано до
   * потолка maxBytes (разобраны первые maxBytes байт).
   */
  readLimits?: { refused: number; capped: number };
  contactDiagnostics?: EngContactDiagnostics;
};

/**
 * Scrape emails from a website by crawling main page + contact/about/team pages.
 *
 * Key improvements over basic scrapers:
 * - Crawls ALL candidate pages (doesn't stop at first email)
 * - Advanced deobfuscation (10+ patterns)
 * - JSON-LD / Schema.org parsing
 * - data-attribute scanning
 * - Smart junk filtering
 * - Encoding handling (UTF-8, Windows-1251, KOI8-R)
 */
export async function scrapeEmails(
  rawUrl: string,
  options?: {
    timeout?: number;
    signal?: AbortSignal;
    maxPages?: number;
    /**
     * When true, scraping returns as soon as ≥1 email survives the
     * `filterJunkEmails` filter. Skips the rest of the candidate
     * page crawl. Used by base-constructor's `find_emails` step where
     * one usable address per company is enough — saves up to 4 extra
     * page fetches × per dead/slow host × 4000+ rows.
     *
     * Default false: callers (e.g. websiteEnrichmentWorker, bugor /
     * eventOutreach findEmails) want as many addresses as they can
     * get and don't mind crawling more pages.
     */
    stopAtFirstUsableEmail?: boolean;
    /**
     * Локаль джобы конструктора баз ('ru' default — обратная совместимость).
     * При 'en':
     *   - Accept-Language запросов → 'en-US,en';
     *   - в обходе кандидат-страниц EN-пути (/contact, /contact-us, /about,
     *     /team, /company) идут первыми; RU-пути остаются в списке дальше.
     * Пробрасывается из stepFindEmails (job.locale конструктора баз).
     */
    locale?: 'ru' | 'en';
    /** ENG caller opt-in only; undefined preserves the legacy traversal and result shape. */
    contactPageStrategy?: 'eng_contact_first';
    /** VE2 RU callers only. TinyFish is reserved for an admitted deficit pass. */
    ruPageFallback?: { tinyfish: boolean };
    includeDescription?: boolean;
    /**
     * Защита чтения (WebsiteFetchGuard, например createUsWebsiteFetchGuard из
     * enrich/publicAddress.ts) для КАЖДОГО запроса обхода: главная, www,
     * найденные ссылки, статичные пути, прокси-ретрай. Редиректы — вручную, с
     * проверкой каждого шага (см. fetchPageLimited). Отклонённый адрес — как
     * страница, которая не открылась: обход идёт дальше, повтора нет. Не
     * передана — redirect: 'follow', как до неё.
     */
    guard?: WebsiteFetchGuard;
    /** Потолок тела каждого ответа в байтах; не передан — тело читается целиком. */
    maxBytes?: number;
    /** Страницы, которые уже скачаны или ещё понадобятся вызывающему (fetchSitePageHtml). */
    pageCache?: SitePageCache;
    /**
     * ENG contact-first only: the company name lets a redirect to a domain of
     * the same brand count as the company's site (companySiteAlias).
     */
    companyName?: string;
  },
): Promise<ScrapeEmailsResult> {
  if (options?.locale === 'en' && options.contactPageStrategy === 'eng_contact_first') {
    return scrapeEngContactEmails(rawUrl, options);
  }
  if (options?.locale === 'ru' && options.ruPageFallback && process.env.RU_BROWSER_ENABLED === '1') {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const deadline = setTimeout(abort, 30_000);
    try { return await scrapeLegacyEmails(rawUrl, { ...options, signal: controller.signal }); }
    finally { clearTimeout(deadline); options.signal?.removeEventListener('abort', abort); }
  }
  return scrapeLegacyEmails(rawUrl, options);
}

async function scrapeLegacyEmails(
  rawUrl: string, options?: NonNullable<Parameters<typeof scrapeEmails>[1]>,
): Promise<ScrapeEmailsResult> {
  const url = normalizeUrl(rawUrl);
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  const signal = options?.signal;
  const maxPages = Math.max(1, Math.min(20, options?.maxPages ?? DEFAULT_MAX_PAGES));
  const stopAtFirstUsableEmail = options?.stopAtFirstUsableEmail === true;
  const locale = options?.locale === 'en' ? 'en' : 'ru';
  const ruFallback = locale === 'ru' && !!options?.ruPageFallback && process.env.RU_BROWSER_ENABLED === '1';
  const acceptLanguage = locale === 'en' ? EN_ACCEPT_LANGUAGE : DEFAULT_ACCEPT_LANGUAGE;
  const origin = new URL(url).origin;
  const tryWithWww = !/^https?:\/\/www\./i.test(url);
  const wwwOrigin = tryWithWww ? origin.replace(/^https?:\/\//i, (m) => `${m}www.`) : null;

  const allEmails = new Set<string>();
  const checkedUrls: string[] = [];
  const checkedNormalized = new Set<string>();
  // Только с опциями guard/maxBytes; без них fetchPage* получают прежние объекты опций.
  const limits: PageReadLimits | null = options?.guard || options?.maxBytes
    ? { guard: options.guard, maxBytes: options.maxBytes, counts: { refused: 0, capped: 0 } }
    : null;
  const limitsOption = limits ? { limits } : {};
  const readLimitsField = () => (limits ? { readLimits: { ...limits.counts } } : {});

  // Helper: have we collected at least one email that survives the
  // junk filter? Cheap enough to call between pages — filterJunkEmails
  // is pure regex on a small set. Used for early-exit when caller
  // opted in via stopAtFirstUsableEmail.
  const hasUsableEmail = (): boolean =>
    stopAtFirstUsableEmail &&
    allEmails.size > 0 &&
    filterJunkEmails(Array.from(allEmails)).length > 0;

  const normalizeForDedupe = stripUrlTail;

  const processPage = (html: string) => {
    for (const e of extractEmailsFromHtmlAdvanced(html)) allEmails.add(e);
  };

  // Причина, по которой не открылась главная. Пишется только для неё:
  // отвал отдельной /contacts ни о чём не говорит, а отвал главной — это
  // ровно тот случай, когда «почт нет» на самом деле значит «мы не смотрели».
  let mainFailure: PageFetchFailure | null = null;
  let accessBlocked = false;
  let mainPageUrl = url;

  const tryFetch = async (pageUrl: string, isMain = false): Promise<string | null> => {
    const normalized = normalizeForDedupe(pageUrl);
    if (checkedNormalized.has(normalized)) return null;
    if (checkedUrls.length >= maxPages) return null;
    if (signal?.aborted || accessBlocked) return null;

    checkedNormalized.add(normalized);
    checkedUrls.push(pageUrl);
    const cached = options?.pageCache?.get(sitePageKey(pageUrl));
    if (cached !== undefined && !ruFallback) return cached;
    // RU fallback needs a real observed HTTP status/final URL. A string-only
    // cache, proxy retry or ambiguous response must not admit a renderer.
    let result = ruFallback
      ? await fetchPage(pageUrl, { timeout: Math.min(timeout, 8_000), signal, acceptLanguage, ...limitsOption, trackFinalUrl: true })
      : await fetchPageWithRetry(pageUrl, { timeout, signal, acceptLanguage, ...limitsOption });
    if (ruFallback) {
      try {
        const { isEngHtmlBlocked } = await import('./engPageFallbackPolicy');
        if ([401, 403, 407, 429, 451].includes(result.status ?? 0) || result.html && isEngHtmlBlocked(result.html)) {
          // A public page can embed a CAPTCHA in its contact form. Preserve
          // addresses already present in a successful direct response, as the
          // legacy RU reader did, without rendering or publishing wall HTML as
          // company evidence. Status refusals never contribute addresses.
          if (result.html && result.status !== undefined && result.status >= 200 && result.status < 300) processPage(result.html);
          result = { ...result, html: null, blocked: true, failure: 'Страница закрыта проверкой доступа' };
          accessBlocked = true;
        } else if (!result.html || filterJunkEmails(extractEmailsFromHtmlAdvanced(result.html)).length === 0) {
          const { fetchEngPageFallback } = await import('./engPageFallback');
          const fallback = await fetchEngPageFallback({ url: result.finalUrl || pageUrl, companyUrl: url,
            html: result.html, status: result.status, signal, locale: 'ru', ruDeficit: options?.ruPageFallback?.tinyfish === true });
          if (fallback) {
            // A renderer may omit a useful footer. Preserve literal original
            // addresses and leave company/site/INN ownership to the constructor.
            if (result.html) processPage(result.html);
            result = { html: fallback.html, finalUrl: fallback.url, failure: null, status: 200, readMethod: fallback.source };
          }
        }
      } catch { /* Keep observed HTTP content and already collected addresses. */ }
    }
    // Прокси тратим только на главную: если она за бот-защитой, остальные
    // страницы того же сайта за ней же, а ретраить каждую — это и есть
    // тот июльский сценарий, когда джоба на 1000 строк шла час.
    if (!ruFallback && isMain && !result.html) {
      result = await fetchPageWithProxyRetry(pageUrl, result, { timeout, signal, acceptLanguage, ...limitsOption });
    }
    if (ruFallback && isMain && result.html && result.finalUrl) mainPageUrl = result.finalUrl;
    if (isMain && !result.html && result.failure) mainFailure = result.failure;
    if (result.html && !result.readMethod) options?.pageCache?.set(sitePageKey(pageUrl), result.html);
    return result.html;
  };

  // 1. Fetch main page
  let mainHtml = await tryFetch(url, true);
  if (!mainHtml && tryWithWww && wwwOrigin) {
    mainHtml = await tryFetch(wwwOrigin, true);
  }

  // Название компании берём с главной (og:site_name / <title>) — бесплатно,
  // страница уже загружена. Используется как фоллбек когда нет имени из ФНС.
  const siteName = mainHtml ? extractSiteName(mainHtml) : null;
  let description: string | undefined;
  if (options?.includeDescription && mainHtml) {
    try { description = (await import('@/lib/enrich/websiteParser')).reusableMainPageDescription(mainHtml); }
    catch { /* Optional enrichment must never discard discovered email addresses. */ }
  }

  // Discover internal links from main page
  let discoveredLinks: string[] = [];
  if (mainHtml) {
    processPage(mainHtml);
    // Early-exit: if the main page already gave us a usable address,
    // skip the link discovery + candidate crawl. Saves up to 4 extra
    // fetches per company. The typical healthy B2B site has its
    // contact email on the homepage or in the header, so this lands
    // on most rows. Opt-in per caller via stopAtFirstUsableEmail.
    if (hasUsableEmail()) {
      const allEmailsRawEarly = Array.from(allEmails);
      return {
        emails: filterJunkEmails(allEmailsRawEarly),
        allEmailsRaw: allEmailsRawEarly,
        checkedUrls,
        pagesScanned: checkedUrls.length,
        siteName,
        ...(description ? { description } : {}),
        failureReason: mainFailure,
        ...readLimitsField(),
      };
    }
    discoveredLinks = await discoverEmailPageLinks(mainHtml, ruFallback ? mainPageUrl : url, ruFallback);
  }

  // 2. Build candidate pages: discovered links first, then static paths
  const candidateUrls: string[] = [];
  const candidateSeen = new Set<string>();

  const addCandidate = (u: string) => {
    const norm = normalizeForDedupe(u);
    if (candidateSeen.has(norm)) return;
    candidateSeen.add(norm);
    candidateUrls.push(u);
  };

  // Discovered links from page have highest priority
  for (const link of discoveredLinks) addCandidate(link);

  // Статичные пути: при locale='en' сначала EN-приоритетные (см. комментарий
  // к EN_PRIORITY_PATHS), дальше общий список; дубли отсекает addCandidate.
  const staticPaths = locale === 'en'
    ? [...EN_PRIORITY_PATHS, ...ALL_STATIC_PATHS]
    : ALL_STATIC_PATHS;

  // Static paths for primary origin
  for (const path of staticPaths) addCandidate(`${origin}${path}`);

  // Static paths for www variant
  if (wwwOrigin) {
    for (const path of staticPaths) addCandidate(`${wwwOrigin}${path}`);
  }

  // 3. Crawl candidate pages (all of them, up to maxPages). Break early
  // after each successful page if caller asked for stopAtFirstUsableEmail
  // and we already have a clean address — same rationale as the post-
  // main-page check above. Bail on first satisfied iteration.
  for (const candidate of candidateUrls) {
    if (signal?.aborted) break;
    if (checkedUrls.length >= maxPages) break;
    const html = await tryFetch(candidate);
    if (html) processPage(html);
    if (hasUsableEmail()) break;
  }

  // 4. Filter and return
  const allEmailsRaw = Array.from(allEmails);
  const filtered = filterJunkEmails(allEmailsRaw);

  return {
    emails: filtered,
    allEmailsRaw,
    checkedUrls,
    pagesScanned: checkedUrls.length,
    siteName,
    ...(description ? { description } : {}),
    failureReason: mainFailure,
    ...readLimitsField(),
  };
}
