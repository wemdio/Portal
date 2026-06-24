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
    expect(re.test('AE, Mid-Market')).toBe(true);
    expect(re.test('Commercial Account Director')).toBe(true);
    expect(re.test('Revenue Development Representative')).toBe(true);
    expect(re.test('Client Partner, Enterprise')).toBe(true);
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

  it('matches full state, province, country-code, and Workday-style locations across supported markets', () => {
    expect(buildCountryRegex(['us'])!.test('Los Angeles, California')).toBe(true);
    expect(buildCountryRegex(['us'])!.test('US-Remote')).toBe(true);
    expect(buildCountryRegex(['ca'])!.test('Vancouver, British Columbia')).toBe(true);
    expect(buildCountryRegex(['ca'])!.test('CA-Ontario-Toronto')).toBe(true);
    expect(buildCountryRegex(['gb'])!.test('UK-London Office')).toBe(true);
    expect(buildCountryRegex(['de'])!.test('DE-Berlin')).toBe(true);
    expect(buildCountryRegex(['fr'])!.test('FR-Paris')).toBe(true);
    expect(buildCountryRegex(['nl'])!.test('NL-Amsterdam')).toBe(true);
    expect(buildCountryRegex(['ie'])!.test('IE-Dublin')).toBe(true);
    expect(buildCountryRegex(['es'])!.test('ES-Madrid')).toBe(true);
    expect(buildCountryRegex(['au'])!.test('Sydney, New South Wales')).toBe(true);
    expect(buildCountryRegex(['sg'])!.test('SG-Singapore')).toBe(true);
  });

  it('recovers bare major-city US locations that omit the state or country', () => {
    const re = buildCountryRegex(['us'])!;
    expect(re.test('San Francisco')).toBe(true);
    expect(re.test('Seattle')).toBe(true);
    expect(re.test('Austin')).toBe(true);
    expect(re.test('Denver')).toBe(true);
    expect(re.test('Atlanta')).toBe(true);
    expect(re.test('Brooklyn')).toBe(true);
    expect(re.test('Chicago, IL')).toBe(true); // still works with a state
  });

  it('does NOT assign internationally-ambiguous city names to the US (precision over recall)', () => {
    const us = buildCountryRegex(['us'])!;
    expect(us.test('London')).toBe(false);
    expect(us.test('Birmingham')).toBe(false);
    expect(us.test('Manchester')).toBe(false);
    expect(us.test('Cambridge')).toBe(false);
    // cities with well-known foreign namesakes must NOT resolve to the US bare
    expect(us.test('Boston')).toBe(false); // Boston, Lincolnshire UK
    expect(us.test('Portland')).toBe(false); // Portland, Victoria AU / Dorset UK
    expect(us.test('San Jose')).toBe(false); // San José, Costa Rica
    expect(us.test('Phoenix')).toBe(false); // Phoenix, Mauritius
    expect(us.test('Durham')).toBe(false); // Durham, England
    expect(us.test('Columbus')).toBe(false);
    // a real US state qualifier must still win for all of them
    expect(us.test('Birmingham, AL')).toBe(true);
    expect(us.test('Cambridge, MA')).toBe(true);
    expect(us.test('Boston, MA')).toBe(true);
    expect(us.test('Portland, OR')).toBe(true);
    expect(us.test('Phoenix, AZ')).toBe(true);
  });

  it('recovers space/dash-separated "City ST" US locations (Lever stores location verbatim)', () => {
    const us = buildCountryRegex(['us'])!;
    expect(us.test('Boulder CO')).toBe(true);
    expect(us.test('Plano TX')).toBe(true);
    expect(us.test('Bloomington IN')).toBe(true);
    expect(us.test('Reston VA')).toBe(true);
    expect(us.test('Austin, TX')).toBe(true); // comma form still works
    // bounded: non-US region codes are not US state codes
    expect(us.test('Toronto ON')).toBe(false);
    expect(us.test('Cork IE')).toBe(false);
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
