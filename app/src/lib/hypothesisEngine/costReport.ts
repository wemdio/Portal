/**
 * Отчёт себестоимости ENG-проекта по журналу 'he_provider_usage'
 * (costTelemetry.ts). ЧИСТЫЙ модуль: ни БД, ни провайдеров — строки журнала и
 * he_jobs приходят параметром (staff-роут
 * /api/tools/hypothesis-engine/projects/[id]/cost, readHeProviderSpend).
 *
 * Читает КАЖДОЕ поле, которое пишет журнал (parseHeCostCall): v — версия;
 * project_id, market — чужие строки не считаются, а называются; job_id —
 * сверка с he_jobs; stage, base_id, provider, model/endpoint, created_at —
 * разрезы; outcome, http_status — исходы и неуспехи по кодам; tokens_* —
 * токены и сверка; credits — кредиты Serper; cost_usd, price_known,
 * cost_source — деньги (счёт роутера отдельно от оценки по таблице);
 * lost_before — маркер пробела. Из he_jobs: tokens_used (сверка), cost_usd
 * (для сравнения сотрудником), result.journal_gap — маркер пробела.
 *
 * ИТОГ НЕ ВРЁТ. Три состояния, а не одно число:
 *  - incomplete — журнал заведомо неполон (маркер пробела, he_jobs насчитал
 *    больше токенов, чем журнал, джоба с расходом без единой строки — в том
 *    числе всё, что шло ДО выката журнала, — или чтение обрезано);
 *  - lower_bound — известных пропусков нет, но у части обращений нет цены (у
 *    Serper цена есть только при тарифе кредита) или у проекта есть кейсы,
 *    разобранные staff-роутом cases (его вызов модели журнал не видит);
 *  - complete — пропусков не видно и у каждого обращения есть цена; только
 *    тогда totalUsd не null.
 * knownUsd — сумма известных цен в любом состоянии: это НИЖНЯЯ граница.
 * Ни одно состояние не включает того, чего журнал не видит по построению
 * (HE_COST_REPORT_EXCLUDES: конструктор баз, запуски шаблона до журнала или
 * без прочитанного рынка, разбор кейса, не оставивший кейса, вызов в полёте
 * при смерти процесса, инфраструктура).
 *
 * ЗАПУСК ШАБЛОНА. Классификатор сегментов зовётся из роутов запуска (клиент и
 * staff), а не из воркера: джобы he_jobs у него нет. Роут открывает журнал
 * стадией HE_COST_LAUNCH_STAGE и id ШАБЛОНА на месте id джобы, поэтому такие
 * строки сверке с he_jobs не подлежат: они видны в byStage/byDay/byModel
 * (базы у них нет — в byBase они под null), а их потери (lost_before) — в
 * lostRows, как у любой строки. Потолок расхода (readHeProviderSpend) читает
 * их вместе с остальными строками проекта.
 */

export interface HeCostLogRow {
  id: string;
  created_at: string;
  context: unknown;
}

/** Строка he_jobs проекта: только счётчики и маркер пробела, без result целиком. */
export interface HeCostJobRow {
  id: string;
  stage: string;
  status: string;
  tokens_used: unknown;
  cost_usd: unknown;
  /** he_jobs.result->journal_gap (markHeJournalGap). */
  journal_gap?: unknown;
}

export type HeCostOutcome = 'ok' | 'failed' | 'aborted';

/** Разобранная строка журнала. */
export interface HeCostCall {
  id: string;
  at: string;
  day: string;
  projectId: string;
  jobId: string;
  stage: string;
  baseId: string | null;
  provider: 'requesty' | 'serper';
  /** Модель (Requesty) или точка API (Serper). */
  resource: string;
  outcome: HeCostOutcome;
  httpStatus: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensTotal: number | null;
  credits: number | null;
  /** null — цены нет (price_known=false). */
  costUsd: number | null;
  costSource: 'router' | 'table' | null;
  lostBefore: Record<string, number>;
}

const OUTCOMES = new Set<HeCostOutcome>(['ok', 'failed', 'aborted']);

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const round = (value: number): number => Number(value.toFixed(9));

