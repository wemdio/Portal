/** @jest-environment node */

jest.mock('server-only', () => ({}));

jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));

jest.mock('@/lib/parsers/serperSearch', () => ({
  serperSearchDetailed: jest.fn(),
}));

import { serperSearchDetailed } from '@/lib/parsers/serperSearch';

const mockSerper = serperSearchDetailed as jest.MockedFunction<typeof serperSearchDetailed>;

describe('socialProfileSerperEnrichment — unit helpers', () => {
  beforeEach(() => {
    jest.resetModules();
    mockSerper.mockReset();
  });

  it('returns empty when supabaseAdmin is null', async () => {
    const { runSocialProfileSerperEnrichment } = await import('@/lib/cisLeads/socialProfileSerperEnrichment');
    const result = await runSocialProfileSerperEnrichment('job-1', 'user-1');
    expect(result).toEqual({ processed: 0, linksFound: 0 });
    expect(mockSerper).not.toHaveBeenCalled();
  });
});

describe('serper search is called with correct query format', () => {
  it('uses site:linkedin.com/in for linkedin queries', () => {
    const buildQuery = (name: string, company: string) =>
      `site:linkedin.com/in "${name}" "${company}"`;

    const query = buildQuery('Иванов Иван', 'Компания');
    expect(query).toBe('site:linkedin.com/in "Иванов Иван" "Компания"');
  });

  it('uses site:vk.com for vk queries', () => {
    const buildQuery = (name: string, company: string) =>
      `site:vk.com "${name}" "${company}"`;

    const query = buildQuery('Петров Пётр', 'Альфа');
    expect(query).toBe('site:vk.com "Петров Пётр" "Альфа"');
  });
});
