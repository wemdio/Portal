/**
 * BoB-добор из mailganer_domain_scores кэша.
 *
 * Iter 3 архитектуры: background BoB scorer постоянно наполняет кэш
 * (Iter 2). А orchestrator при cron-прогоне берёт **готовые активные
 * домены** из этого кэша вместо случайной выборки из BoB.
 *
 * Профит:
 *   1. Никаких Mailganer-вызовов в cron'е для BoB-части (всё уже scored)
 *   2. Только domains со score>0 (не тратим время на склад score=0)
 *   3. Cron укладывается в 10-15 минут вместо 2.5h
 *
 * Если кэш пустой / мало активных — orchestrator может fall back на
 * прямой BoB через fetchTopUpFromBaseOfBases (старая логика).
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getClientExcludedDomainSuffixes, isClientDomainExcluded } from '@/lib/clientBlocklist/domainPolicy';
import { deriveDomain, type HhEmployer } from './hhAutoParser';

const PAGE_SIZE = 500;
const MAX_SCANNED = 50_000;

type CacheRow = {
  domain: string;
  scored_at: string;
  score: number;
  company_name: string | null;
  area: string | null;
  employees_count: number | null;
  industries: unknown;
  bob_inn: string | null;
};
type CacheCursor = { scoredAt: string; domain: string };

function matchesCursor(cursor: CacheCursor | null, row: CacheRow): boolean {
  return cursor !== null && cursor.domain === row.domain && cursor.scoredAt === row.scored_at;
}

export interface FetchFromCacheInput {
  clientUserId: string;
  /** Сколько активных компаний нужно из кэша. */
  neededCount: number;
  /** Уже виденные домены (HH-результаты + БД seen_employers). */
  seenDomains: Set<string>;
  /** Historical employer identities, including alternative domains for the same BoB INN. */
  seenEmployerIds?: Set<string>;
  /** Only this run's fresh HH domains; historical exclusions are selected inside the RPC. */
  currentRunDomains?: string[];
  /** Regex-паттерны имени для exclude. */
  excludePatterns: RegExp[];
  log?: (msg: string) => void;
}

export interface FetchFromCacheResult {
  employers: HhEmployer[];
  scanned: number;
  dedupSkipped: number;
  excludeSkipped: number;
  noCompanyDataSkipped: number;
}

/**
 * Берёт N активных доменов (score > 0) из кэша и формирует HhEmployer'ы.
 * Каждая строка кэша из background scorer'а уже содержит company_name, area,
 * industries — формируем employer'а на лету.
 */
export async function fetchTopUpFromCache(
  input: FetchFromCacheInput,
): Promise<FetchFromCacheResult> {
  const log = input.log ?? (() => undefined);
  if (!supabaseAdmin) {
    throw new Error('BoB cache: supabaseAdmin not initialized');
  }
  if (input.neededCount <= 0) {
    return { employers: [], scanned: 0, dedupSkipped: 0, excludeSkipped: 0, noCompanyDataSkipped: 0 };
  }

  const employers: HhEmployer[] = [];
  const employerIds = new Set(input.seenEmployerIds);
  let scanned = 0;
  let dedupSkipped = 0;
  let excludeSkipped = 0;
  let noCompanyDataSkipped = 0;
  let cursor: CacheCursor | null = null;
  let exhausted = false;

  log(`BoB cache: paging active domains — maxScanned=${MAX_SCANNED}`);

  while (employers.length < input.neededCount && scanned < MAX_SCANNED) {
    // History must be filtered in SQL BEFORE LIMIT. Paging the newest seen
    // prefix locally would permanently hide older reserve behind MAX_SCANNED.
    const pageSize = Math.min(PAGE_SIZE, MAX_SCANNED - scanned);
    const { data, error } = await supabaseAdmin.rpc('mailganer_cache_topup_candidates', {
      p_client_user_id: input.clientUserId,
      p_page_size: pageSize,
      p_after_scored_at: cursor?.scoredAt ?? null,
      p_after_domain: cursor?.domain ?? null,
      p_excluded_suffixes: [...getClientExcludedDomainSuffixes(input.clientUserId)],
      p_excluded_domains: input.currentRunDomains ?? [],
    });
    // Never return an empty/partial success on a DB failure: that would permit
    // the live fallback to replace a failed cache read with additional work.
    if (error) throw new Error(`BoB cache query failed: ${error.message}`);
    if (!data || typeof data !== 'object' || !Array.isArray(data.rows) ||
        typeof data.has_more !== 'boolean' || data.rows.length > pageSize) {
      throw new Error('BoB cache returned an invalid page');
    }
    const rows = data.rows as CacheRow[];
    exhausted = !data.has_more;
    if (rows.length === 0) {
      if (!exhausted) throw new Error('BoB cache returned an invalid empty cursor page');
      break;
    }
    const last = rows[rows.length - 1];
    if (!last?.domain || !last.scored_at || matchesCursor(cursor, last)) {
      throw new Error('BoB cache cursor did not advance');
    }
    cursor = { scoredAt: last.scored_at, domain: last.domain };
    scanned += rows.length;

    for (const row of rows) {
      if (employers.length >= input.neededCount) break;
      const domain = deriveDomain(row.domain);
      if (!domain || isClientDomainExcluded(input.clientUserId, domain)) {
        excludeSkipped++;
        continue;
      }
      if (!row.company_name) {
        noCompanyDataSkipped++;
        continue;
      }
      const employerId = `bob:${row.bob_inn || domain}`;
      if (input.seenDomains.has(domain) || employerIds.has(employerId)) {
        dedupSkipped++;
        continue;
      }
      if (input.excludePatterns.some((p) => p.test(row.company_name!))) {
        excludeSkipped++;
        continue;
      }

      input.seenDomains.add(domain);
      employerIds.add(employerId);

      employers.push({
        id: employerId,
        name: row.company_name,
        siteUrl: `https://${domain}`,
        hhUrl: null,
        area: row.area,
        industries: Array.isArray(row.industries)
          ? row.industries.filter((s): s is string => typeof s === 'string')
          : [],
        employeeCount: typeof row.employees_count === 'number' ? row.employees_count : null,
      });
    }
    if (exhausted) break;
  }

  const stopReason = employers.length >= input.neededCount ? 'target_met'
    : exhausted ? 'source_exhausted' : 'scan_budget_reached';
  log(
    `BoB cache: produced ${employers.length}/${input.neededCount} — scanned=${scanned} dedupSkipped=${dedupSkipped} excludeSkipped=${excludeSkipped} noCompanyDataSkipped=${noCompanyDataSkipped} stopReason=${stopReason}`,
  );

  return {
    employers,
    scanned,
    dedupSkipped,
    excludeSkipped,
    noCompanyDataSkipped,
  };
}
