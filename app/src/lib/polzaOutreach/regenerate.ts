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
 * Только законченный запуск, которого воркер уже не держит: пока запуск
 * идёт, воркер ведёт лимит готовых и расход в памяти, и пересборка сбоку их бы
 * разошла, а остановленный он ещё доводит (аренда progress_detail.worker,
 * lib/outreachLlm/workerLease.ts) — и его итоговая запись стёрла бы расход и
 * счётчики пересборки. А внутри одного запуска пересборка одна за раз (маркер
 * REBUILD_LEASE_KEY): две пересборки разных офферов считали бы свободные места
 * в лимите готовых каждая по себе. Бюджет — из progress_detail.llm,
 * прочитанного под маркером. Писателю не платим, пока не ясно, что писать есть
 * кому: строки ждут шаблон, лимит готовых ещё не набран, а попытка писателя
 * помещается в лимит на ИИ.
 *
 * Остаточная гонка: расход дописывается чтением и записью progress_detail, не
 * атомарно. Под маркером пишет только эта пересборка, воркер к законченному
 * запуску не возвращается — разойтись может лишь пересборка, пережившая
 * маркер (дольше 6 минут, после смерти роута), и то на расход одной попытки.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { JobBudget, runWithOutreachContext, type OutreachLlmBudgetSnapshot } from '@/lib/outreachLlm/context';
import { withoutWorkerLease, workerLeaseLive, workerLeaseOf } from '@/lib/outreachLlm/workerLease';
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
  writerAttemptWorstUsd,
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
  /**
   * Запуск ещё у воркера: running — идёт (или ждёт воркера); stopping —
   * остановлен, но воркер его ещё доводит и запишет итог.
   */
  | { kind: 'active'; state: 'running' | 'stopping' }
  /**
   * Лимит на ИИ запуска исчерпан или на попытку писателя его не хватает
   * (needUsd — её оценка сверху): писателю не платим, шаблон не трогаем.
   */
  | { kind: 'budget'; spentUsd: number; limitUsd: number; needUsd?: number }
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
}

/** Вход пересборки под маркером: бюджет — из снимка, прочитанного под ним. */
type RebuildInput = RegenerateOfferInput & { budget: JobBudget };

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

interface JobUnderLease {
  config: PolzaOutreachConfig;
  detail: Record<string, unknown>;
}

/**
 * Запуск, прочитанный под маркером пересборки: статус, аренда воркера и
 * расход на ИИ — одним чтением. Идёт или ждёт воркера — running; остановлен,
 * но воркер ещё держит аренду (доводит строки и запишет итог) — stopping: его
 * запись стёрла бы нашу. Истёкшую аренду умершего воркера снимаем сравнением
 * с обменом — переживший её процесс пишет только при своей отметке и ничего не
 * перетрёт; продлил её между чтением и записью — воркер жив, читаем заново.
 */
async function jobUnderLease(db: SupabaseClient, jobId: string): Promise<JobUnderLease | 'running' | 'stopping'> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: job, error } = await db.from('parser_jobs').select('status,config,progress_detail,completed_at').eq('id', jobId).maybeSingle();
    if (error || !job) throw new Error(`Не удалось прочитать запуск: ${error?.message ?? 'не найден'}`);
    if (job.status === 'pending' || job.status === 'running') return 'running';
    const detail = asObject(job.progress_detail);
    if (workerLeaseLive(detail, typeof job.completed_at === 'string' ? job.completed_at : null)) return 'stopping';
    const config = sanitizePolzaOutreachConfig((job.config ?? {}) as Partial<PolzaOutreachConfig>);
    const lease = workerLeaseOf(detail);
    if (!lease) return { config, detail };
    const released = withoutWorkerLease(detail);
    const { data: saved, error: saveErr } = await db
      .from('parser_jobs')
      .update({ progress_detail: released })
      .eq('id', jobId)
      .eq('progress_detail->worker->>until', lease.until)
      .select('id');
    if (saveErr) throw new Error(`Не удалось снять аренду воркера: ${saveErr.message}`);
    if (saved?.length) return { config, detail: released };
  }
  return 'stopping';
}

