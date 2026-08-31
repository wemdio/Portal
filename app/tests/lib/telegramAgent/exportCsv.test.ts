/** @jest-environment node */

jest.mock('@/lib/supabaseAdmin', () => {
  const mockChain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
  };
  return {
    supabaseAdmin: { from: jest.fn(() => ({ ...mockChain })) },
  };
});

import { exportParserResults } from '@/lib/telegramAgent/exportCsv';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const mockFrom = supabaseAdmin!.from as jest.Mock;

function mockJobLookup(table: string) {
  return {
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        maybeSingle: jest.fn().mockResolvedValue({
          data: table === 'parser_jobs' ? { id: 'job-1' } : null,
          error: null,
        }),
      }),
    }),
  };
}

function mockResultsQuery(rows: Record<string, unknown>[]) {
  return {
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        range: jest.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    }),
  };
}

describe('exportParserResults', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exports HH results as CSV buffer', async () => {
    const rows = [
      { vacancy_id: '1', name: 'Dev', url: 'http://hh.ru/1', company_name: 'Co', company_url: 'https://hh.ru/employer/456', employer_id: '456', company_site_url: '', company_description: '', area: 'Moscow', salary_from: 100000, salary_to: 200000, salary_currency: 'RUR', industries: 'IT', published_at: '2026-01-01' },
      { vacancy_id: '2', name: 'QA', url: 'http://hh.ru/2', company_name: 'Co2', company_url: 'https://hh.ru/employer/789', employer_id: null, company_site_url: '', company_description: '', area: 'SPb', salary_from: null, salary_to: null, salary_currency: null, industries: null, published_at: '2026-01-02' },
    ];

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'hh_vacancies') {
        callCount++;
        if (callCount === 1) {
          return mockResultsQuery(rows);
        }
        return mockResultsQuery([]);
      }
      return mockJobLookup(table);
    });

    const result = await exportParserResults('job-1', 'hh');
    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') return;

    expect(result.rowCount).toBe(2);
    expect(result.filename).toContain('hh_vacancies');
    expect(result.filename.endsWith('.csv')).toBe(true);

    const csv = result.buffer.toString('utf-8');
    expect(csv).toContain('vacancy_id');
    expect(csv).toContain('company_url,employer_id,company_site_url');
    const [headerLine, ...dataLines] = csv.replace(/^\uFEFF/, '').split('\r\n');
    const employerIdIndex = headerLine.split(',').indexOf('employer_id');
    expect(employerIdIndex).toBeGreaterThan(-1);
    expect(dataLines[0].split(',')[employerIdIndex]).toBe('456');
    expect(dataLines[1].split(',')[employerIdIndex]).toBe('789');
    expect(csv).toContain('Dev');
    expect(csv).toContain('QA');
  });

  it('returns error string for empty results', async () => {
    mockFrom.mockImplementation(() => mockResultsQuery([]));

    const result = await exportParserResults('job-1', 'hh');
    expect(typeof result).toBe('string');
    expect(result).toContain('нет');
  });

  it('returns error for unknown parser type', async () => {
    const result = await exportParserResults('job-1', 'unknown_type');
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Неизвестный');
  });

  it('auto-resolves parser type when not provided', async () => {
    const rows = [{ vacancy_id: '1', name: 'Dev', url: '', company_name: '', company_url: '', company_site_url: '', company_description: '', area: '', salary_from: null, salary_to: null, salary_currency: null, industries: null, published_at: null }];

    let resultCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'parser_jobs') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'job-1' }, error: null }),
            }),
          }),
        };
      }
      if (table === 'hh_vacancies') {
        resultCallCount++;
        if (resultCallCount === 1) return mockResultsQuery(rows);
        return mockResultsQuery([]);
      }
      return mockResultsQuery([]);
    });

    const result = await exportParserResults('job-1');
    expect(typeof result).not.toBe('string');
    if (typeof result !== 'string') {
      expect(result.filename).toContain('hh_vacancies');
    }
  });

  it('escapes CSV fields with commas and quotes', async () => {
    const rows = [
      { vacancy_id: '1', name: 'Dev, Senior "Lead"', url: '', company_name: 'A\nB', company_url: '', company_site_url: '', company_description: '', area: '', salary_from: null, salary_to: null, salary_currency: null, industries: null, published_at: null },
    ];

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'hh_vacancies') {
        callCount++;
        if (callCount === 1) return mockResultsQuery(rows);
        return mockResultsQuery([]);
      }
      return mockJobLookup(table);
    });

    const result = await exportParserResults('job-1', 'hh');
    if (typeof result === 'string') return;

    const csv = result.buffer.toString('utf-8');
    expect(csv).toContain('"Dev, Senior ""Lead"""');
    expect(csv).toContain('"A\nB"');
  });
});
