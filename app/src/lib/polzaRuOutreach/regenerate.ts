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
 * Роут пускает сюда только законченный запуск: пока он идёт, воркер ведёт
 * лимит готовых и расход в памяти, и пересборка сбоку их бы разошла.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { BudgetExceededError, JobBudget, LlmAuthError, type OutreachLlmBudgetSnapshot } from '@/lib/outreachLlm/context';
import { dropLettersDoubts, lettersQaDoubtText, templateDoubtText, withLettersDoubt } from './doubts';
import { journalCounts, type JournalCountRow } from './funnel';
import { buildSegmentsHypothesis, type SegmentsHypothesis } from './letters/chains';
import { composeCompanyLetters, type CompanyLettersInput } from './letters/renderTemplate';
import { regenerateChainTemplate, ROUTE_WRITER_TIMEOUT_MS, type ChainTemplate } from './letters/templateWriter';
import type { Libraries, SenderProfile } from './libraries';
import { chainOfSignal } from './router';
import { TEMPLATE_VERSION, sanitizeRuOutreachConfig, type ChainType, type RuOutreachConfig, type Signal } from './types';

const ROWS = 'polza_ru_outreach_companies';
const PAGE = 1000;
const WAITING_COLUMNS =
  'id,chain_type,company_name,company_brand,is_routing,signals,signal_type,signal_title,prior_contact,' +
  'market_evidence_quote,target_market,fit_reasons,case_id,recipient_email,amo_status,priority_score,doubt_flags,doubt_detail';
const PRODUCT_PREFIX = 'Продукт: ';

interface WaitingRow {
  id: string;
  chain_type: string;
  company_name: string;
  company_brand: string | null;
  is_routing: boolean | null;
  signals: unknown;
  signal_type: string | null;
  signal_title: string | null;
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
  /** Лимит готовых запуска уже набран — LIMIT_REACHED, как в раннере. */
  limitReached: number;
  /** Сколько эта пересборка потратила на ИИ (писатель и гипотезы). */
  costUsd: number;
  qaFlags: string[];
  error: string | null;
}

export type RegenerateOfferResult = { kind: 'missing' } | { kind: 'busy' } | { kind: 'done'; summary: RegenerateSummary };

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
}

function log(level: 'info' | 'warn', msg: string): void {
  console[level](`[polza-ru-outreach][regenerate][${level.toUpperCase()}] ${msg}`);
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

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

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

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

/**
 * Вход писем из строки журнала — то же, что раннер берёт из разбора. Главный
 * повод — среди поводов строки по типу и заголовку; исходная цепочка
 * «Автоматизации» — «Возврат», если был разговор в AMO, иначе цепочка
 * главного повода (без повода — «Только профиль»): её выбрал роутер.
 */
function companyInput(row: WaitingRow, chain: ChainType, libraries: Libraries): CompanyLettersInput {
  const signals = Array.isArray(row.signals) ? (row.signals as Signal[]) : [];
  const primary = row.signal_type
    ? signals.find((s) => s.type === row.signal_type && s.title === row.signal_title) ?? signals.find((s) => s.type === row.signal_type) ?? null
    : null;
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

/**
 * Расход на ИИ и счётчики экрана — в progress_detail. Расход — прибавкой к
 * свежему снимку, а не нашим снимком целиком: две пересборки разных офферов
 * одного запуска иначе затёрли бы расход друг друга.
 */
async function refreshJob(db: SupabaseClient, jobId: string, spent: Spend, recount: boolean): Promise<void> {
  const { data: job, error } = await db.from('parser_jobs').select('config,progress_detail').eq('id', jobId).maybeSingle();
  if (error || !job) throw new Error(`Не удалось прочитать запуск: ${error?.message ?? 'не найден'}`);
  const detail = asObject(job.progress_detail);
  const patch: Record<string, unknown> = {};
  if (spent.analysis.calls || spent.writer.calls || spent.analysis.usd || spent.writer.usd) {
    const limit = sanitizeRuOutreachConfig((job.config ?? {}) as Partial<RuOutreachConfig>).llm_budget_usd;
    const total = JobBudget.fromSnapshot((detail.llm ?? null) as Partial<OutreachLlmBudgetSnapshot> | null, limit);
    for (const role of ['analysis', 'writer'] as const) {
      total.byRole[role].usd += spent[role].usd;
      total.byRole[role].calls += spent[role].calls;
      total.spentUsd += spent[role].usd;
      total.calls += spent[role].calls;
    }
    detail.llm = total.snapshot();
  }
  if (recount) {
    const rows: JournalCountRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error: rowsErr } = await db
        .from(ROWS)
        .select('row_status,pipeline_stage,reason_code,chain_type')
        .eq('job_id', jobId)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (rowsErr) throw new Error(`Не удалось прочитать журнал запуска: ${rowsErr.message}`);
      rows.push(...((data ?? []) as JournalCountRow[]));
      if (!data || data.length < PAGE) break;
    }
    const counts = journalCounts(rows);
    Object.assign(detail, { ready: counts.ready, doubtful: counts.doubtful, funnel: counts.funnel, reasons: counts.reasons, chains: counts.chains });
    patch.total_parsed = counts.ready;
  }
  patch.progress_detail = detail;
  const { error: saveErr } = await db.from('parser_jobs').update(patch).eq('id', jobId);
  if (saveErr) throw new Error(`Не удалось сохранить расход и счётчики запуска: ${saveErr.message}`);
}