/**
 * Расход на ИИ — в progress_detail, прибавкой к свежему снимку, а не нашим
 * снимком целиком: так запись не теряет расход, дописанный в запуск после
 * того, как роут прочитал бюджет. Отдельно от счётчиков (recountJob): не
 * прочитался журнал — расход всё равно записан.
 */
async function saveSpend(db: SupabaseClient, jobId: string, spent: Spend): Promise<void> {
  const hasSpend = Boolean(spent.analysis.calls || spent.writer.calls || spent.analysis.usd || spent.writer.usd);
  if (!hasSpend) return;
  const { data: job, error } = await db.from('parser_jobs').select('config,progress_detail').eq('id', jobId).maybeSingle();
  if (error || !job) throw new Error(`Не удалось прочитать запуск: ${error?.message ?? 'не найден'}`);
  const detail = asObject(job.progress_detail);
  const config = sanitizePolzaOutreachConfig((job.config ?? {}) as Partial<PolzaOutreachConfig>);
  const total = JobBudget.fromSnapshot((detail.llm ?? null) as Partial<OutreachLlmBudgetSnapshot> | null, config.llm_budget_usd);
  for (const role of ['analysis', 'writer'] as const) {
    total.byRole[role].usd += spent[role].usd;
    total.byRole[role].calls += spent[role].calls;
    total.spentUsd += spent[role].usd;
    total.calls += spent[role].calls;
  }
  detail.llm = total.snapshot();
  const { error: saveErr } = await db.from('parser_jobs').update({ progress_detail: detail }).eq('id', jobId);
  if (saveErr) throw new Error(`Не удалось сохранить расход на ИИ запуска: ${saveErr.message}`);
}

