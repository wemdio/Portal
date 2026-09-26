/**
 * «Переписать цепочку» (спека 2026-09-26-outreach-to-sender-design.md §4):
 * новая попытка писателя для шаблона оффера, не прошедшего проверку, и
 * пересборка писем строк, которые этот шаблон ждали (очень спорные с
 * признаком TEMPLATE_FAILED).
 *
 * Работает в роуте, без обхода сайтов: всё, что нужно письмам, лежит в строке
 * журнала (поводы, цитата рынка, кейс, почта). Лимит готовых — тот же, что у
 * запуска: сколько готовых уже есть, столько мест и занято; строки сверх
 * лимита получают то же, что в раннере, — LIMIT_REACHED. Деньги — из лимита
 * на ИИ запуска (бюджет из progress_detail.llm); потраченное дописывается
 * обратно в progress_detail.llm, счётчики экрана пересчитываются по журналу.
 *
 * Одна пересборка на запуск за раз: отметка progress_detail.rebuilding,
 * которую ставят и снимают записью со сравнением. Под ней считаются готовые
 * (места в лимите) и пишется расход — две пересборки разных офферов не
 * делят одни места и не затирают расход друг друга. Роут пускает сюда только
 * законченный запуск: пока он идёт, воркер ведёт лимит готовых и расход в
 * памяти, и пересборка сбоку их бы разошла.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BudgetExceededError, JobBudget, LlmAuthError, type OutreachLlmBudgetSnapshot } from '@/lib/outreachLlm/context';
import { dropLettersDoubts, lettersQaDoubtText, templateDoubtText, withLettersDoubt } from './doubts';
import { journalCounts, type JournalCountRow, type JournalCounts } from './funnel';
import { buildSegmentsHypothesis, type SegmentsHypothesis } from './letters/chains';
import { composeCompanyLetters, type CompanyLettersInput } from './letters/renderTemplate';
import {
  regenerateChainTemplate,
  ROUTE_WRITER_TIMEOUT_MS,
  templateBeingWritten,
  templateExists,
  type ChainTemplate,
} from './letters/templateWriter';
import type { Libraries, SenderProfile } from './libraries';
import { chainOfSignal } from './router';
import { TEMPLATE_VERSION, sanitizeRuOutreachConfig, type ChainType, type RuOutreachConfig, type Signal } from './types';

const ROWS = 'polza_ru_outreach_companies';
const PAGE = 1000;
const WAITING_COLUMNS =
  'id,chain_type,company_name,company_brand,is_routing,signals,signal_type,signal_title,signal_date,evidence_quote,source_url,' +
  'prior_contact,market_evidence_quote,target_market,fit_reasons,case_id,recipient_email,amo_status,priority_score,doubt_flags,doubt_detail';
const PRODUCT_PREFIX = 'Продукт: ';
/** Письма строк собираются по четыре сразу: гипотеза — сетевой вызов. */
const REBUILD_POOL = 4;
/** Писатель не съедает весь срок роута: минута остаётся на пересборку писем. */
const REBUILD_RESERVE_MS = 60_000;
/** Меньше этого до срока — гипотезы не считаем: письма без гипотезы, зато успеют. */
const HYPOTHESIS_MIN_LEFT_MS = 60_000;
/** Гипотеза — дешёвая модель: полминуты ей с запасом, дольше — ждать нечего. */
const HYPOTHESIS_TIMEOUT_MS = 30_000;
/** Меньше этого до срока — новую пачку строк не начинаем: они подождут следующего нажатия. */
const STOP_MARGIN_MS = 10_000;
/**
 * Отметка пересборки живёт дольше самого роута (maxDuration 280 с): роут,
 * который умер посреди работы, отпускает запуск сам, через пять минут.
 */
const REBUILD_LOCK_TTL_MS = 300_000;

interface WaitingRow {
  id: string;
  chain_type: string;
  company_name: string;
  company_brand: string | null;
  is_routing: boolean | null;
  signals: unknown;
  signal_type: string | null;
  signal_title: string | null;
  signal_date: string | null;
  evidence_quote: string | null;
  source_url: string | null;
  prior_contact: boolean | null;
  market_evidence_quote: string | null;
  target_market: string | null;
  fit_reasons: unknown;
  case_id: string | null;
  recipient_email: string | null;
  amo_status: string | null;
  priority_score: number | null;
  doubt_flags: string[] | null;
  doubt_detail: string | null;
}

