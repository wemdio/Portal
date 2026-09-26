/**
 * Раннер английского аутрича v2 (parser_type='polza_outreach').
 *
 * Флоу CEO (en-outreach-flow-improvements, 23.09.2026):
 *   компания → fit → поводы → данные → Lead Score → кейс → угол → цепочка.
 *
 * Порядок — дорогое в конце (docs/superpowers/specs/2026-09-26-outreach-to-sender-design.md §2 EN):
 *  S1 кандидаты: вакансии sales/GTM + стартапы YC, склейка по домену/названию;
 *  S2 домен, размер/отрасль/страна из PDL;
 *  S3 жёсткие отсевы, дубль домена в запуске и повторы между запусками —
 *     компания уже готова в другом запуске (previously_exported; галочка
 *     include_previously_exported этот отсев выключает);
 *  S5 почта, тоже бесплатно: поиск на сайте, SMTP-проверка, стоп-лист
 *     «Рассылки». Нет рабочей почты — отсев до ИИ: разбор компании, которой
 *     некуда писать, — выброшенные деньги. Почта не проверена — на ручную
 *     проверку (email_unverified), тоже без ИИ;
 *  S4 дешёвый ИИ: сайт (кэш 30 дней) и вакансия → поводы, Lead Score, статус;
 *  S6 четыре письма и гарды — прошедшим порог, от самых сильных к слабым,
 *     пока не набрано заказанное число готовых. Письма — из шаблона цепочки
 *     оффера (тип главного повода): его один раз на оффер запуска пишет
 *     Gemini 3.1 Pro (templateWriter.ts), под компанию подставляются
 *     проверенные факты и подпись из настроек. Шаблон не прошёл проверку или
 *     письма компании не прошли гарды — строка на ручную проверку
 *     (template_failed / letters_qa_failed), в рассылку она не идёт (спека §4).
 * Номера стадий исторические (их хранит поле stage): почта (s5_email) с
 * 26.09.2026 идёт раньше разбора (s4_analyzed). Воронку по строкам считает
 * lib/polzaOutreach/funnel.ts.
 *
 * Волна идёт тремя пулами по очереди: почта (свой параллелизм — обход сайта и
 * SMTP-проверка больше ждут, чем работают), разбор ИИ, письма.
 *
 * Лимит считает ГОТОВЫЕ компании; кандидатов раннер берёт волнами, пока не
 * наберёт или пока не кончится пул. Отсеянные строки остаются с причиной —
 * по ним считается воронка. Ошибка одной компании не валит запуск.
 *
 * ИИ — общий клиент аутричей: свой ключ, дешёвая модель разбора и лимит
 * расхода на запуск (спека §1). Лимит исчерпан — новые строки не начинаются,
 * запуск завершается штатно (stop_reason 'budget'), готовое остаётся. Ключ не
 * работает или модель молчит 10 компаний подряд — запуск сразу failed с
 * понятным текстом, а не сотни строк «ИИ не ответил». Так же и с проверкой
 * почт: 15 адресов подряд «не удалось проверить» — лежат SMTP-прокси.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { smtpAvailable, type EmailDomainCache, type OutreachEmailVerdict } from '@/lib/outreachEmail/findAndVerify';
import { outreachApiKey } from '@/lib/outreachLlm/client';
import {
  BudgetExceededError,
  JobBudget,
  LlmAuthError,
  LlmCallError,
  runWithOutreachContext,
  type OutreachLlmBudgetSnapshot,
} from '@/lib/outreachLlm/context';
import { pruneSiteAnalysisCache } from '@/lib/outreachLlm/siteAnalysisCache';
import { JobOwner, WORKER_LEASE_KEY, WORKER_LEASE_TOKEN_PATH, withoutWorkerLease } from '@/lib/outreachLlm/workerLease';
import { isSuppressed } from '@/lib/polzaRuOutreach/company';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { analyzeVacancy } from './analyzeVacancy';
import { displayName, SEQUENCE_ID, triggerPhrase } from './buildLetters';
import { loadEnCases, routeEnCase, type EnCase } from './caseRouter';
import { findCompanyEmail, type PolzaEmailType } from './findEmail';
import { POLZA_FUNNEL_COLUMNS, polzaFunnel, type PolzaFunnelRow } from './funnel';
import { icpFilter } from './icpFilter';
import { employeesFromBucket, leadStatus, primaryTrigger, scoreLead, type LeadScore, type Trigger } from './leadScore';
import { composeCompanyLetters, offerKeyOf } from './renderTemplate';
import { lookupPdlProfile, normalizeDomain, PDL_COUNTRY_BY_CODE, resolveCompanyDomain } from './resolveDomain';
import { selectVacancies } from './selectVacancies';
import { loadSignature } from './settings';
import { buildSiteProfile, type SiteProfile } from './siteProfile';
import {
  createChainTemplates,
  REBUILD_LEASE_KEY,
  templateFailureDetail,
  WORKER_WRITER_TIMEOUT_MS,
  writerAttemptWorstUsd,
  type ChainTemplate,
  type ChainTemplates,
} from './templateWriter';
import {
  POLZA_OFFER_KEYS,
  POLZA_OFFER_LABELS,
  POLZA_OUTREACH_STAGES as ST,
  polzaReviewReason,
  sanitizePolzaOutreachConfig,
  type PolzaOutreachConfig,
  type PolzaOutreachVacancyCandidate,
  type PolzaVacancyAnalysis,
} from './types';
import { loadYcCompanies, type YcCompany } from './ycCandidates';

/** Целое из env в рамках. Пусто или мусор — значение по умолчанию: NaN в пуле дал бы ноль потоков. */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

const ENRICH_CONCURRENCY = envInt('POLZA_OUTREACH_LLM_CONCURRENCY', 4, 1, 6);
// Шаг почты: обход сайта до минуты и SMTP-проверка через прокси — потоки
// больше ждут, чем работают, и ИИ не тратят. Почту теперь ищут у всех
// прошедших S3, а не только у write now, поэтому свой пул, шире разбора.
const EMAIL_CONCURRENCY = envInt('POLZA_OUTREACH_EMAIL_CONCURRENCY', 8, 1, 16);
// Письма — подстановка в шаблон оффера. Шаблон пишется один раз на оффер:
// компании оффера, дошедшие до писем одновременно, ждут одного писателя.
const LETTERS_CONCURRENCY = 4;
// Поиск домена (запросы по каталогу PDL и Clearbit) и профиль PDL идут в
// пуле почты, а он шире прежнего пула разбора (8 против 4): без своего
// ограничителя запросов к Clearbit и каталогу одновременно стало бы вдвое
// больше. Четыре — как было, когда S2 шёл в пуле разбора.
const DOMAIN_CONCURRENCY = 4;
const DB_CHUNK = 100;
const MIN_WAVE = 25;
const MAX_WAVE = 250;
const BLIND_YIELD_GUESS = 0.12;
const LAUNCH_MAX_AGE_DAYS = 180;
const DAY = 86_400_000;

class PolzaOutreachCancelledError extends Error {
  constructor() {
    super('Запуск остановлен');
    this.name = 'PolzaOutreachCancelledError';
  }
}
/**
 * Как часто воркер сам смотрит, не остановили ли запуск: потоки писем могут
 * минутами ждать писателя цепочек и на статус не смотреть, а остановка должна
 * оборвать и его.
 */
const CANCEL_WATCH_MS = 15_000;
/** ИИ не отвечает серией — запуск падает целиком, как при неверном ключе. */
class LlmSilentError extends Error {}
/** Сколько компаний подряд с «ИИ не ответил» — уже не случайность, а лежащая модель. */
const LLM_FAIL_STREAK = 10;
/** SMTP-проверка не отвечает серией — запуск падает целиком: дальше все строки ушли бы на ручную проверку. */
class SmtpSilentError extends Error {}
/**
 * Сколько адресов подряд «не удалось проверить» — уже не greylisting одного
 * сервера, а лежащие SMTP-прокси.
 */
const SMTP_UNVERIFIED_STREAK = 15;
/**
 * Писатель цепочек не отвечает — запуск падает целиком: шаблон один на оффер,
 * и без писателя все компании запуска ушли бы на ручную проверку, а разбор
 * следующих волн был бы оплачен впустую.
 */
class WriterSilentError extends Error {}
/**
 * Сколько попыток шаблона кончились молчанием модели (не провалом проверки),
 * пока ни один шаблон не написан, — уже не случайность: два оффера подряд или
 * один оффер дважды (повтор в следующей волне тоже не ответил).
 */
const WRITER_FAILED_ATTEMPTS = 2;
/**
 * Запас лимита на ИИ под писателя цепочек: шаблоны пишутся в конце волны, и
 * разбор не должен съесть лимит до цента — иначе компании, оплаченные
 * разбором, остались бы без писем. Новый разбор не начинаем, когда до лимита
 * (за вычетом броней идущих запросов) меньше запаса.
 *
 * Лимит строгий: каждый вызов писателя бронирует свою оценку сверху
 * (writerAttemptWorstUsd — около $0.14: 12 000 токенов ответа Gemini 3.1 Pro
 * по $10.8 за миллион и промпт, с наценкой Requesty), а шаблоны офферов волны
 * пишутся разом. Поэтому запас — не меньше первых попыток всех пяти офферов
 * (около $0.72) с четвертью сверху на строки, чей разбор начался до
 * стоп-линии. Базовый запас — $1, у маленького лимита — пятая часть; итог —
 * не больше половины лимита, иначе при лимите в $1 разбор не начался бы вовсе.
 */
