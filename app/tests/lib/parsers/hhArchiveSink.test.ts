/** @jest-environment node */

jest.mock('server-only', () => ({}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

import { buildHhArchiveSinkCallback } from '@/lib/parsers/hhArchiveSink';

describe('hh archive sink employer_id', () => {
  it('persists employer_id alongside company_url for each vacancy row', async () => {
    mockDb = createMockSupabase({ tables: { hh_vacancies: [] } });
    const callback = buildHhArchiveSinkCallback('sink-job-1');
    expect(callback).toBeDefined();

    await callback!([
      {
        vacancy_id: '123',
        name: 'PR-менеджер',
        url: 'https://hh.ru/vacancy/123',
        salary_from: null,
        salary_to: null,
        salary_currency: null,
        company_name: 'ООО Ромашка',
        company_url: 'https://hh.ru/employer/456',
        employer_id: '456',
        area: 'Москва',
        published_at: null,
      },
    ]);

    const upserts = mockDb.upserts.filter((u) => u.table === 'hh_vacancies');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].rows[0]).toMatchObject({
      job_id: 'sink-job-1',
      vacancy_id: '123',
      employer_id: '456',
      company_url: 'https://hh.ru/employer/456',
    });
  });
});
