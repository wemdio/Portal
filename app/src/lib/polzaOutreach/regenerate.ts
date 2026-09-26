/**
 * «Переписать цепочку» английского аутрича (спека
 * 2026-09-26-outreach-to-sender-design.md §4): новая попытка писателя для
 * шаблона оффера, не прошедшего проверку, и пересборка писем строк, которые
 * этот шаблон ждали (needs_review с причиной template_failed). Как у русского
 * аутрича (polzaRuOutreach/regenerate.ts).
 *
 * Работает в роуте, без обхода сайтов: всё, что нужно письмам, лежит в строке
 * журнала (поводы, кейс, сегменты, тип почты). Лимит готовых — тот же, что у
 * запуска: сколько готовых уже есть, столько мест и занято; строки сверх
 * лимита получают то же, что в раннере, — limit_reached. Деньги — из лимита
 * на ИИ запуска (бюджет из progress_detail.llm); потраченное дописывается
 * обратно в progress_detail.llm, счётчики экрана пересчитываются по журналу.
 *
 * Роут пускает сюда только законченный запуск: пока он идёт, воркер ведёт
 * лимит готовых и расход в памяти, и пересборка сбоку их бы разошла. А внутри
 * одного запуска пересборка одна за раз (маркер REBUILD_LEASE_KEY): две
 * пересборки разных офферов считали бы свободные места в лимите готовых
 * каждая по себе. Писателю не платим, пока не ясно, что писать есть кому:
 * строки ждут шаблон и лимит готовых ещё не набран.
 *
 * Остаточная гонка: расход дописывается чтением и записью progress_detail, не
 * атомарно. Под маркером пишет только эта пересборка, воркер к законченному
 * запуску не возвращается — разойтись может лишь пересборка, пережившая
 * маркер (дольше 6 минут, после смерти роута), и то на расход одной попытки.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { JobBudget, type OutreachLlmBudgetSnapshot } from '@/lib/outreachLlm/context';
import { SEQUENCE_ID } from './buildLetters';
import type { EnCase } from './caseRouter';
import { POLZA_FUNNEL_COLUMNS, polzaFunnel, type PolzaFunnelRow } from './funnel';
import type { Trigger } from './leadScore';
import { composeCompanyLetters, type CompanyLettersInput } from './renderTemplate';
import {
  claimRebuildLease,
  findChainTemplate,
  hasPendingTemplate,
  regenerateChainTemplate,
  releaseRebuildLease,
  ROUTE_WRITER_TIMEOUT_MS,
  ROUTE_WRITER_TOTAL_MS,
  templateFailureDetail,
  type ChainTemplate,
} from './templateWriter';
import {
  POLZA_OUTREACH_STAGES as ST,
  polzaReviewReason,
  sanitizePolzaOutreachConfig,
  type PolzaOfferKey,
  type PolzaOutreachConfig,
} from './types';

const ROWS = 'polza_outreach_companies';
const PAGE = 1000;
const WAITING_COLUMNS = 'id,company_name,trigger_list,recommended_case,segments,email_type,lead_score';
/** review_reason строк, ждущих шаблон: код и подробность («template_failed: …»). */
const TEMPLATE_FAILED_LIKE = 'template_failed%';
/** Письма собираются без ИИ — параллельно пишем только строки в базу. */
const REBUILD_CONCURRENCY = 4;

interface WaitingRow {
  id: string;
  company_name: string;
  trigger_list: unknown;
  recommended_case: string | null;
  segments: unknown;
  email_type: string | null;
  lead_score: number | null;
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
  /** Остались на ручной проверке: шаблон снова не прошёл или письма не прошли гарды. */
  stillReview: number;
  /** Лимит готовых запуска уже набран — limit_reached, как в раннере. */
  limitReached: number;
  /** Сколько эта пересборка потратила на ИИ. */
  costUsd: number;
  qaFlags: string[];
  error: string | null;
}

export type RegenerateOfferResult =
  | { kind: 'missing' }
  /** rebuild — письма запуска уже пересобирает другой роут; template — шаблон запуска пишется. */
  | { kind: 'busy'; reason: 'rebuild' | 'template' }
  /** Цепочку этого оффера не ждёт ни одна строка — платить писателю не за что. */
  | { kind: 'nothing_waiting' }
  /** Лимит готовых запуска набран: все ждущие строки ушли бы в limit_reached. */
  | { kind: 'limit_full'; ready: number; target: number }
  | { kind: 'done'; summary: RegenerateSummary };