const WRITER_RESERVE_USD = 1;
const WRITER_RESERVE_SHARE = 0.2;
const WRITER_RESERVE_MARGIN = 1.25;
const WRITER_RESERVE_MAX_SHARE = 0.5;

function writerReserveUsd(budget: JobBudget): number {
  const firstAttempts = POLZA_OFFER_KEYS.length * writerAttemptWorstUsd() * WRITER_RESERVE_MARGIN;
  const base = Math.min(WRITER_RESERVE_USD, budget.limitUsd * WRITER_RESERVE_SHARE);
  return Math.min(budget.limitUsd * WRITER_RESERVE_MAX_SHARE, Math.max(base, firstAttempts));
}

/** На разбор ещё можно тратить: лимит не исчерпан и запас под писателя цел (с бронями идущих запросов). */
function analysisBudgetLeft(budget: JobBudget): boolean {
  return !budget.exhausted() && budget.available() >= writerReserveUsd(budget);
}

/**
 * Сколько ждать идущие вызовы ИИ, прежде чем записать итог расхода. После
 * остановки или сбоя они оборваны и списываются сразу — ждём с запасом. У
 * законченного запуска могут дописываться шаблоны, начатые заранее (их
 * компании ушли в limit_reached): писатель — до двух попыток по пять минут.
 */
const ABORTED_SETTLE_MS = 30_000;
const COMPLETED_SETTLE_MS = 2 * WORKER_WRITER_TIMEOUT_MS + 30_000;
/** Строки шаблонов после ответа или обрыва писателя дописываются за миллисекунды — ждём с запасом. */
const TEMPLATE_ROWS_SETTLE_MS = 10_000;

/**
 * Строка, которую лимит на ИИ вернул в необработанные: статус «найдена» и ни
 * одного поля шагов S2 и S5, и без оценки S4. В конце запуска такие строки
 * уходят из журнала; но воронку экран считает по полям строки (домен, почта,
 * write now), и строка, которую не удалось удалить, иначе числилась бы в ней,
 * хотя из счётчиков запуска её уже вычли. Оценка есть у строки, которую лимит
 * остановил на письмах: шаблон оффера ещё не написан, а платить писателю уже
 * нечем.
 */
