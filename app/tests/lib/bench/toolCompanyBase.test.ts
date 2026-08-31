/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { companyBaseTool, escapeLike } from '@/lib/bench/tools/companyBase';
import type { SupabaseClient } from '@supabase/supabase-js';

function db(rows: Array<Record<string, unknown>>): SupabaseClient {
  return createMockSupabase({
    // Без флага мок игнорирует .order/.limit, и постраничность проверялась бы
    // вхолостую — совпадением числа отфильтрованных строк с размером страницы.
    enforceQueryWindows: true,
    tables: { pdl_companies: rows },
  }) as unknown as SupabaseClient;
}

const ROWS = [
  { id: 'c1', name: 'Alpha', country: 'russia', industry: 'software', size: '11-50' },
  { id: 'c2', name: 'Beta', country: 'russia', industry: 'software', size: '51-200' },
  { id: 'c3', name: 'Gamma', country: 'germany', industry: 'retail', size: '11-50' },
];

describe('адаптер company-base', () => {
  it('принимает фильтры портала', () => {
    const parsed = companyBaseTool.filtersSchema.safeParse({
      country: ['russia'],
      industry: ['software'],
      size: ['11-50'],
      name: 'Alp',
    });
    expect(parsed.success).toBe(true);
  });

  it('не пропускает лишние фильтры', () => {
    expect(companyBaseTool.filtersSchema.safeParse({ drop_table: 'x' }).success).toBe(false);
  });

  it('отдаёт страницу и курсор последней строки', async () => {
    const page = await companyBaseTool.run({
      db: db(ROWS),
      filters: { country: ['russia'] },
      limit: 2,
      cursor: null,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.cursor).toBe('c2');
    expect(page.has_more).toBe(true);
  });

  it('на последней странице курсор пуст и has_more ложно', async () => {
    const page = await companyBaseTool.run({
      db: db(ROWS),
      filters: {},
      limit: 10,
      cursor: null,
    });
    expect(page.has_more).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it('курсор продолжает выдачу с нужного места', async () => {
    const page = await companyBaseTool.run({
      db: db(ROWS),
      filters: {},
      limit: 10,
      cursor: 'c2',
    });
    expect(page.rows.map((r) => (r as { id: string }).id)).toEqual(['c3']);
  });

  it('экранирует подстановочные знаки в поиске по имени', () => {
    // Без вырезания запрос name='%' означал бы «отдать все 13 млн строк».
    expect(escapeLike('100%_рост')).toBe('100рост');
  });
});
