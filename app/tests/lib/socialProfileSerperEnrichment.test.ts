/** @jest-environment node */

jest.mock('server-only', () => ({}));

jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));

describe('socialProfileSerperEnrichment — unit helpers', () => {
  it('returns empty when supabaseAdmin is null', async () => {
    const { runSocialProfileSerperEnrichment } = await import('@/lib/cisLeads/socialProfileSerperEnrichment');
    const result = await runSocialProfileSerperEnrichment('job-1', 'user-1');
    expect(result).toEqual({ processed: 0, linksFound: 0 });
  });

  it('normalizes company legal forms for search aliases', async () => {
    const { normalizeCompanyNameForSearch, extractCompanyAliases } = await import('@/lib/cisLeads/socialProfileSerperEnrichment');
    const normalized = normalizeCompanyNameForSearch('ООО "КОРПОРАЦИЯ УРАЛТЕХНОСТРОЙ"');
    expect(normalized).toBe('КОРПОРАЦИЯ УРАЛТЕХНОСТРОЙ');

    const aliases = extractCompanyAliases('ООО "КОРПОРАЦИЯ УРАЛТЕХНОСТРОЙ"');
    expect(aliases).toContain('ООО "КОРПОРАЦИЯ УРАЛТЕХНОСТРОЙ"');
    expect(aliases).toContain('КОРПОРАЦИЯ УРАЛТЕХНОСТРОЙ');
  });

  it('builds de-duplicated linkedin queries with /in scope', async () => {
    const { buildLinkedInQueries } = await import('@/lib/cisLeads/socialProfileSerperEnrichment');
    const queries = buildLinkedInQueries(
      'Иванов Иван Иванович',
      'ООО "Ромашка Плюс"',
      'Генеральный директор',
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(8);
    expect(queries.some((q) => q.includes('site:linkedin.com/in'))).toBe(true);
  });

  it('scores relevant linkedin candidate higher than noisy company page', async () => {
    const { computeLinkedInCandidateScore, extractCompanyAliases } = await import('@/lib/cisLeads/socialProfileSerperEnrichment');
    const aliases = extractCompanyAliases('ООО "Ромашка Плюс"');

    const good = computeLinkedInCandidateScore(
      {
        link: 'https://www.linkedin.com/in/ivan-ivanov/',
        title: 'Иван Иванов - Генеральный директор - Ромашка Плюс',
        snippet: 'Генеральный директор в компании Ромашка Плюс',
      },
      'Иван Иванов',
      aliases,
      'Генеральный директор',
    );

    const noisy = computeLinkedInCandidateScore(
      {
        link: 'https://www.linkedin.com/company/romashka-plus/',
        title: 'Romashka Plus: Jobs',
        snippet: 'Company page and vacancies',
      },
      'Иван Иванов',
      aliases,
      'Генеральный директор',
    );

    expect(good).toBeGreaterThanOrEqual(70);
    expect(noisy).toBeLessThan(50);
    expect(good).toBeGreaterThan(noisy);
  });
});