export interface RegenerateSummary {
  /** Итог шаблона: ok — прошёл проверку, failed — снова нет. */
  status: 'ok' | 'failed';
  templateId: string;
  /** Писатель писал заново (false — шаблон уже был готов, пересобраны только письма). */
  rewritten: boolean;
  /** Строк оффера ждали цепочку. */
  waiting: number;
  /** Стали готовыми. */
  promoted: number;
  /** Остались очень спорными: шаблон снова не прошёл или письма не прошли автопроверку. */
  stillDoubtful: number;
  /** Лимит готовых запуска набран — LIMIT_REACHED, как в раннере. */
  limitReached: number;
  /** Не успели до срока роута — ждут дальше, следующее нажатие их пересоберёт (без писателя). */
  unfinished: number;
  /** Сколько эта пересборка потратила на ИИ (писатель и гипотезы). */
  costUsd: number;
  qaFlags: string[];
  error: string | null;
}

export type RegenerateOfferResult =
  | { kind: 'missing' }
  /** rebuild — идёт другая пересборка запуска; writing — пишется шаблон оффера (offer). */
  | { kind: 'busy'; reason: 'rebuild' | 'writing'; offer?: ChainType }
  /** Компаний, которые ждут эту цепочку, нет — переписывать незачем, писателю не платим. */
  | { kind: 'nothing' }
  /** Лимит готовых уже набран — пересобранные письма всё равно не стали бы готовыми. */
  | { kind: 'limit'; ready: number }
  | { kind: 'done'; summary: RegenerateSummary };

export interface RegenerateOfferInput {
  /** Клиент пользователя: RLS пускает только к его запускам. */
  db: SupabaseClient;
  jobId: string;
  chain: ChainType;
  /** Сколько готовых компаний нужно запуску (config.limit). */
  target: number;
  libraries: Libraries;
  sender: SenderProfile;
  /** Бюджет запуска из progress_detail.llm — тот же объект, что в контексте ИИ. */
  budget: JobBudget;
  /** Срок роута (Date.now()): писатель, гипотезы и пересборка укладываются в него. */
  deadlineAt: number;
}

function log(level: 'info' | 'warn', msg: string): void {
  console[level](`[polza-ru-outreach][regenerate][${level.toUpperCase()}] ${msg}`);
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/** Пул: не больше limit задач сразу, результаты — в порядке входа. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/* ─────────────────────────── Расход на ИИ ─────────────────────────── */

interface Spend {
  analysis: { usd: number; calls: number };
  writer: { usd: number; calls: number };
}

function spendOf(budget: JobBudget): Spend {
  return { analysis: { ...budget.byRole.analysis }, writer: { ...budget.byRole.writer } };
}

function spendSince(before: Spend, budget: JobBudget): Spend {
  const now = spendOf(budget);
  return {
    analysis: { usd: now.analysis.usd - before.analysis.usd, calls: now.analysis.calls - before.analysis.calls },
    writer: { usd: now.writer.usd - before.writer.usd, calls: now.writer.calls - before.writer.calls },
  };
}

function hasSpend(spent: Spend): boolean {
  return Boolean(spent.analysis.calls || spent.writer.calls || spent.analysis.usd || spent.writer.usd);
}

/* ─────────────────────── Отметка пересборки ─────────────────────── */

interface RebuildMarker {
  token: string;
  until: string;
}

function markerOf(detail: Record<string, unknown>): RebuildMarker | null {
  const raw = detail.rebuilding;
  if (!raw || typeof raw !== 'object') return null;
  const { token, until } = raw as Record<string, unknown>;
  return typeof token === 'string' && typeof until === 'string' ? { token, until } : null;
}

interface JobState {
  status: string;
  config: RuOutreachConfig;
  detail: Record<string, unknown>;
}

type DetailChange = { detail: Record<string, unknown>; patch?: Record<string, unknown> } | null;

/**
 * Запись progress_detail со сравнением: пишем, только если отметка
 * пересборки в базе та же, что мы прочитали (или её так же нет). Законченный
 * запуск меняют только пересборки, и каждая ставит и снимает отметку, — её
 * хватает как версии. change вернул null — писать не надо (занято).
 */
async function casProgressDetail(db: SupabaseClient, jobId: string, change: (job: JobState) => DetailChange): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: job, error } = await db.from('parser_jobs').select('status,config,progress_detail').eq('id', jobId).maybeSingle();
    if (error || !job) throw new Error(`Не удалось прочитать запуск: ${error?.message ?? 'не найден'}`);
    const detail = asObject(job.progress_detail);
    const seen = markerOf(detail);
    const next = change({
      status: String(job.status ?? ''),
      config: sanitizeRuOutreachConfig((job.config ?? {}) as Partial<RuOutreachConfig>),
      detail,
    });
    if (!next) return false;
    const base = db.from('parser_jobs').update({ ...(next.patch ?? {}), progress_detail: next.detail }).eq('id', jobId);
    const guarded = seen ? base.eq('progress_detail->rebuilding->>token', seen.token) : base.is('progress_detail->rebuilding', null);
    const { data, error: saveErr } = await guarded.select('id');
    if (saveErr) throw new Error(`Не удалось сохранить прогресс запуска: ${saveErr.message}`);
    if (data?.length) return true;
  }
  throw new Error('Прогресс запуска меняют одновременно — попробуйте ещё раз');
}