/**
 * Строка журнала → обращение, либо причина, по которой её нельзя считать.
 * Причина не теряется: она уходит в incompleteBecause отчёта.
 */
export function parseHeCostCall(row: HeCostLogRow, projectId?: string): HeCostCall | { issue: string } {
  const context = object(row.context);
  if (!context) return { issue: 'malformed_rows' };
  if (context.v !== 1) return { issue: 'unknown_journal_version' };
  if (context.market !== 'us') return { issue: 'foreign_market_rows' };
  const rowProject = text(context.project_id);
  if (!rowProject || (projectId !== undefined && rowProject !== projectId)) return { issue: 'foreign_project_rows' };
  const jobId = text(context.job_id);
  const stage = text(context.stage);
  const provider = context.provider;
  const outcome = context.outcome as HeCostOutcome;
  const at = text(row.created_at);
  const time = at ? Date.parse(at) : NaN;
  if (!jobId || !stage || (provider !== 'requesty' && provider !== 'serper') || !OUTCOMES.has(outcome) || !Number.isFinite(time)) {
    return { issue: 'malformed_rows' };
  }
  const resource = text(provider === 'requesty' ? context.model : context.endpoint) ?? 'unknown';
  // Цена считается известной, только если строка говорит это ОБОИМИ полями:
  // price_known=true и число в cost_usd. Расхождение — цены нет.
  const cost = count(context.cost_usd);
  const priced = context.price_known === true && cost !== null;
  const source = context.cost_source === 'router' || context.cost_source === 'table' ? context.cost_source : null;
  const lostBefore: Record<string, number> = {};
  for (const [job, rows] of Object.entries(object(context.lost_before) ?? {})) {
    const n = count(rows);
    if (n) lostBefore[job] = n;
  }
  return {
    id: row.id,
    at: at!,
    day: new Date(time).toISOString().slice(0, 10),
    projectId: rowProject,
    jobId,
    stage,
    baseId: text(context.base_id),
    provider,
    resource,
    outcome,
    httpStatus: count(context.http_status),
    tokensIn: count(context.tokens_in),
    tokensOut: count(context.tokens_out),
    tokensTotal: count(context.tokens_total),
    credits: count(context.credits),
    costUsd: priced ? cost : null,
    costSource: priced ? source : null,
    lostBefore,
  };
}

/** Сводка по набору обращений — одна форма для итога и каждого разреза. */
export interface HeCostBucket {
  calls: number;
  outcomes: Record<HeCostOutcome, number>;
  /** Сумма известных цен (Requesty + Serper по тарифу, если он передан). */
  knownUsd: number;
  requesty: {
    calls: number;
    /** По счёту роутера (usage.cost). */
    routerUsd: number;
    /** По ставке таблицы llm.ts с наценкой: роутер цену не вернул. */
    tableUsd: number;
    /** Обращения без цены — по исходам. ok без цены: деньги ушли, сумма неизвестна. */
    unpriced: Record<HeCostOutcome, number>;
    tokensIn: number;
    tokensOut: number;
    tokensTotal: number;
  };
  serper: {
    calls: number;
    credits: number;
    /** Поиски, по которым провайдер не вернул число кредитов. */
    creditsUnknown: number;
    /** Кредиты × тариф / 1000; null — тариф не передан. */
    usdAtTariff: number | null;
  };
  /** Неуспешные обращения по исходу и коду ответа: 'failed:429', 'aborted:200'. */
  notOkByHttpStatus: Record<string, number>;
}

