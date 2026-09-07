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
  other: number;
}

const cell = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

export function veRelevanceCompanyKey(row: Record<string, unknown>): string {
  const inn = cell(row.inn).replace(/\D/g, '');
  if (inn) return 'inn:' + inn;
  const company = cell(row.company).toLocaleLowerCase(), website = cell(row.website).toLocaleLowerCase();
  if (company || website) return JSON.stringify([company, website]);
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
  const summary: VeRelevanceReserveSummary = { total: rows.length, needs_review: 0, error: 0, irrelevant: 0, email_unready: 0, other: 0 };
  for (const row of rows) {
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
    || (!decision && row._relevance_unchecked === true);
}

/** Spend the next bounded website pass on usable emails not yet investigated. */
export function needsVeRelevanceEvidence(row: Record<string, unknown>): boolean {
  const decision = row._ve_relevance && typeof row._ve_relevance === 'object'
    ? row._ve_relevance as { status?: unknown; review_attempts?: unknown } : null;
  return decision?.status === 'needs_review' && row._email_status === 'ok'
    && cell(row.website).length > 0 && (decision.review_attempts ?? 0) === 0;
}
