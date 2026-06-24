/** @jest-environment node */

import { resolveCompanyDomainViaPdl, domainToSiteUrl } from '@/lib/parsers/companyDomainResolver';

type Row = { name: string; website: string | null; country: string | null };

// Mock the pdl_companies query chain: from().select().ilike().limit() -> {data,error}.
// The mock ignores the ilike pattern (returns the given candidate set) so the test
// exercises the JS normalize / country-disambiguation / collision logic.
function mockDb(rows: Row[], error: { message: string } | null = null) {
  let captured = '';
  const db = {
    from: () => ({
      select: () => ({
        ilike: (_col: string, pattern: string) => {
          captured = pattern;
          return { limit: async () => ({ data: error ? null : rows, error }) };
        },
      }),
    }),
    pattern: () => captured,
  };
  return db as any;
}

describe('resolveCompanyDomainViaPdl', () => {
  it('returns the website for a single exact (normalized) name match', async () => {
    const db = mockDb([{ name: 'Datadog', website: 'datadog.com', country: 'united states' }]);
    expect(await resolveCompanyDomainViaPdl('Datadog', 'us', db)).toBe('datadog.com');
  });

  it('normalizes the website (strips protocol/www/path)', async () => {
    const db = mockDb([{ name: 'Datadog', website: 'https://www.Datadog.com/careers', country: 'united states' }]);
    expect(await resolveCompanyDomainViaPdl('Datadog', 'us', db)).toBe('datadog.com');
  });

  it('folds duplicate rows of the SAME company (legal-suffix variants, one website)', async () => {
    const db = mockDb([
      { name: 'Datadog', website: 'datadog.com', country: 'united states' },
      { name: 'Datadog, Inc.', website: 'https://datadog.com', country: 'united states' },
    ]);
    expect(await resolveCompanyDomainViaPdl('Datadog', 'us', db)).toBe('datadog.com');
  });

  it('refuses to guess when one name maps to two DIFFERENT companies (distinct websites)', async () => {
    const db = mockDb([
      { name: 'Paradigm', website: 'paradigm.xyz', country: 'united states' },
      { name: 'Paradigm', website: 'cecredentialtrust.com', country: 'united states' },
    ]);
    expect(await resolveCompanyDomainViaPdl('Paradigm', 'us', db)).toBe('');
  });

  it('disambiguates same-name companies by country', async () => {
    const rows: Row[] = [
      { name: 'Momentum', website: 'momentum.co.za', country: 'south africa' },
      { name: 'Momentum', website: 'momentum.io', country: 'united states' },
    ];
    // no country hint -> two distinct sites -> refuse
    expect(await resolveCompanyDomainViaPdl('Momentum', null, mockDb(rows))).toBe('');
    // US hint picks the US company
    expect(await resolveCompanyDomainViaPdl('Momentum', 'us', mockDb(rows))).toBe('momentum.io');
  });

  it('ignores candidates whose normalized name does not actually match', async () => {
    const db = mockDb([
      { name: 'Datadoghouse Ventures', website: 'datadoghouse.com', country: 'united states' },
      { name: 'Datadog', website: 'datadog.com', country: 'united states' },
    ]);
    expect(await resolveCompanyDomainViaPdl('Datadog', 'us', db)).toBe('datadog.com');
  });

  it('returns empty on a DB error, a missing db, or a blank name', async () => {
    expect(await resolveCompanyDomainViaPdl('Datadog', 'us', mockDb([], { message: 'boom' }))).toBe('');
    expect(await resolveCompanyDomainViaPdl('Datadog', 'us', null)).toBe('');
    expect(await resolveCompanyDomainViaPdl('   ', 'us', mockDb([{ name: 'x', website: 'x.com', country: 'united states' }]))).toBe('');
  });

  it('skips rows with no website', async () => {
    const db = mockDb([{ name: 'Datadog', website: null, country: 'united states' }]);
    expect(await resolveCompanyDomainViaPdl('Datadog', 'us', db)).toBe('');
  });
});

describe('domainToSiteUrl', () => {
  it('builds an https url from a bare domain and returns null for blanks', () => {
    expect(domainToSiteUrl('datadog.com')).toBe('https://datadog.com');
    expect(domainToSiteUrl('https://www.datadog.com')).toBe('https://datadog.com');
    expect(domainToSiteUrl('')).toBeNull();
    expect(domainToSiteUrl(null)).toBeNull();
  });
});
