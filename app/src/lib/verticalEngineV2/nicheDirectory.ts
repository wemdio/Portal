import type { SupabaseClient } from '@supabase/supabase-js';
import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';
import { OKVED2_TREE, reduceToTopCodes } from '@/lib/companiesSearch/okved2';
import { VE_PAYMENT_DIRECTORY_REVISION, vePaymentCompanyInns } from './paymentCompanyDirectory';

const TIMEOUT_MS = 10_000;
const MAX_ROWS = 1_000;
const MAX_OFFSET = 200_000;
const ALLOWED_FILTERS = new Set([
  'okvedCodes', 'regionCodes', 'includeIp', 'hasEmail', 'hasWebsite',
  'revenueFrom', 'revenueTo', 'employeesFrom', 'employeesTo',
  'identityCatalog',
]);
const OKVED_CODE = /^\d{2}(?:\.\d{1,2}){0,2}$/;
const NAME_TERM = /^[A-Za-zА-Яа-яЁё0-9 -]+$/;
const COLUMNS = 'id,name,inn,kpp,address,phones,email,employees_count,revenue,cost,activity_type,'
  + 'website,edo_id,egais,ogrn,okved_code,okved_code_exact,registration_date,registry_status,okved_exact_source';

type SearchResult = { rows: Record<string, unknown>[]; error?: string };
type DirectoryRow = Record<string, unknown> & { okved_code: string | null; okved_code_exact: string | null };
type NicheFilters = CompaniesSearchFilters & { identityCatalog?: typeof VE_PAYMENT_DIRECTORY_REVISION };

/** Only code-owned literal fragments enter PostgREST's expression grammar. */
function normalizedTerms(value: readonly string[]): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return null;
  const terms: string[] = [];
  for (const input of value) {
    if (typeof input !== 'string') return null;
    const term = input.trim();
    // Require three consecutive letters/digits so the name GIN trigram index
    // has a useful key even when the fragment contains spaces or hyphens.
    if (term.length < 3 || term.length > 40 || !NAME_TERM.test(term)
      || !/[A-Za-zА-Яа-яЁё0-9]{3}/.test(term)) return null;
    terms.push(term);
  }
  return [...new Set(terms)];
}

