/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

import { fetchVacanciesLocal } from '@/lib/parsers/hhArchive/localSearch';

describe('fetchVacanciesLocal employer_id', () => {
  it('selects and returns the stored HH employer ID', async () => {
    mockDb = createMockSupabase({
      tables: {
        hh_vacancies: [{
          vacancy_id: '123',
          name: 'Developer',
          url: 'https://hh.ru/vacancy/123',
          company_name: 'Company',
          company_url: 'https://hh.ru/employer/456',
          employer_id: '456',
          company_site_url: 'https://example.com',
          area: 'Moscow',
          published_at: '2026-08-01T00:00:00Z',
        }],
      },
    });

    const rows = await fetchVacanciesLocal({ query: '', areaIds: [] }, 1);

    expect(mockDb.selects[0]).toMatchObject({ table: 'hh_vacancies' });
    expect(mockDb.selects[0].columns).toContain('employer_id');
    expect(rows[0].employer_id).toBe('456');
  });
});
