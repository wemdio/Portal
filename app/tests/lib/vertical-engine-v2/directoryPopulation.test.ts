/** @jest-environment node */

/**
 * Размер реестровой части плана тем же условием, что и выборка.
 *
 * SQL проверен на проде только чтением (тело функции как SELECT, 23.09.2026):
 * 68.3 с порогами — 69 компаний, 10.1 с порогами — 954, 86.2 — 27 848 строк
 * (26 337 компаний), 86.2 вместе с 86 — 52 992, а не 79 329. Прежний счётчик
 * по приблизительному ОКВЭД давал 0 для 68.3 и 86.2.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getVeDirectoryPlanPopulation, veDirectoryPopulationSlice } from '@/lib/verticalEngineV2/directoryPopulation';
import { veSecondQueueTask } from '@/lib/verticalEngineV2/planWidening';

const migration = fs.readFileSync(path.resolve(process.cwd(), '..', 'supabase', 'migrations',
  '20260923_0002_ve_directory_plan_population.sql'), 'utf8');
const fetchRpc = fs.readFileSync(path.resolve(process.cwd(), '..', 'supabase', 'migrations',
  '20260719_0001_companies_directory_exact_okved.sql'), 'utf8');

// Реальный срез базы 3cfcfbbd: оценка 0 компаний, выборка 69.
const REALTY = { source: 'companies_directory' as const, rationale: 'Агентства недвижимости',
  directory_filters: { hasEmail: false, includeIp: false, okvedCodes: ['68.3'], revenueTo: 300_000_000, employeesFrom: 3, employeesTo: 50 } };

describe('directory population slice', () => {
  it('passes the same thresholds, OKVED prefixes and IP rule the fetcher uses', () => {
    expect(veDirectoryPopulationSlice(REALTY)).toEqual({
      okved_prefixes: ['68.3'], region_codes: null, include_ip: false, has_email: false,
      revenue_to: 300_000_000, employees_from: 3, employees_to: 50,
    });
    // Предок и потомок схлопываются, буквенная секция раскрывается в классы — как в rpcSearch.
    expect(veDirectoryPopulationSlice({ ...REALTY, directory_filters: { okvedCodes: ['86', '86.2', 'A'], regionCodes: ['77'] } }))
      .toMatchObject({ okved_prefixes: ['86', '01', '02', '03'], region_codes: ['77'], include_ip: false });
    expect(veDirectoryPopulationSlice({ source: 'yandex_maps', rationale: 'Карты', maps_query: { queries: ['Риелторы'] } })).toBeNull();
  });

  it('counts the second queue as the fetcher keeps it: relaxed bound or an empty field', () => {
    const second = veSecondQueueTask(REALTY, true)!;
    expect(veDirectoryPopulationSlice(second)).toEqual({
      okved_prefixes: ['68.3'], region_codes: null, include_ip: false, has_email: false,
      keep_revenue_to: 600_000_000, keep_employees_to: 100,
    });
  });

  it('asks the database once for the union of all slices and passes other bases as exclusions', async () => {
    const db = createMockSupabase({ tables: {}, rpcHandlers: { ve_directory_plan_population: () => ({ data: {
      directory_rows_total: 60_429, companies_unique_total: 52_992, companies_available: 52_990,
      companies_with_email: 44_604, companies_with_phone: 39_192, slice_companies: [26_337, 52_992] } }) } });
    const slices = [{ okved_prefixes: ['86.2'], region_codes: null, include_ip: false, has_email: false },
      { okved_prefixes: ['86'], region_codes: null, include_ip: false, has_email: false }];
    const population = await getVeDirectoryPlanPopulation(db as unknown as SupabaseClient, slices, ['7700000001', '7700000001', '7700000002']);
    expect(db.rpcCalls).toEqual([{ fn: 've_directory_plan_population',
      params: { p_slices: slices, p_exclude_inns: ['7700000001', '7700000002'] } }]);
    expect(population).toMatchObject({ companies_unique_total: 52_992, companies_available: 52_990, slice_companies: [26_337, 52_992] });
    expect(population.error).toBeUndefined();
    const broken = createMockSupabase({ tables: {}, rpcHandlers: { ve_directory_plan_population: () => ({ data: {
      companies_unique_total: 10, companies_available: 11 } }) } });
    expect((await getVeDirectoryPlanPopulation(broken as unknown as SupabaseClient, slices)).error).toBeTruthy();
  });
});

describe('ve_directory_plan_population migration', () => {
  const body = migration.split('as $$')[1].split('$$;')[0];

  it('filters OKVED exactly like companies_directory_fetch_rpc: exact code first, mapped code only as fallback', () => {
    const squash = (sql: string) => sql.replace(/\s+/g, ' ');
    for (const clause of [
      "c.okved_code_exact is not null and ( (sl.okved_codes is not null and c.okved_code_exact = any(sl.okved_codes))",
      "where px ~ '^[0-9]{2}([.][0-9]{1,2}){0,2}$' and starts_with(c.okved_code_exact, px)",
      'c.okved_code_exact is null and sl.okved_codes is not null and c.okved_code = any(sl.okved_codes)',
    ]) expect(squash(body)).toContain(clause);
    // Те же проверки есть в самой выборке.
    expect(squash(fetchRpc)).toContain("where px ~ '^[0-9]{2}([.][0-9]{1,2}){0,2}$' and starts_with(c.okved_code_exact, px)");
    expect(body).toContain("(sl.include_ip or c.name not ilike 'ИП %')");
    expect(body).toContain('(not sl.has_email or c.email is not null)');
    expect(body).toContain('c.employees_count is null or c.employees_count >= sl.keep_employees_from');
  });

  it('counts a company once across overlapping slices and never touches data', () => {
    // Одна компания — один ключ (ИНН, без ИНН — строка), сколько бы срезов её ни содержало.
    expect(body).toContain("coalesce(nullif(btrim(c.inn), ''), 'row:' || c.id::text) as company_key");
    expect(body).toMatch(/companies as \(\s+select\s+company_key,[\s\S]+from matched\s+group by company_key/);
    expect(body).toContain("'companies_unique_total', (select count(*) from companies)");
    // Подзапрос кодов не должен пересчитываться на каждой из 2,4 млн строк.
    expect(body).toContain('slice_codes as materialized');
    expect(migration).toContain('stable');
    expect(migration).toContain("set statement_timeout = '180s'");
    expect(migration).not.toMatch(/\b(insert|update|delete|alter table|create index)\b/i);
    expect(migration).toContain('grant execute on function public.ve_directory_plan_population(jsonb, text[]) to service_role');
  });
});