export function aggregateHeCalls(calls: HeCostCall[], serperUsdPer1000?: number | null): HeCostBucket {
  const tariff = typeof serperUsdPer1000 === 'number' && Number.isFinite(serperUsdPer1000) && serperUsdPer1000 >= 0
    ? serperUsdPer1000
    : null;
  const bucket: HeCostBucket = {
    calls: calls.length,
    outcomes: { ok: 0, failed: 0, aborted: 0 },
    knownUsd: 0,
    requesty: {
      calls: 0, routerUsd: 0, tableUsd: 0,
      unpriced: { ok: 0, failed: 0, aborted: 0 },
      tokensIn: 0, tokensOut: 0, tokensTotal: 0,
    },
    serper: { calls: 0, credits: 0, creditsUnknown: 0, usdAtTariff: tariff === null ? null : 0 },
    notOkByHttpStatus: {},
  };
  for (const call of calls) {
    bucket.outcomes[call.outcome] += 1;
    if (call.outcome !== 'ok' && call.httpStatus !== null) {
      const key = `${call.outcome}:${call.httpStatus}`;
      bucket.notOkByHttpStatus[key] = (bucket.notOkByHttpStatus[key] ?? 0) + 1;
    }
    if (call.provider === 'requesty') {
      const r = bucket.requesty;
      r.calls += 1;
      r.tokensIn += call.tokensIn ?? 0;
      r.tokensOut += call.tokensOut ?? 0;
      r.tokensTotal += call.tokensTotal ?? 0;
      if (call.costUsd === null) r.unpriced[call.outcome] += 1;
      else if (call.costSource === 'router') r.routerUsd += call.costUsd;
      else r.tableUsd += call.costUsd;
    } else {
      const s = bucket.serper;
      s.calls += 1;
      if (call.credits === null) s.creditsUnknown += 1;
      else s.credits += call.credits;
    }
  }
  bucket.requesty.routerUsd = round(bucket.requesty.routerUsd);
  bucket.requesty.tableUsd = round(bucket.requesty.tableUsd);
  if (tariff !== null) bucket.serper.usdAtTariff = round((bucket.serper.credits * tariff) / 1000);
  bucket.knownUsd = round(bucket.requesty.routerUsd + bucket.requesty.tableUsd + (bucket.serper.usdAtTariff ?? 0));
  return bucket;
}

/** Обращений без известной цены в сводке (Serper без тарифа — все). */
export function heUnpricedCalls(bucket: HeCostBucket): number {
  const r = bucket.requesty.unpriced;
  return r.ok + r.failed + r.aborted + (bucket.serper.usdAtTariff === null ? bucket.serper.calls : bucket.serper.creditsUnknown);
}

/** Сумма маркеров lost_before по джобам. */
export function heLostRowsByJob(calls: HeCostCall[]): Map<string, number> {
  const lost = new Map<string, number>();
  for (const call of calls) {
    for (const [job, rows] of Object.entries(call.lostBefore)) lost.set(job, (lost.get(job) ?? 0) + rows);
  }
  return lost;
}

export interface HeCostReportInput {
  projectId: string;
  logs: HeCostLogRow[];
  jobs: HeCostJobRow[];
  logsTruncated?: boolean;
  jobsTruncated?: boolean;
  /** Тариф Serper, USD за 1000 кредитов; нет — поиски без цены. */
  serperUsdPer1000?: number | null;
  /**
   * Кейсов проекта с source='upload' (he_cases): каждый — след вызова модели
   * staff-роутом cases (caseBank.structureCaseText), которого журнал не видит.
   */
  staffCaseUploads: number;
}

export interface HeCostJobCheck {
  id: string;
  stage: string;
  status: string;
  heJobsTokens: number;
  heJobsCostUsd: number;
  journalCalls: number;
  journalTokens: number;
  journalKnownUsd: number;
  /** Строк потеряно (максимум из маркера в he_jobs.result и переносов lost_before). */
  lostRows: number;
  /**
   * ok — журнал не меньше he_jobs; short — he_jobs насчитал больше токенов;
   * no_journal — у джобы есть расход, а строк нет (в том числе до выката
   * журнала); he_jobs_short — журнал больше he_jobs (не легла запись расхода
   * в he_jobs; журнал при этом полон); running — джоба идёт, её текущий
   * прогон уже в журнале, но ещё не в he_jobs.
   */
  verdict: 'ok' | 'short' | 'no_journal' | 'he_jobs_short' | 'running';
}

