/** @jest-environment node */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FnsExactPlanStore,
  iterateFnsExactKeysetPages,
  type FnsExactRegistryStoreRow,
} from '@/lib/companiesDirectory/fnsExactPlanStore';
import type {
  ExistingDirectoryExactOkvedRow,
} from '@/lib/companiesDirectory/fnsExactPlan';

const LEGAL_INN_A = '7704414297';
const LEGAL_INN_B = '7729058675';
const IP_INN = '212401514249';
const LEGAL_OGRN_A = '1177746494166';
const LEGAL_OGRN_B = '1177746494177';
const IP_OGRN_A = '322890100023953';
const IP_OGRN_B = '315890400001930';

function existing(
  overrides: Partial<ExistingDirectoryExactOkvedRow> = {},
): ExistingDirectoryExactOkvedRow {
  return {
    id: '10',
    inn: LEGAL_INN_A,
    ogrn: LEGAL_OGRN_A,
    okved_code_exact: null,
    okved_exact_source: null,
    ...overrides,
  };
}

function registry(
  overrides: Partial<FnsExactRegistryStoreRow> = {},
): FnsExactRegistryStoreRow {
  return {
    inn: LEGAL_INN_A,
    ogrn: LEGAL_OGRN_A,
    okved_code_exact: '62.01',
    okved_version: '2014',
    ...overrides,
  };
}

