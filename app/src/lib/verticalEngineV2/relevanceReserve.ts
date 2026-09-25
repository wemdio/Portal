import { isVeAcceptedEmailStatus } from './emailPolicy';
import { normalizeVeCompanyInn, veCompanyIdentityKey } from './collectionIdentity';
import { needsVeSavedEmailReview } from './savedEmailReviewEligibility';
import { VE_RELEVANCE_RULES_VERSION, VE_RELEVANCE_WEBSITE_VERSION } from './relevanceDecision';
import { VE_RELEVANCE_TRIAGE_VERSION } from './relevanceTriageConfig';

/** Validated address of a relevant company kept out of the ready base only by the
 * specialist's "addresses per company" limit (companyContactCap.ts). Recomputed
 * by every partition; never a reason for paid relevance or e-mail work. */
export const VE_COMPANY_CAP_FIELD = '_ve_company_cap';

/** Durable candidates are separate from the approved/launchable base projection. */
export interface VeRelevanceReserve {
  version: 1;
  rows: Array<Record<string, unknown>>;
  /** Repeated descriptions are stored once. Row flags/verdicts remain inline
   * for SQL review eligibility; all worker reads restore the original text. */
  descriptions?: string[];
  /** Preserved acquisition inputs, including multi-email cells BC may reduce. */
  source_rows?: Array<Record<string, unknown>>;
}

export interface VeRelevanceReserveSummary {
  total: number;
  needs_review: number;
  error: number;
  /** Never submitted for checking — the round ended before the queue reached
   * them. Separate from `error`: nothing failed, so the UI must not alarm. */
  unchecked: number;
  irrelevant: number;
  email_unready: number;
  /** Additional overlapping count, not another term in the total. */
  email_retryable: number;
  other: number;
  /** Ready addresses over the per-company limit; present only when there are any. */
  over_company_cap?: number;
}

const cell = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const fact = (row: Record<string, unknown>, names: string[]) => {
  for (const [key, value] of Object.entries(row)) if (names.includes(key.trim().toLowerCase()) && cell(value)) return cell(value);
  return '';
};
const hasEvidenceSource = (row: Record<string, unknown>) => Boolean(normalizeVeCompanyInn(fact(row, ['inn', 'инн']))
  || fact(row, ['website', 'site', 'сайт'])
  || (fact(row, ['company', 'компания']) && fact(row, ['address', 'адрес'])));

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
  return reserve.rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => {
      if (!('_ve_description_ref' in row)) return row;
      const ref = row._ve_description_ref;
      if (typeof ref !== 'number' || !Number.isSafeInteger(ref) || ref < 0
        || !Array.isArray(reserve.descriptions) || typeof reserve.descriptions[ref] !== 'string') {
        throw new Error('Invalid relevance reserve description reference');
      }
      const restored: Record<string, unknown> = { ...row, description: reserve.descriptions[ref] };
      delete restored._ve_description_ref;
      return restored;
    });
}

/** Lossless storage compaction, without removing any company, email or verdict.
 * Historical constructors expanded one company's description to hundreds of
 * addresses; StaffLine's reserve alone grew to 201 MB and blocked checkpoint
 * writes at PostgreSQL's 256 MB jsonb limit. Keep small reserves unchanged. */
export function compactVeRelevanceReserve(value: VeRelevanceReserve): VeRelevanceReserve {
  const rows = readVeRelevanceReserve(value);
  const counts = new Map<string, number>();
  for (const row of rows) if (typeof row.description === 'string' && row.description.length >= 256) {
    counts.set(row.description, (counts.get(row.description) ?? 0) + 1);
  }
  const descriptions: string[] = [];
  let savings = 0;
  for (const [description, count] of counts) if (count > 1) {
    descriptions.push(description);
    savings += (count - 1) * description.length - count * 32;
  }
  const { descriptions: _previous, ...plain } = value;
  if (savings < 64 * 1024) return _previous ? { ...plain, rows } : value;
  const refs = new Map(descriptions.map((description, index) => [description, index]));
  return { ...plain, descriptions, rows: rows.map((row) => {
    const ref = typeof row.description === 'string' ? refs.get(row.description) : undefined;
    if (ref === undefined) return row;
    const packed: Record<string, unknown> = { ...row, _ve_description_ref: ref };
    delete packed.description;
    return packed;
  }) };
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
      delete merged._ve_email_pending_relevance;
      if (row._low_relevance === true) merged._low_relevance = true;
      if (row._relevance_unchecked === true) merged._relevance_unchecked = true;
      if (row._ve_email_pending_relevance === true) merged._ve_email_pending_relevance = true;
    }
    rows.set(key, merged);
  }
  return [...rows.values()];
}

