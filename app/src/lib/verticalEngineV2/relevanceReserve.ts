import { normalizeVeCompanyInn, veCompanyIdentityKey } from './collectionIdentity';
import { needsVeSavedEmailReview } from './savedEmailReviewEligibility';

/** Durable candidates are separate from the approved/launchable base projection. */
export interface VeRelevanceReserve {
  version: 1;
  rows: Array<Record<string, unknown>>;
  /** Preserved acquisition inputs, including multi-email cells BC may reduce. */
  source_rows?: Array<Record<string, unknown>>;
}

export interface VeRelevanceReserveSummary {
  total: number;
  needs_review: number;
  error: number;
  irrelevant: number;
  email_unready: number;
  /** Additional overlapping count, not another term in the total. */
  email_retryable: number;
  other: number;
}

const cell = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const fact = (row: Record<string, unknown>, names: string[]) => {
  for (const [key, value] of Object.entries(row)) if (names.includes(key.trim().toLowerCase()) && cell(value)) return cell(value);
  return '';
};
const hasEvidenceSource = (row: Record<string, unknown>) => Boolean(normalizeVeCompanyInn(fact(row, ['inn', 'инн']))
  || fact(row, ['website', 'site', 'сайт']));

export function veRelevanceCompanyKey(row: Record<string, unknown>): string {
  const stableIdentity = veCompanyIdentityKey({ inn: fact(row, ['inn', 'инн']),
    company: fact(row, ['company', 'компания']), website: fact(row, ['website', 'site', 'сайт']) });
  if (stableIdentity) return stableIdentity;
  // Anonymous rows still retain their distinct source facts rather than sharing
  // one empty key; quality metadata must not change that identity on a retry.
  return JSON.stringify(Object.entries(row).filter(([key]) => !key.startsWith('_') && key !== 'email')
    .sort(([a], [b]) => a.localeCompare(b)));
}

/** Include company identity: an email shared by two entities must retain both facts. */
export function veRelevanceRowKey(row: Record<string, unknown>): string {
  return JSON.stringify([veRelevanceCompanyKey(row), cell(row.email).toLocaleLowerCase()]);
}

export function readVeRelevanceReserve(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const reserve = value as Partial<VeRelevanceReserve>;
  if (reserve.version !== 1 || !Array.isArray(reserve.rows)) return [];
  return reserve.rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
}

export function readVeRelevanceSourceRows(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const reserve = value as Partial<VeRelevanceReserve>;
  if (reserve.version !== 1 || !Array.isArray(reserve.source_rows)) return [];
  return reserve.source_rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
}

/** Later observations replace earlier verdicts without discarding richer source fields. */
export function mergeVeRelevanceRows(...groups: Array<Array<Record<string, unknown>>>): Array<Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const group of groups) for (const row of group) {
    const key = veRelevanceRowKey(row);
    const previous = rows.get(key);
    const merged = previous ? { ...previous, ...row } : { ...row };
    if (previous) for (const [field, value] of Object.entries(row)) {
      // Sparse subsequent observations cannot erase known source facts. Quality
      // metadata is authoritative and is intentionally not restored this way.
      if (!field.startsWith('_') && cell(value) === '' && cell(previous[field]) !== '') merged[field] = previous[field];
    }
    // A fresh explicit decision supersedes compatibility flags of an old attempt.
    if ('_ve_relevance' in row) {
      delete merged._low_relevance;
      delete merged._relevance_unchecked;
      if (row._low_relevance === true) merged._low_relevance = true;
      if (row._relevance_unchecked === true) merged._relevance_unchecked = true;
    }
    rows.set(key, merged);
  }
  return [...rows.values()];
}

export function summarizeVeRelevanceReserve(rows: Array<Record<string, unknown>>): VeRelevanceReserveSummary {
  const summary: VeRelevanceReserveSummary = { total: rows.length, needs_review: 0, error: 0, irrelevant: 0, email_unready: 0, email_retryable: 0, other: 0 };
  for (const row of rows) {
    if (needsVeSavedEmailReview(row)) summary.email_retryable += 1;
    const decision = row._ve_relevance && typeof row._ve_relevance === 'object'
      ? row._ve_relevance as { status?: unknown } : null;
    if (decision?.status === 'needs_review') summary.needs_review += 1;
    else if (decision?.status === 'error') summary.error += 1;
    else if (decision?.status === 'irrelevant' || row._low_relevance === true) summary.irrelevant += 1;
    else if (row._relevance_unchecked === true) summary.error += 1;
    else if (row._email_status !== 'ok') summary.email_unready += 1;
    else summary.other += 1;
  }
  return summary;
}

/** Only uncertain/failed classification is automatically revisited; rejects stay auditable. */
export function needsVeRelevanceReview(row: Record<string, unknown>): boolean {
  const decision = row._ve_relevance && typeof row._ve_relevance === 'object'
    ? row._ve_relevance as { status?: unknown } : null;
  return decision?.status === 'needs_review' || decision?.status === 'error'
    || (row._relevance_unchecked === true && decision?.status !== 'irrelevant' && String(row._low_relevance ?? '') !== 'true');
}

function canAutomaticallyReview(row: Record<string, unknown>, evidenceAvailable: boolean): boolean {
  if (!needsVeRelevanceReview(row) || row._email_status !== 'ok') return false;
  const decision = row._ve_relevance && typeof row._ve_relevance === 'object'
    ? row._ve_relevance as { status?: unknown; review_attempts?: unknown } : null;
  // Newly recovered legacy emails still need their initial classification.
  // Technical errors use the caller's bounded recovery policy, not a guess.
  if (!decision || decision.status === 'error') return true;
  return decision.status === 'needs_review' && evidenceAvailable && (decision.review_attempts ?? 0) === 0;
}

/** Spend the next bounded pass on usable emails with a site or searchable INN. */
export function needsVeRelevanceEvidence(row: Record<string, unknown>): boolean {
  return canAutomaticallyReview(row, hasEvidenceSource(row));
}

export interface VeRelevanceReviewBatch {
  /** All saved recipient rows of selected companies, with their own email verdicts. */
  rows: Array<Record<string, unknown>>;
  /** Source observations are classifier context only, never output recipients. */
  evidenceRows: Array<Record<string, unknown>>;
  companies: number;
}

/** A company is reviewed once using facts from all of its saved observations. */
export function buildVeRelevanceReviewBatch(input: {
  reserve: Array<Record<string, unknown>>;
  ready: Array<Record<string, unknown>>;
  source: Array<Record<string, unknown>>;
  automatic: boolean;
}): VeRelevanceReviewBatch {
  const saved = mergeVeRelevanceRows(input.reserve, input.ready);
  const withEvidence = new Set([...saved, ...input.source]
    .filter(hasEvidenceSource)
    .map(veRelevanceCompanyKey));
  const selected = new Set(input.reserve.filter((row) => {
    if (!needsVeRelevanceReview(row)) return false;
    if (!input.automatic) return true;
    return canAutomaticallyReview(row, withEvidence.has(veRelevanceCompanyKey(row)));
  }).map(veRelevanceCompanyKey));
  return {
    rows: saved.filter((row) => selected.has(veRelevanceCompanyKey(row))),
    // Do not pass old raw-row verdicts into the cache/attempt counter. Only the
    // recipient observations may carry authoritative validation metadata.
    evidenceRows: input.source.filter((row) => selected.has(veRelevanceCompanyKey(row))).map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_')))),
    companies: selected.size,
  };
}
