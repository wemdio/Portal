import type { TaScoringTelemetry } from './processingSteps';

type Stats = Record<string, unknown>;

interface StepTiming {
  step_index: number;
  key: string;
  started_at: string;
  completed_at?: string;
  failed_at?: string;
  active_ms: number;
  attempts: number;
  /** A restart can lose the uncheckpointed tail; active_ms is then a lower bound. */
  interrupted: boolean;
  input_rows: number;
  output_rows?: number;
}

export function mergeBaseConstructorStats(previous: unknown, patch: Stats): Stats {
  const base = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? previous as Stats
    : {};
  return { ...base, ...patch };
}

/** Each callback is an attempt-local snapshot, added to a fixed durable baseline only once. */
export function accumulateTaScoringTelemetry(
  previous: unknown,
  snapshot: TaScoringTelemetry,
  interrupted: boolean,
  complete: boolean,
): Stats {
  const baseline = mergeBaseConstructorStats(previous, {});
  const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value) : 0;
  const counters: Stats = {};
  for (const key of [
    'http_attempts', 'api_duration_ms', 'retry_wait_ms', 'length_responses',
    'usage_responses', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens',
  ] as const) counters[key] = nonnegative(baseline[key]) + nonnegative(snapshot[key]);
  const previousModels = Array.isArray(baseline.models)
    ? baseline.models.filter((value): value is string => typeof value === 'string') : [];
  return {
    version: 1, ...counters, complete,
    interrupted: interrupted || baseline.interrupted === true,
    unique_companies: Math.max(nonnegative(baseline.unique_companies), snapshot.unique_companies),
    models: [...new Set([...previousModels, ...snapshot.models])].slice(0, 8),
    failed_rows: complete ? snapshot.failed_rows
      : Math.max(nonnegative(baseline.failed_rows), snapshot.failed_rows),
    failed_batches: complete ? snapshot.failed_batches
      : Math.max(nonnegative(baseline.failed_batches), snapshot.failed_batches),
    errors: snapshot.errors.length || complete ? snapshot.errors.slice(0, 5)
      : Array.isArray(baseline.errors) ? baseline.errors.slice(0, 5) : [],
  };
}

/** Small snapshots piggyback existing writes; never derive durations from heartbeat started_at. */
export function createBaseConstructorMetrics(previous: unknown) {
  let stats = mergeBaseConstructorStats(previous, {});
  const stored = stats.step_timings as { version?: number; steps?: StepTiming[] } | undefined;
  const steps: StepTiming[] = stored?.version === 1 && Array.isArray(stored.steps)
    ? stored.steps.filter((entry) => entry && typeof entry.key === 'string'
      && Number.isInteger(entry.step_index) && Number.isFinite(entry.active_ms)
      && Number.isFinite(entry.attempts)).map((entry) => ({ ...entry }))
    : [];
  let active: { position: number; since: number; previousMs: number } | undefined;

  function currentSteps(): StepTiming[] {
    return steps.map((entry, position) => active?.position === position
      ? { ...entry, active_ms: active.previousMs + Math.max(0, Date.now() - active.since) }
      : { ...entry });
  }

  return {
    beginStep(stepIndex: number, key: string, inputRows: number, resumed: boolean) {
      const now = Date.now();
      let position = steps.findIndex((entry) => entry.step_index === stepIndex && entry.key === key);
      const previousStep = position >= 0 ? steps[position] : undefined;
      const entry: StepTiming = {
        step_index: stepIndex,
        key,
        started_at: previousStep?.started_at ?? new Date(now).toISOString(),
        active_ms: Math.max(0, previousStep?.active_ms ?? 0),
        attempts: Math.max(0, previousStep?.attempts ?? 0) + 1,
        interrupted: resumed || previousStep?.interrupted === true,
        input_rows: previousStep?.input_rows ?? inputRows,
      };
      if (position < 0) { position = steps.length; steps.push(entry); }
      else steps[position] = entry;
      active = { position, since: now, previousMs: entry.active_ms };
    },
    finishStep(outputRows?: number) {
      if (!active) return;
      const entry = currentSteps()[active.position];
      if (outputRows == null) entry.failed_at = new Date(Date.now()).toISOString();
      else {
        entry.completed_at = new Date(Date.now()).toISOString();
        entry.output_rows = outputRows;
      }
      steps[active.position] = entry;
      active = undefined;
    },
    merge(patch: Stats) { stats = mergeBaseConstructorStats(stats, patch); },
    snapshot(): Stats {
      return { ...stats, step_timings: { version: 1, steps: currentSteps() } };
    },
  };
}
