/**
 * Почта компании для автоаутричей RU и EN: поиск на сайте и проверка адреса
 * (docs/superpowers/specs/2026-09-26-outreach-to-sender-design.md §3).
 *
 * Поиск — портальный scrapeEmails через общий кэш email_scraper_cache. Ключ
 * (нормализованный адрес сайта) и формат записи — как у обогащения сайтов
 * (lib/enrich/websiteEnrichmentWorker.ts, fetchEmailsForUrl/setEmailCache):
 * сайт, который портал уже обходил за неделю, второй раз не обходится — ни
 * аутричем, ни обогащением.
 *
 * Проверка — validateEmailForAutoPipeline, как у автопайплайна: синтаксис → MX →
 * SMTP через прокси. Какой адрес брать, решают правила аутрича (pick); здесь
 * только цикл «выбрали → проверили → нерабочий исключили → выбрали следующий»:
 * мёртвый sales@ не повод терять компанию, если на сайте есть живой info@.
 *
 * Вердикты:
 *   ok         — ящик подтверждён (role- и free-адреса — тоже рабочие для B2B);
 *   catch_all  — сервер принимает любой адрес: отказа не будет, дойдёт ли — неизвестно;
 *   unverified — проверить не удалось (прокси, greylisting, таймаут) — решает раннер;
 *   invalid    — все проверенные кандидаты нерабочие;
 *   none       — подходящих адресов на сайте нет.
 *
 * Без SMTP-прокси обёртка проверяет только синтаксис и MX и считает рабочим
 * любой адрес на домене с почтовым сервером — это видно по smtpAvailable().
 *
 * Поиск одной компании целиком укладывается в общий потолок времени
 * (OUTREACH_EMAIL_COMPANY_TIMEOUT_MS, по умолчанию 2 минуты) — см. COMPANY_TIMEOUT_MS.
 */

import type { DomainInfo } from '@/lib/emailValidation/shared';
import { scrapeEmails } from '@/lib/enrich/emailScraper';
import { shouldUseCachedError } from '@/lib/enrich/errorPolicy';
import { runWithTimeout } from '@/lib/enrich/timeoutUtils';
import { normalizeUrl } from '@/lib/enrich/urlUtils';
import {
  smtpProxyAvailable,
  validateEmailForAutoPipeline,
  type AutoPipelineEmailValidationStatus,
} from '@/lib/jobs/autoPipelineEmailValidation';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type OutreachEmailVerdict = 'ok' | 'catch_all' | 'unverified' | 'invalid' | 'none';
/** Вердикт найденного адреса — его пишут в email_verification строки. */
export type OutreachEmailVerification = 'ok' | 'catch_all' | 'unverified';

/**
 * MX и catch-all доменов для validateEmailForAutoPipeline — один на запуск:
 * кандидаты одного сайта не проверяют его домен заново.
 */
export type EmailDomainCache = Map<string, DomainInfo>;

export interface FindAndVerifyOptions<P extends { email: string }> {
  /** Адрес сайта компании; пустой или неразборчивый — обходится домен. */
  website: string;
  /** Нормализованный домен компании (без схемы и www). */
  domain: string;
  /** Язык обхода: заголовок Accept-Language и порядок страниц контактов. */
  locale: 'ru' | 'en';
  /**
   * Правила выбора адреса аутрича. excluded — отбракованные проверкой адреса в
   * нижнем регистре: их пропускать. null — подходящих адресов больше нет.
   */
  pick: (emails: string[], excluded: ReadonlySet<string>) => P | null;
  domainCache: EmailDomainCache;
  /** Сколько адресов проверить, прежде чем признать почту нерабочей (по умолчанию 3). */
  maxCandidates?: number;
  /** Страниц обхода сайта (по умолчанию 8). */
  maxPages?: number;
}

export interface CompanyEmailSearch<P extends { email: string }> {
  /** Выбранный адрес с вердиктом проверки; null — при verdict 'invalid' и 'none'. */
  result: (P & { verification: OutreachEmailVerification }) | null;
  verdict: OutreachEmailVerdict;
  /** Адреса, отбракованные проверкой, в порядке проверки — для журнала. */
  triedInvalid: string[];
  /**
   * Корень обхода. scrapeEmails не отдаёт, на какой странице лежал адрес, —
   * честный источник только «сайт компании». null, когда адреса нет.
   */
  sourceUrl: string | null;
}

