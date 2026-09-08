/** Pure accounting of the scoped provider journal; no database or provider calls. */
export interface VeCostLog {
  id: string;
  created_at: string;
  event: string;
  context: Record<string, unknown>;
}
export interface VeCostJob {
  id: string;
  project_id: string;
  base_id?: string | null;
  stage: string;
  status: string;
  started_at?: string | null;
  created_at?: string;
  updated_at?: string;
  origin_run_id?: string | null;
}
export interface VeCostReportInput {
  projectId: string;
  baseId?: string;
  mode: 'collection' | 'research' | 'all';
  logs: VeCostLog[];
  jobs: VeCostJob[];
  readyCount?: number | null;
  logsTruncated?: boolean;
  serperUsdPer1000?: number;
  snapshotAdvanced?: boolean;
}

const RESEARCH = new Set(['site_profile', 'competitors', 'brand_cloud', 'hypotheses', 'evidence', 'clustering']);
const CONSTRUCTOR_NO_AI_SEARCH = new Set([
  'find_emails', 'enrich_descriptions', 'split_emails', 'dedup_email', 'validate_emails', 'cap_emails_per_company',
]);
const INLINE_SOURCES = new Set(['companies_directory', 'pdl', 'funded', 'eng_hiring']);
const CHILD_NO_AI_SEARCH = new Set(['hh_live', 'yandex_maps', 'google_maps']);
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const sum = (values: number[]) => Number(values.reduce((total, value) => total + value, 0).toFixed(12));

function inStage(stage: unknown, mode: VeCostReportInput['mode']) {
  return typeof stage === 'string' && (mode === 'all' || (mode === 'collection' ? stage === 'base_collect' : RESEARCH.has(stage)));
}