/** Занять запуск: отметки нет или она просрочена (роут умер). Идёт или ждёт воркера — нельзя. */
async function acquireRebuild(db: SupabaseClient, jobId: string, token: string): Promise<boolean> {
  return casProgressDetail(db, jobId, (job) => {
    if (job.status === 'pending' || job.status === 'running') return null;
    const seen = markerOf(job.detail);
    if (seen && Date.parse(seen.until) > Date.now()) return null;
    return { detail: { ...job.detail, rebuilding: { token, until: new Date(Date.now() + REBUILD_LOCK_TTL_MS).toISOString() } } };
  });
}

/**
 * Отпустить запуск и записать итог: расход на ИИ — прибавкой к снимку, счётчики
 * экрана — по журналу, stop_reason — «набран лимит», если пересборка его
 * добрала. Отметку снимаем, только если она ещё наша: просроченную и занятую
 * заново не трогаем, но расход дописываем и тогда — деньги потрачены.
 */
async function releaseRebuild(
  db: SupabaseClient,
  jobId: string,
  token: string,
  spent: Spend,
  counts: JournalCounts | null,
  target: number,
): Promise<void> {
  await casProgressDetail(db, jobId, (job) => {
    const detail = { ...job.detail };
    if (markerOf(detail)?.token === token) delete detail.rebuilding;
    if (hasSpend(spent)) {
      const total = JobBudget.fromSnapshot((detail.llm ?? null) as Partial<OutreachLlmBudgetSnapshot> | null, job.config.llm_budget_usd);
      for (const role of ['analysis', 'writer'] as const) {
        total.byRole[role].usd += spent[role].usd;
        total.byRole[role].calls += spent[role].calls;
        total.spentUsd += spent[role].usd;
        total.calls += spent[role].calls;
      }
      detail.llm = total.snapshot();
    }
    if (!counts) return { detail };
    Object.assign(detail, {
      ready: counts.ready,
      doubtful: counts.doubtful,
      awaiting_templates: counts.awaiting,
      funnel: counts.funnel,
      reasons: counts.reasons,
      chains: counts.chains,
    });
    if (counts.ready >= target) {
      detail.stop_reason = 'target_reached';
      delete detail.stop_reason_base;
    } else if (detail.stop_reason === 'awaiting_templates' && counts.ready + counts.awaiting < target) {
      // Запуск встал, потому что заказанное набиралось вместе с ждущими
      // цепочку. Их стало меньше (часть писем не прошла автопроверку) — эта
      // причина больше не верна: возвращаем ту, что была бы без ждущих
      // (раннер записал её в stop_reason_base), а если её нет — не
      // утверждаем никакой.
      const base = detail.stop_reason_base;
      if (typeof base === 'string' && base) detail.stop_reason = base;
      else delete detail.stop_reason;
      delete detail.stop_reason_base;
    }
    return { detail, patch: { total_parsed: counts.ready } };
  });
}