const CACHE_TABLE = 'email_scraper_cache';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// Сроки — те же переменные и умолчания, что у обогащения сайтов: кэш общий, и
// запись аутрича живёт столько же, сколько запись обогащения (7 дней удача,
// 6 часов пустой ответ или ошибка).
const CACHE_SUCCESS_TTL_MS = Number(process.env.WEBSITE_ENRICHMENT_CACHE_DAYS ?? '7') * DAY_MS;
const CACHE_ERROR_TTL_MS = Number(process.env.WEBSITE_ENRICHMENT_ERROR_TTL_HOURS ?? '6') * HOUR_MS;
// Обогащение хранит 10 адресов — ему столько и нужно. Правилам аутрича нужен
// весь список: у крупной компании sales@ бывает одиннадцатым после филиалов.
// Больше десяти обогащению не мешает — читая кэш, оно само берёт первые 10.
const CACHE_MAX_EMAILS = 30;

// Потолки обхода — прежние у обоих аутричей: страница 15 с, сайт целиком минута.
const PAGE_TIMEOUT_MS = 15_000;
const SITE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_MAX_CANDIDATES = 3;
// Обычная проверка — доли секунды. Минуты уходят, только когда висят прокси
// или MX (у каждого из трёх прокси по 25 с, до трёх MX на домен), и ответа всё
// равно не будет: адрес — «не удалось проверить», строка идёт дальше.
const VERIFY_TIMEOUT_MS = 90_000;
// Кэш — экономия, а не источник правды: зависший PostgREST не держит строку.
const DB_TIMEOUT_MS = 15_000;

function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Потолок на компанию целиком: чтение кэша, обход сайта и проверка до трёх
// адресов. Каждый шаг ограничен и сам (минута на сайт, 90 с на адрес), но
// вместе это до шести минут на одну компанию, а параллельных слотов на почту
// у раннера всего несколько: пара сайтов-ловушек или зависших прокси — и темп
// запуска падает в ноль.
// Тот же урок, что у обогащения сайтов (FETCH_EMAIL_ROW_HARD_TIMEOUT_MS в
// websiteEnrichmentWorker.ts): отдельные потолки шагов не ограничивают строку.
// Две минуты хватает нормальному сайту и проверке. Кончилось время — уже
// выбранный адрес уходит как «не удалось проверить», а если до адреса не
// дошли — почты нет.
const COMPANY_TIMEOUT_MS = envMs('OUTREACH_EMAIL_COMPANY_TIMEOUT_MS', 120_000);

/** И Error, и ошибка Supabase (PostgrestError — не Error) несут message. */
function warn(message: string, err?: unknown): void {
  if (err === undefined) {
    console.warn(`[outreach-email][WARN] ${message}`);
    return;
  }
  const text = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  console.warn(`[outreach-email][WARN] ${message}: ${text}`);
}

/**
 * Идёт ли проверка до SMTP. Условие — ровно то, по которому решает обёртка
 * (только SMTP_PROXY_URLS): без него она молча проверяет синтаксис и MX, и
 * экран запуска должен сказать «SMTP-проверка недоступна», а не делать вид.
 */
export function smtpAvailable(): boolean {
  return smtpProxyAvailable();
}

/**
 * Статус обёртки → вердикт аутрича. invalid — адрес нерабочий, берём
 * следующего кандидата. Список исчерпывающий: новый статус обёртки не
 * соберётся, пока его не разнесут сюда.
 */
export function verdictForStatus(status: AutoPipelineEmailValidationStatus): OutreachEmailVerification | 'invalid' {
  switch (status) {
    case 'valid':
    case 'role_address':
    case 'free_provider':
      return 'ok';
    case 'catch_all':
      return 'catch_all';
    case 'smtp_unknown':
    case 'not_validated':
      return 'unverified';
    case 'invalid_syntax':
    case 'no_mx':
    case 'smtp_reject':
    case 'disposable':
      return 'invalid';
  }
}

/**
 * Ключ кэша — как у обогащения: https-адрес после normalizeUrl. Адрес сайта не
 * разбирается — пробуем домен; null — обходить нечего.
 */
function cacheKeyFor(website: string, domain: string): string | null {
  for (const raw of [website, domain]) {
    const value = raw.trim();
    if (!value) continue;
    try {
      return normalizeUrl(value);
    } catch {
      // следующий вариант
    }
  }
  return null;
}