/** Счётчики экрана — по журналу тем же правилом, что экран (funnel.ts). */
async function recountJob(db: SupabaseClient, jobId: string): Promise<void> {
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
  const { data: job, error } = await db.from('parser_jobs').select('config,progress_detail').eq('id', jobId).maybeSingle();
  if (error || !job) throw new Error(`Не удалось прочитать запуск: ${error?.message ?? 'не найден'}`);
  const detail = asObject(job.progress_detail);
  const config = sanitizePolzaOutreachConfig((job.config ?? {}) as Partial<PolzaOutreachConfig>);
  const ready = rows.filter((r) => r.status === 'ready').length;
  const awaiting = rows.filter((r) => r.status === 'needs_review' && (r.review_reason ?? '').startsWith('template_failed')).length;
  Object.assign(detail, { ready, awaiting_templates: awaiting, funnel: polzaFunnel(rows) });
  if (ready >= config.limit) {
    // Пересборка добрала лимит готовых — запуск закончился тем, ради чего шёл
    // (раньше — «ждут цепочку» или «кончились кандидаты»).
    detail.stop_reason = 'target_reached';
    delete detail.stop_reason_base;
  } else if (detail.stop_reason === 'awaiting_templates' && ready + awaiting < config.limit) {
    // Запуск встал, потому что заказанное набиралось вместе с ждущими
    // цепочку. Их стало меньше (часть писем не прошла гарды) — эта причина
    // больше не верна, и плашка «ждут цепочку» висела бы при нуле ждущих:
    // возвращаем ту, что была бы без ждущих (раннер записал её в
    // stop_reason_base), а если её нет — не утверждаем никакой.
    const base = detail.stop_reason_base;
    if (typeof base === 'string' && base) detail.stop_reason = base;
    else delete detail.stop_reason;
    delete detail.stop_reason_base;
  }
  const { error: saveErr } = await db.from('parser_jobs').update({ total_parsed: ready, progress_detail: detail }).eq('id', jobId);
  if (saveErr) throw new Error(`Не удалось сохранить счётчики запуска: ${saveErr.message}`);
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
 * Переписать шаблон оффера и пересобрать письма ждавших его строк. Бюджет —
 * лимит и уже потраченное из progress_detail.llm, прочитанного под маркером
 * пересборки, — и вся работа идёт внутри своего контекста ИИ: писатель
 * списывает деньги с лимита запуска. Расход сохраняется в запуск, даже если
 * пересборка оборвалась на середине — деньги уже потрачены.
 */
export async function regenerateOfferChain(input: RegenerateOfferInput): Promise<RegenerateOfferResult> {
  const { db, jobId } = input;
  const lease = await claimRebuildLease(db, jobId);
  if (!lease) return { kind: 'busy', reason: 'rebuild' };
  let result: RegenerateOfferResult | null = null;
  const touched = { rows: false };
  let failure: unknown = null;
  let budget: JobBudget | null = null;
  let before: Spend | null = null;
  try {
    const job = await jobUnderLease(db, jobId);
    if (job === 'running' || job === 'stopping') {
      result = { kind: 'active', state: job };
    } else {
      const own = JobBudget.fromSnapshot((job.detail.llm ?? null) as Partial<OutreachLlmBudgetSnapshot> | null, job.config.llm_budget_usd);
      budget = own;
      before = spendOf(own);
      result = own.exhausted()
        ? { kind: 'budget', spentUsd: own.spentUsd, limitUsd: own.limitUsd }
        : await runWithOutreachContext({ lang: 'en', budget: own }, () => rebuildOffer({ ...input, budget: own }, touched));
    }
  } catch (err) {
    failure = err;
  }
  try {
    // Расход — первым и отдельно: он пишется, даже если пересчёт журнала потом
    // не прочитается.
    if (budget && before) await saveSpend(db, jobId, spendSince(before, budget));
  } catch (err) {
    // Сбой записи расхода не должен спрятать исходную ошибку пересборки.
    if (failure) log('warn', `job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    else failure = err;
  }
  try {
    if (touched.rows) await recountJob(db, jobId);
  } catch (err) {
    // Письма пересобраны и расход записан — устаревшие счётчики экрана не повод
    // отвечать ошибкой: их пересчитает следующая пересборка.
    log('warn', `job ${jobId}: counters were not recounted after the rebuild — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await releaseRebuildLease(db, lease);
  }
  if (failure) throw failure;
  if (!result) throw new Error('Пересборка цепочки не вернула результата');
  return result;
}

/** Пересборка под маркером, внутри контекста ИИ запуска. touched.rows — строки менялись, счётчики пересчитать. */
async function rebuildOffer(input: RebuildInput, touched: { rows: boolean }): Promise<RegenerateOfferResult> {
  const { db, jobId, offer, budget } = input;
  const spentBefore = budget.spentUsd;
  const current = await findChainTemplate(db, jobId, offer);
  if (!current) return { kind: 'missing' };
  if (await hasPendingTemplate(db, jobId)) return { kind: 'busy', reason: 'template' };
  // До оплаты писателя: есть ли кому писать и есть ли места в лимите готовых.
  const rows = await loadWaitingRows(db, jobId, current.id);
  const ready = await countReady(db, jobId);
  if (!rows.length) return { kind: 'nothing_waiting' };
  if (ready >= input.target) return { kind: 'limit_full', ready, target: input.target };
  // Попытка писателя не помещается в лимит (оценкой сверху) — отказ до того,
  // как шаблон занят: иначе отказ бюджета стёр бы его прошлый вариант и
  // замечания проверки.
  const needUsd = writerAttemptWorstUsd();
  if (current.status !== 'ok' && budget.available() < needUsd) {
    return { kind: 'budget', spentUsd: budget.spentUsd, limitUsd: budget.limitUsd, needUsd };
  }
  const outcome = await regenerateChainTemplate(
    { db, jobId, writerTimeoutMs: ROUTE_WRITER_TIMEOUT_MS, writerTotalMs: ROUTE_WRITER_TOTAL_MS },
    offer,
  );
  if (outcome.kind !== 'done') return outcome.kind === 'busy' ? { kind: 'busy', reason: 'template' } : outcome;
  // До пересборки: оборвётся на середине — часть строк уже поменялась, и
  // счётчики всё равно надо пересчитать. Не прошедший шаблон меняет строкам
  // только подробность причины — счётчики те же.
  touched.rows = outcome.template.status === 'ok';
  const counts = await rebuildRows(input, outcome.template, rows, ready);
  return {
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
