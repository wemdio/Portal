/** @jest-environment node */

import {
  buildFnsExactOkvedPlan,
  type ExistingDirectoryExactOkvedRow,
  type FnsExactOkvedRegistryRow,
} from '@/lib/companiesDirectory/fnsExactPlan';

const FNS_SOURCE = 'fns_sme_registry';

function registryRow(
  overrides: Partial<FnsExactOkvedRegistryRow> = {},
): FnsExactOkvedRegistryRow {
  return {
    inn: '7704414297',
    ogrn: '1177746494166',
    okved_code_exact: '62.01',
    okved_version: '2014',
    ...overrides,
  };
}

function existingRow(
  overrides: Partial<ExistingDirectoryExactOkvedRow> = {},
): ExistingDirectoryExactOkvedRow {
  return {
    id: 10,
    inn: '7704414297',
    ogrn: '1177746494166',
    okved_code_exact: null,
    okved_exact_source: null,
    ...overrides,
  };
}

describe('FNS exact OKVED canonical plan', () => {
  it('uses the same OGRN-first matcher for direct, fallback, conflict, and quarantine rows', () => {
    const plan = buildFnsExactOkvedPlan(
      [
        registryRow(),
        registryRow({
          inn: '212401514249',
          ogrn: '322890100023953',
          okved_code_exact: '01.46.1',
        }),
        registryRow({
          inn: '212401514249',
          ogrn: '315890400001930',
          okved_code_exact: '01.46',
        }),
      ],
      [
        existingRow(),
        existingRow({
          id: 11,
          inn: '212401514249',
          ogrn: '322890100023953',
        }),
        existingRow({
          id: 12,
          inn: '212401514249',
          ogrn: null,
        }),
        existingRow({
          id: 13,
          okved_code_exact: '62.02.2',
          okved_exact_source: 'dadata',
        }),
      ],
    );

    expect(plan.source).toBe(FNS_SOURCE);
    expect(plan.updates).toEqual([
      {
        id: 10,
        inn: '7704414297',
        expected_ogrn: '1177746494166',
        fns_ogrn: '1177746494166',
        match_method: 'ogrn_inn',
        okved_code_exact: '62.01',
        okved_exact_source: FNS_SOURCE,
      },
      {
        id: 11,
        inn: '212401514249',
        expected_ogrn: '322890100023953',
        fns_ogrn: '322890100023953',
        match_method: 'ogrn_inn',
        okved_code_exact: '01.46.1',
        okved_exact_source: FNS_SOURCE,
      },
    ]);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        id: 13,
        expected_ogrn: '1177746494166',
        fns_ogrn: '1177746494166',
        match_method: 'ogrn_inn',
        kind: 'existing_exact_preserved',
      }),
    ]);
    expect(plan.skipped).toEqual([
      {
        id: 12,
        inn: '212401514249',
        expected_ogrn: null,
        reason: 'ambiguous_inn_multiple_ogrn',
      },
    ]);
    expect(plan.metrics).toMatchObject({
      updates: 2,
      conflicts: 1,
      skipped: 1,
      inserts: 0,
    });
    expect(plan).not.toHaveProperty('inserts');
  });

  it('is deterministic across input order and changes fingerprint when identity matching changes', () => {
    const registryRows = [
      registryRow(),
      registryRow({
        inn: '7729058675',
        ogrn: '1177746494177',
        okved_code_exact: '62.09',
      }),
    ];
    const existingRows = [
      existingRow({ id: 20 }),
      existingRow({
        id: 21,
        inn: '7729058675',
        ogrn: null,
      }),
    ];

    const forward = buildFnsExactOkvedPlan(registryRows, existingRows);
    const reversed = buildFnsExactOkvedPlan(
      [...registryRows].reverse(),
      [...existingRows].reverse(),
    );
    const changed = buildFnsExactOkvedPlan(
      registryRows,
      [
        existingRows[0],
        {
          ...existingRows[1],
          ogrn: '1177746494199',
        },
      ],
    );

    expect(forward).toEqual(reversed);
    expect(forward.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(changed.fingerprint).not.toBe(forward.fingerprint);
  });
});
