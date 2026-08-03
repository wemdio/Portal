// Shared filter chain for the funded_companies table (Crunchbase tab).
// Used by BOTH /api/funded/search and /api/funded/count so the "≈ N" counter
// can never disagree with the actual search results (prod issue 2026-08-03:
// the old planner-estimate RPC assumed filter independence and showed ≈1700
// where the strict search returned 0 — industry='b2b' rows are all YC and
// have no last_funding_date).

export type FundedFilters = {
  source?: string[];
  country?: string[];
  industry?: string[];
  stage?: string[];
  hasFunding?: boolean;
  minFunding?: number | null;
  fundedSince?: string | null;
  name?: string;
};

// Structural subset of the postgrest filter builder. Postgrest builders are
// mutable and return `this`, so we call for side effects and hand the SAME
// query object back — reassigning a widened structural type would lose the
// concrete builder generic (and breaks tsc).
type FilterableQuery = {
  in(column: string, values: readonly unknown[]): unknown;
  or(filters: string): unknown;
  gte(column: string, value: unknown): unknown;
  ilike(column: string, pattern: string): unknown;
};

export function applyFundedFilters<Q extends FilterableQuery>(query: Q, filters: FundedFilters): Q {
  if (filters.source?.length) query.in('source', filters.source);
  if (filters.country?.length) query.in('country', filters.country);
  if (filters.industry?.length) query.in('industry', filters.industry);
  if (filters.stage?.length) query.in('last_funding_type', filters.stage);
  if (filters.hasFunding) {
    query.or('last_funding_date.not.is.null,last_funding_usd.not.is.null,total_funding_usd.not.is.null');
  }
  if (filters.minFunding != null) {
    query.or(`last_funding_usd.gte.${filters.minFunding},total_funding_usd.gte.${filters.minFunding}`);
  }
  if (filters.fundedSince) query.gte('last_funding_date', filters.fundedSince);
  if (filters.name) query.ilike('name', `%${filters.name.replace(/[%_]/g, '')}%`);
  return query;
}