export function buildVeCostReport(input: VeCostReportInput) {
  const scoped = (scope: Record<string, unknown>) => scope.projectId === input.projectId
    && (!input.baseId || scope.baseId === input.baseId) && inStage(scope.stage, input.mode);
  const logs = input.logs.filter((row) => scoped(row.context)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const jobs = input.jobs.filter((job) => job.project_id === input.projectId
    && (!input.baseId || job.base_id === input.baseId) && inStage(job.stage, input.mode));
  const issues = new Set<string>();
  if (input.logsTruncated) issues.add('journal_pagination_incomplete');
  if (input.snapshotAdvanced) issues.add('snapshot_advanced_after_cutoff');
  const runs = new Map<string, { start?: VeCostLog; end?: VeCostLog }>();
  const attempts = new Map<string, VeCostLog[]>();
  for (const log of logs) {
    if (log.context.version !== 1) { issues.add('unknown_journal_version'); continue; }
    if (log.event === 'stage_started' || log.event === 'stage_finished') {
      if (typeof log.context.runId !== 'string') { issues.add('invalid_run_identity'); continue; }
      const run = runs.get(log.context.runId) ?? {};
      const phase = log.event === 'stage_started' ? 'start' : 'end';
      const prior = run[phase];
      if (prior && JSON.stringify(prior.context) !== JSON.stringify(log.context)) issues.add('conflicting_stage_marker');
      run[phase] = prior ?? log;
      runs.set(log.context.runId, run);
    } else if (log.event === 'started' || log.event === 'finished') {
      if (typeof log.context.attemptId !== 'string') { issues.add('invalid_attempt_identity'); continue; }
      const rows = attempts.get(log.context.attemptId) ?? [];
      rows.push(log);
      attempts.set(log.context.attemptId, rows);
    } else issues.add('unknown_journal_event');
  }

  const childPlans = new Map<string, { kind: string; jobId?: string; steps?: string[] | null; coverage: string }>();
  const firstJobStart = new Map<string, VeCostLog>();
  for (const [runId, run] of runs) {
    if (!run.start || !run.end) issues.add(`unpaired_stage_run:${runId}`);
    if (run.start && run.end && ['projectId', 'baseId', 'jobId', 'stage'].some((key) => run.start!.context[key] !== run.end!.context[key])) issues.add('conflicting_run_scope');
    if (run.start && typeof run.start.context.jobId === 'string' && !firstJobStart.has(run.start.context.jobId)) firstJobStart.set(run.start.context.jobId, run.start);
    for (const marker of [run.start, run.end]) {
      if (!marker || marker.context.stage !== 'base_collect') continue;
      const children = object(marker.context.children);
      if (!children || children.state !== 'ok' || children.truncated) { issues.add('child_snapshot_incomplete'); continue; }
      const constructor = object(children.constructorJob);
      if (constructor) {
        const jobId = String(constructor.jobId ?? 'unknown');
        const steps = Array.isArray(constructor.steps) && constructor.steps.every((step) => typeof step === 'string') ? constructor.steps as string[] : null;
        const safe = steps !== null && steps.every((step) => CONSTRUCTOR_NO_AI_SEARCH.has(step));
        const plan = { kind: 'base_constructor', jobId, steps, coverage: safe ? 'audited_no_ai_or_serper_v1' : 'unknown' };
        const previous = childPlans.get(`constructor:${jobId}`);
        // A missing or changing plan in any snapshot cannot be overwritten by a later reassuring one.
        if (previous && JSON.stringify(previous.steps) !== JSON.stringify(steps)) plan.coverage = 'unknown';
        if (previous?.coverage === 'unknown') plan.coverage = 'unknown';
        childPlans.set(`constructor:${jobId}`, plan);
      }
      if (!Array.isArray(children.sources)) { issues.add('child_snapshot_incomplete'); continue; }
      for (const value of children.sources) {
        const source = object(value);
        if (!source || typeof source.source !== 'string') { issues.add('child_snapshot_incomplete'); continue; }
        if (INLINE_SOURCES.has(source.source) && !source.jobId) continue;
        const jobId = typeof source.jobId === 'string' ? source.jobId : undefined;
        childPlans.set(`source:${source.source}:${jobId ?? marker.context.runId}`, {
          kind: source.source, jobId, coverage: CHILD_NO_AI_SEARCH.has(source.source) ? 'audited_no_ai_or_serper_v1' : 'unknown',
        });
      }
    }
  }
  const seenBaseStarts = new Set<string>();
  for (const marker of firstJobStart.values()) {
    const base = typeof marker.context.baseId === 'string' ? marker.context.baseId : undefined;
    const firstBaseStart = base !== undefined && !seenBaseStarts.has(base);
    if (base) seenBaseStarts.add(base);
    if ((number(marker.context.priorTokensUsed) ?? 0) > 0 || (number(marker.context.priorEstimatedCostUsd) ?? 0) > 0
      || marker.context.priorCheckpoint === true
      || (firstBaseStart && object(marker.context.children)?.priorProgress === true)) issues.add(`meter_started_after_progress:${marker.context.jobId}`);
  }
  for (const job of jobs) {
    if (!firstJobStart.has(job.id)) continue;
    const origin = job.origin_run_id ? runs.get(job.origin_run_id)?.start : undefined;
    if (!origin || origin.context.jobId !== job.id || origin.context.originRunId !== job.origin_run_id) issues.add(`missing_origin_run:${job.id}`);
  }
  for (const jobId of firstJobStart.keys()) if (!jobs.some((job) => job.id === jobId)) issues.add(`missing_job:${jobId}`);
  const unmeteredJobs = jobs.filter((job) => !firstJobStart.has(job.id) && (job.started_at || ['done', 'failed'].includes(job.status))).map((job) => job.id);
  if (unmeteredJobs.length) issues.add('historical_jobs_without_journal');
  if (!logs.length) issues.add('no_journal_for_scope');
  if ([...childPlans.values()].some((plan) => plan.coverage === 'unknown')) issues.add('unmetered_child_plan');

  const records = [...attempts].map(([attemptId, rows]) => {
    const starts = rows.filter((row) => row.event === 'started');
    const finishes = rows.filter((row) => row.event === 'finished');
    const finish = finishes[0]?.context;
    const identity = rows[0].context;
    const conflict = rows.some((row) => ['projectId', 'baseId', 'jobId', 'stage', 'runId', 'provider'].some((key) => row.context[key] !== identity[key]))
      || finishes.some((row) => JSON.stringify(row.context) !== JSON.stringify(finish));
    const run = typeof identity.runId === 'string' ? runs.get(identity.runId) : undefined;
    const markerMatches = run?.start && ['projectId', 'baseId', 'jobId', 'stage'].every((key) => run.start!.context[key] === identity[key]);
    const ambiguous = conflict || !starts.length || !finishes.length || finish?.status === 'ambiguous' || !markerMatches;
    if (ambiguous) issues.add(`incomplete_attempt:${attemptId}`);
    const measured = conflict ? undefined : finish;
    return {
      attemptId, provider: identity.provider, stage: String(identity.stage), jobId: String(identity.jobId),
      status: conflict ? 'conflict' : finish?.status ?? 'started_only', ambiguous,
      reportedCostUsd: number(measured?.reportedCostUsd), estimatedCostUsd: number(measured?.estimatedCostUsd),
      serperCredits: number(measured?.serperCredits),
      requestedModel: measured?.requestedModel ?? identity.requestedModel, actualModel: measured?.actualModel,
      promptTokens: number(measured?.promptTokens), completionTokens: number(measured?.completionTokens), cachedTokens: number(measured?.cachedTokens),
      providerRequestId: measured?.providerRequestId, httpStatus: number(measured?.httpStatus),
    };
  });
  if (records.some((record) => !['requesty', 'serper'].includes(String(record.provider)))) issues.add('unknown_provider');

  const aggregate = (rows: typeof records) => {
    const ai = rows.filter((row) => row.provider === 'requesty');
    const search = rows.filter((row) => row.provider === 'serper');
    const reported = sum(ai.flatMap((row) => row.reportedCostUsd === undefined ? [] : [row.reportedCostUsd]));
    const credits = sum(search.flatMap((row) => row.serperCredits === undefined ? [] : [row.serperCredits]));
    const aiUnknown = ai.filter((row) => row.reportedCostUsd === undefined || row.ambiguous).length;
    const searchUnknown = search.filter((row) => row.serperCredits === undefined || row.ambiguous).length;
    return {
      httpAttempts: rows.length,
      requesty: { attempts: ai.length, reportedUsdKnownSubtotal: reported, unknownCostAttempts: aiUnknown,
        estimatedUsdKnownSubtotal: sum(ai.flatMap((row) => row.estimatedCostUsd === undefined ? [] : [row.estimatedCostUsd])),
        missingEstimateAttempts: ai.filter((row) => row.reportedCostUsd === undefined && row.estimatedCostUsd === undefined).length },
      serper: { attempts: search.length, returnedCreditsKnownSubtotal: credits, unknownCreditAttempts: searchUnknown },
    };
  };
  const totals = aggregate(records);
  if (totals.requesty.unknownCostAttempts) issues.add('requesty_cost_missing');
  if (totals.serper.unknownCreditAttempts) issues.add('serper_credits_missing');
  const journalComplete = issues.size === 0;
  const tariff = number(input.serperUsdPer1000);
  const ready = input.mode === 'collection' && input.baseId && number(input.readyCount) !== undefined ? input.readyCount! : null;
  const searchUsd = tariff === undefined ? null : totals.serper.returnedCreditsKnownSubtotal * tariff / 1000;
  const totalUsd = journalComplete && searchUsd !== null ? sum([totals.requesty.reportedUsdKnownSubtotal, searchUsd]) : null;
  const collectionFinished = input.mode === 'collection' && jobs.length > 0 && jobs.every((job) => ['done', 'failed', 'cancelled'].includes(job.status));
  return {
    version: 1,
    scope: { projectId: input.projectId, baseId: input.baseId ?? null, mode: input.mode },
    period: { first: logs[0]?.created_at ?? null, last: logs.at(-1)?.created_at ?? null },
    financialCoverageComplete: journalComplete,
    collectionFinished,
    jobs: jobs.map(({ id, stage, status }) => ({ id, stage, status })),
    unmeteredJobs, issues: [...issues], stageRuns: runs.size, childPlans: [...childPlans.values()],
    ...totals,
    requestyReportedUsd: journalComplete ? totals.requesty.reportedUsdKnownSubtotal : null,
    serperCredits: journalComplete ? totals.serper.returnedCreditsKnownSubtotal : null,
    serperUsdPer1000: tariff ?? null, serperUsdAtProvidedTariff: journalComplete ? searchUsd : null,
    totalAiAndSearchUsd: totalUsd, readyCount: ready,
    costPerReadyContactUsd: collectionFinished && totalUsd !== null && ready !== null && ready > 0 ? totalUsd / ready : null,
    byStage: [...new Set(records.map((row) => row.stage))].map((stage) => ({ stage, ...aggregate(records.filter((row) => row.stage === stage)) })),
    attempts: records,
    excludes: ['infrastructure_and_proxy_costs', 'other_provider_tariffs', 'outreach_sending_costs'],
  };
}