describe('FNS exact OKVED disk-backed OGRN-first plan store', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fns-exact-store-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function createStore(): FnsExactPlanStore {
    return new FnsExactPlanStore(join(directory, 'plan.sqlite'));
  }

  it('matches by exact OGRN+INN and falls back only for one registry identity', () => {
    const store = createStore();
    try {
      store.beginSnapshot();
      store.addExisting(existing({ id: '10' }));
      store.addExisting(existing({
        id: '11',
        inn: IP_INN,
        ogrn: null,
      }));
      store.addExisting(existing({
        id: '12',
        inn: LEGAL_INN_B,
        ogrn: LEGAL_OGRN_B,
        okved_code_exact: '62.09',
        okved_exact_source: 'fns_sme_registry',
      }));
      store.addExisting(existing({
        id: '13',
        okved_code_exact: '62.02.2',
        okved_exact_source: 'dadata',
      }));
      store.commitSnapshot();

      store.beginRegistry();
      store.addRegistry(registry());
      store.addRegistry(registry({
        inn: IP_INN,
        ogrn: IP_OGRN_A,
        okved_code_exact: '01.46.1',
      }));
      store.addRegistry(registry({
        inn: LEGAL_INN_B,
        ogrn: LEGAL_OGRN_B,
        okved_code_exact: '62.09',
      }));
      store.commitRegistry();

      expect([...store.iterateUpdates()]).toEqual([
        {
          id: '10',
          inn: LEGAL_INN_A,
          expected_ogrn: LEGAL_OGRN_A,
          fns_ogrn: LEGAL_OGRN_A,
          match_method: 'ogrn_inn',
          okved_code_exact: '62.01',
          okved_exact_source: 'fns_sme_registry',
        },
        {
          id: '11',
          inn: IP_INN,
          expected_ogrn: null,
          fns_ogrn: IP_OGRN_A,
          match_method: 'unique_inn_fallback',
          okved_code_exact: '01.46.1',
          okved_exact_source: 'fns_sme_registry',
        },
      ]);
      expect([...store.iterateNoops()]).toEqual([
        {
          id: '12',
          inn: LEGAL_INN_B,
          expected_ogrn: LEGAL_OGRN_B,
          fns_ogrn: LEGAL_OGRN_B,
          match_method: 'ogrn_inn',
          reason: 'already_exact',
        },
      ]);
      expect([...store.iterateConflicts()]).toEqual([
        expect.objectContaining({
          id: '13',
          inn: LEGAL_INN_A,
          expected_ogrn: LEGAL_OGRN_A,
          fns_ogrn: LEGAL_OGRN_A,
          match_method: 'ogrn_inn',
          kind: 'existing_exact_preserved',
          incoming_okved_code_exact: '62.01',
        }),
      ]);
      expect(store.metrics()).toMatchObject({
        registry_rows: 3,
        unique_registry_ogrns: 3,
        unique_registry_inns: 3,
        matched_directory_rows: 4,
        matched_by_ogrn_rows: 3,
        matched_by_unique_inn_rows: 1,
        updates: 2,
        noops: 1,
        conflicts: 1,
        skipped: 0,
        inserts: 0,
      });
      expect(store.checkIdempotency()).toEqual({
        firstPassUpdates: 2,
        repeatedUpdates: 0,
        passed: true,
      });
    } finally {
      store.close();
    }
  });

  it('keeps multiple registrations for one INN separate and quarantines only an ambiguous fallback', () => {
    const store = createStore();
    try {
      store.beginSnapshot();
      store.addExisting(existing({
        id: '20',
        inn: IP_INN,
        ogrn: IP_OGRN_A,
      }));
      store.addExisting(existing({
        id: '21',
        inn: IP_INN,
        ogrn: IP_OGRN_B,
      }));
      store.addExisting(existing({
        id: '22',
        inn: IP_INN,
        ogrn: null,
      }));
      store.commitSnapshot();

      store.beginRegistry();
      expect(store.addRegistry(registry({
        inn: IP_INN,
        ogrn: IP_OGRN_A,
        okved_code_exact: '01.46.1',
      }))).toBe('added');
      expect(store.addRegistry(registry({
        inn: IP_INN,
        ogrn: IP_OGRN_B,
        okved_code_exact: '01.46',
      }))).toBe('added');
      store.commitRegistry();

      expect([...store.iterateUpdates()]).toEqual([
        expect.objectContaining({
          id: '20',
          fns_ogrn: IP_OGRN_A,
          okved_code_exact: '01.46.1',
          match_method: 'ogrn_inn',
        }),
        expect.objectContaining({
          id: '21',
          fns_ogrn: IP_OGRN_B,
          okved_code_exact: '01.46',
          match_method: 'ogrn_inn',
        }),
      ]);
      expect([...store.iterateSkipped()]).toEqual([
        {
          id: '22',
          inn: IP_INN,
          expected_ogrn: null,
          reason: 'ambiguous_inn_multiple_ogrn',
        },
      ]);
      expect(store.metrics()).toMatchObject({
        registry_multi_registration_inns: 1,
        ambiguous_inn_quarantined: 1,
        updates: 2,
        skipped: 1,
      });
    } finally {
      store.close();
    }
  });

  it('never falls back when a target OGRN is invalid, absent in FNS, or belongs to another INN', () => {
    const store = createStore();
    try {
      store.beginSnapshot();
      store.addExisting(existing({
        id: '30',
        ogrn: '1177746494167',
      }));
      store.addExisting(existing({
        id: '31',
        ogrn: '1207700000012',
      }));
      store.addExisting(existing({
        id: '32',
        inn: LEGAL_INN_B,
        ogrn: LEGAL_OGRN_A,
      }));
      store.commitSnapshot();

      store.beginRegistry();
      store.addRegistry(registry());
      store.addRegistry(registry({
        inn: LEGAL_INN_B,
        ogrn: LEGAL_OGRN_B,
        okved_code_exact: '62.09',
      }));
      store.commitRegistry();

      expect([...store.iterateUpdates()]).toEqual([]);
      expect([...store.iterateSkipped()]).toEqual([
        {
          id: '30',
          inn: LEGAL_INN_A,
          expected_ogrn: '1177746494167',
          reason: 'invalid_target_ogrn',
        },
        {
          id: '31',
          inn: LEGAL_INN_A,
          expected_ogrn: '1207700000012',
          reason: 'ogrn_not_found',
        },
        {
          id: '32',
          inn: LEGAL_INN_B,
          expected_ogrn: LEGAL_OGRN_A,
          reason: 'ogrn_inn_mismatch',
        },
      ]);
      expect(store.metrics()).toMatchObject({
        invalid_target_ogrn_quarantined: 1,
        ogrn_not_found_quarantined: 1,
        identity_mismatch_quarantined: 1,
        updates: 0,
        skipped: 3,
      });
    } finally {
      store.close();
    }
  });

  it('deduplicates one registration, accepts a second OGRN for the same INN, and rejects corruption of one OGRN', () => {
    const store = createStore();
    try {
      store.beginRegistry();
      expect(store.addRegistry(registry())).toBe('added');
      expect(store.addRegistry(registry())).toBe('duplicate_same');
      expect(store.addRegistry(registry({
        ogrn: LEGAL_OGRN_B,
        okved_code_exact: '62.02.2',
      }))).toBe('added');
      expect(() => store.addRegistry(registry({
        ogrn: LEGAL_OGRN_A,
        okved_code_exact: '62.03',
      }))).toThrow(/conflicting.*OGRN|OGRN.*conflicting/i);
      store.rollbackRegistry();
    } finally {
      store.close();
    }
  });

  it('does not use a lone OKVED-2001 registration for an exact or fallback update', () => {
    const store = createStore();
    try {
      store.beginSnapshot();
      store.addExisting(existing({ id: '40' }));
      store.addExisting(existing({ id: '41', ogrn: null }));
      store.commitSnapshot();
      store.beginRegistry();
      store.addRegistry(registry({
        okved_code_exact: '72.20',
        okved_version: '2001',
      }));
      store.commitRegistry();

      expect([...store.iterateUpdates()]).toEqual([]);
      expect([...store.iterateSkipped()]).toEqual([
        {
          id: '40',
          inn: LEGAL_INN_A,
          expected_ogrn: LEGAL_OGRN_A,
          reason: 'legacy_okved_2001',
        },
        {
          id: '41',
          inn: LEGAL_INN_A,
          expected_ogrn: null,
          reason: 'legacy_okved_2001',
        },
      ]);
      expect(store.metrics()).toMatchObject({
        okved_2001_quarantined: 1,
        updates: 0,
        skipped: 2,
      });
    } finally {
      store.close();
    }
  });
  it('paginates decimal-text ids with a strict keyset cursor', () => {
    const orderedRows = ['1', '2', '9', '10', '11'].map((id) => ({ id }));
    const requestedCursors: Array<{ idLength: number; id: string }> = [];

    const rows = [...iterateFnsExactKeysetPages(
      (cursor, limit) => {
        requestedCursors.push({ ...cursor });
        return orderedRows.filter((row) =>
          row.id.length > cursor.idLength
          || (
            row.id.length === cursor.idLength
            && row.id > cursor.id
          )
        ).slice(0, limit);
      },
      2,
    )];

    expect(rows).toEqual(orderedRows);
    expect(requestedCursors).toEqual([
      { idLength: 0, id: '' },
      { idLength: 1, id: '2' },
      { idLength: 2, id: '10' },
    ]);
  });

  it('streams more than one production page exactly once after metrics and idempotency checks', () => {
    const store = createStore();
    const rowCount = 10_005;
    try {
      store.beginSnapshot();
      for (let id = 1; id <= rowCount; id += 1) {
        store.addExisting(existing({ id: String(id) }));
      }
      store.commitSnapshot();

      store.beginRegistry();
      store.addRegistry(registry());
      store.commitRegistry();

      expect(store.metrics()).toMatchObject({ updates: rowCount });
      expect(store.checkIdempotency()).toEqual({
        firstPassUpdates: rowCount,
        repeatedUpdates: 0,
        passed: true,
      });

      const updates = [...store.iterateUpdates()];
      const ids = updates.map((row) => row.id);
      expect(updates).toHaveLength(rowCount);
      expect(new Set(ids).size).toBe(rowCount);
      expect(ids[0]).toBe('1');
      expect(ids[9_999]).toBe('10000');
      expect(ids.at(-1)).toBe('10005');
    } finally {
      store.close();
    }
  });
});