export interface RegenerateOfferInput {
  /** Клиент пользователя: RLS пускает только к его запускам. */
  db: SupabaseClient;
  jobId: string;
  offer: PolzaOfferKey;
  /** Сколько готовых компаний нужно запуску (config.limit). */
  target: number;
  /** Подпись из настроек — та же, что раннер ставит в письма. */
  signature: string;
  /** Утверждённые кейсы (loadEnCases): кейс строки ищется по recommended_case. */
  cases: EnCase[];
  /** Бюджет запуска из progress_detail.llm — тот же объект, что в контексте ИИ. */
  budget: JobBudget;
}

function log(level: 'info' | 'warn', msg: string): void {
  console[level](`[polza-outreach][regenerate][${level.toUpperCase()}] ${msg}`);
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
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

/** Строки, которые ждут этот шаблон: раннер ставит им template_failed и id шаблона. */
async function loadWaitingRows(db: SupabaseClient, jobId: string, templateId: string): Promise<WaitingRow[]> {
  const rows: WaitingRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(ROWS)
      .select(WAITING_COLUMNS)
      .eq('job_id', jobId)
      .eq('chain_template_id', templateId)
      .eq('status', 'needs_review')
      .like('review_reason', TEMPLATE_FAILED_LIKE)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Не удалось прочитать строки оффера: ${error.message}`);
    rows.push(...((data ?? []) as unknown as WaitingRow[]));
    if (!data || data.length < PAGE) break;
  }
  // От сильных к слабым, как письма в раннере: места в лимите готовых
  // достаются лучшим.
  return rows.sort((a, b) => (b.lead_score ?? -1) - (a.lead_score ?? -1));
}

async function countReady(db: SupabaseClient, jobId: string): Promise<number> {
  const { count, error } = await db.from(ROWS).select('id', { count: 'exact', head: true }).eq('job_id', jobId).eq('status', 'ready');
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
    .eq('status', 'needs_review')
    .like('review_reason', TEMPLATE_FAILED_LIKE)
    .select('id');
  if (error) throw new Error(`Не удалось обновить строку ${id}: ${error.message}`);
  return Boolean(data?.length);
}

/** Вход писем из строки журнала — то же, что раннер берёт из разбора. */
function companyInput(row: WaitingRow, cases: EnCase[]): CompanyLettersInput {
  const triggers = Array.isArray(row.trigger_list) ? (row.trigger_list as Trigger[]) : [];
  const segments = Array.isArray(row.segments) ? row.segments.filter((s): s is string => typeof s === 'string') : [];
  return {
    companyName: row.company_name,
    triggers,
    // Кейс — только утверждённый сейчас: отозванный после запуска в письмо не идёт.
    caseHit: row.recommended_case ? cases.find((c) => c.caseId === row.recommended_case) ?? null : null,
    segments,
    emailType: row.email_type,
  };
}

/**
 * Расход на ИИ и счётчики экрана — в progress_detail. Расход — прибавкой к
 * свежему снимку, а не нашим снимком целиком: так запись не теряет расход,
 * дописанный в запуск после того, как роут прочитал бюджет.
 */
async function refreshJob(db: SupabaseClient, jobId: string, spent: Spend, recount: boolean): Promise<void> {
  const hasSpend = Boolean(spent.analysis.calls || spent.writer.calls || spent.analysis.usd || spent.writer.usd);
  if (!hasSpend && !recount) return;
  const { data: job, error } = await db.from('parser_jobs').select('config,progress_detail').eq('id', jobId).maybeSingle();
  if (error || !job) throw new Error(`Не удалось прочитать запуск: ${error?.message ?? 'не найден'}`);
  const detail = asObject(job.progress_detail);
  const patch: Record<string, unknown> = {};
  if (hasSpend) {
    const limit = sanitizePolzaOutreachConfig((job.config ?? {}) as Partial<PolzaOutreachConfig>).llm_budget_usd;
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
    // Счётчики — по журналу тем же правилом, что экран (funnel.ts).
    const rows: PolzaFunnelRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error: rowsErr } = await db
        .from(ROWS)
        .select(POLZA_FUNNEL_COLUMNS)
        .eq('job_id', jobId)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (rowsErr) throw new Error(`Не удалось прочитать журнал запуска: ${rowsErr.message}`);
      rows.push(...((data ?? []) as unknown as PolzaFunnelRow[]));
      if (!data || data.length < PAGE) break;
    }
    const ready = rows.filter((r) => r.status === 'ready').length;
    Object.assign(detail, { ready, funnel: polzaFunnel(rows) });
    patch.total_parsed = ready;
  }
  patch.progress_detail = detail;
  const { error: saveErr } = await db.from('parser_jobs').update(patch).eq('id', jobId);
  if (saveErr) throw new Error(`Не удалось сохранить расход и счётчики запуска: ${saveErr.message}`);
}

interface RowsOutcome {
  promoted: number;
  stillReview: number;
  limitReached: number;
}

/**
 * Письма ждавших строк по новому шаблону. Решение «есть ли место в лимите
 * готовых» принимается синхронно, до записи строки, — параллельные потоки
 * пула не займут одно место дважды.
 */
async function rebuildRows(input: RegenerateOfferInput, template: ChainTemplate, rows: WaitingRow[], readyAtStart: number): Promise<RowsOutcome> {
  const { db, jobId } = input;
  const outcome: RowsOutcome = { promoted: 0, stillReview: 0, limitReached: 0 };
  const letters = template.status === 'ok' ? template.letters : null;
  if (!letters) {
    // Шаблон снова не прошёл: строки ждут дальше, причина — про новую попытку.
    const reason = polzaReviewReason('template_failed', templateFailureDetail(template));
    await runPool(rows, REBUILD_CONCURRENCY, async (row) => {
      if (await updateWaitingRow(db, jobId, row.id, { review_reason: reason, chain_template_id: template.id })) outcome.stillReview += 1;
    });
    return outcome;
  }
  let ready = readyAtStart;
  await runPool(rows, REBUILD_CONCURRENCY, async (row) => {
    if (ready >= input.target) {
      // Лимит готовых запуска набран — как в раннере: оценку прошла, писем нет.
      if (await updateWaitingRow(db, jobId, row.id, {
        review_reason: 'limit_reached',
        stage: ST.s4Analyzed,
        letters: null,
        chain_template_id: template.id,
      })) outcome.limitReached += 1;
      return;
    }
    const composed = composeCompanyLetters(letters, companyInput(row, input.cases), input.signature);
    const base = { letters: composed.letters, sequence_id: SEQUENCE_ID, chain_template_id: template.id, stage: ST.s6Letters };
    if (!composed.guard.ok) {
      // Письма собраны, но гарды не прошли — как в раннере: на ручную
      // проверку, письма в строке, решает человек.
      if (await updateWaitingRow(db, jobId, row.id, {
        ...base,
        review_reason: polzaReviewReason('letters_qa_failed', composed.guard.violations.join('; ')),
      })) outcome.stillReview += 1;
      return;
    }
    ready += 1;
    if (await updateWaitingRow(db, jobId, row.id, { ...base, status: 'ready', review_reason: null })) {
      outcome.promoted += 1;
    } else {
      // Строку уже поменяли — место в лимите не занято.
      ready -= 1;
    }
  });
  return outcome;
}

/**
 * Переписать шаблон оффера и пересобрать письма ждавших его строк. Вызывать
 * внутри runWithOutreachContext с тем же бюджетом (input.budget): писатель
 * списывает деньги с лимита запуска. Расход сохраняется в запуск, даже если
 * пересборка оборвалась на середине — деньги уже потрачены.
 */
export async function regenerateOfferChain(input: RegenerateOfferInput): Promise<RegenerateOfferResult> {
  const { db, jobId, offer, budget } = input;
  const lease = await claimRebuildLease(db, jobId);
  if (!lease) return { kind: 'busy', reason: 'rebuild' };
  const before = spendOf(budget);
  const spentBefore = budget.spentUsd;
  let result: RegenerateOfferResult | null = null;
  let touchedRows = false;
  let failure: unknown = null;
  try {
    const current = await findChainTemplate(db, jobId, offer);
    if (!current) {
      result = { kind: 'missing' };
    } else if (await hasPendingTemplate(db, jobId)) {
      result = { kind: 'busy', reason: 'template' };
    } else {
      // До оплаты писателя: есть ли кому писать и есть ли места в лимите готовых.
      const rows = await loadWaitingRows(db, jobId, current.id);
      const ready = await countReady(db, jobId);
      if (!rows.length) {
        result = { kind: 'nothing_waiting' };
      } else if (ready >= input.target) {
        result = { kind: 'limit_full', ready, target: input.target };
      } else {
        const outcome = await regenerateChainTemplate(
          { db, jobId, writerTimeoutMs: ROUTE_WRITER_TIMEOUT_MS, writerTotalMs: ROUTE_WRITER_TOTAL_MS },
          offer,
        );
        if (outcome.kind !== 'done') {
          result = outcome.kind === 'busy' ? { kind: 'busy', reason: 'template' } : outcome;
        } else {
          // До пересборки: оборвётся на середине — часть строк уже поменялась, и
          // счётчики всё равно надо пересчитать. Не прошедший шаблон меняет
          // строкам только подробность причины — счётчики те же.
          touchedRows = outcome.template.status === 'ok';
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
    await refreshJob(db, jobId, spendSince(before, budget), touchedRows);
  } catch (err) {
    // Сбой записи счётчиков не должен спрятать исходную ошибку пересборки.
    if (failure) log('warn', `job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    else failure = err;
  } finally {
    await releaseRebuildLease(db, lease);
  }
  if (failure) throw failure;
  if (!result) throw new Error('Пересборка цепочки не вернула результата');
  return result;
}