/** A narrow VE-only reader. It never falls back to the unfiltered registry. */
export async function searchVeNicheDirectoryRows(
  db: SupabaseClient,
  filters: NicheFilters,
  nameTerms: readonly string[],
  limit: number,
  offset = 0,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const invalid = (): SearchResult => ({ rows: [], error: 'Invalid niche directory filters' });
  const terms = normalizedTerms(nameTerms);
  if (!terms || !filters || typeof filters !== 'object' || Array.isArray(filters)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS
    || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET
    || Object.entries(filters).some(([key, value]) => value !== undefined && !ALLOWED_FILTERS.has(key))) return invalid();
  if (filters.identityCatalog !== undefined && filters.identityCatalog !== VE_PAYMENT_DIRECTORY_REVISION) return invalid();
  const identityInns = filters.identityCatalog === VE_PAYMENT_DIRECTORY_REVISION ? vePaymentCompanyInns() : [];
  for (const key of ['includeIp', 'hasEmail', 'hasWebsite'] as const) {
    if (filters[key] !== undefined && typeof filters[key] !== 'boolean') return invalid();
  }
  for (const key of ['revenueFrom', 'revenueTo', 'employeesFrom', 'employeesTo'] as const) {
    const value = filters[key];
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) return invalid();
    if ((key === 'employeesFrom' || key === 'employeesTo') && typeof value === 'number' && !Number.isSafeInteger(value)) return invalid();
  }
  if (filters.regionCodes !== undefined && (!Array.isArray(filters.regionCodes)
    || filters.regionCodes.length > 100 || filters.regionCodes.some((code) => typeof code !== 'string' || !/^\d{2}$/.test(code)))) return invalid();
  if (filters.okvedCodes !== undefined && (!Array.isArray(filters.okvedCodes)
    || filters.okvedCodes.length > 100 || filters.okvedCodes.some((code) => typeof code !== 'string'
      || (!OKVED_CODE.test(code) && !/^[A-Z]$/.test(code))))) return invalid();
  const prefixes = reduceToTopCodes(new Set(filters.okvedCodes ?? [])).flatMap((code) =>
    /^[A-Z]$/.test(code) ? OKVED2_TREE.find((node) => node.code === code)?.children?.map((child) => child.code) ?? [] : [code]);
  if (filters.okvedCodes?.length && !prefixes.length) return invalid();
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  try {
    boundedSignal.throwIfAborted();
    // The existing RPC uses the exact registry code when present; only a null
    // exact code may fall back to mapped OKVED. Restrict the latter to real
    // dictionary codes, just as the RPC's recursive reference lookup does.
    let mappedCodes: string[] = [];
    if (prefixes.length) {
      const reference = await db.from('okved_reference').select('code,parent_code')
        .or(prefixes.map((code) => `code.like.${code}*`).join(','))
        .order('code', { ascending: true }).range(0, MAX_ROWS - 1).abortSignal(boundedSignal);
      if (reference.error) return { rows: [], error: reference.error.message };
      if (!Array.isArray(reference.data) || reference.data.length >= MAX_ROWS) {
        return { rows: [], error: 'Niche directory OKVED scope is too large' };
      }
      const dictionary = reference.data.filter((row) => typeof row.code === 'string' && OKVED_CODE.test(row.code));
      const picked = new Set(dictionary.filter((row) => prefixes.includes(row.code)).map((row) => row.code));
      // A numeric prefix absent from the reference still matches exact codes,
      // but must not make mapped codes eligible (same as the shared RPC).
      for (let previous = -1; previous !== picked.size;) {
        previous = picked.size;
        for (const row of dictionary) if (picked.has(row.parent_code)) picked.add(row.code);
      }
      mappedCodes = [...picked];
    }
    const names = `or(${terms.map((term) => `name.ilike.*${term}*`).join(',')})`;
    const okved = prefixes.length ? `or(${prefixes.map((code) => `okved_code_exact.like.${code}*`).join(',')}`
      + (mappedCodes.length ? `,and(okved_code_exact.is.null,okved_code.in.(${mappedCodes.join(',')}))` : '') + ')' : null;
    // One top-level .or avoids accidental replacement of the name predicate
    // by a second PostgREST `or` parameter. All remaining filters are ANDed.
    const identity = identityInns.length ? `inn.in.(${identityInns.join(',')})` : null;
    const normalScope = okved ? `and(${names},${okved})` : names;
    const audienceScope = identity ? `or(${identity},${normalScope})` : normalScope;
    // Known public identities cover neutral legal names and inaccurate OKVED,
    // without opening another industry slice. Geography and size still apply.
    // A known official URL is an existing website candidate even when the
    // registry lacks one. It still passes the normal ownership/relevance gate.
    const scope = identity && filters.hasWebsite
      ? `and(${audienceScope},or(website.not.is.null,${identity}))` : audienceScope;
    let query = db.from('companies_directory').select(COLUMNS)
      .or(!identity && !okved ? terms.map((term) => `name.ilike.*${term}*`).join(',') : scope);
    if (filters.regionCodes?.length) query = query.in('region_code', filters.regionCodes);
    if (filters.includeIp === false) query = query.not('name', 'ilike', 'ИП %');
    if (filters.hasEmail) query = query.not('email', 'is', null);
    if (filters.hasWebsite && !identity) query = query.not('website', 'is', null);
    for (const [from, to, column] of [
      ['revenueFrom', 'revenueTo', 'revenue'], ['employeesFrom', 'employeesTo', 'employees_count'],
    ] as const) {
      if (typeof filters[from] === 'number') query = query.gte(column, filters[from]);
      if (typeof filters[to] === 'number') query = query.lte(column, filters[to]);
    }
    const result = await query.order('id', { ascending: true }).range(offset, offset + limit - 1)
      .returns<DirectoryRow[]>().abortSignal(boundedSignal);
    if (result.error) return { rows: [], error: result.error.message };
    const rows = result.data ?? [];
    if (!rows.length) return { rows: [] };
    const codes = [...new Set(rows.map((row) => row.okved_code_exact ?? row.okved_code)
      .filter((code): code is string => typeof code === 'string' && code.length > 0))];
    const namesByCode = new Map<string, string>();
    if (codes.length) {
      const reference = await db.from('okved_reference').select('code,name').in('code', codes).abortSignal(boundedSignal);
      if (reference.error) return { rows: [], error: reference.error.message };
      for (const row of reference.data ?? []) {
        if (typeof row.code === 'string' && typeof row.name === 'string') namesByCode.set(row.code, row.name);
      }
    }
    boundedSignal.throwIfAborted();
    return { rows: rows.map((row) => {
      const code = row.okved_code_exact ?? row.okved_code;
      return { ...row, okved_code_mapped: row.okved_code, okved_code: code,
        okved_name: code === null ? null : namesByCode.get(code) ?? null };
    }) };
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  }
}
