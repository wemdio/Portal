/** @jest-environment node */

import {
  buildRolesRegex,
  buildCountryRegex,
  ATS_COUNTRIES,
  ATS_COUNTRY_CODES,
} from '@/lib/parsers/atsFilters';

describe('atsFilters — role keywords', () => {
  it('matches comma-separated keywords against job titles', () => {
    const re = buildRolesRegex('head of growth, demand gen');
    expect(re.test('Head of Growth')).toBe(true);
    expect(re.test('Demand Gen Manager')).toBe(true);
    expect(re.test('Backend Engineer')).toBe(false);
  });

  it('escapes regex-special characters in keywords', () => {
    const re = buildRolesRegex('c++ developer');
    expect(re.test('C++ Developer')).toBe(true);
  });

  it('expands b2b searches into common sales titles without matching generic managers', () => {
    const re = buildRolesRegex('b2b manager');
    expect(re.test('Enterprise Account Executive')).toBe(true);
    expect(re.test('Business Development Manager')).toBe(true);
    expect(re.test('Sales Manager')).toBe(true);
    expect(re.test('Engineering Manager')).toBe(false);
  });

  it('empty input matches anything (no role filter)', () => {
    expect(buildRolesRegex('').test('Anything')).toBe(true);
    expect(buildRolesRegex('   ').test('Whatever')).toBe(true);
  });
});

describe('atsFilters — countries', () => {
  it('returns null when no countries are selected', () => {
    expect(buildCountryRegex([])).toBeNull();
    expect(buildCountryRegex(undefined)).toBeNull();
    expect(buildCountryRegex(['xx'])).toBeNull(); // unknown code
  });

  it('matches location text for the selected countries', () => {
    const re = buildCountryRegex(['us', 'gb']);
    expect(re).not.toBeNull();
    expect(re!.test('California, USA (Remote)')).toBe(true);
    expect(re!.test('London, United Kingdom')).toBe(true);
    expect(re!.test('Berlin, Germany')).toBe(false);
  });

  it('matches the common "City, ST" US format (state codes)', () => {
    const re = buildCountryRegex(['us'])!;
    expect(re.test('New York, NY')).toBe(true);
    expect(re.test('San Francisco, CA')).toBe(true);
    expect(re.test('Austin, TX')).toBe(true);
    // Canadian province codes are not US states
    expect(re.test('Toronto, ON')).toBe(false);
    expect(re.test('Berlin, Germany')).toBe(false);
  });

  it('remote matches remote postings', () => {
    const re = buildCountryRegex(['remote']);
    expect(re!.test('Remote — North America')).toBe(true);
  });

  it('exposes the country code list', () => {
    expect(ATS_COUNTRY_CODES).toContain('us');
    expect(ATS_COUNTRIES.length).toBeGreaterThan(0);
  });
});
