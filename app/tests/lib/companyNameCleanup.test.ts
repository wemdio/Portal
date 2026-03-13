import { buildHeuristicCleanupResults, cleanCompanyNameHeuristic } from '@/lib/companyNameCleanup';

describe('companyNameCleanup', () => {
  it('handles prompt examples without AI', () => {
    expect(cleanCompanyNameHeuristic('CGT Staffing (CompuGroup Technologies)')).toBe('CGT Staffing');
    expect(cleanCompanyNameHeuristic('Albano Systems, Inc.')).toBe('Albano Systems');
    expect(cleanCompanyNameHeuristic('Alliance of Professionals & Consultants, Inc. (APC)')).toBe('APC');
    expect(cleanCompanyNameHeuristic('BIO-key International, Inc.', 'http://www.bio-key.com')).toBe('BIO-key');
    expect(cleanCompanyNameHeuristic('QuesTek Innovations LLC', 'http://www.questek.com')).toBe('QuesTek');
    expect(cleanCompanyNameHeuristic('IBEX IT Business Experts', 'http://www.ibexexperts.com')).toBe('IBEX Experts');
  });

  it('keeps readable short names intact', () => {
    expect(cleanCompanyNameHeuristic('Bank of America')).toBe('Bank of America');
    expect(cleanCompanyNameHeuristic('The Honest Company')).toBe('The Honest Company');
  });

  it('normalizes all-uppercase names to readable casing', () => {
    expect(cleanCompanyNameHeuristic('ALBANO SYSTEMS, INC.')).toBe('Albano Systems');
    expect(cleanCompanyNameHeuristic('IBM GLOBAL SERVICES')).toBe('IBM Global Services');
  });

  it('builds fallback results for batches', () => {
    expect(buildHeuristicCleanupResults([
      { idx: 4, name: 'Albano Systems, Inc.' },
      { idx: 7, name: 'QuesTek Innovations LLC', domain: 'questek.com' },
    ])).toEqual([
      { idx: 4, cleanedName: 'Albano Systems' },
      { idx: 7, cleanedName: 'QuesTek' },
    ]);
  });
});