const UNPROCESSED_PATCH: Record<string, unknown> = {
  status: 'discovered',
  stage: ST.s1Selected,
  normalized_domain: null,
  company_website: null,
  employee_range: null,
  industry: null,
  country: null,
  selected_company_email: null,
  email_type: null,
  email_source_url: null,
  email_verification: null,
  lead_status: null,
};

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) {
  const line = `[polza-outreach][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

/** Общий потолок просмотренных кандидатов — страховка от бесконечного прогона. */
export function maxCandidatesFor(target: number): number {
  return Math.min(4000, Math.max(300, target * 25));
}

export function nextWaveSize(target: number, totals: { vacancies: number; ready: number }): number {
  const missing = Math.max(1, target - totals.ready);
  const yieldRate = totals.vacancies > 0 && totals.ready > 0 ? totals.ready / totals.vacancies : BLIND_YIELD_GUESS;
  return Math.max(MIN_WAVE, Math.min(MAX_WAVE, Math.ceil(missing / Math.max(0.02, yieldRate))));
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await worker(item);
      }
    }),
  );
}

/**
 * Не больше max задач одновременно внутри более широкого пула; остальные ждут
 * в очереди. Освободившееся место сразу переходит следующему ждущему.
 */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/** Кандидат после склейки источников: одна компания — одна карточка. */
interface Candidate {
  companyName: string;
  vacancy: PolzaOutreachVacancyCandidate | null;
  yc: YcCompany | null;
}

function nameKey(name: string): string {
  return displayName(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const COUNTRY_CODE_BY_NAME = Object.fromEntries(Object.entries(PDL_COUNTRY_BY_CODE).map(([code, name]) => [name, code]));

function mergeCandidates(vacancies: PolzaOutreachVacancyCandidate[], ycs: YcCompany[]): Candidate[] {
  const ycByDomain = new Map(ycs.map((y) => [y.domain, y]));
  const ycByName = new Map(ycs.map((y) => [nameKey(y.name), y]));
  const usedYc = new Set<YcCompany>();
  const both: Candidate[] = [];
  const hiringOnly: Candidate[] = [];
  for (const v of vacancies) {
    const domain = normalizeDomain(String(v.companySiteUrl ?? ''));
    const yc = (domain && ycByDomain.get(domain)) || ycByName.get(nameKey(v.companyName)) || null;
    if (yc && !usedYc.has(yc)) {
      usedYc.add(yc);
      both.push({ companyName: v.companyName, vacancy: v, yc });
    } else {
      hiringOnly.push({ companyName: v.companyName, vacancy: v, yc: null });
    }
  }
  const ycOnly = ycs.filter((y) => !usedYc.has(y)).map((y) => ({ companyName: y.name, vacancy: null, yc: y }));
  // Два сильных повода сразу — первыми: это прямой путь к write now.
  return [...both, ...hiringOnly, ...ycOnly];
}

/**
 * Домены компаний, готовых в других запусках английского аутрича: второй раз
 * одной компании не пишем (спека §2 EN — как «уже выгружалась» у русского).
 * Готовые — status 'ready': их выгружают в рассылку. Удалённый запуск уносит
 * свои строки (on delete cascade), и его компании снова доступны.
 */
async function loadPreviouslyExported(db: SupabaseClient, excludeJobId: string): Promise<Set<string>> {
  const domains = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    // Порядок по id — иначе страницы range() не стабильны и строка могла бы выпасть.
    const { data, error } = await db
      .from('polza_outreach_companies')
      .select('id, normalized_domain')
      .eq('status', 'ready')
      .neq('job_id', excludeJobId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`previously exported lookup failed: ${error.message}`);
    for (const row of data ?? []) {
      if (row.normalized_domain) domains.add(String(row.normalized_domain));
    }
    if (!data || data.length < PAGE) break;
  }
  return domains;
}

interface Totals {
  vacancies: number;
  domainFound: number;
  icpPassed: number;
  emailFound: number;
  writeNow: number;
  ready: number;
}

/** Счётчики воронки, которые строка двигает по пути к готовой. */
type TalliedTotal = 'domainFound' | 'icpPassed' | 'emailFound' | 'writeNow';

/**
 * Вклад строки в счётчики запуска и в дедуп доменов. Строку, которую
 * остановил лимит на ИИ, вычитаем обратно — её как будто не брали из пула: на
 * экране она не должна числиться ни в воронке, ни занимать домен.
 */
interface Tally {
  /** Строка журнала: по ней дедуп знает, кто занял домен. */
  id: string;
  totals: TalliedTotal[];
  /** Домен, который строка заняла в дедупе запуска. */
  domain: string | null;
}

/** Итог бесплатного шага: компания с доменом и рабочей почтой — вход разбора ИИ. */
interface Prepared {
  id: string;
  tally: Tally;
  c: Candidate;
  domain: string;
  website: string;
  employees: number | null;
  countryCode: string | null;
  /** Общий ящик (info@, hello@) получает письмо 1 «кто у вас за это отвечает?». */
  emailType: PolzaEmailType | null;
}

/** Всё, что известно о компании после разбора и оценки, — вход писем. */
interface Qualified {
  id: string;
  tally: Tally;
  c: Candidate;
  site: SiteProfile;
  triggers: Trigger[];
  score: LeadScore;
  caseHit: EnCase | null;
  emailType: PolzaEmailType | null;
}

/** «Дубль домена» и строка, чей домен он повторил, — для уборки после стопа по лимиту. */
interface Duplicate {
  id: string;
  tally: Tally;
  owner: string;
}

/**
 * Весь запуск идёт внутри контекста ИИ (lib/outreachLlm/context.ts): каждый
 * вызов разбора знает язык и списывает деньги с лимита именно этого запуска —
 * воркер одновременно ведёт и русский аутрич. Сигнал контекста — остановка
 * всего запуска: он обрывает каждый идущий вызов ИИ, не только писателя, и
 * итог расхода пишется сразу, а не когда они сами закончатся.
 *
 * Запуск воркер держит арендой (lib/outreachLlm/workerLease.ts): пока он
 * доводит остановленный запуск, «Переписать цепочку» ждёт, и итог воркера не
 * стирает её расход.
 */
export async function runPolzaOutreachJob(jobId: string): Promise<void> {
  const db = supabaseAdmin;
  if (!db) {
    log('error', 'supabaseAdmin not configured');
    return;
  }
  const runAbort = new AbortController();
  const owner = new JobOwner({
    db,
    jobId,
    log,
    // Запуск забрали (аренда истекла, отметку снял роут) — прогон больше не
    // наш: обрываем его, записывать итог он не будет.
    onLost: () => {
      if (!runAbort.signal.aborted) runAbort.abort(new PolzaOutreachCancelledError());
    },
  });
  // Остановку или сбой воркер заметил — до итоговой записи держит аренду свежей.
  runAbort.signal.addEventListener('abort', () => owner.windDown(), { once: true });
  let start: JobStart;
  try {
    start = await loadJobStart(db, jobId);
    // Только идущий запуск: остановленный между захватом и стартом (его уже
    // может переписывать «Переписать цепочку») заново не начинается.
    if (!(await owner.claim(start.previousDetail))) {
      log('info', `job ${jobId}: not running anymore — the run is not started`);
      return;
    }
  } catch (err) {
    // Лимит и прошлый расход не прочитались — не запускаем: с лимитом по
    // умолчанию и нулём потраченного перезапуск мог бы потратить лимит ещё раз.
    const message = err instanceof Error ? err.message : String(err);
    log('error', `job ${jobId}: ${message}`);
    const { error } = await db
      .from('parser_jobs')
      .update({ status: 'failed', progress_stage: 'failed', completed_at: new Date().toISOString(), error_message: message })
      .eq('id', jobId)
      .eq('status', 'running');
    if (error) log('warn', `job ${jobId}: failed status update failed`, error);
    return;
  }
  await runWithOutreachContext({ lang: 'en', budget: start.budget, signal: runAbort.signal }, () =>
    runJob(db, jobId, start.budget, start.previousDetail, runAbort, owner),
  );
}

interface JobStart {
  budget: JobBudget;
  /** progress_detail прошлого прогона (перезапуск воркера) или null у нового запуска. */
  previousDetail: Record<string, unknown> | null;
}

const START_READ_RETRY_MS = 2_000;

/**
 * Бюджет нужен до входа в контекст, поэтому конфиг здесь читается отдельно от
 * runJob. Лимит — из конфига, потраченное — из снимка progress_detail.llm. У
 * нового запуска снимка нет, счёт с нуля. После падения воркера запуск
 * возвращается в очередь и идёт заново, а снимок остаётся от прерванного
 * прогона: деньги уже потрачены, и без него каждый перезапуск получал бы
 * лимит целиком ещё раз. Читаем до runJob — первая же публикация прогресса
 * снимок перезапишет. Снимок сохраняется продлением аренды раз в 30 с и сразу
 * после каждого вызова писателя: при падении теряются только вызовы разбора
 * последних секунд.
 *
 * Не прочиталось (сбой PostgREST или сети) — одна повторная попытка, потом
 * ошибка: молча начать с лимитом по умолчанию и нулём потраченного нельзя.
 */
async function loadJobStart(db: SupabaseClient, jobId: string): Promise<JobStart> {
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, START_READ_RETRY_MS));
    try {
      const { data, error } = await db.from('parser_jobs').select('config, progress_detail').eq('id', jobId).maybeSingle();
      if (error) {
        problem = error.message;
        continue;
      }
      if (!data) {
        problem = 'запуск не найден';
        continue;
      }
      const limit = sanitizePolzaOutreachConfig((data.config ?? {}) as Partial<PolzaOutreachConfig>).llm_budget_usd;
      const raw: unknown = data.progress_detail;
      const previousDetail = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      const snapshot = (previousDetail?.llm ?? null) as Partial<OutreachLlmBudgetSnapshot> | null;
      return { budget: JobBudget.fromSnapshot(snapshot, limit), previousDetail };
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`Не удалось прочитать запуск и расход на ИИ из базы: ${problem}`);
}

/**
 * Незаконченные строки журнала: не начатые, прерванные на S2–S5 и дождавшиеся
 * разбора, но не писем (qualified). Строка без писем — не готовая и не
 * отсеянная, и к моменту перезапуска её разбор уже не продолжить.
 */
const UNFINISHED_STATUSES = ['discovered', 'normalized', 'qualified'];

type JournalRow = PolzaFunnelRow & { id: string; exclusion_reason: string | null };

/**
 * Перезапуск воркера, когда лимит на ИИ уже исчерпан (по снимку
 * progress_detail.llm): разбирать больше не на что, а журнал прошлого прогона —
 * готовые, отсеянные, на ручной проверке — оплачен. Поэтому журнал не стираем:
 * убираем только незаконченные строки (и дубли, чей оригинал среди них, — как
 * при обычном стопе по лимиту), счётчики пересчитываем по журналу тем же
 * правилом, что экран (funnel.ts), и завершаем запуск остановленным лимитом.
 * Номер волны и размер пула по журналу не пересчитать — они остаются из снимка.
 */
async function completeSpentRun(
  db: SupabaseClient,
  jobId: string,
  target: number,
  budget: JobBudget,
  previousDetail: Record<string, unknown> | null,
  finishRun: (patch: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const { error: dropErr } = await db.from('polza_outreach_companies').delete().eq('job_id', jobId).in('status', UNFINISHED_STATUSES);
  if (dropErr) throw new Error(`Не удалось убрать необработанные строки журнала: ${dropErr.message}`);
  const rows: JournalRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('polza_outreach_companies')
      .select(`id,exclusion_reason,${POLZA_FUNNEL_COLUMNS}`)
      .eq('job_id', jobId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Не удалось прочитать журнал запуска: ${error.message}`);
    rows.push(...((data ?? []) as unknown as JournalRow[]));
    if (!data || data.length < PAGE) break;
  }
  // Дубль без оригинала: ни одна строка, кроме дублей, не держит его домен.
  const held = new Set(rows.filter((r) => r.exclusion_reason !== 'duplicate_domain').map((r) => r.normalized_domain).filter(Boolean));
  const orphans = rows
    .filter((r) => r.exclusion_reason === 'duplicate_domain' && !(r.normalized_domain && held.has(r.normalized_domain)))
    .map((r) => r.id);
  const gone = new Set<string>();
  for (let i = 0; i < orphans.length; i += DB_CHUNK) {
    const { data, error } = await db
      .from('polza_outreach_companies')
      .delete()
      .eq('job_id', jobId)
      .eq('exclusion_reason', 'duplicate_domain')
      .in('id', orphans.slice(i, i + DB_CHUNK))
      .select('id');
    if (error) log('warn', `job ${jobId}: orphan duplicates cleanup failed`, error);
    for (const r of data ?? []) gone.add(String(r.id));
  }
  const kept = rows.filter((r) => !gone.has(String(r.id)));
  const ready = kept.filter((r) => r.status === 'ready').length;
  // Ждущие цепочку — тоже по журналу, а не из снимка прогона: снимок мог
  // устареть (прервался посреди писем или после «Переписать цепочку»).
  const awaiting = kept.filter((r) => r.status === 'needs_review' && (r.review_reason ?? '').startsWith('template_failed')).length;
  const stopReason = ready >= target ? 'target_reached' : 'budget';
  const spend = budget.snapshot();
  log('info', `job ${jobId}: LLM budget already spent ($${spend.spent_usd}/$${spend.limit_usd}) — restart keeps the journal: ${kept.length} rows, ${ready} ready (${stopReason})`);
  const progressDetail: Record<string, unknown> = {
    ...withoutWorkerLease(previousDetail ?? {}),
    scanned: kept.length,
    ready,
    awaiting_templates: awaiting,
    funnel: polzaFunnel(kept),
    llm: spend,
    stop_reason: stopReason,
  };
  // Причина «без ждущих» относилась к прошлому прогону — теперь причина своя.
  delete progressDetail.stop_reason_base;
  await finishRun({
    status: 'completed',
    progress_stage: 'completed',
    progress_percent: 100,
    total_found: kept.length,
    total_parsed: ready,
    completed_at: new Date().toISOString(),
    error_message: null,
    progress_detail: progressDetail,
  });
}

