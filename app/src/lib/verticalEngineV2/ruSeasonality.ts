/**
 * Verified Russian seasonality and Moscow-calendar evaluation.
 *
 * This module intentionally contains no industry/title heuristics.  A useful
 * seasonal or neutral decision must arrive with evidence already persisted by
 * evidence-stage; missing, malformed, or unsupported input stays `unknown`.
 */

import { VeRuSeasonalitySchema } from './schemas';
import {
  verifyEvidenceItems,
  type VeFetchedSource,
} from './verifyEvidence';
import type {
  VeEvidenceItem,
  VeRuSeasonality,
  VeRuSeasonalityConfidence,
  VeRuSeasonalityEvaluation,
  VeRuSeasonalityPrioritySnapshot,
  VeRuSeasonalityState,
  VeRuSeasonalityWindow,
} from './types';

export type {
  VeRuSeasonality,
  VeRuSeasonalityConfidence,
  VeRuSeasonalityEvaluation,
  VeRuSeasonalityPrioritySnapshot,
  VeRuSeasonalityState,
  VeRuSeasonalityWindow,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RU_SEASONALITY_PREP_BUFFER_DAYS = 14;

const PRIORITY: Record<VeRuSeasonalityState, number> = {
  launch_now: 100,
  prepare_now: 200,
  neutral: 300,
  unknown: 400,
  wait: 500,
  avoid: 600,
};

const UNKNOWN_RATIONALE = 'Проверенных данных о сезонности недостаточно.';

function unknownSeasonality(rationale = UNKNOWN_RATIONALE): VeRuSeasonality {
  return {
    version: 1,
    classification: 'unknown',
    confidence: 'low',
    rationale: rationale.trim() || UNKNOWN_RATIONALE,
    windows: [],
    evidence: [],
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseMonthDay(value: string): { month: number; day: number } | null {
  const match = /^(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(2000, month)) return null;
  return { month, day };
}

function validWindow(window: VeRuSeasonalityWindow): boolean {
  return Boolean(
    window.label.trim() &&
      parseMonthDay(window.start_mm_dd) &&
      parseMonthDay(window.end_mm_dd) &&
      (window.kind !== 'peak' ||
        (Number.isSafeInteger(window.lead_days) && window.lead_days >= 0 && window.lead_days <= 366)),
  );
}

function canonicalWindows(windows: VeRuSeasonalityWindow[]): VeRuSeasonalityWindow[] {
  const kindRank: Record<VeRuSeasonalityWindow['kind'], number> = { peak: 0, avoid: 1 };
  return windows
    .filter(validWindow)
    .map((window) => ({
      ...window,
      label: window.label.trim(),
      evidence: canonicalEvidence(window.evidence),
    }))
    // A top-level citation cannot vouch for every model-generated window.
    // Persist/evaluate only windows with evidence linked to that exact claim.
    .filter((window) => window.evidence.length > 0)
    .sort((left, right) =>
      kindRank[left.kind] - kindRank[right.kind] ||
      left.start_mm_dd.localeCompare(right.start_mm_dd, 'en') ||
      left.end_mm_dd.localeCompare(right.end_mm_dd, 'en') ||
      left.label.localeCompare(right.label, 'ru') ||
      (left.kind === 'peak' ? left.lead_days : 0) -
        (right.kind === 'peak' ? right.lead_days : 0),
    );
}

function canonicalEvidence(items: VeEvidenceItem[]): VeEvidenceItem[] {
  const normalized = [...items]
    .map((item) => ({
      claim: item.claim.trim(),
      source_url: item.source_url.trim(),
      quote: item.quote.trim(),
    }))
    .filter((item) => item.claim && item.source_url && item.quote)
    .sort((left, right) =>
      left.source_url.localeCompare(right.source_url, 'en') ||
      left.quote.localeCompare(right.quote, 'ru') ||
      left.claim.localeCompare(right.claim, 'ru'),
    );
  return normalized.filter((item, index) =>
    index === 0 ||
    item.source_url !== normalized[index - 1].source_url ||
    item.quote !== normalized[index - 1].quote ||
    item.claim !== normalized[index - 1].claim,
  );
}

/**
 * Read a persisted assessment defensively.  Legacy NULL/absence, malformed
 * JSON, an evidence-free `neutral`, and a clue-only `seasonal` value all map
 * to explicit unknown; no default month or industry dictionary is consulted.
 */
export function readStoredRuSeasonality(value: unknown): VeRuSeasonality {
  const parsed = VeRuSeasonalitySchema.safeParse(value);
  if (!parsed.success) return unknownSeasonality();

  const rationale = parsed.data.rationale.trim();
  if (parsed.data.classification === 'unknown') {
    return unknownSeasonality(rationale);
  }

  if (parsed.data.classification === 'neutral') {
    const evidence = canonicalEvidence(parsed.data.evidence);
    if (evidence.length === 0) return unknownSeasonality();
    return {
      version: 1,
      classification: 'neutral',
      confidence: parsed.data.confidence,
      rationale,
      windows: [],
      evidence,
    };
  }

  const windows = canonicalWindows(parsed.data.windows as VeRuSeasonalityWindow[]);
  if (windows.length === 0) return unknownSeasonality();
  const evidence = canonicalEvidence(windows.flatMap((window) => window.evidence));
  return {
    version: 1,
    classification: 'seasonal',
    confidence: parsed.data.confidence,
    rationale,
    windows,
    evidence,
  };
}

/**
 * Verify every seasonal window's own evidence against pages fetched by
 * evidence-stage. A valid citation linked to one window never implicitly
 * validates the model's other windows.
 */
export function normalizeVerifiedRuSeasonality(
  value: unknown,
  sources: VeFetchedSource[],
): VeRuSeasonality {
  const parsed = VeRuSeasonalitySchema.safeParse(value);
  if (!parsed.success || parsed.data.classification === 'unknown') {
    return unknownSeasonality(parsed.success ? parsed.data.rationale : undefined);
  }

  if (parsed.data.classification === 'neutral') {
    const verification = verifyEvidenceItems(parsed.data.evidence, sources);
    if (verification.valid.length === 0) return unknownSeasonality();
    return readStoredRuSeasonality({
      ...parsed.data,
      evidence: verification.valid,
    });
  }

  const windows = parsed.data.windows.flatMap((window) => {
    const verification = verifyEvidenceItems(window.evidence, sources);
    return verification.valid.length > 0
      ? [{ ...window, evidence: verification.valid }]
      : [];
  });
  if (windows.length === 0) return unknownSeasonality();

  return readStoredRuSeasonality({
    ...parsed.data,
    windows,
    evidence: windows.flatMap((window) => window.evidence),
  });
}

/** YYYY-MM-DD in Europe/Moscow (UTC+3 year-round), independent of host TZ. */
export function moscowDateKey(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError('now must be a valid Date');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function dateKeyMs(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function occurrenceDateMs(year: number, monthDay: string): number {
  const parsed = parseMonthDay(monthDay);
  if (!parsed) throw new RangeError(`invalid MM-DD: ${monthDay}`);
  // Feb 29 is represented as Feb 28 in non-leap recurrence years.
  const day = Math.min(parsed.day, daysInMonth(year, parsed.month));
  return Date.UTC(year, parsed.month - 1, day);
}

function dateKeyFromMs(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

interface PeakOccurrence {
  outreachStart: number;
  prepStart: number;
  peakStart: number;
  end: number;
}

interface AvoidOccurrence {
  start: number;
  end: number;
}

function endYearForWindow(window: VeRuSeasonalityWindow, startYear: number): number {
  return window.end_mm_dd < window.start_mm_dd ? startYear + 1 : startYear;
}

function peakOccurrence(
  window: Extract<VeRuSeasonalityWindow, { kind: 'peak' }>,
  startYear: number,
): PeakOccurrence {
  const peakStart = occurrenceDateMs(startYear, window.start_mm_dd);
  return {
    peakStart,
    outreachStart: peakStart - window.lead_days * DAY_MS,
    prepStart: peakStart - (window.lead_days + RU_SEASONALITY_PREP_BUFFER_DAYS) * DAY_MS,
    end: occurrenceDateMs(endYearForWindow(window, startYear), window.end_mm_dd),
  };
}

function avoidOccurrence(
  window: Extract<VeRuSeasonalityWindow, { kind: 'avoid' }>,
  startYear: number,
): AvoidOccurrence {
  return {
    start: occurrenceDateMs(startYear, window.start_mm_dd),
    end: occurrenceDateMs(endYearForWindow(window, startYear), window.end_mm_dd),
  };
}

function isWithin(today: number, start: number, end: number): boolean {
  return today >= start && today <= end;
}

function eligibility(state: VeRuSeasonalityState): boolean {
  return state === 'launch_now' || state === 'neutral';
}

function evaluation(
  state: VeRuSeasonalityState,
  confidence: VeRuSeasonalityConfidence,
  evaluatedOn: string,
  plannedActivationMs: number | null,
  seasonalDeadlineMs: number | null,
): VeRuSeasonalityEvaluation {
  return {
    state,
    confidence,
    evaluated_on: evaluatedOn,
    planned_activation_date:
      plannedActivationMs === null ? null : dateKeyFromMs(plannedActivationMs),
    seasonal_deadline_date:
      seasonalDeadlineMs === null ? null : dateKeyFromMs(seasonalDeadlineMs),
    automatic_activation_eligible: eligibility(state),
  };
}

/** Evaluate verified annual windows for the current Moscow business date. */
export function evaluateRuSeasonality(
  value: VeRuSeasonality | null | undefined,
  now: Date = new Date(),
): VeRuSeasonalityEvaluation {
  const assessed = readStoredRuSeasonality(value);
  const evaluatedOn = moscowDateKey(now);
  const today = dateKeyMs(evaluatedOn);

  if (assessed.classification === 'unknown') {
    return evaluation('unknown', 'low', evaluatedOn, null, null);
  }
  if (assessed.classification === 'neutral') {
    return evaluation('neutral', assessed.confidence, evaluatedOn, today, null);
  }

  const year = Number(evaluatedOn.slice(0, 4));
  const startYears = [year - 2, year - 1, year, year + 1, year + 2];
  const peakWindows = assessed.windows.filter(
    (window): window is Extract<VeRuSeasonalityWindow, { kind: 'peak' }> =>
      window.kind === 'peak',
  );
  const avoidWindows = assessed.windows.filter(
    (window): window is Extract<VeRuSeasonalityWindow, { kind: 'avoid' }> =>
      window.kind === 'avoid',
  );
  const peaks = peakWindows
    .flatMap((window) => startYears.map((startYear) => peakOccurrence(window, startYear)))
    .sort((left, right) =>
      left.outreachStart - right.outreachStart || left.end - right.end,
    );
  const avoids = avoidWindows.flatMap((window) =>
    startYears.map((startYear) => avoidOccurrence(window, startYear)),
  );
  const nextOutreach = peaks.find((item) => item.outreachStart > today) ?? null;

  // Explicit verified negative windows win overlaps: automatic launch fails closed.
  if (avoids.some((item) => isWithin(today, item.start, item.end))) {
    return evaluation(
      'avoid',
      assessed.confidence,
      evaluatedOn,
      nextOutreach?.outreachStart ?? null,
      nextOutreach ? nextOutreach.end + DAY_MS : null,
    );
  }

  // A verified negative-only assessment says when NOT to send. Outside those
  // windows there is no positive peak to wait for, so the slot is available
  // today. Treating it as unknown would permanently strand such campaigns.
  if (peakWindows.length === 0 && avoidWindows.length > 0) {
    return evaluation('launch_now', assessed.confidence, evaluatedOn, today, null);
  }

  const active = peaks.find((item) => isWithin(today, item.outreachStart, item.end));
  if (active) {
    return evaluation(
      'launch_now',
      assessed.confidence,
      evaluatedOn,
      active.outreachStart,
      active.end + DAY_MS,
    );
  }

  const preparing = peaks.find(
    (item) => today >= item.prepStart && today < item.outreachStart,
  );
  if (preparing) {
    return evaluation(
      'prepare_now',
      assessed.confidence,
      evaluatedOn,
      preparing.outreachStart,
      preparing.end + DAY_MS,
    );
  }

  if (nextOutreach) {
    return evaluation(
      'wait',
      assessed.confidence,
      evaluatedOn,
      nextOutreach.outreachStart,
      nextOutreach.end + DAY_MS,
    );
  }
  return evaluation('unknown', 'low', evaluatedOn, null, null);
}

/** Stable display/ranking snapshot; eligibility remains an independent gate. */
export function buildRuSeasonalityPrioritySnapshot(
  value: VeRuSeasonality | null | undefined,
  now: Date = new Date(),
): VeRuSeasonalityPrioritySnapshot {
  const result = evaluateRuSeasonality(value, now);
  return {
    version: 1,
    ...result,
    priority: PRIORITY[result.state],
  };
}