/* ─────────────────────────── Строки ─────────────────────────── */

async function loadWaitingRows(db: SupabaseClient, jobId: string, chain: ChainType): Promise<WaitingRow[]> {
  const rows: WaitingRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(ROWS)
      .select(WAITING_COLUMNS)
      .eq('job_id', jobId)
      .eq('chain_type', chain)
      .eq('row_status', 'doubtful')
      .contains('doubt_flags', ['TEMPLATE_FAILED'])
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Не удалось прочитать строки оффера: ${error.message}`);
    rows.push(...((data ?? []) as unknown as WaitingRow[]));
    if (!data || data.length < PAGE) break;
  }
  // От сильных к слабым, как письма в раннере (pre-LPR rerank): места в
  // лимите готовых достаются лучшим.
  return rows.sort((a, b) => (b.priority_score ?? -1) - (a.priority_score ?? -1));
}

async function countReady(db: SupabaseClient, jobId: string): Promise<number> {
  const { count, error } = await db.from(ROWS).select('id', { count: 'exact', head: true }).eq('job_id', jobId).eq('row_status', 'ready');
  if (error) throw new Error(`Не удалось посчитать готовые строки: ${error.message}`);
  return count ?? 0;
}

async function loadCounts(db: SupabaseClient, jobId: string): Promise<JournalCounts> {
  const rows: JournalCountRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(ROWS)
      .select('row_status,pipeline_stage,reason_code,chain_type,doubt_flags')
      .eq('job_id', jobId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Не удалось прочитать журнал запуска: ${error.message}`);
    rows.push(...((data ?? []) as JournalCountRow[]));
    if (!data || data.length < PAGE) break;
  }
  return journalCounts(rows);
}

/** Правка строки — только пока она ждёт цепочку: false — строку уже поменяли. */
async function updateWaitingRow(db: SupabaseClient, jobId: string, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await db
    .from(ROWS)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('job_id', jobId)
    .eq('row_status', 'doubtful')
    .select('id');
  if (error) throw new Error(`Не удалось обновить строку ${id}: ${error.message}`);
  return Boolean(data?.length);
}