async function runJob(
  db: SupabaseClient,
  jobId: string,
  budget: JobBudget,
  previousDetail: Record<string, unknown> | null,
  // Остановка обрывает все вызовы ИИ запуска (сигнал контекста): писатель ждёт
  // Gemini до пяти минут, и без сигнала «Остановить» ждало бы, пока он допишет
  // (и заплатило бы за это).
  runAbort: AbortController,
  owner: JobOwner,
): Promise<void> {
  // Прогресс и итог пишем только идущему запуску. Упал или остановлен — потоки
  // пула ещё добегают свои строки, и их публикации перетёрли бы «failed» и
  // «Stopped by user». И только при своей аренде: запуск, который подхватил
  // другой прогон, этот не перетирает.
  const setRunningProgress = async (patch: Record<string, unknown>) => {
    const { error } = await db
      .from('parser_jobs')
      .update(patch)
      .eq('id', jobId)
      .eq('status', 'running')
      .eq(WORKER_LEASE_TOKEN_PATH, owner.token);
    if (error) log('warn', `progress update failed for ${jobId}`, error);
  };
  /**
   * Итог законченного запуска — последняя запись, она же отпускает аренду.
   * Остановили в последний момент — статус остановки не трогаем и причину
   * окончания не утверждаем, но прогресс и расход всё равно пишем.
   */
  const finishRun = async (patch: Record<string, unknown>) => {
    await owner.close();
    if ((await owner.write(patch, { requireRunning: true })) !== 'skipped') return;
    const progressDetail = { ...(patch.progress_detail as Record<string, unknown>) };
    delete progressDetail.stop_reason;
    delete progressDetail.stop_reason_base;
    await owner.write({ progress_detail: progressDetail });
  };
  // Шаблоны цепочек запуска — когда созданы: итог ждёт и их строк.
  let templatesRef: ChainTemplates | null = null;
  /**
   * Дождаться идущих вызовов ИИ: итог расхода пишется после них. false — не
   * дождались, и их брони (оценку сверху) итог считает потраченными. Потом —
   * строки шаблонов, которые писатели дописывают или отпускают после обрыва:
   * «Переписать цепочку» сразу после итога не должна видеть шаблон «пишется».
   */
  const settleCalls = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    let settled = budget.idle();
    if (!settled) {
      log('info', `job ${jobId}: waiting for LLM calls in flight before writing the final spend`);
      settled = await budget.whenIdle(timeoutMs);
      if (!settled) log('warn', `job ${jobId}: LLM calls still in flight after ${Math.round(timeoutMs / 1000)} s — their upper estimate is counted as spent`);
    }
    if (templatesRef) await templatesRef.settled(Math.min(TEMPLATE_ROWS_SETTLE_MS, Math.max(0, deadline - Date.now())));
    return settled;
  };
  const ensureNotCancelled = async () => {
    const { data } = await db.from('parser_jobs').select('status').eq('id', jobId).single();
    if (!data || data.status !== 'running') {
      const cancelled = new PolzaOutreachCancelledError();
      if (!runAbort.signal.aborted) runAbort.abort(cancelled);
      throw cancelled;
    }
  };
  let cancelWatch: ReturnType<typeof setInterval> | null = null;
  const updateRow = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await db
      .from('polza_outreach_companies')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) log('warn', `row update failed (${id})`, error);
  };
  const excludeRow = async (id: string, stage: string, reason: string, patch: Record<string, unknown> = {}): Promise<null> => {
    await updateRow(id, { ...patch, status: 'excluded', stage, exclusion_reason: reason, lead_status: 'skip' });
    return null;
  };
  // Прогресс «как сейчас» — для сбоя и остановки: к нему дописывается итог
  // расходов на ИИ. Появляется, когда запуск дошёл до обработки строк.
  let currentDetail: (() => Record<string, unknown>) | null = null;
  // До того — прошлый прогон и расход (его пишут продление аренды и итог).
  const baseDetail = (): Record<string, unknown> => ({
    ...withoutWorkerLease(previousDetail ?? {}),
    llm: budget.snapshot(),
    [WORKER_LEASE_KEY]: owner.lease(),
  });
  // Раз в 30 с воркер сохраняет изменившийся progress_detail — расход на ИИ
  // (при падении теряются только последние секунды). Вызов писателя — дорогой:
  // его расход сохраняем сразу, иначе перезапуск воркера заплатил бы за шаблон
  // ещё раз мимо лимита.
  owner.start(() => (currentDetail ? currentDetail() : baseDetail()));
  budget.onCharge((role) => {
    if (role === 'writer') owner.save();
  });

  try {
    const { data: job, error: jobErr } = await db.from('parser_jobs').select('config,status').eq('id', jobId).single();
    if (jobErr || !job) throw new Error(jobErr?.message ?? 'Job not found');

    const config: PolzaOutreachConfig = sanitizePolzaOutreachConfig((job.config ?? {}) as Partial<PolzaOutreachConfig>);
    const target = config.limit;
    const maxCandidates = maxCandidatesFor(target);
    const thresholds = { write: config.write_threshold };
    // Перезапуск после исчерпанного лимита: журнал оплачен и остаётся, новых
    // строк не будет — ни ключ, ни источники не нужны. Остаток меньше запаса
    // под писателя — то же самое: новый прогон стёр бы оплаченный журнал, а
    // разбор всё равно не начался бы.
    if (!analysisBudgetLeft(budget)) {
      await completeSpentRun(db, jobId, target, budget, previousDetail, finishRun);
      return;
    }
    // Роут не создаёт запуск без ключа, но окружение воркера — отдельное. Без
    // ключа ни одна компания не пройдёт разбор: падаем до выборки кандидатов.
    if (!outreachApiKey('en')) {
      throw new LlmAuthError('Не задан ключ ИИ для EN автоаутрича (POLZA_EN_OUTREACH_API_KEY) в окружении воркера', 'missing_key');
    }
    // Без SMTP-прокси проверка почт — только синтаксис и MX: адрес «рабочий»,
    // если у домена есть почтовый сервер. Запуск идёт, но экран об этом
    // предупреждает (progress_detail.smtp_unavailable).
    const smtpOn = smtpAvailable();
    if (!smtpOn) log('warn', `job ${jobId}: SMTP_PROXY_URLS not set — emails are checked by syntax and MX only`);

    // Только идущему: статус остановки не перетираем (запуск, остановленный
    // после захвата, заново не начинается — ensureNotCancelled ниже).
    await setRunningProgress({
      started_at: new Date().toISOString(),
      error_message: null,
      progress_stage: 'selecting_vacancies',
      progress_percent: 1,
      total_found: 0,
      total_parsed: 0,
    });
    // Потоки писем могут минутами ждать писателя и на статус не смотреть —
    // остановку ловим отдельно, чтобы она обрывала и запись шаблона. Только
    // явную: сбой запроса статуса — не повод обрывать оплаченную запись.
    cancelWatch = setInterval(() => {
      void db
        .from('parser_jobs')
        .select('status')
        .eq('id', jobId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (!error && data && data.status !== 'running' && !runAbort.signal.aborted) runAbort.abort(new PolzaOutreachCancelledError());
        }, () => undefined);
    }, CANCEL_WATCH_MS);
    cancelWatch.unref?.();
    // Остановленный между захватом и стартом запуск журнал прошлого прогона не стирает.
    await ensureNotCancelled();
    // Повторный прогон (recover после падения воркера) — с чистого листа.
    // Лимит при этом ещё не исчерпан (иначе — completeSpentRun выше): профили
    // сайтов в кэше, и заново платим в основном за вакансии.
    await db.from('polza_outreach_companies').delete().eq('job_id', jobId);
    // Из шаблонов цепочек прошлого прогона — только не готовые: failed-шаблон
    // иначе сразу отправил бы компании оффера на ручную проверку без новой
    // попытки, а pending умершего прогона заставил бы ждать. Готовые (ok)
    // оплачены и годятся этому же запуску — новый прогон возьмёт их, а не
    // заплатит писателю второй раз. Путь «лимит уже исчерпан» выше шаблоны не
    // трогает — журнал и его письма остаются.
    const { error: templatesErr } = await db.from('polza_chain_templates').delete().eq('job_id', jobId).eq('lang', 'en').neq('status', 'ok');
    if (templatesErr) throw new Error(`Не удалось убрать цепочки прошлого прогона: ${templatesErr.message}`);
    // Маркер пересборки прошлого прогона (отпущенный — со статусом ok) — тоже:
    // новый прогон начинается без него.
    const { error: leaseErr } = await db.from('polza_chain_templates').delete().eq('job_id', jobId).eq('lang', 'en').eq('offer_key', REBUILD_LEASE_KEY);
    if (leaseErr) throw new Error(`Не удалось убрать маркер пересборки прошлого прогона: ${leaseErr.message}`);
    // Устаревшие профили сайтов читатель не берёт — чистим, чтобы кэш не рос без конца.
    await pruneSiteAnalysisCache('en');
    // Подпись писем — из настроек (одна на все запуски), читается один раз:
    // все письма запуска подписаны одинаково, даже если её поменяют посреди.
    const signature = await loadSignature(db);
    // Шаблоны цепочек запуска: пишутся лениво, один раз на оффер; остановка
    // запуска обрывает писателя.
    const templates = createChainTemplates({ db, jobId, writerTimeoutMs: WORKER_WRITER_TIMEOUT_MS, signal: runAbort.signal });
    templatesRef = templates;

    // ── S1: пул кандидатов ──
    const vacancies = config.sources.includes('hiring')
      ? (await selectVacancies(db, config, { want: maxCandidates })).candidates
      : [];
    const ycs = config.sources.includes('yc') ? await loadYcCompanies(db, config) : [];
    const pool = mergeCandidates(vacancies, ycs);
    const cases = await loadEnCases(db);
    // Повторы между запусками — домены компаний, готовых в других запусках.
    // Галочка «Брать компании, которые уже выгружались раньше» их не отсеивает.
    const exported = config.include_previously_exported ? new Set<string>() : await loadPreviouslyExported(db, jobId);
    log('info', `job ${jobId}: pool=${pool.length} (hiring=${vacancies.length}, yc=${ycs.length}), cases=${cases.length}, previously exported=${exported.size}, target=${target}`);

    const totals: Totals = { vacancies: 0, domainFound: 0, icpPassed: 0, emailFound: 0, writeNow: 0, ready: 0 };
    // Дедуп запуска: какая строка заняла домен. Строка, возвращённая в
    // необработанные, его освобождает; дубль помнит, чей домен он повторил
    // (уборка после стопа по лимиту).
    const domainOwner = new Map<string, string>();
    const duplicates: Duplicate[] = [];
    // MX и catch-all доменов для SMTP-проверки почты — один кэш на запуск.
    const emailDomainCache: EmailDomainCache = new Map();
    // Места для S2 (каталог PDL и Clearbit) внутри пула почты — DOMAIN_CONCURRENCY.
    const domainSlot = createLimiter(DOMAIN_CONCURRENCY);
    let cursor = 0;
    let waveNo = 0;
    let processed = 0;
    // Шаг волны, который сейчас идёт, — для progress_stage.
    let phase = 'finding_emails';
    // Лимит на ИИ исчерпан или от него остался только запас под писателя:
    // новые строки и волны не начинаем, запуск завершится штатно. Строки,
    // которые лимит остановил, уберём из журнала.
    let budgetStop = false;
    const stopForBudget = (): boolean => {
      if (!analysisBudgetLeft(budget)) budgetStop = true;
      return budgetStop;
    };
    // Ключ ИИ отвергнут, ИИ или проверка почт молчат: запуск уже падает —
    // остальным потокам новых строк не брать и прогресс не публиковать.
    let halted = false;
    // Предохранитель «ИИ молчит»: LLM_FAIL_STREAK компаний подряд отсеяны с
    // «ИИ не ответил», и между ними ни одного целого ответа модели — значит,
    // лежат модель или Requesty, и так же упадёт каждая следующая строка.
    // Считаем только отсевы по ИИ; любой целый ответ (в том числе на другой
    // строке) серию обнуляет, а ответ без главных полей и профиль из кэша —
    // нет: они ничего не говорят о том, что модель работает.
    let llmFailStreak = 0;
    const noteLlmAnswered = () => {
      llmFailStreak = 0;
    };
    const noteLlmFailed = () => {
      llmFailStreak += 1;
      if (llmFailStreak >= LLM_FAIL_STREAK) {
        throw new LlmSilentError(`ИИ не отвечает: ${LLM_FAIL_STREAK} компаний подряд без ответа модели — проверьте Requesty/модель`);
      }
    };
    // Предохранитель «проверка почт молчит»: SMTP_UNVERIFIED_STREAK адресов
    // подряд «не удалось проверить» — лежат SMTP-прокси, и каждая следующая
    // компания уйдёт на ручную проверку. Любой определённый ответ проверки
    // (рабочий, catch-all, нерабочий) серию обнуляет; «адресов на сайте нет»
    // её не трогает. Без SMTP-прокси проверки SMTP нет — нет и предохранителя.
    let smtpUnverifiedStreak = 0;
    /** true — серия дошла до порога: строку дописываем и валим запуск. */
    const noteEmailVerdict = (verdict: OutreachEmailVerdict): boolean => {
      if (!smtpOn || verdict === 'none') return false;
      if (verdict !== 'unverified') {
        smtpUnverifiedStreak = 0;
        return false;
      }
      smtpUnverifiedStreak += 1;
      return smtpUnverifiedStreak >= SMTP_UNVERIFIED_STREAK;
    };
    const smtpSilentError = () =>
      new SmtpSilentError(`Проверка почт не отвечает: ${SMTP_UNVERIFIED_STREAK} адресов подряд не удалось проверить — проверьте SMTP-прокси`);
    // Предохранитель «писатель молчит»: WRITER_FAILED_ATTEMPTS попыток шаблона
    // кончились молчанием модели — два оффера или один оффер и его повтор в
    // следующей волне, — и ни один шаблон не написан: лежат Gemini или
    // Requesty, так же кончится каждая следующая попытка. Шаблон, не прошедший
    // проверку, — ответ писателя, он серию не копит.
    let writerWorks = false;
    const writerFailures = new Map<string, string>();
    const noteTemplate = (t: ChainTemplate) => {
      if (t.status === 'ok') {
        writerWorks = true;
        return;
      }
      if (!t.aiFailed || writerWorks) return;
      writerFailures.set(`${t.offer}#${t.attempt}`, `«${POLZA_OFFER_LABELS[t.offer]}» — ${t.error ?? 'нет ответа'}`);
      if (writerFailures.size >= WRITER_FAILED_ATTEMPTS) {
        throw new WriterSilentError(`Gemini не пишет цепочки: ${[...writerFailures.values()].join('; ')}`.slice(0, 1000));
      }
    };
    // Строки, ждущие шаблон оффера, который не написан (template_failed):
    // «Переписать цепочку» доведёт их до писем без нового разбора, поэтому в
    // лимите готовых они уже занимают место — новые волны за них не докупаем.
    let awaitingTemplate = 0;
    // Из них — ждущие шаблон, который не написан из-за молчания модели: в
    // следующей волне оффер пробует писателя ещё раз, и они снова идут в письма.
    let awaitingAiRows: Qualified[] = [];
    // Строки, снова поставленные в письма, — лимит на ИИ их не возвращает в
    // необработанные: они уже разобраны и оплачены, ждут только цепочку.
    const requeuedIds = new Set<string>();

    // Ключи воронки — в порядке шагов раннера; geo_confirmed исторически значит «write now».
    const funnelOf = () => ({
      vacancies: totals.vacancies,
      domain_found: totals.domainFound,
      icp_passed: totals.icpPassed,
      email_found: totals.emailFound,
      geo_confirmed: totals.writeNow,
      ready: totals.ready,
    });
    // llm — снимок расходов: экран пишет «ИИ: потрачено $X из $Y».
    // smtp_unavailable — плашка «SMTP-проверка почт недоступна».
    const detail = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      wave: waveNo,
      target,
      pool: pool.length,
      scanned: totals.vacancies,
      ready: totals.ready,
      // Сколько компаний ждут цепочку оффера («Переписать цепочку»).
      awaiting_templates: awaitingTemplate,
      funnel: funnelOf(),
      llm: budget.snapshot(),
      ...(smtpOn ? {} : { smtp_unavailable: true }),
      ...extra,
      // Аренда запуска воркером: её несёт каждая запись progress_detail.
      [WORKER_LEASE_KEY]: owner.lease(),
    });
    currentDetail = () => detail();
    const publish = async (stage: string, extra: Record<string, unknown> = {}) => {
      // Запуск уже падает — промежуточный прогресс не пишем, итог запишет
      // обработчик сбоя.
      if (halted) return;
      await setRunningProgress({
        progress_stage: stage,
        progress_percent: Math.min(97, 5 + Math.round(90 * Math.max(totals.ready / target, Math.min(1, totals.vacancies / maxCandidates)))),
        total_found: totals.vacancies,
        total_parsed: totals.ready,
        progress_detail: detail(extra),
      });
    };
    const newTally = (id: string): Tally => ({ id, totals: [], domain: null });
    const count = (tally: Tally, key: TalliedTotal) => {
      totals[key] += 1;
      tally.totals.push(key);
    };
    /** Строка возвращается в необработанные: её вклад в счётчики вычитаем, домен освобождаем. */
    const untally = (tally: Tally) => {
      for (const key of tally.totals) totals[key] -= 1;
      // Иначе такая же компания дальше в запуске отсеялась бы «дублем»
      // строки, которой в журнале уже нет.
      if (tally.domain && domainOwner.get(tally.domain) === tally.id) domainOwner.delete(tally.domain);
      tally.totals = [];
      tally.domain = null;
    };
    /**
     * Строку остановил лимит на ИИ: она не отсеяна и не сломана — она не
     * обработана. Вклад в счётчики вычитаем, а в журнале стираем найденное
     * (UNPROCESSED_PATCH) — в конце запуска строка уйдёт из журнала вместе с
     * остальными необработанными.
     */
    const returnToPool = async (id: string, tally: Tally) => {
      untally(tally);
      await updateRow(id, UNPROCESSED_PATCH);
    };

    // ── S2, S3 и S5 для одной компании: всё бесплатное, до ИИ ──
    const prepare = async (id: string, c: Candidate, tally: Tally): Promise<Prepared | null> => {
      // S2 домен и профиль PDL — не больше DOMAIN_CONCURRENCY строк сразу.
      const resolved = await domainSlot(async () => {
        let foundDomain: string | null = c.yc?.domain ?? null;
        let foundWebsite: string | null = c.yc?.website ?? null;
        if (!foundDomain && c.vacancy) {
          const res = await resolveCompanyDomain(db, c.companyName, c.vacancy.jobCountryCode, c.vacancy.companySiteUrl);
          foundDomain = res.normalizedDomain;
          foundWebsite = res.companyWebsite;
        }
        if (!foundDomain || !foundWebsite) return null;
        return { domain: foundDomain, website: foundWebsite, pdl: await lookupPdlProfile(db, c.companyName, foundDomain) };
      });
      if (!resolved) return excludeRow(id, ST.s2Domain, 'domain_not_resolved');
      const { domain, website, pdl } = resolved;
      count(tally, 'domainFound');
      const employees = c.yc?.teamSize ?? employeesFromBucket(pdl.size);
      const countryName = c.yc?.country ?? pdl.country ?? null;
      const countryCode = c.vacancy?.jobCountryCode || (countryName ? COUNTRY_CODE_BY_NAME[countryName.toLowerCase()] ?? null : null);
      await updateRow(id, {
        normalized_domain: domain,
        company_website: website,
        employee_range: c.yc?.teamSize != null ? String(c.yc.teamSize) : pdl.size,
        industry: pdl.industry ?? c.yc?.industry ?? null,
        country: countryName,
        status: 'normalized',
        stage: ST.s2Domain,
      });

      // S3 жёсткие отсевы и дубль домена в запуске. Проверка и захват домена —
      // синхронно внутри icpFilter, без await между ними: параллельные потоки
      // не займут один домен дважды. Владельца запоминаем для уборки дублей.
      const icp = icpFilter(
        {
          companyName: c.companyName,
          companyDescription: c.vacancy?.companyDescription ?? c.yc?.description ?? null,
          vacancyDescription: c.vacancy?.vacancyDescription ?? null,
          normalizedDomain: domain,
          employees,
          minEmployees: config.min_employees,
          maxEmployees: config.max_employees,
        },
        {
          has: (d) => domainOwner.has(d),
          add: (d) => {
            domainOwner.set(d, id);
            tally.domain = d;
          },
        },
      );
      if (icp.exclude) {
        const owner = icp.reason === 'duplicate_domain' ? domainOwner.get(domain) : undefined;
        if (owner) duplicates.push({ id, tally, owner });
        return excludeRow(id, ST.s3Icp, icp.reason ?? 'icp');
      }
      // Повторы между запусками: компания уже готова в другом запуске — второй
      // раз ей не пишем. Домен строка уже заняла: такая же компания дальше в
      // этом запуске отсеется дублем этой строки.
      if (exported.has(domain)) return excludeRow(id, ST.s3Icp, 'previously_exported');
      count(tally, 'icpPassed');
      // Стадию почты пишем сразу, до поиска: ICP и повторы строка прошла, и
      // воронка по строкам должна это видеть — и пока идёт долгий поиск почты,
      // и если строка на нём упадёт (сбойная остаётся на последней стадии).
      await updateRow(id, { stage: ST.s5Email });

      // S5 почта — до ИИ: компания без рабочего адреса не стоит разбора.
      const found = await findCompanyEmail(website, domain, emailDomainCache);
      // Серия «не удалось проверить» дошла до порога — строку дописываем, запуск валим.
      const smtpSilent = noteEmailVerdict(found.verdict);
      if (!found.email || !found.verification) {
        // Адреса на сайте есть, но все не прошли проверку, — своя причина:
        // «почты нет» и «почта мёртвая» — разные выводы об источнике. Колонки
        // пояснения у английского журнала нет — какие адреса, пишем в лог.
        const invalid = found.verdict === 'invalid';
        if (invalid) log('info', `S5 ${domain}: all candidates failed verification: ${found.triedInvalid.join(', ')}`);
        return excludeRow(id, ST.s5Email, invalid ? 'email_invalid' : 'no_corporate_email');
      }
      if (await isSuppressed(db, found.email)) {
        log('info', `S5 ${domain}: ${found.email} is on the sender stop-list`);
        await excludeRow(id, ST.s5Email, 'suppressed_contact');
        if (smtpSilent) throw smtpSilentError();
        return null;
      }
      // Почту и вердикт проверки пишем сразу: строка, отсеянная дальше
      // разбором или оценкой, показывает в журнале, какой адрес у неё был и
      // чем кончилась проверка.
      const emailPatch = {
        selected_company_email: found.email,
        email_type: found.emailType,
        email_source_url: found.emailSourceUrl,
        email_verification: found.verification,
      };
      if (found.verification === 'unverified') {
        // Почта не проверена — на ручную проверку, и дальше строка не идёт:
        // разбор ИИ ей не оплачиваем, письма не пишем, решает человек. «Почту»
        // в воронке она не проходит (lib/polzaOutreach/funnel.ts).
        await updateRow(id, { ...emailPatch, status: 'needs_review', stage: ST.s5Email, review_reason: 'email_unverified' });
        if (smtpSilent) throw smtpSilentError();
        return null;
      }
      await updateRow(id, { ...emailPatch, stage: ST.s5Email });
      count(tally, 'emailFound');
      return { id, tally, c, domain, website, employees, countryCode, emailType: found.emailType };
    };

    // ── S4 для одной компании: дешёвый ИИ, поводы, Lead Score ──
    const analyze = async (p: Prepared): Promise<Qualified | null> => {
      const { id, tally, c, domain, website, employees, countryCode } = p;
      // ИИ не ответил на этой строке — отсев с честной причиной llm_failed, а
      // не «сайт не открылся». Подробность — в лог: колонки пояснения у
      // английского журнала нет, а review_reason на экране читается как
      // «на ручную проверку». Лимит, ключ и ошибки кода — выше, в safely().
      const llmFailed = async (what: string, err: LlmCallError, patch: Record<string, unknown> = {}) => {
        log('warn', `${what} LLM failed for ${c.companyName}: ${err.message}`);
        await excludeRow(id, ST.s4Analyzed, 'llm_failed', patch);
        noteLlmFailed();
        return null;
      };

      // Сайт — один обход и один разбор или готовый профиль из кэша за 30
      // дней. Не открылся — site_unreachable; ИИ не ответил — llm_failed:
      // сайт мог быть в порядке.
      let site: SiteProfile;
      try {
        site = await buildSiteProfile(website, c.yc?.description ?? c.vacancy?.companyDescription ?? null, {
          domain,
          onLlmAnswer: noteLlmAnswered,
        });
      } catch (err) {
        if (!(err instanceof LlmCallError)) throw err;
        return llmFailed('site profile', err);
      }
      if (!site.reachable) return excludeRow(id, ST.s4Analyzed, 'site_unreachable');
      if (site.exclusion) {
        const map: Record<string, string> = {
          staffing: 'staffing_agency', job_board: 'staffing_agency', lead_gen_agency: 'competitor',
          marketing_agency: 'generic_marketing', b2c: 'b2c_or_education', local_service: 'b2c_or_education', course: 'b2c_or_education',
        };
        return excludeRow(id, ST.s4Analyzed, map[site.exclusion] ?? 'b2c_or_education', { company_context: site.companyContext });
      }

      const triggers: Trigger[] = [];
      let analysisPatch: Record<string, unknown> = {};
      if (c.vacancy) {
        // Пока шёл разбор сайта, от лимита мог остаться только запас под
        // писателя цепочек — вакансию не разбираем, строка вернётся в
        // необработанные (safely()). Разбор сайта не пропал: он в кэше.
        if (!analysisBudgetLeft(budget)) throw new BudgetExceededError('На разбор остался только запас под писателя цепочек');
        let analysis: PolzaVacancyAnalysis;
        try {
          analysis = await analyzeVacancy({
            jobTitle: c.vacancy.jobTitle,
            vacancyDescription: c.vacancy.vacancyDescription,
            companyName: c.companyName,
            countryCode: c.vacancy.jobCountryCode,
          });
        } catch (err) {
          // Без разбора вакансии не проверить повод «найм» — строку не угадываем.
          if (!(err instanceof LlmCallError)) throw err;
          return llmFailed('vacancy', err, { company_context: site.companyContext });
        }
        noteLlmAnswered();
        analysisPatch = {
          outbound_mandate: analysis.outbound_mandate,
          outbound_evidence: analysis.outbound_evidence || null,
          service_line: analysis.service_line,
          target_sales_geo: analysis.target_sales_geo,
          target_sales_geo_evidence: analysis.target_sales_geo_evidence || null,
          target_sales_geo_confidence: analysis.target_sales_geo_confidence,
        };
        if (analysis.is_lead_gen_agency) return excludeRow(id, ST.s4Analyzed, 'competitor', analysisPatch);
        if (analysis.outbound_mandate) {
          triggers.push({ type: 'hiring', title: c.vacancy.jobTitle, url: c.vacancy.jobSourceUrl, date: c.vacancy.jobPublishedAt, quote: analysis.outbound_evidence || null });
        }
      }
      if (c.yc) triggers.push({ type: 'yc', title: c.yc.batch, url: c.yc.sourceUrl, date: null, quote: null });
      if (site.launch && site.launch.date && Date.now() - new Date(site.launch.date).getTime() <= LAUNCH_MAX_AGE_DAYS * DAY) {
        triggers.push({ type: 'launch', title: site.launch.quote, url: site.launch.url, date: site.launch.date, quote: site.launch.quote });
      }
      if (site.techStack.length) triggers.push({ type: 'tech_stack', title: site.techStack.join(', '), url: website, date: null, quote: null });

      const isB2b = site.isB2b || c.yc?.industry === 'b2b';
      const common = {
        ...analysisPatch,
        source_list: [c.vacancy ? 'hiring' : null, c.yc ? 'yc' : null].filter(Boolean),
        trigger_list: triggers,
        company_context: site.companyContext,
        likely_gtm_problem: site.likelyGtmProblem,
        outreach_angle: site.outreachAngle,
        segments: site.segments,
      };
      if (!isB2b) return excludeRow(id, ST.s4Analyzed, 'not_b2b', common);
      if (!triggers.length) return excludeRow(id, ST.s4Analyzed, 'no_trigger', common);

      const score = scoreLead({
        isB2b,
        businessModel: site.businessModel,
        icpClear: Boolean(site.icpQuote),
        highValue: site.highValue,
        excluded: false,
        employees,
        countryCode,
        triggers,
        hasSite: true,
        // Почта уже найдена и прошла проверку — шаг S5 теперь до разбора.
        hasEmail: true,
        hasDescription: site.hasDescription,
      });
      const status = leadStatus(score.total, thresholds);
      const primary = primaryTrigger(triggers);
      const routed = routeEnCase(cases, site.industryGroup);
      const patch = {
        ...common,
        primary_trigger: primary?.type ?? null,
        trigger_evidence_url: primary?.url ?? null,
        trigger_phrase: triggerPhrase(displayName(c.companyName), primary),
        lead_score: score.total,
        score_breakdown: score.breakdown,
        data_quality_score: score.dataQuality,
        lead_status: status,
        recommended_case: routed?.record.caseId ?? null,
        case_reason: routed?.reason ?? null,
        case_snippet: routed?.record.snippet ?? null,
        cta_type: 'route',
      };
      if (status === 'skip') return excludeRow(id, ST.s4Analyzed, 'low_score', patch);
      count(tally, 'writeNow');
      await updateRow(id, { ...patch, status: 'qualified', stage: ST.s4Analyzed });
      return { id, tally, c, site, triggers, score, caseHit: routed?.record ?? null, emailType: p.emailType };
    };

    // Места в лимите готовых для писем, которые сейчас собираются. Между
    // проверкой лимита и готовой строкой теперь ожидание шаблона (писатель —
    // до минуты): без мест все потоки пула прошли бы проверку разом, и за
    // шаблон оффера, чьи компании всё равно уйдут в limit_reached, мы бы
    // заплатили. Строка без места ждёт: место освободится, если письма
    // соседа не выйдут, — в limit_reached она уходит, только когда лимит
    // действительно набран.
    let lettersInFlight = 0;
    let slotWaiters: Array<() => void> = [];
    const takeLettersSlot = async (): Promise<boolean> => {
      for (;;) {
        if (totals.ready >= target) return false;
        if (totals.ready + lettersInFlight < target) {
          lettersInFlight += 1;
          return true;
        }
        await new Promise<void>((resolve) => slotWaiters.push(resolve));
      }
    };
    const releaseLettersSlot = () => {
      lettersInFlight -= 1;
      const waiting = slotWaiters;
      slotWaiters = [];
      for (const wake of waiting) wake();
    };

    // ── S6 для одной компании: письма из шаблона оффера и гарды ──
    const buildCompanyLetters = async (q: Qualified) => {
      // Шаблон цепочки оффера: пишется, когда до писем дошла первая компания
      // оффера; остальные ждут тот же промис. Лимит на ИИ до записи шаблона —
      // BudgetExceededError: строка возвращается в необработанные (safely()).
      const template = await templates.get(offerKeyOf(primaryTrigger(q.triggers)));
      if (template.status !== 'ok' || !template.letters) {
        // Шаблон оффера не прошёл проверку или не написан — писем собирать не
        // из чего. На ручную проверку: в рассылку строка не идёт, а
        // «Переписать цепочку» найдёт её по template_failed и id шаблона.
        await updateRow(q.id, {
          status: 'needs_review',
          stage: ST.s6Letters,
          sequence_id: SEQUENCE_ID,
          chain_template_id: template.id,
          review_reason: polzaReviewReason('template_failed', templateFailureDetail(template)),
        });
        awaitingTemplate += 1;
        if (template.aiFailed) awaitingAiRows.push(q);
        // Строка записана — теперь предохранитель: писатель молчит серией, валим запуск.
        noteTemplate(template);
        return;
      }
      noteTemplate(template);
      const composed = composeCompanyLetters(
        template.letters,
        { companyName: q.c.companyName, triggers: q.triggers, caseHit: q.caseHit, segments: q.site.segments, emailType: q.emailType },
        signature,
      );
      const base = { stage: ST.s6Letters, sequence_id: SEQUENCE_ID, chain_template_id: template.id, letters: composed.letters };
      if (!composed.guard.ok) {
        // Письма собраны, но гарды не прошли — на ручную проверку, письма в
        // строке, решает человек. Какое правило нарушено — в причине строки.
        await updateRow(q.id, {
          ...base,
          status: 'needs_review',
          review_reason: polzaReviewReason('letters_qa_failed', composed.guard.violations.join('; ')),
        });
        log('warn', `S6 guard failed for ${displayName(q.c.companyName)}`, composed.guard.violations);
        return;
      }
      if (totals.ready >= target) {
        await updateRow(q.id, { ...base, status: 'needs_review', review_reason: 'limit_reached' });
        return;
      }
      totals.ready += 1;
      // review_reason — сбросить: у строки, снова поставленной в письма, там
      // осталась бы прежняя причина «цепочка оффера не готова».
      await updateRow(q.id, { ...base, status: 'ready', review_reason: null });
    };

    const finalize = async (q: Qualified) => {
      if (!(await takeLettersSlot())) {
        // Лимит готовых набран: оценку строка прошла, писем нет (и у строки,
        // снова поставленной в письма после молчания писателя, — тоже).
        await updateRow(q.id, { status: 'needs_review', stage: ST.s4Analyzed, review_reason: 'limit_reached' });
        return;
      }
      try {
        // Пока строка ждала места, запуск мог упасть — письма ей уже не нужны.
        if (halted) return;
        await buildCompanyLetters(q);
      } finally {
        releaseLettersSlot();
      }
    };

    // Строка, снова поставленная в письма после молчания писателя: лимит на ИИ
    // до записи шаблона не возвращает её в необработанные, как свежую, — она
    // уже разобрана и оплачена, в базе ждёт цепочку (template_failed), и
    // «Переписать цепочку» доведёт её позже.
    const finalizeRequeued = async (q: Qualified) => {
      try {
        await finalize(q);
      } catch (err) {
        if (!(err instanceof BudgetExceededError)) throw err;
        budgetStop = true;
        awaitingTemplate += 1;
      }
    };

    const safely = async (id: string, tally: Tally, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof PolzaOutreachCancelledError) throw err;
        if (err instanceof LlmAuthError || err instanceof LlmSilentError || err instanceof SmtpSilentError || err instanceof WriterSilentError) {
          // Ключ не работает, ИИ, писатель цепочек или проверка почт молчат
          // серией — так же упадёт каждая строка. Валим запуск целиком.
          halted = true;
          throw err;
        }
        if (err instanceof BudgetExceededError) {
          // Лимит на ИИ: строка не отсеяна и не сломана — она не обработана.
          budgetStop = true;
          await returnToPool(id, tally);
          return;
        }
        // Стадию не трогаем: строка остаётся на последней пройденной, и
        // воронка считает её дошедшей докуда дошла.
        await updateRow(id, { status: 'failed', review_reason: err instanceof Error ? err.message.slice(0, 500) : 'failed' });
      } finally {
        // Шаг строки, а не строка: строка, дошедшая до писем, считается трижды —
        // счётчик нужен только для частоты публикаций.
        processed += 1;
        if (processed % 10 === 0) await publish(phase);
      }
    };

    /**
     * Стоп по лимиту убрал из журнала необработанные строки. «Дубль домена»,
     * чья строка-оригинал среди них, остался бы дублем записи, которой в
     * журнале нет, — а повторный запуск возьмёт компанию заново. Такие дубли
     * убираем вместе с ней.
     */
    const dropOrphanDuplicates = async (droppedIds: ReadonlySet<string>) => {
      const orphans = duplicates.filter((d) => droppedIds.has(d.owner));
      for (let i = 0; i < orphans.length; i += DB_CHUNK) {
        const chunk = orphans.slice(i, i + DB_CHUNK);
        const { data, error } = await db
          .from('polza_outreach_companies')
          .delete()
          .eq('job_id', jobId)
          .eq('exclusion_reason', 'duplicate_domain')
          .in('id', chunk.map((d) => d.id))
          .select('id');
        if (error) {
          log('warn', `job ${jobId}: orphan duplicates cleanup failed`, error);
          continue;
        }
        const gone = new Set((data ?? []).map((r) => String(r.id)));
        for (const d of chunk) {
          if (!gone.has(d.id)) continue;
          untally(d.tally);
          totals.vacancies = Math.max(0, totals.vacancies - 1);
        }
      }
    };

    // Компании, ждущие цепочку, уже занимают место в лимите готовых: докупать
    // за них разбор новых компаний незачем — «Переписать цепочку» доведёт их.
    while (totals.ready + awaitingTemplate < target && cursor < pool.length && totals.vacancies < maxCandidates) {
      // Лимит на ИИ исчерпан — новую волну не начинаем: её строкам нужен разбор.
      // Внутри волны шаг почты ИИ не тратит, поэтому лимит в нём не кончается.
      if (stopForBudget()) break;
      await ensureNotCancelled();
      waveNo += 1;
      const want = Math.min(
        nextWaveSize(target, { vacancies: totals.vacancies, ready: totals.ready + awaitingTemplate }),
        maxCandidates - totals.vacancies,
      );
      const wave = pool.slice(cursor, cursor + want);
      cursor += wave.length;

      const ids: string[] = [];
      for (let i = 0; i < wave.length; i += DB_CHUNK) {
        const { data, error } = await db
          .from('polza_outreach_companies')
          .insert(
            wave.slice(i, i + DB_CHUNK).map((c) => ({
              job_id: jobId,
              source_type: c.vacancy && c.yc ? 'hiring+yc' : c.vacancy ? 'hiring' : 'yc',
              vacancy_id: c.vacancy?.vacancyId ?? null,
              job_title: c.vacancy?.jobTitle ?? null,
              job_source_url: c.vacancy?.jobSourceUrl ?? c.yc?.sourceUrl ?? null,
              job_country_code: c.vacancy?.jobCountryCode ?? null,
              job_published_at: c.vacancy?.jobPublishedAt ?? null,
              company_name: c.companyName,
              status: 'discovered',
              stage: ST.s1Selected,
            })),
          )
          .select('id');
        if (error) throw new Error(`polza outreach S1 insert failed: ${error.message}`);
        for (const r of data ?? []) ids.push(String(r.id));
      }
      totals.vacancies += wave.length;
      phase = 'finding_emails';
      await publish(phase, { wave_size: wave.length });
      log('info', `wave ${waveNo}: ${wave.length} candidates (ready ${totals.ready}/${target})`);

      // Шаг 1 (бесплатно): домен, отсевы, повторы, почта, стоп-лист — у всей волны.
      const prepared: Prepared[] = [];
      await runPool(wave.map((c, i) => ({ c, id: ids[i] })).filter((x) => x.id), EMAIL_CONCURRENCY, async ({ c, id }) => {
        if (halted) return;
        await ensureNotCancelled();
        const tally = newTally(id);
        await safely(id, tally, async () => {
          const p = await prepare(id, c, tally);
          if (p) prepared.push(p);
        });
      });

      // Шаг 2 (дешёвый ИИ): разбор — только у компаний с рабочей почтой.
      const qualified: Qualified[] = [];
      phase = 'analyzing_vacancies';
      await publish(phase, { with_email: prepared.length });
      await runPool(prepared, ENRICH_CONCURRENCY, async (p) => {
        if (halted) return;
        if (stopForBudget()) {
          // Лимит на ИИ исчерпан — разбор не начинаем. Почту строка прошла, но
          // этот шаг бесплатный, а без разбора она ни отсеяна, ни готова:
          // возвращаем в необработанные, как строку, которую лимит прервал
          // (в конце уйдёт из журнала, повторный запуск возьмёт её заново).
          await returnToPool(p.id, p.tally);
          return;
        }
        await ensureNotCancelled();
        await safely(p.id, p.tally, async () => {
          const q = await analyze(p);
          if (q) qualified.push(q);
        });
      });

      // Шаг 3: письма — от самых сильных к слабым. Лимит на ИИ здесь не
      // проверяем: по готовому шаблону оффера письма бесплатны — уже
      // оплаченный разбор доводим до готовых (на писателя оставлен запас,
      // writerReserveUsd). Шаблон, который ещё не написан, после лимита не
      // написать: такие строки вернутся в необработанные (BudgetExceededError
      // в safely()).
      // Шаблоны, не написанные в прошлых волнах из-за молчания модели, — ещё
      // одна попытка (один раз на оффер): ждавшие их строки снова идут в письма
      // вместе со строками волны, разбор им не нужен. Снова не ответит — и ни
      // одного написанного шаблона — предохранитель валит запуск.
      const retrying = new Set(templates.retryAiFailures());
      if (retrying.size) {
        const requeued = awaitingAiRows.filter((q) => retrying.has(offerKeyOf(primaryTrigger(q.triggers))));
        awaitingAiRows = awaitingAiRows.filter((q) => !requeued.includes(q));
        awaitingTemplate -= requeued.length;
        for (const q of requeued) requeuedIds.add(q.id);
        qualified.push(...requeued);
        log('info', `job ${jobId}: retrying offer templates after the model did not answer: ${[...retrying].join(', ')} (${requeued.length} waiting rows back to letters)`);
      }
      qualified.sort((a, b) => b.score.total - a.score.total);
      phase = 'building_letters';
      await publish(phase, { write_now: qualified.length });
      // Шаблоны офферов волны — сразу и параллельно: иначе оффер, чья первая
      // компания стоит в очереди писем последней, ждал бы, пока допишутся
      // шаблоны офферов перед ним. Только офферы строк, которым хватит места
      // в лимите готовых: за шаблон оффера, все компании которого уйдут в
      // limit_reached, платить незачем (понадобится — строка напишет его
      // сама). Ошибку получит строка, которая ждёт тот же промис, — здесь её
      // только гасим.
      if (!halted) {
        const fits = qualified.slice(0, Math.max(0, target - totals.ready));
        for (const offer of new Set(fits.map((q) => offerKeyOf(primaryTrigger(q.triggers))))) {
          void templates.get(offer).catch(() => undefined);
        }
      }
      await runPool(qualified, LETTERS_CONCURRENCY, async (q) => {
        if (halted) return;
        await ensureNotCancelled();
        await safely(q.id, q.tally, () => (requeuedIds.has(q.id) ? finalizeRequeued(q) : finalize(q)));
      });
    }

    // Пока добегала последняя волна, запуск могли остановить — не перетираем «Stopped by user».
    await ensureNotCancelled();
    if (budgetStop) {
      // Строки, до которых из-за лимита не дошли или которые он прервал, — не
      // отсев и не ошибка. Среди них и прошедшие почту, но не успевшие к
      // разбору ИИ: почта бесплатна и готовой строку не делает. Убираем их из
      // журнала: воронка на экране (её считают по строкам) и «просмотрено» —
      // только то, что действительно разобрали. Повторный запуск возьмёт эти
      // компании заново, а уже оплаченные профили сайтов — из кэша.
      // normalized — прерванная строка, которую не удалось пометить необработанной.
      const { data: dropped, error: dropErr } = await db
        .from('polza_outreach_companies')
        .delete()
        .eq('job_id', jobId)
        .in('status', ['discovered', 'normalized'])
        .select('id');
      if (dropErr) log('warn', `job ${jobId}: unprocessed rows cleanup failed`, dropErr);
      else {
        const droppedIds = new Set((dropped ?? []).map((r) => String(r.id)));
        totals.vacancies = Math.max(0, totals.vacancies - droppedIds.size);
        await dropOrphanDuplicates(droppedIds);
      }
    }

    // awaiting_templates — готовых меньше заказанного, но вместе с ждущими
    // цепочку лимит набран: докупать разбор незачем, их доведёт «Переписать
    // цепочку» (тот же ключ у русского аутрича — экран пишет один текст).
    // stop_reason_base — причина, какой она была бы без ждущих (null — волны
    // шли бы дальше): если после «Переписать цепочку» ждущих не хватит до
    // заказанного (часть писем не пройдёт гарды), экран покажет её
    // (regenerate.ts), а не устаревшее «ждут цепочку».
    const baseReason = budgetStop
      ? 'budget'
      : cursor >= pool.length ? 'pool_exhausted' : totals.vacancies >= maxCandidates ? 'scan_limit' : null;
    const stopReason = totals.ready >= target
      ? 'target_reached'
      : totals.ready + awaitingTemplate >= target
        ? 'awaiting_templates'
        : baseReason ?? 'pool_exhausted';
    // Шаблон, начатый заранее для компаний, которые ушли в limit_reached, ещё
    // пишется — его расход часть итога: дожидаемся (запуск пока идёт).
    const settled = await settleCalls(COMPLETED_SETTLE_MS);
    const spend = budget.snapshot({ includeReserved: !settled });
    log('info', `job ${jobId} done: ${JSON.stringify(funnelOf())} (${stopReason}), llm $${spend.spent_usd}/$${spend.limit_usd} in ${spend.calls} calls`);
    // Тоже только идущему: остановку между проверкой выше и этой записью не перетираем.
    await finishRun({
      status: 'completed',
      progress_stage: 'completed',
      progress_percent: 100,
      total_found: totals.vacancies,
      total_parsed: totals.ready,
      completed_at: new Date().toISOString(),
      error_message: null,
      progress_detail: {
        ...detail({ stop_reason: stopReason, ...(stopReason === 'awaiting_templates' ? { stop_reason_base: baseReason } : {}) }),
        llm: spend,
      },
    });
  } catch (err) {
    // Остановка или сбой: идущие вызовы ИИ запуска обрываем — другие офферы
    // писали бы шаблоны (может, и повтор) и тратили деньги, которые итог уже
    // не увидит. Оборванные списываются оценкой сверху; итог расхода — после
    // них, последней записью, она же отпускает аренду.
    if (!runAbort.signal.aborted) runAbort.abort(new PolzaOutreachCancelledError());
    const settled = await settleCalls(ABORTED_SETTLE_MS);
    const finalDetail = { ...(currentDetail ? currentDetail() : baseDetail()), llm: budget.snapshot({ includeReserved: !settled }) };
    await owner.close();
    if (err instanceof PolzaOutreachCancelledError) {
      log('info', `job ${jobId} cancelled`);
      // Статус поставил тот, кто остановил; дописываем только итог — сколько
      // успели потратить на ИИ и докуда дошли. Только при своей аренде: после
      // перезапуска воркера запуск мог подхватить новый прогон, его прогресс
      // не трогаем.
      await owner.write({ progress_detail: finalDetail });
      return;
    }
    log('error', `job ${jobId} failed`, err);
    await owner.write({
      status: 'failed',
      progress_stage: 'failed',
      completed_at: new Date().toISOString(),
      error_message: err instanceof Error ? err.message : 'Unknown error',
      progress_detail: finalDetail,
    });
  } finally {
    if (cancelWatch) clearInterval(cancelWatch);
    await owner.close();
  }
}