interface RowsOutcome {
  promoted: number;
  stillDoubtful: number;
  limitReached: number;
}

async function rebuildRows(input: RegenerateOfferInput, template: ChainTemplate, rows: WaitingRow[]): Promise<RowsOutcome> {
  const { db, jobId, chain, libraries, sender, budget } = input;
  const outcome: RowsOutcome = { promoted: 0, stillDoubtful: 0, limitReached: 0 };
  if (template.status !== 'ok' || !template.letters) {
    // Шаблон снова не прошёл: строки ждут дальше, пояснение — про новую попытку.
    const text = templateDoubtText(template);
    for (const row of rows) {
      if (await updateWaitingRow(db, jobId, row.id, { ...withLettersDoubt(row.doubt_flags, row.doubt_detail, 'TEMPLATE_FAILED', text), chain_template_id: template.id })) {
        outcome.stillDoubtful += 1;
      }
    }
    return outcome;
  }
  // Гипотеза необязательна, как в раннере: лимит на ИИ или сбой модели — письмо 3 без неё.
  const hypothesis = async (req: { brand: string; productSummary: string | null; marketQuote: string }): Promise<SegmentsHypothesis | null> => {
    if (budget.exhausted()) return null;
    try {
      return await buildSegmentsHypothesis(req);
    } catch (err) {
      if (err instanceof LlmAuthError) throw err;
      if (!(err instanceof BudgetExceededError)) log('warn', `segments hypothesis failed for ${req.brand}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  let ready = await countReady(db, jobId);
  for (const row of rows) {
    const kept = dropLettersDoubts(row.doubt_flags, row.doubt_detail);
    if (ready >= input.target) {
      // Лимит готовых запуска набран — как в раннере: оценку прошла, до писем не дошла.
      if (await updateWaitingRow(db, jobId, row.id, {
        ...kept,
        chain_template_id: template.id,
        row_status: 'manual_review',
        pipeline_stage: 'sequence_assembled',
        reason_code: 'LIMIT_REACHED',
        reason_detail: 'лимит готовых компаний уже набран',
      })) outcome.limitReached += 1;
      continue;
    }
    const composed = await composeCompanyLetters(template.letters, companyInput(row, chain, libraries), { sender, claims: libraries.claims, hypothesis });
    const base = {
      letters: composed.letters,
      subject_b: null,
      case_id: composed.caseId,
      campaign_hypothesis: composed.hypothesisText,
      offer_version: libraries.offerVersion,
      offer_claim_ids: composed.claimIds,
      sender_id: sender.id,
      template_version: TEMPLATE_VERSION,
      chain_template_id: template.id,
      qa_status: composed.qa.status,
      qa_flags: composed.qa.flags,
    };
    if (composed.qa.status !== 'passed') {
      // Письма собраны, но автопроверку не прошли — как в раннере: очень
      // спорная на проверке писем, письма в строке, решает человек.
      if (await updateWaitingRow(db, jobId, row.id, {
        ...base,
        ...withLettersDoubt(kept.doubt_flags, kept.doubt_detail, 'LETTERS_QA_FAILED', lettersQaDoubtText(composed.qa.flags)),
        row_status: 'doubtful',
        pipeline_stage: 'qa_checked',
        reason_code: null,
        reason_detail: null,
      })) outcome.stillDoubtful += 1;
      continue;
    }
    if (await updateWaitingRow(db, jobId, row.id, { ...base, ...kept, row_status: 'ready', pipeline_stage: 'ready', reason_code: null, reason_detail: null })) {
      ready += 1;
      outcome.promoted += 1;
    }
  }
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
  const before = spendOf(budget);
  const spentBefore = budget.spentUsd;
  let result: RegenerateOfferResult | null = null;
  let touchedRows = false;
  let failure: unknown = null;
  try {
    const outcome = await regenerateChainTemplate({ db, jobId, sender, claims: libraries.claims, writerTimeoutMs: ROUTE_WRITER_TIMEOUT_MS }, chain);
    if (outcome.kind !== 'done') {
      result = outcome;
    } else {
      const rows = await loadWaitingRows(db, jobId, chain);
      touchedRows = rows.length > 0;
      const counts = await rebuildRows(input, outcome.template, rows);
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
  } catch (err) {
    failure = err;
  }
  try {
    await refreshJob(db, jobId, spendSince(before, budget), touchedRows);
  } catch (err) {
    // Сбой записи счётчиков не должен спрятать исходную ошибку пересборки.
    if (failure) log('warn', `job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    else failure = err;
  }
  if (failure) throw failure;
  if (!result) throw new Error('Пересборка цепочки не вернула результата');
  return result;
}
