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
import type { HhEmployer } from './hhAutoParser';

export interface FetchFromCacheInput {
  /** Сколько активных компаний нужно из кэша. */
  neededCount: number;
  /** Уже виденные домены (HH-результаты + БД seen_employers). */
  seenDomains: Set<string>;
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
    log('BoB cache: supabaseAdmin not initialized — skipping');
    return { employers: [], scanned: 0, dedupSkipped: 0, excludeSkipped: 0, noCompanyDataSkipped: 0 };
  }
  if (input.neededCount <= 0) {
    return { employers: [], scanned: 0, dedupSkipped: 0, excludeSkipped: 0, noCompanyDataSkipped: 0 };
  }

  // Берём с запасом — после dedup и exclude может отсеяться часть.
  // ×3 эмпирически: dedup съест ~20-40% при недельном-месячном использовании.
  const queryLimit = Math.min(input.neededCount * 3, 50_000);

  log(`BoB cache: querying up to ${queryLimit} active domains from cache`);

  const { data, error } = await supabaseAdmin
    .from('mailganer_domain_scores')
    .select('domain, score, company_name, area, employees_count, industries, bob_inn')
    .gt('score', 0)
    .not('company_name', 'is', null)
    .order('scored_at', { ascending: false })
    .limit(queryLimit);

  if (error) {
    log(`BoB cache: query error — ${error.message}`);
    return { employers: [], scanned: 0, dedupSkipped: 0, excludeSkipped: 0, noCompanyDataSkipped: 0 };
  }

  const rows = (data ?? []) as Array<{
    domain: string;
    score: number;
    company_name: string | null;
    area: string | null;
    employees_count: number | null;
    industries: unknown;
    bob_inn: string | null;
  }>;

  const employers: HhEmployer[] = [];
  let dedupSkipped = 0;
  let excludeSkipped = 0;
  let noCompanyDataSkipped = 0;

  for (const row of rows) {
    if (employers.length >= input.neededCount) break;
    if (!row.company_name) {
      noCompanyDataSkipped++;
      continue;
    }
    if (input.seenDomains.has(row.domain)) {
      dedupSkipped++;
      continue;
    }
    if (input.excludePatterns.some((p) => p.test(row.company_name!))) {
      excludeSkipped++;
      continue;
    }

    input.seenDomains.add(row.domain);

    employers.push({
      id: `bob:${row.bob_inn || row.domain}`,
      name: row.company_name,
      siteUrl: `https://${row.domain}`,
      hhUrl: null,
      area: row.area,
      industries: Array.isArray(row.industries)
        ? row.industries.filter((s): s is string => typeof s === 'string')
        : [],
      employeeCount: typeof row.employees_count === 'number' ? row.employees_count : null,
    });
  }

  log(
    `BoB cache: produced ${employers.length}/${input.neededCount} — scanned=${rows.length} dedupSkipped=${dedupSkipped} excludeSkipped=${excludeSkipped} noCompanyDataSkipped=${noCompanyDataSkipped}`,
  );

  return {
    employers,
    scanned: rows.length,
    dedupSkipped,
    excludeSkipped,
    noCompanyDataSkipped,
  };
}