/** Разбор поля emails — тот же, что у обогащения (parseEmailList). */
function parseEmailList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;,\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Свежие адреса сайта из кэша; null — промах, сайт надо обойти.
 *
 * Запись из кэша бывает беднее своего обхода: обогащение хранит только первые
 * 10 адресов сайта (наши записи — до 30), и если строку первым записало оно,
 * адрес дальше десятого (тот же sales@ после филиалов) аутрич не увидит, пока
 * запись не протухнет (7 дней). Это осознанно: перепроверять каждую чужую
 * запись обходом — значит не иметь общего кэша вовсе.
 */
async function readCachedEmails(key: string, budgetMs: number): Promise<string[] | null> {
  const db = supabaseAdmin;
  if (!db || budgetMs <= 0) return null;
  try {
    const { data, error } = await runWithTimeout(
      Promise.resolve(db.from(CACHE_TABLE).select('emails, last_error, expires_at').eq('url_normalized', key).maybeSingle()),
      { timeoutMs: Math.min(DB_TIMEOUT_MS, budgetMs), timeoutMessage: 'таймаут чтения кэша почт' },
    );
    if (error) {
      warn(`email cache read failed (${key})`, error);
      return null;
    }
    const row = data as { emails: string | null; last_error: string | null; expires_at: string | null } | null;
    if (!row?.expires_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
    const emails = parseEmailList(row.emails);
    // Пустой ответ с временной ошибкой — не ответ: обогащение такие не пишет,
    // но строка могла остаться от прежних правил. Сайт обходим заново.
    if (!emails.length && row.last_error && !shouldUseCachedError(row.last_error)) return null;
    return emails;
  } catch (err) {
    warn(`email cache read failed (${key})`, err);
    return null;
  }
}

/**
 * Запись — поля и сроки как у обогащения (setEmailCache). Сбой записи — пропуск.
 * Никогда не бросает, поэтому зовётся без ожидания: результат поиска от записи
 * не зависит, а время на компанию общее и нужно проверке адресов.
 */
async function writeCachedEmails(key: string, payload: { emails: string[]; pagesScanned: number } | { error: string }): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;
  const emails = 'error' in payload ? null : payload.emails.slice(0, CACHE_MAX_EMAILS).join('; ');
  const now = Date.now();
  try {
    const { error } = await runWithTimeout(
      Promise.resolve(
        db.from(CACHE_TABLE).upsert(
          {
            url_normalized: key,
            emails,
            last_error: 'error' in payload ? payload.error : null,
            fetched_at: new Date(now).toISOString(),
            expires_at: new Date(now + (emails ? CACHE_SUCCESS_TTL_MS : CACHE_ERROR_TTL_MS)).toISOString(),
            source_url: key,
            pages_scanned: 'error' in payload ? 0 : payload.pagesScanned,
          },
          { onConflict: 'url_normalized' },
        ),
      ),
      { timeoutMs: DB_TIMEOUT_MS, timeoutMessage: 'таймаут записи кэша почт' },
    );
    if (error) warn(`email cache write failed (${key})`, error);
  } catch (err) {
    warn(`email cache write failed (${key})`, err);
  }
}

/**
 * Обход сайта: минута, но не дольше, чем осталось у компании; результат — в
 * кэш. Сбой — пустой список. cutByDeadline — обход оборвал общий потолок
 * компании, а не свой минутный.
 */
