import { buildAboutCandidates } from '@/lib/enrich/aboutCandidates';

describe('buildAboutCandidates', () => {
  it('keeps discovered links first, deduplicates and limits count', () => {
    const discoveredLinks = Array.from({ length: 20 }, (_, idx) => `https://example.com/about-${idx}`);
    const staticCandidates = [
      'https://example.com/about',
      ...Array.from({ length: 20 }, (_, idx) => `https://example.com/static-${idx}`),
    ];

    const result = buildAboutCandidates({
      mainUrl: 'https://example.com',
      discoveredLinks,
      staticCandidates,
      maxCandidates: 8,
    });

    expect(result).toHaveLength(8);
    expect(result[0]).toBe('https://example.com/about-0');
    expect(result).not.toContain('https://example.com');
    expect(new Set(result).size).toBe(result.length);
  });
});
