/** @jest-environment node */

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

import { exportPipelineResults } from '@/lib/telegramAgent/pipelineExport';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const mockFrom = supabaseAdmin!.from as jest.Mock;

describe('exportPipelineResults HH employer_id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exports employer_id and falls back to the HH employer URL', async () => {
    let selectedColumns = '';
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'hh_vacancies') throw new Error(`Unexpected table: ${table}`);
      return {
        select: jest.fn((columns: string) => {
          selectedColumns = columns;
          return {
            eq: jest.fn().mockResolvedValue({
              data: [{
                company_name: 'Co',
                employer_id: null,
                company_url: 'https://hh.ru/employer/789',
                company_site_url: 'https://example.com',
                name: 'Dev',
                url: 'https://hh.ru/vacancy/1',
                area: 'Moscow',
                salary_from: null,
                salary_to: null,
                salary_currency: null,
                published_at: '2026-01-01',
              }],
              error: null,
            }),
          };
        }),
      };
    });

    const result = await exportPipelineResults({
      id: 'pipeline-1',
      user_id: 'user-1',
      chat_id: 1,
      name: 'HH export',
      status: 'completed',
      current_step_index: 1,
      steps: [{ type: 'parse_hh', config: {}, status: 'completed', job_id: 'job-1' }],
      context: {},
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });

    expect(selectedColumns).toContain('employer_id');
    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') return;

    const csv = result.buffer.toString('utf-8');
    expect(csv).toContain('company_name,employer_id,company_site_url');
    expect(csv).toContain('789');
  });
});
