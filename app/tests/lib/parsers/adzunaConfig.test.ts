/** @jest-environment node */

import {
  isExcludedCompany,
  ADZUNA_COUNTRY_CODES,
  ADZUNA_RECENCY_OPTIONS,
} from '@/lib/parsers/adzunaConfig';

describe('adzunaConfig — staffing/agency filter', () => {
  it('excludes staffing & recruiting agencies', () => {
    for (const name of [
      'Robert Half',
      'Randstad',
      'Aston Carter',
      'TEKsystems',
      'Insight Global',
      'W3Global Inc.',
      'Acme Staffing',
      'Global Recruiting LLC',
      'Bright Talent Solutions',
    ]) {
      expect(isExcludedCompany(name)).toBe(true);
    }
  });

  it('keeps real hiring companies', () => {
    for (const name of ['Postman', 'Stripe', 'Cargill', 'ThermoFisher Scientific', 'Amazon', 'Notion']) {
      expect(isExcludedCompany(name)).toBe(false);
    }
  });

  it('exposes country and recency config', () => {
    expect(ADZUNA_COUNTRY_CODES).toContain('us');
    expect(ADZUNA_COUNTRY_CODES).toContain('gb');
    expect(ADZUNA_RECENCY_OPTIONS.length).toBeGreaterThan(0);
  });
});