function dateMs(value: string | null | undefined): number | null {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * Главный повод строки среди её поводов: того же типа, и лучше всего
 * совпавший по заголовку, цитате, ссылке и дате — у компании бывает несколько
 * поводов одного типа (две новости, два контракта).
 */
function mainSignal(row: WaitingRow, signals: Signal[]): Signal | null {
  if (!row.signal_type) return null;
  const rowDate = dateMs(row.signal_date);
  const score = (s: Signal) =>
    (s.title === row.signal_title ? 4 : 0) +
    (row.evidence_quote && s.quote === row.evidence_quote ? 2 : 0) +
    (row.source_url && s.url === row.source_url ? 1 : 0) +
    (rowDate !== null && dateMs(s.date) === rowDate ? 1 : 0);
  let best: Signal | null = null;
  for (const s of signals) {
    if (s.type === row.signal_type && (!best || score(s) > score(best))) best = s;
  }
  return best;
}

/**
 * Вход писем из строки журнала — то же, что раннер берёт из разбора.
 * Исходная цепочка «Автоматизации» — «Возврат», если был разговор в AMO,
 * иначе цепочка главного повода (без повода — «Только профиль»): её выбрал
 * роутер.
 */
function companyInput(row: WaitingRow, chain: ChainType, libraries: Libraries): CompanyLettersInput {
  const signals = Array.isArray(row.signals) ? (row.signals as Signal[]) : [];
  const primary = mainSignal(row, signals);
  const prior = row.prior_contact === true;
  const fitReasons = Array.isArray(row.fit_reasons) ? row.fit_reasons : [];
  const product = fitReasons.find((r): r is string => typeof r === 'string' && r.startsWith(PRODUCT_PREFIX));
  return {
    chain,
    brand: row.company_brand ?? row.company_name,
    isRouting: row.is_routing === true,
    primary,
    signals,
    priorContact: prior,
    baseChain: chain === 'automation' ? (prior ? 'reactivation' : (primary && chainOfSignal(primary.type)) || 'icp_only') : undefined,
    marketQuote: row.market_evidence_quote,
    productSummary: product ? product.slice(PRODUCT_PREFIX.length) : null,
    targetMarket: row.target_market,
    caseRecord: row.case_id ? libraries.cases.find((c) => c.case_id === row.case_id) ?? null : null,
    recipientEmail: row.recipient_email ?? '',
    amoStatus: row.amo_status,
  };
}

interface RowsOutcome {
  promoted: number;
  stillDoubtful: number;
  limitReached: number;
  unfinished: number;
}

/**
 * Письма строк по готовому шаблону. Строки идут пачками по числу свободных мест
 * в лимите готовых, от сильных к слабым: пачка собирается параллельно, места
 * раздаются по порядку, а если чьи-то письма не прошли автопроверку — места
 * добирает следующая пачка. Лишних писем (и гипотез) для строк, которым места
 * всё равно не достанется, не собираем.
 */
async function rebuildRows(input: RegenerateOfferInput, template: ChainTemplate, rows: WaitingRow[], readyAtStart: number): Promise<RowsOutcome> {
  const { db, jobId, chain, libraries, sender, budget, deadlineAt } = input;
  const outcome: RowsOutcome = { promoted: 0, stillDoubtful: 0, limitReached: 0, unfinished: 0 };
  const letters = template.letters;
  if (template.status !== 'ok' || !letters) {
    // Шаблон снова не прошёл: строки ждут дальше, пояснение — про новую попытку.
    const text = templateDoubtText(template);
    const updated = await mapPool(rows, REBUILD_POOL, (row) =>
      updateWaitingRow(db, jobId, row.id, { ...withLettersDoubt(row.doubt_flags, row.doubt_detail, 'TEMPLATE_FAILED', text), chain_template_id: template.id }),
    );
    outcome.stillDoubtful = updated.filter(Boolean).length;
    return outcome;
  }
  // Гипотеза необязательна, как в раннере: лимит на ИИ, сбой модели или
  // близкий срок роута — письмо 3 без неё.
  const hypothesis = async (req: { brand: string; productSummary: string | null; marketQuote: string }): Promise<SegmentsHypothesis | null> => {
    const left = deadlineAt - Date.now();
    if (left < HYPOTHESIS_MIN_LEFT_MS || budget.exhausted()) return null;
    try {
      return await buildSegmentsHypothesis(req, { timeoutMs: Math.min(HYPOTHESIS_TIMEOUT_MS, left - HYPOTHESIS_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof LlmAuthError) throw err;
      if (!(err instanceof BudgetExceededError)) log('warn', `segments hypothesis failed for ${req.brand}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  let slots = input.target - readyAtStart;
  let next = 0;
  while (next < rows.length && slots > 0) {
    if (deadlineAt - Date.now() < STOP_MARGIN_MS) break;
    const batch = rows.slice(next, next + slots);
    next += batch.length;
    const composed = await mapPool(batch, REBUILD_POOL, (row) =>
      composeCompanyLetters(letters, companyInput(row, chain, libraries), { sender, claims: libraries.claims, hypothesis }),
    );
    for (const [i, row] of batch.entries()) {
      const c = composed[i];
      const kept = dropLettersDoubts(row.doubt_flags, row.doubt_detail);
      const base = {
        letters: c.letters,
        subject_b: null,
        case_id: c.caseId,
        campaign_hypothesis: c.hypothesisText,
        offer_version: libraries.offerVersion,
        offer_claim_ids: c.claimIds,
        sender_id: sender.id,
        template_version: TEMPLATE_VERSION,
        chain_template_id: template.id,
        qa_status: c.qa.status,
        qa_flags: c.qa.flags,
      };
      if (c.qa.status !== 'passed') {
        // Письма собраны, но автопроверку не прошли — как в раннере: очень
        // спорная на проверке писем, письма в строке, решает человек.
        const saved = await updateWaitingRow(db, jobId, row.id, {
          ...base,
          ...withLettersDoubt(kept.doubt_flags, kept.doubt_detail, 'LETTERS_QA_FAILED', lettersQaDoubtText(c.qa.flags)),
          row_status: 'doubtful',
          pipeline_stage: 'qa_checked',
          reason_code: null,
          reason_detail: null,
        });
        if (saved) outcome.stillDoubtful += 1;
        continue;
      }
      if (await updateWaitingRow(db, jobId, row.id, { ...base, ...kept, row_status: 'ready', pipeline_stage: 'ready', reason_code: null, reason_detail: null })) {
        slots -= 1;
        outcome.promoted += 1;
      }
    }
  }
  // Остальные: лимит набран — как в раннере, оценку прошли, до писем не дошли;
  // не успели до срока роута — ждут следующего нажатия (шаблон уже готов).
  const rest = rows.slice(next);
  if (slots > 0) {
    outcome.unfinished = rest.length;
    return outcome;
  }
  const limited = await mapPool(rest, REBUILD_POOL, (row) =>
    updateWaitingRow(db, jobId, row.id, {
      ...dropLettersDoubts(row.doubt_flags, row.doubt_detail),
      chain_template_id: template.id,
      row_status: 'manual_review',
      pipeline_stage: 'sequence_assembled',
      reason_code: 'LIMIT_REACHED',
      reason_detail: 'лимит готовых компаний уже набран',
    }),
  );
  outcome.limitReached = limited.filter(Boolean).length;
  return outcome;
}

/**
 * Переписать шаблон оффера и пересобрать письма ждавших его строк. Вызывать
 * внутри runWithOutreachContext с тем же бюджетом (input.budget): писатель и
 * гипотезы списывают деньги с лимита запуска. Расход сохраняется в запуск,
 * даже если пересборка оборвалась на середине — деньги уже потрачены.
 */
export async function regenerateOfferChain(input: RegenerateOfferInput): Promise<RegenerateOfferResult> {
  const { db, jobId, chain, libraries, sender, budget } = input;
  const token = randomUUID();
  if (!(await acquireRebuild(db, jobId, token))) return { kind: 'busy', reason: 'rebuild' };
  const before = spendOf(budget);
  const spentBefore = budget.spentUsd;
  let touchedRows = false;
  let failure: unknown = null;
  let result: RegenerateOfferResult | null = null;
  try {
    // Под отметкой: другой шаблон запуска ещё пишется (процесс жив) — ждём,
    // иначе две записи делили бы лимит и расход.
    const writing = await templateBeingWritten(db, jobId);
    if (writing) {
      result = { kind: 'busy', reason: 'writing', offer: writing };
    } else if (!(await templateExists(db, jobId, chain))) {
      result = { kind: 'missing' };
    } else {
      // Платить писателю — только если есть кого пересобирать и куда:
      // строки ждут цепочку, а в лимите готовых есть места.
      const rows = await loadWaitingRows(db, jobId, chain);
      const ready = rows.length ? await countReady(db, jobId) : 0;
      if (!rows.length) {
        result = { kind: 'nothing' };
      } else if (ready >= input.target) {
        result = { kind: 'limit', ready };
      } else {
        const outcome = await regenerateChainTemplate(
          { db, jobId, sender, claims: libraries.claims, writerTimeoutMs: ROUTE_WRITER_TIMEOUT_MS, deadlineAt: input.deadlineAt - REBUILD_RESERVE_MS },
          chain,
        );
        if (outcome.kind === 'busy') {
          result = { kind: 'busy', reason: 'writing', offer: chain };
        } else if (outcome.kind === 'missing') {
          result = { kind: 'missing' };
        } else {
          touchedRows = true;
          const counts = await rebuildRows(input, outcome.template, rows, ready);
          result = {
            kind: 'done',
            summary: {
              status: outcome.template.status,
              templateId: outcome.template.id,
              rewritten: outcome.wrote,
              waiting: rows.length,
              ...counts,
              costUsd: roundUsd(budget.spentUsd - spentBefore),
              qaFlags: outcome.template.qaFlags,
              error: outcome.template.error,
            },
          };
        }
      }
    }
  } catch (err) {
    failure = err;
  }
  try {
    const counts = touchedRows ? await loadCounts(db, jobId) : null;
    await releaseRebuild(db, jobId, token, spendSince(before, budget), counts, input.target);
  } catch (err) {
    // Сбой записи итога не должен спрятать исходную ошибку пересборки.
    if (failure) log('warn', `job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    else failure = err;
  }
  if (failure) throw failure;
  if (!result) throw new Error('Пересборка цепочки не вернула результата');
  return result;
}