export function summarizeVeRelevanceReserve(rows: Array<Record<string, unknown>>): VeRelevanceReserveSummary {
  const summary: VeRelevanceReserveSummary = { total: rows.length, needs_review: 0, error: 0, unchecked: 0, irrelevant: 0, email_unready: 0, email_retryable: 0, other: 0 };
  for (const row of rows) {
    if (needsVeSavedEmailReview(row)) summary.email_retryable += 1;
    const decision = row._ve_relevance && typeof row._ve_relevance === 'object'
      ? row._ve_relevance as { status?: unknown } : null;
    if (row._ve_email_pending_relevance === true && !isVeAcceptedEmailStatus(row._email_status)) summary.email_unready += 1;
    else if (decision?.status === 'needs_review') summary.needs_review += 1;
    else if (decision?.status === 'error') summary.error += 1;
    else if (decision?.status === 'irrelevant' || row._low_relevance === true) summary.irrelevant += 1;
    // Строка без вердикта — не сбой проверки: до неё просто не дошла очередь
    // (обычно раунд закончился, когда набрался нужный объём). Прежде такие
    // строки попадали в error, и интерфейс объявлял их неудачей автопроверки.
    else if (row._relevance_unchecked === true) summary.unchecked += 1;
    else if (!isVeAcceptedEmailStatus(row._email_status)) summary.email_unready += 1;
    else if (row[VE_COMPANY_CAP_FIELD]) summary.over_company_cap = (summary.over_company_cap ?? 0) + 1;
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
  if (!needsVeRelevanceReview(row) || !isVeAcceptedEmailStatus(row._email_status)) return false;
  const decision = row._ve_relevance && typeof row._ve_relevance === 'object'
    ? row._ve_relevance as { status?: unknown; review_attempts?: unknown; website_review_version?: unknown; search_deferred?: unknown } : null;
  // Newly recovered legacy emails still need their initial classification.
  // Technical errors use the caller's bounded recovery policy, not a guess.
  if (!decision || decision.status === 'error') return true;
  if (decision.status === 'needs_review' && decision.search_deferred === true) return evidenceAvailable;
  // The gate stamps website_review_version once its bounded follow-up under the
  // current policy is complete, also when no paid attempt was counted (site
  // unavailable, identity unverified). Treating a zero attempt count as "never
  // reviewed" re-selected such companies forever: the gate reused the cached
  // verdict, nothing changed, and the base requeued every 30 seconds (19.09.2026).
  return decision.status === 'needs_review' && evidenceAvailable
    && decision.website_review_version !== VE_RELEVANCE_WEBSITE_VERSION;
}

/** Saved uncertainty the calibrated triage has not read yet. It needs no site,
 * INN or paid search, so neither missing evidence sources nor a deferred search
 * excludes the company. The gate stamps every company it has seen, including
 * those it cannot decide, so one pass per company is all this ever selects. */
function awaitsVeTriage(row: Record<string, unknown>): boolean {
  if (!isVeAcceptedEmailStatus(row._email_status)) return false;
  const decision = row._ve_relevance && typeof row._ve_relevance === 'object'
    ? row._ve_relevance as { status?: unknown; triage_version?: unknown } : null;
  return decision?.status === 'needs_review' && decision.triage_version !== VE_RELEVANCE_TRIAGE_VERSION;
}

/** Saved uncertainty not yet checked under the current selection rules
 * (VE_RELEVANCE_RULES_VERSION). One pass per company: the gate rechecks a
 * rejected admission from its saved quotes and stamps everything else, so
 * this needs no site, INN or paid search either. */
function awaitsVeRulesReview(row: Record<string, unknown>): boolean {
  if (!isVeAcceptedEmailStatus(row._email_status)) return false;
  const decision = row._ve_relevance && typeof row._ve_relevance === 'object'
    ? row._ve_relevance as { status?: unknown; rules_version?: unknown } : null;
  return decision?.status === 'needs_review' && decision.rules_version !== VE_RELEVANCE_RULES_VERSION;
}

/** Отпечаток отбора сохранённой проверки: «этот проход повторяет предыдущий».
 *
 * Здесь ТОЛЬКО то, что сама проверка способна изменить: состав выбранных строк
 * и поля вердикта, по которым строится следующий отбор. Числа готовых контактов
 * базы и сырого статуса валидации чужого адреса здесь нет намеренно: они
 * меняются от дочерней валидации почт и от пересчёта лимита адресов на
 * компанию, то есть по причинам, к сохранённой проверке не относящимся.
 * 21.09.2026 именно эта примесь сбрасывала детектор застоя: база 912c19df с
 * 17:26 до 18:32 UTC сорок раз подряд «уточняла» одни и те же 479 контактов
 * 110 компаний, каждый раунд перечитывая и переписывая свои 19 МБ и не делая
 * ни одного обращения к провайдеру.
 *
 * Годность адреса всё же входит в отпечаток: именно она решает, попадёт ли
 * строка в отбор, поэтому переход «unknown → ok» обязан считаться продвижением,
 * а «unknown → invalid» — нет.
 */
export function veSavedReviewSignature(
  rows: Array<Record<string, unknown>>,
  options: { triage: boolean },
): unknown[] {
  return rows.map((row) => {
    const decision = row._ve_relevance && typeof row._ve_relevance === 'object'
      ? row._ve_relevance as Record<string, unknown> : undefined;
    return [veRelevanceRowKey(row), isVeAcceptedEmailStatus(row._email_status),
      decision?.status ?? null, decision?.review_attempts ?? null,
      decision?.website_review_version ?? null, decision?.search_deferred ?? null,
      // Быстрый проход, который лишь пометил компанию просмотренной, — тоже
      // продвижение; элемент существует только при включённом триаже, поэтому
      // отпечатки, снятые без него, остаются сравнимыми.
      ...(options.triage ? [decision?.triage_version ?? null] : []),
      // Отметка правил отбора — тоже продвижение. Элемент есть только у
      // отмеченных строк: отпечатки строк без отметки прежние, лишнего
      // прохода после раскатки нет.
      ...(decision?.rules_version !== undefined ? [decision.rules_version] : [])];
  }).sort();
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
  allowPaidSearch?: boolean;
  /** isVeRelevanceTriageEnabled(project): also select saved uncertainty not yet triaged. */
  triage?: boolean;
}): VeRelevanceReviewBatch {
  const saved = mergeVeRelevanceRows(input.reserve, input.ready);
  const withEvidence = new Set([...saved, ...input.source]
    .filter(hasEvidenceSource)
    .map(veRelevanceCompanyKey));
  const selected = new Set(input.reserve.filter((row) => {
    if (!needsVeRelevanceReview(row)) return false;
    const untriaged = input.triage === true && awaitsVeTriage(row);
    // A deferred search stays excluded without paid search, also for the rules
    // pass: a rejected admission waits for that website work, so selecting it
    // would only repeat the same pass.
    if (!untriaged && input.allowPaidSearch === false
      && (row._ve_relevance as { search_deferred?: unknown } | undefined)?.search_deferred === true) return false;
    if (!input.automatic) return true;
    return untriaged || awaitsVeRulesReview(row) || canAutomaticallyReview(row, withEvidence.has(veRelevanceCompanyKey(row)));
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
