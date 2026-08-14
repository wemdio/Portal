/** @jest-environment node */

import {
  buildSbisExactOkvedPlan,
  SBIS_EXACT_OKVED_SOURCE,
} from '@/lib/companiesDirectory/sbisExactOkvedPlan';

const LEGAL_INN_A = '7704414297';
const LEGAL_INN_B = '7729058675';
const IP_INN = '212401514249';
const LEGAL_OGRN_A = '1177746494166';
const LEGAL_OGRN_B = '1177746494177';
const IP_OGRN = '322890100023953';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const REFERENCE_CODES: ReadonlySet<string> = new Set([
  '01.46.1',
  '62.01',
  '62.02',
  '62.09',
]);

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    inn: LEGAL_INN_A,
    ogrn: LEGAL_OGRN_A,
    okved_code_exact: '62.01',
    source_file: 'LEGAL77.csv.zip',
    source_sha256: SHA_A,
    row_number: 2,
    ...overrides,
  };
}

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '10',
    inn: LEGAL_INN_A,
    ogrn: LEGAL_OGRN_A,
    okved_code_exact: null,
    okved_exact_source: null,
    ...overrides,
  };
}

describe('SBIS registry exact OKVED plan', () => {
  it('updates only a blank exact/source pair matched by strict INN+OGRN', () => {
    const plan = buildSbisExactOkvedPlan(
      [
        sourceRow(),
        sourceRow({
          inn: LEGAL_INN_B,
          ogrn: LEGAL_OGRN_B,
          okved_code_exact: '62.09',
          row_number: 3,
        }),
      ],
      [
        existingRow(),
        existingRow({
          id: '11',
          inn: LEGAL_INN_B,
          ogrn: null,
        }),
      ],
      REFERENCE_CODES,
    );

    expect(SBIS_EXACT_OKVED_SOURCE).toBe('sbis_registry');
    expect(plan.source).toBe('sbis_registry');
    expect(plan.updates).toEqual([
      {
        id: '10',
        inn: LEGAL_INN_A,
        expected_ogrn: LEGAL_OGRN_A,
        registry_ogrn: LEGAL_OGRN_A,
        match_method: 'ogrn_inn',
        okved_code_exact: '62.01',
        okved_exact_source: 'sbis_registry',
      },
    ]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({
        inn: LEGAL_INN_B,
        registry_ogrn: LEGAL_OGRN_B,
      }),
    ]);
    expect(plan.updates).not.toContainEqual(
      expect.objectContaining({ id: '11' }),
    );
    expect(plan).not.toHaveProperty('inserts');
    expect(plan.metrics).toMatchObject({
      source_rows: 2,
      matched_directory_rows: 1,
      updates: 1,
      noops: 0,
      conflicts: 0,
      skipped: 1,
      source_quarantined: 0,
      inserts: 0,
    });
    expect(plan.provenance).toContainEqual({
      action: 'update',
      id: '10',
      inn: LEGAL_INN_A,
      ogrn: LEGAL_OGRN_A,
      okved_code_exact: '62.01',
      sources: [{
        source_file: 'LEGAL77.csv.zip',
        sha256: SHA_A,
        rowNumbers: [2],
      }],
    });
  });

  it('keeps occupied exact data and treats partial exact/source pairs as conflicts', () => {
    const same = buildSbisExactOkvedPlan(
      [sourceRow()],
      [existingRow({
        okved_code_exact: '62.01',
        okved_exact_source: 'dadata',
      })],
      REFERENCE_CODES,
    );
    expect(same.updates).toEqual([]);
    expect(same.noops).toEqual([
      expect.objectContaining({
        id: '10',
        reason: 'already_exact',
      }),
    ]);

    const different = buildSbisExactOkvedPlan(
      [sourceRow()],
      [existingRow({
        okved_code_exact: '62.02',
        okved_exact_source: 'dadata',
      })],
      REFERENCE_CODES,
    );
    expect(different.updates).toEqual([]);
    expect(different.conflicts).toEqual([
      expect.objectContaining({
        id: '10',
        kind: 'existing_exact_preserved',
        existing_okved_code_exact: '62.02',
        incoming_okved_code_exact: '62.01',
      }),
    ]);

    for (const partialState of [
      { okved_code_exact: null, okved_exact_source: 'legacy_import' },
      { okved_code_exact: '62.01', okved_exact_source: null },
    ]) {
      const partial = buildSbisExactOkvedPlan(
        [sourceRow()],
        [existingRow(partialState)],
        REFERENCE_CODES,
      );
      expect(partial.updates).toEqual([]);
      expect(partial.noops).toEqual([]);
      expect(partial.conflicts).toEqual([
        expect.objectContaining({
          id: '10',
          kind: 'partial_existing_exact_state',
        }),
      ]);
    }

    const whitespaceOccupied = buildSbisExactOkvedPlan(
      [sourceRow()],
      [existingRow({
        okved_code_exact: '   ',
        okved_exact_source: '',
      })],
      REFERENCE_CODES,
    );
    expect(whitespaceOccupied.updates).toEqual([]);
    expect(whitespaceOccupied.conflicts).toEqual([
      expect.objectContaining({
        id: '10',
        existing_okved_code_exact: '   ',
        existing_okved_exact_source: '',
      }),
    ]);
  });

  it('deduplicates identical source evidence and quarantines a multi-code identity', () => {
    const duplicate = buildSbisExactOkvedPlan(
      [
        sourceRow(),
        sourceRow({
          source_file: 'WIRUJA.csv',
          source_sha256: SHA_B,
          row_number: 8,
        }),
      ],
      [existingRow()],
      REFERENCE_CODES,
    );

    expect(duplicate.updates).toHaveLength(1);
    expect(duplicate.sourceQuarantine).toEqual([]);
    expect(duplicate.metrics).toMatchObject({
      source_rows: 2,
      unique_source_identities: 1,
      duplicate_source_rows: 1,
      updates: 1,
    });
    expect(duplicate.provenance).toContainEqual(
      expect.objectContaining({
        action: 'update',
        inn: LEGAL_INN_A,
        ogrn: LEGAL_OGRN_A,
        sources: [
          {
            source_file: 'LEGAL77.csv.zip',
            sha256: SHA_A,
            rowNumbers: [2],
          },
          {
            source_file: 'WIRUJA.csv',
            sha256: SHA_B,
            rowNumbers: [8],
          },
        ],
      }),
    );

    const conflicting = buildSbisExactOkvedPlan(
      [
        sourceRow(),
        sourceRow({
          okved_code_exact: '62.02',
          source_file: 'WIRUJA.csv',
          source_sha256: SHA_B,
          row_number: 8,
        }),
      ],
      [existingRow()],
      REFERENCE_CODES,
    );

    expect(conflicting.updates).toEqual([]);
    expect(conflicting.sourceQuarantine).toEqual([
      expect.objectContaining({
        inn: LEGAL_INN_A,
        ogrn: LEGAL_OGRN_A,
        reason: 'conflicting_source_okved',
        okved_codes: ['62.01', '62.02'],
      }),
    ]);
    expect(conflicting.metrics).toMatchObject({
      updates: 0,
      conflicting_source_identities: 1,
      source_quarantined: 2,
    });
  });

  it('quarantines every source row when one INN has multiple OGRNs', () => {
    const plan = buildSbisExactOkvedPlan(
      [
        sourceRow(),
        sourceRow({
          ogrn: LEGAL_OGRN_B,
          source_file: 'WIRUJA.csv',
          source_sha256: SHA_B,
          row_number: 8,
        }),
      ],
      [
        existingRow(),
        existingRow({ id: '11', ogrn: LEGAL_OGRN_B }),
      ],
      REFERENCE_CODES,
    );

    expect(plan.updates).toEqual([]);
    expect(plan.sourceQuarantine).toEqual([
      expect.objectContaining({
        inn: LEGAL_INN_A,
        ogrn: LEGAL_OGRN_A,
        reason: 'conflicting_source_ogrn',
      }),
      expect.objectContaining({
        inn: LEGAL_INN_A,
        ogrn: LEGAL_OGRN_B,
        reason: 'conflicting_source_ogrn',
      }),
    ]);
    expect(plan.metrics).toMatchObject({
      updates: 0,
      conflicting_source_ogrn_inns: 1,
      source_quarantined: 2,
    });
  });

  it('skips a matching identity when the target INN has another registration', () => {
    const plan = buildSbisExactOkvedPlan(
      [sourceRow()],
      [
        existingRow(),
        existingRow({ id: '11', ogrn: LEGAL_OGRN_B }),
      ],
      REFERENCE_CODES,
    );

    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({
        inn: LEGAL_INN_A,
        registry_ogrn: LEGAL_OGRN_A,
        reason: 'ambiguous_target_inn',
        target_ids: ['10', '11'],
      }),
    ]);
    expect(plan.metrics).toMatchObject({
      updates: 0,
      ambiguous_target_inns: 1,
      skipped: 1,
    });
  });

  it('quarantines malformed and reference-missing exact codes before matching', () => {
    const plan = buildSbisExactOkvedPlan(
      [
        sourceRow({ okved_code_exact: '62.020' }),
        sourceRow({
          inn: LEGAL_INN_B,
          ogrn: LEGAL_OGRN_B,
          okved_code_exact: '64.99.6',
          row_number: 3,
        }),
      ],
      [
        existingRow(),
        existingRow({
          id: '11',
          inn: LEGAL_INN_B,
          ogrn: LEGAL_OGRN_B,
        }),
      ],
      REFERENCE_CODES,
    );

    expect(plan.updates).toEqual([]);
    expect(plan.sourceQuarantine).toEqual([
      expect.objectContaining({
        inn: LEGAL_INN_A,
        okved_code_exact: '62.020',
        reason: 'invalid_okved_code',
      }),
      expect.objectContaining({
        inn: LEGAL_INN_B,
        okved_code_exact: '64.99.6',
        reason: 'okved_not_in_reference',
      }),
    ]);
    expect(plan.metrics).toMatchObject({
      updates: 0,
      invalid_okved_quarantined: 1,
      reference_missing_quarantined: 1,
      source_quarantined: 2,
    });
  });

  it('is deterministic across input order and becomes a no-op after the update state is applied', () => {
    const sourceRows = [
      sourceRow(),
      sourceRow({
        inn: IP_INN,
        ogrn: IP_OGRN,
        okved_code_exact: '01.46.1',
        source_file: 'ENT89.csv.zip',
        source_sha256: SHA_B,
        row_number: 7,
      }),
    ];
    const existingRows = [
      existingRow(),
      existingRow({
        id: '11',
        inn: IP_INN,
        ogrn: IP_OGRN,
      }),
    ];

    const forward = buildSbisExactOkvedPlan(
      sourceRows,
      existingRows,
      REFERENCE_CODES,
    );
    const reversed = buildSbisExactOkvedPlan(
      [...sourceRows].reverse(),
      [...existingRows].reverse(),
      REFERENCE_CODES,
    );
    const provenanceChanged = buildSbisExactOkvedPlan(
      [{ ...sourceRows[0], source_sha256: 'c'.repeat(64) }, sourceRows[1]],
      existingRows,
      REFERENCE_CODES,
    );

    expect(forward).toEqual(reversed);
    expect(forward.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(provenanceChanged.fingerprint).not.toBe(forward.fingerprint);

    const applied = buildSbisExactOkvedPlan(
      sourceRows,
      [
        existingRow({
          okved_code_exact: '62.01',
          okved_exact_source: 'sbis_registry',
        }),
        existingRow({
          id: '11',
          inn: IP_INN,
          ogrn: IP_OGRN,
          okved_code_exact: '01.46.1',
          okved_exact_source: 'sbis_registry',
        }),
      ],
      REFERENCE_CODES,
    );
    expect(applied.updates).toEqual([]);
    expect(applied.noops).toHaveLength(2);
    expect(applied.conflicts).toEqual([]);
    expect(applied.metrics).toMatchObject({
      updates: 0,
      noops: 2,
    });
  });
});
