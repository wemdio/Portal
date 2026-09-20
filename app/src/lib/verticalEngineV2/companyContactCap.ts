/**
 * "До N адресов на одну компанию" for auto-collected bases.
 *
 * The constructor keeps every validated address of a company (13.09.2026: the
 * old destructive cap of 5 was removed on the owner's request). Production then
 * showed bases of 556 "ready contacts" from 145 companies, one company with 45
 * addresses. This limit is NOT a return of that step: nothing is deleted. It is
 * applied where a round decides which validated rows form the ready base
 * (completeTargetRound); addresses over the limit stay in the reserve with an
 * explicit marker and come back, free of charge, when the limit is raised.
 */
import { isVeAcceptedEmailStatus } from './emailPolicy';
import { VE_COMPANY_CAP_FIELD, veRelevanceCompanyKey, veRelevanceRowKey } from './relevanceReserve';

export { VE_COMPANY_CAP_FIELD };
export const VE_MAX_EMAILS_PER_COMPANY_MIN = 1;
export const VE_MAX_EMAILS_PER_COMPANY_MAX = 100;

/** null = no limit. Anything that is not an integer within bounds is "no limit", never a guess. */
export function normalizeVeMaxEmailsPerCompany(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= VE_MAX_EMAILS_PER_COMPANY_MIN && value <= VE_MAX_EMAILS_PER_COMPANY_MAX ? value : null;
}

/**
 * One organisation = the unit the relevance gate already decides on (INN, else
 * name + own site, else the row's own facts). The e-mail domain is never used:
 * mail.ru or gmail.com must not glue companies together. Kept as its own name so
 * a later refinement of the limit never changes reserve row identity.
 */
export const veContactLimitKey = (row: Record<string, unknown>): string => veRelevanceCompanyKey(row);

export interface VeCompanyCapResult<T> { kept: T[]; overCap: T[] }

/**
 * Keeps at most `limit` rows per company, in the original order. Inside a
 * company: a confirmed address (ok) before catch_all; then an address that is
 * already in the ready base before a newcomer, so the chosen addresses do not
 * flip between rounds (the reserve is merged in front of the base); then order.
 */
export function capVeContactsPerCompany<T extends Record<string, unknown>>(
  rows: T[], options: { limit: number | null; incumbentKeys?: ReadonlySet<string> },
): VeCompanyCapResult<T> {
  const limit = normalizeVeMaxEmailsPerCompany(options.limit);
  if (limit === null) return { kept: rows, overCap: [] };
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = veContactLimitKey(row);
    const group = groups.get(key);
    if (group) group.push(index); else groups.set(key, [index]);
  });
  const rank = (index: number) => [
    rows[index]._email_status === 'ok' ? 0 : isVeAcceptedEmailStatus(rows[index]._email_status) ? 1 : 2,
    options.incumbentKeys?.has(veRelevanceRowKey(rows[index])) ? 0 : 1,
    index,
  ];
  const keep = new Set<number>();
  for (const indices of groups.values()) {
    const ordered = indices.length <= limit ? indices : [...indices].sort((a, b) => {
      const left = rank(a), right = rank(b);
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    });
    for (const index of ordered.slice(0, limit)) keep.add(index);
  }
  return { kept: rows.filter((_, index) => keep.has(index)), overCap: rows.filter((_, index) => !keep.has(index)) };
}

/** The marker is recomputed by every partition and never trusted from storage. */
export function stripVeCompanyCapMarker<T extends Record<string, unknown>>(row: T): T {
  if (!(VE_COMPANY_CAP_FIELD in row)) return row;
  const clean = { ...row };
  delete clean[VE_COMPANY_CAP_FIELD];
  return clean;
}
