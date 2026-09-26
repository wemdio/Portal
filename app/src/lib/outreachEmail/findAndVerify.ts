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

/** И Error, и ошибка Supabase (PostgrestError — не Error) несут message. */
function warn(message: string, err: unknown): void {
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

/** Свежие адреса сайта из кэша; null — промах, сайт надо обойти. */
async function readCachedEmails(key: string): Promise<string[] | null> {
  const db = supabaseAdmin;
  if (!db) return null;
  try {
    const { data, error } = await runWithTimeout(
      Promise.resolve(db.from(CACHE_TABLE).select('emails, last_error, expires_at').eq('url_normalized', key).maybeSingle()),
      { timeoutMs: DB_TIMEOUT_MS, timeoutMessage: 'таймаут чтения кэша почт' },
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

/** Запись — поля и сроки как у обогащения (setEmailCache). Сбой записи — пропуск. */
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

/** Обход сайта с общим потолком времени; результат — в кэш. Сбой — пустой список. */
async function scrapeSiteEmails(url: string, locale: 'ru' | 'en', maxPages: number): Promise<string[]> {
  const abort = new AbortController();
  try {
    const result = await runWithTimeout(
      scrapeEmails(url, { locale, maxPages, timeout: PAGE_TIMEOUT_MS, signal: abort.signal }),
      {
        timeoutMs: SITE_TIMEOUT_MS,
        timeoutMessage: `Превышено время ожидания сайта (${Math.round(SITE_TIMEOUT_MS / 1000)}с)`,
        // Потолок обрывает и сам обход: иначе зависший сайт качался бы в фоне.
        onTimeout: () => abort.abort(),
      },
    );
    const emails = result.emails.slice(0, CACHE_MAX_EMAILS);
    await writeCachedEmails(url, { emails, pagesScanned: result.pagesScanned });
    return emails;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка извлечения email';
    // Таймаут и сеть не кэшируем — как обогащение: следующий запуск попробует снова.
    if (shouldUseCachedError(message)) await writeCachedEmails(url, { error: message });
    return [];
  }
}

async function verifyAddress(email: string, domainCache: EmailDomainCache): Promise<OutreachEmailVerification | 'invalid'> {
  try {
    const validation = await runWithTimeout(validateEmailForAutoPipeline(email, domainCache), {
      timeoutMs: VERIFY_TIMEOUT_MS,
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
 */
export async function findAndVerifyCompanyEmail<P extends { email: string }>(
  opts: FindAndVerifyOptions<P>,
): Promise<CompanyEmailSearch<P>> {
  const url = cacheKeyFor(opts.website, opts.domain);
  if (!url) return { result: null, verdict: 'none', triedInvalid: [], sourceUrl: null };

  const emails = (await readCachedEmails(url)) ?? (await scrapeSiteEmails(url, opts.locale, opts.maxPages ?? DEFAULT_MAX_PAGES));
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
    const verification = await verifyAddress(picked.email, opts.domainCache);
    if (verification === 'invalid') {
      excluded.add(key);
      triedInvalid.push(picked.email);
      continue;
    }
    return { result: { ...picked, verification }, verdict: verification, triedInvalid, sourceUrl: url };
  }
  return { result: null, verdict: triedInvalid.length ? 'invalid' : 'none', triedInvalid, sourceUrl: null };
}