export interface HeCostReport {
  version: 1;
  projectId: string;
  period: { first: string | null; last: string | null };
  status: 'complete' | 'lower_bound' | 'incomplete';
  /** Только при status='complete'. */
  totalUsd: number | null;
  /** Нижняя граница расхода в любом состоянии. */
  knownUsd: number;
  unpricedCalls: number;
  lostRows: number;
  incompleteBecause: string[];
  lowerBoundBecause: string[];
  notes: string[];
  serperUsdPer1000: number | null;
  totals: HeCostBucket;
  byStage: Array<{ stage: string } & HeCostBucket>;
  byDay: Array<{ day: string } & HeCostBucket>;
  byBase: Array<{ baseId: string | null } & HeCostBucket>;
  byModel: Array<{ provider: 'requesty' | 'serper'; resource: string } & HeCostBucket>;
  jobs: HeCostJobCheck[];
  excludes: string[];
}

/**
 * Стадия строк журнала, открытого роутом запуска шаблона вокруг ядра запуска
 * (классификатор сегментов). Не стадия he_jobs: job_id у таких строк — id
 * шаблона.
 */
export const HE_COST_LAUNCH_STAGE = 'launch';

/**
 * Что отчёт не покрывает по построению:
 *  - конструктор баз (отдельный воркер, журнала нет);
 *  - классификатор запуска шаблона ДО выката журнала в роуты запуска и
 *    staff-запуск, у которого роут не прочитал рынок проекта (тогда журнал не
 *    открыт; расход — в аудите запуска, context.classifierCostUsd);
 *  - разбор кейса staff-роутом cases, не оставивший кейса source='upload'
 *    (разбор упал или кейс потом удалён); оставившие — lower_bound в статусе;
 *  - вызов в полёте при смерти процесса;
 *  - инфраструктура (прокси, серверы).
 */
export const HE_COST_REPORT_EXCLUDES = [
  'base_constructor_crawl_and_smtp_probes',
  'launch_segment_classifier_before_journal_or_unread_market_see_launch_audit_classifierCostUsd',
  'staff_case_structuring_without_a_kept_upload_case',
  'paid_call_in_flight_at_process_death',
  'infrastructure_proxies_and_servers',
];

function groupBy<K>(calls: HeCostCall[], key: (call: HeCostCall) => K): Map<K, HeCostCall[]> {
  const groups = new Map<K, HeCostCall[]>();
  for (const call of calls) {
    const k = key(call);
    const list = groups.get(k);
    if (list) list.push(call);
    else groups.set(k, [call]);
  }
  return groups;
}

