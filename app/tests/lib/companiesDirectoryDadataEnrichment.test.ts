/** @jest-environment node */

import {
  enrichDirectoryRows,
  extractCompanyEnrichment,
  isDadataQuotaError,
} from '@/lib/companiesSearch/dadataEnrichment';

const NOW = new Date('2026-07-19T12:00:00.000Z');

const dadataSuggestion = {
  value: 'ООО "ЧЕРКИЗОВО-СВИНОВОДСТВО"',
  data: {
    inn: '4812042756',
    okved: '01.46.11',
    state: {
      status: 'ACTIVE',
      registration_date: 1409270400000,
    },
  },
};

describe('companiesDirectory DaData enrichment', () => {
  it('extracts the exact main OKVED and registration date without replacing the mapped code', () => {
    expect(extractCompanyEnrichment(dadataSuggestion, NOW)).toEqual({
      okved_code_exact: '01.46.11',
      registration_date: '2014-08-29',
      registry_status: 'ACTIVE',
      okved_exact_source: 'dadata',
      dadata_enrichment_status: 'success',
      dadata_enriched_at: NOW.toISOString(),
    });
  });

  it('skips previously enriched rows and persists one successful update per fresh INN', async () => {
    const findByInn = jest.fn().mockResolvedValue(dadataSuggestion);
    const persist = jest.fn().mockResolvedValue(undefined);

    const result = await enrichDirectoryRows(
      [
        {
          id: 1,
          inn: '1111111111',
          okved_code: '01.4',
          dadata_enriched_at: '2026-07-18T00:00:00.000Z',
        },
        {
          id: 2,
          inn: '4812042756',
          okved_code: '01.4',
          dadata_enriched_at: null,
        },
      ],
      { findByInn, persist, now: () => NOW },
    );

    expect(findByInn).toHaveBeenCalledTimes(1);
    expect(findByInn).toHaveBeenCalledWith('4812042756');
    expect(persist).toHaveBeenCalledWith(2, {
      okved_code_exact: '01.46.11',
      registration_date: '2014-08-29',
      registry_status: 'ACTIVE',
      okved_exact_source: 'dadata',
      dadata_enrichment_status: 'success',
      dadata_enriched_at: NOW.toISOString(),
    });
    expect(result).toMatchObject({
      attempted: 1,
      succeeded: 1,
      skippedAlreadyEnriched: 1,
      stoppedForQuota: false,
    });
  });

  it('marks a missing company as attempted without claiming the mapped OKVED came from DaData', async () => {
    const findByInn = jest.fn().mockResolvedValue(null);
    const persist = jest.fn().mockResolvedValue(undefined);

    const result = await enrichDirectoryRows(
      [{ id: 3, inn: '5032070546', okved_code: '01.4', dadata_enriched_at: null }],
      { findByInn, persist, now: () => NOW },
    );

    expect(persist).toHaveBeenCalledWith(3, {
      okved_code_exact: null,
      registration_date: null,
      registry_status: null,
      okved_exact_source: null,
      dadata_enrichment_status: 'not_found',
      dadata_enriched_at: NOW.toISOString(),
    });
    expect(result).toMatchObject({ attempted: 1, notFound: 1, succeeded: 0 });
  });

  it('does not label an empty/invalid exact OKVED as sourced from DaData', () => {
    expect(
      extractCompanyEnrichment(
        { data: { okved: '', state: { status: 'ACTIVE' } } },
        NOW,
      ),
    ).toMatchObject({
      okved_code_exact: null,
      okved_exact_source: null,
      dadata_enrichment_status: 'success',
    });
  });

  it('stops the batch on quota/auth responses without persisting partial data for that row', async () => {
    const findByInn = jest.fn().mockRejectedValue(new Error('DaData HTTP 403'));
    const persist = jest.fn().mockResolvedValue(undefined);

    const result = await enrichDirectoryRows(
      [
        { id: 1, inn: '4812042756', okved_code: '01.4', dadata_enriched_at: null },
        { id: 2, inn: '5032070546', okved_code: '01.4', dadata_enriched_at: null },
      ],
      { findByInn, persist, now: () => NOW },
    );

    expect(findByInn).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      attempted: 1,
      succeeded: 0,
      failed: 0,
      stoppedForQuota: true,
    });
  });

  it.each([
    new Error('DaData HTTP 403'),
    new Error('DaData HTTP 429'),
    { status: 403 },
    { status: 429 },
  ])('recognizes quota/auth stop errors', (error) => {
    expect(isDadataQuotaError(error)).toBe(true);
  });
});