async function scrapeSiteEmails(
  url: string,
  locale: 'ru' | 'en',
  maxPages: number,
  budgetMs: number,
): Promise<{ emails: string[]; cutByDeadline: boolean }> {
  if (budgetMs <= 0) return { emails: [], cutByDeadline: true };
  const timeoutMs = Math.min(SITE_TIMEOUT_MS, budgetMs);
  const abort = new AbortController();
  let timedOut = false;
  try {
    const result = await runWithTimeout(
      scrapeEmails(url, { locale, maxPages, timeout: PAGE_TIMEOUT_MS, signal: abort.signal }),
      {
        timeoutMs,
        timeoutMessage: `Превышено время ожидания сайта (${Math.round(timeoutMs / 1000)}с)`,
        // Потолок обрывает и сам обход: иначе зависший сайт качался бы в фоне.
        onTimeout: () => {
          timedOut = true;
          abort.abort();
        },
      },
    );
    const emails = result.emails.slice(0, CACHE_MAX_EMAILS);
    void writeCachedEmails(url, { emails, pagesScanned: result.pagesScanned });
    return { emails, cutByDeadline: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка извлечения email';
    // Таймаут и сеть не кэшируем — как обогащение: следующий запуск попробует снова.
    if (shouldUseCachedError(message)) void writeCachedEmails(url, { error: message });
    return { emails: [], cutByDeadline: timedOut && timeoutMs < SITE_TIMEOUT_MS };
  }
}

/** Проверка адреса: 90 с, но не дольше, чем осталось у компании. */
async function verifyAddress(
  email: string,
  domainCache: EmailDomainCache,
  budgetMs: number,
): Promise<OutreachEmailVerification | 'invalid'> {
  // Адрес выбран, а время компании вышло: проверять не начинаем — «не удалось проверить».
  if (budgetMs <= 0) return 'unverified';
  try {
    // Отменить проверку нечем: у validateEmailForAutoPipeline нет сигнала
    // отмены, поэтому по потолку мы только перестаём её ждать. Дотикает она в
    // фоне сама — запросы к прокси внутри ограничены своими 25 с, — и её
    // единственный след — MX и catch-all домена в domainCache запуска, это
    // безвредно: компания к тому времени уже решена.
    const validation = await runWithTimeout(validateEmailForAutoPipeline(email, domainCache), {
      timeoutMs: Math.min(VERIFY_TIMEOUT_MS, budgetMs),
      timeoutMessage: 'email verification timeout',
    });
    return verdictForStatus(validation.status);
  } catch {
    // Обёртка сама не бросает — сюда приходит только наш потолок времени.
    // Висящий прокси говорит о прокси, а не об адресе: «не удалось проверить».
    return 'unverified';
  }
}

/**
 * Лучший рабочий адрес компании по правилам pick. Нерабочий кандидат
 * исключается, и pick выбирает следующего — до maxCandidates проверок.
 * «Не удалось проверить» — окончательный ответ: следующий адрес того же домена
 * упрётся в те же прокси и MX, а правила выбора уже сказали, кто лучше.
 *
 * Всё вместе — не дольше COMPANY_TIMEOUT_MS: каждый шаг получает свой потолок,
 * но не больше остатка общего времени. Время вышло на проверке — выбранный
 * адрес уходит как «не удалось проверить»; до адреса не дошли — почты нет.
 */
export async function findAndVerifyCompanyEmail<P extends { email: string }>(
  opts: FindAndVerifyOptions<P>,
): Promise<CompanyEmailSearch<P>> {
  const url = cacheKeyFor(opts.website, opts.domain);
  if (!url) return { result: null, verdict: 'none', triedInvalid: [], sourceUrl: null };
  const deadline = Date.now() + COMPANY_TIMEOUT_MS;
  const left = () => deadline - Date.now();

  let emails = await readCachedEmails(url, left());
  if (!emails) {
    const scraped = await scrapeSiteEmails(url, opts.locale, opts.maxPages ?? DEFAULT_MAX_PAGES, left());
    // Для раннера это просто «почты нет»; лог отличает «не успели» от сайта,
    // где почты правда нет.
    if (scraped.cutByDeadline) warn(`company email search hit the ${COMPANY_TIMEOUT_MS}ms cap before any address (${url})`);
    emails = scraped.emails;
  }
  const maxCandidates = Math.max(1, opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  const excluded = new Set<string>();
  const triedInvalid: string[] = [];
  while (triedInvalid.length < maxCandidates) {
    const picked = opts.pick(emails, excluded);
    if (!picked) break;
    const key = picked.email.trim().toLowerCase();
    // Правила выбора обязаны пропускать исключённые адреса. Не пропустили —
    // считаем, что кандидаты кончились: иначе один адрес проверялся бы по кругу.
    if (excluded.has(key)) break;
    const verification = await verifyAddress(picked.email, opts.domainCache, left());
    if (verification === 'invalid') {
      excluded.add(key);
      triedInvalid.push(picked.email);
      continue;
    }
    return { result: { ...picked, verification }, verdict: verification, triedInvalid, sourceUrl: url };
  }
  return { result: null, verdict: triedInvalid.length ? 'invalid' : 'none', triedInvalid, sourceUrl: null };
}