export function buildHeCostReport(input: HeCostReportInput): HeCostReport {
  const incomplete = new Set<string>();
  const lowerBound = new Set<string>();
  const notes = new Set<string>();
  if (input.logsTruncated) incomplete.add('journal_read_truncated');
  if (input.jobsTruncated) incomplete.add('jobs_read_truncated');
  const tariff = typeof input.serperUsdPer1000 === 'number' && Number.isFinite(input.serperUsdPer1000)
    && input.serperUsdPer1000 >= 0 ? input.serperUsdPer1000 : null;

  const seen = new Set<string>();
  const calls: HeCostCall[] = [];
  for (const row of input.logs) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const parsed = parseHeCostCall(row, input.projectId);
    if ('issue' in parsed) incomplete.add(parsed.issue);
    else calls.push(parsed);
  }
  calls.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  const totals = aggregateHeCalls(calls, tariff);
  const unpricedCalls = heUnpricedCalls(totals);
  if (totals.requesty.unpriced.ok) lowerBound.add('requesty_answers_without_price');
  if (totals.requesty.unpriced.failed || totals.requesty.unpriced.aborted) lowerBound.add('requesty_failed_or_aborted_without_price');
  if (totals.serper.calls && tariff === null) lowerBound.add('serper_tariff_not_given');
  if (totals.serper.creditsUnknown) lowerBound.add('serper_credits_unknown');
  if (input.staffCaseUploads > 0) lowerBound.add('staff_case_structuring_not_journaled');

  // Сверка с he_jobs: tokens_used прибавляется из того же usage, что пишет
  // журнал, поэтому журнал по джобе не может быть МЕНЬШЕ — если меньше, строки
  // потеряны (или джоба работала до выката журнала).
  const lostByCarry = heLostRowsByJob(calls);
  const byJob = groupBy(calls, (call) => call.jobId);
  const jobIds = new Set<string>();
  const jobs: HeCostJobCheck[] = input.jobs.map((job) => {
    jobIds.add(job.id);
    const own = byJob.get(job.id) ?? [];
    const bucket = aggregateHeCalls(own, tariff);
    const heJobsTokens = Number(job.tokens_used) > 0 ? Number(job.tokens_used) : 0;
    const heJobsCostUsd = Number(job.cost_usd) > 0 ? Number(job.cost_usd) : 0;
    const gap = count(object(job.journal_gap)?.lost) ?? 0;
    const lostRows = Math.max(gap, lostByCarry.get(job.id) ?? 0);
    let verdict: HeCostJobCheck['verdict'] = 'ok';
    if ((heJobsTokens > 0 || heJobsCostUsd > 0) && own.length === 0) verdict = 'no_journal';
    else if (heJobsTokens > bucket.requesty.tokensTotal) verdict = 'short';
    // Идущий прогон пишет строки сразу, а в he_jobs расход ложится в конце
    // прогона: журнал больше he_jobs — норма, а не расхождение.
    else if (heJobsTokens < bucket.requesty.tokensTotal) verdict = job.status === 'running' ? 'running' : 'he_jobs_short';
    if (verdict === 'no_journal') incomplete.add('jobs_with_spend_but_no_journal');
    if (verdict === 'short') incomplete.add('journal_short_of_he_jobs_tokens');
    if (verdict === 'he_jobs_short') notes.add('he_jobs_tokens_short_of_journal');
    if (gap > 0) incomplete.add('journal_gap_marked_in_he_jobs');
    return {
      id: job.id,
      stage: job.stage,
      status: job.status,
      heJobsTokens,
      heJobsCostUsd: round(heJobsCostUsd),
      journalCalls: own.length,
      journalTokens: bucket.requesty.tokensTotal,
      journalKnownUsd: round(bucket.requesty.routerUsd + bucket.requesty.tableUsd),
      lostRows,
      verdict,
    };
  });
  let lostRows = jobs.reduce((sum, job) => sum + job.lostRows, 0);
  for (const [job, rows] of lostByCarry) if (!jobIds.has(job)) lostRows += rows;
  if (lostByCarry.size) incomplete.add('journal_rows_lost');
  // Строки запуска шаблона несут id шаблона, а не джобы (см. шапку): в he_jobs
  // их нет по построению, и расхождением они не считаются.
  if (calls.some((call) => call.stage !== HE_COST_LAUNCH_STAGE && !jobIds.has(call.jobId))) {
    notes.add('rows_for_jobs_not_in_he_jobs');
  }

  const status: HeCostReport['status'] = incomplete.size ? 'incomplete' : lowerBound.size ? 'lower_bound' : 'complete';
  const slice = <K>(key: (call: HeCostCall) => K) =>
    [...groupBy(calls, key)].map(([k, group]) => ({ k, bucket: aggregateHeCalls(group, tariff) }));
  return {
    version: 1,
    projectId: input.projectId,
    period: { first: calls[0]?.at ?? null, last: calls.at(-1)?.at ?? null },
    status,
    totalUsd: status === 'complete' ? totals.knownUsd : null,
    knownUsd: totals.knownUsd,
    unpricedCalls,
    lostRows,
    incompleteBecause: [...incomplete],
    lowerBoundBecause: [...lowerBound],
    notes: [...notes],
    serperUsdPer1000: tariff,
    totals,
    byStage: slice((call) => call.stage).map(({ k, bucket }) => ({ stage: k, ...bucket })),
    byDay: slice((call) => call.day).map(({ k, bucket }) => ({ day: k, ...bucket })),
    byBase: slice((call) => call.baseId).map(({ k, bucket }) => ({ baseId: k, ...bucket })),
    byModel: slice((call) => `${call.provider}\u0000${call.resource}`).map(({ k, bucket }) => {
      const [provider, resource] = k.split('\u0000') as ['requesty' | 'serper', string];
      return { provider, resource, ...bucket };
    }),
    jobs,
    excludes: HE_COST_REPORT_EXCLUDES,
  };
}
