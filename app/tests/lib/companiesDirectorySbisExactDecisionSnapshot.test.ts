/** @jest-environment node */

import {
  canonicalJson,
  sha256Hex,
} from '@/lib/companiesDirectory/guardedImportCore';
import {
  buildSbisExactDecisionSnapshot,
} from '@/lib/companiesDirectory/sbisExactDecisionSnapshot';

const EXACT_CODE = '62.01';

function legalInn(prefix: string): string {
  if (!/^\d{9}$/.test(prefix)) throw new Error('INN prefix must have 9 digits');
  const digits = [...prefix].map(Number);
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const check = weights.reduce(
    (sum, weight, index) => sum + weight * digits[index],
    0,
  ) % 11 % 10;
  return `${prefix}${check}`;
}

function legalOgrn(prefix: string): string {
  if (!/^\d{12}$/.test(prefix)) throw new Error('OGRN prefix must have 12 digits');
  return `${prefix}${BigInt(prefix) % BigInt(11) % BigInt(10)}`;
}

function candidateKey(input: {
  ordinal: number;
  inn: string;
  ogrn: string;
  okved_code_exact: string;
}): string {
  return sha256Hex(canonicalJson(input));
}

function candidate(
  ordinal: number,
  overrides: Partial<{
    inn: string;
    ogrn: string;
    okved_code_exact: string;
  }> = {},
) {
  const identity = {
    ordinal,
    inn: overrides.inn ?? legalInn(`77000000${ordinal}`),
    ogrn: overrides.ogrn ?? legalOgrn(`11777000000${ordinal}`),
    okved_code_exact: overrides.okved_code_exact ?? EXACT_CODE,
  };
  return {
    ...identity,
    candidate_key_sha256: candidateKey(identity),
  };
}

function target(
  source: ReturnType<typeof candidate>,
  id: string,
  overrides: Partial<{
    inn: string;
    ogrn: string | null;
    okved_code_exact: string | null;
    okved_exact_source: string | null;
  }> = {},
) {
  return {
    id,
    inn: overrides.inn ?? source.inn,
    ogrn: Object.prototype.hasOwnProperty.call(overrides, 'ogrn')
      ? overrides.ogrn!
      : source.ogrn,
    okved_code_exact: Object.prototype.hasOwnProperty.call(
      overrides,
      'okved_code_exact',
    )
      ? overrides.okved_code_exact!
      : null,
    okved_exact_source: Object.prototype.hasOwnProperty.call(
      overrides,
      'okved_exact_source',
    )
      ? overrides.okved_exact_source!
      : null,
  };
}

describe('SBIS exact OKVED production decision snapshot', () => {
  it('partitions every candidate once using strict INN+OGRN and exposes a target only for one identity row', () => {
    const candidates = Array.from({ length: 9 }, (_, index) => candidate(index + 1));
    const [eligible, extraInn, _absent, mismatch, duplicate, same, different, partial, whitespace] = candidates;
    const targetRows = [
      target(eligible, '101'),
      target(extraInn, '102'),
      target(extraInn, '103', {
        ogrn: legalOgrn('117779999999'),
        okved_code_exact: '62.02',
        okved_exact_source: 'dadata',
      }),
      target(mismatch, '104', {
        ogrn: legalOgrn('117778888888'),
      }),
      target(duplicate, '105'),
      target(duplicate, '106'),
      target(same, '107', {
        okved_code_exact: EXACT_CODE,
        okved_exact_source: 'dadata',
      }),
      target(different, '108', {
        okved_code_exact: '62.02',
        okved_exact_source: 'fns_sme_registry',
      }),
      target(partial, '109', {
        okved_code_exact: null,
        okved_exact_source: 'sbis_registry',
      }),
      target(whitespace, '110', {
        okved_code_exact: '   ',
        okved_exact_source: '',
      }),
    ];

    const snapshot = buildSbisExactDecisionSnapshot({
      source: 'sbis_registry',
      candidates,
      targetRows,
    });

    expect(snapshot.source).toBe('sbis_registry');
    expect(snapshot).not.toHaveProperty('updates');
    expect(snapshot.decisions).toHaveLength(candidates.length);
    expect(new Set(snapshot.decisions.map((row) => row.ordinal)).size)
      .toBe(candidates.length);
    expect(Object.fromEntries(snapshot.decisions.map((row) => [
      row.ordinal,
      row.category,
    ]))).toEqual({
      1: 'eligible_null_unique_inn',
      2: 'eligible_null_extra_inn',
      3: 'absent_inn',
      4: 'ogrn_mismatch',
      5: 'duplicate_identity',
      6: 'occupied_same',
      7: 'occupied_different',
      8: 'partial_exact_state',
      9: 'partial_exact_state',
    });

    const byOrdinal = new Map(snapshot.decisions.map((row) => [row.ordinal, row]));
    expect(byOrdinal.get(1)).toMatchObject({
      inn_match_count: 1,
      identity_match_count: 1,
      target: {
        id: '101',
        okved_code_exact: null,
        okved_exact_source: null,
      },
    });
    expect(Object.keys(byOrdinal.get(1)!.target!).sort()).toEqual([
      'id',
      'okved_code_exact',
      'okved_exact_source',
    ]);
    expect(byOrdinal.get(2)).toMatchObject({
      inn_match_count: 2,
      identity_match_count: 1,
      inn_target_ids: ['102', '103'],
      identity_target_ids: ['102'],
      target: { id: '102' },
    });
    expect(byOrdinal.get(3)).toMatchObject({
      inn_match_count: 0,
      identity_match_count: 0,
      target: null,
    });
    expect(byOrdinal.get(4)).toMatchObject({
      inn_match_count: 1,
      identity_match_count: 0,
      target: null,
    });
    expect(byOrdinal.get(5)).toMatchObject({
      inn_match_count: 2,
      identity_match_count: 2,
      inn_target_ids: ['105', '106'],
      identity_target_ids: ['105', '106'],
      target: null,
    });
    expect(byOrdinal.get(9)).toMatchObject({
      category: 'partial_exact_state',
      target: {
        id: '110',
        okved_code_exact: '   ',
        okved_exact_source: '',
      },
    });

    const categories = snapshot.decisions.map((row) => row.category);
    expect(categories).toHaveLength(candidates.length);
    expect(categories.filter((category) =>
      category === 'eligible_null_unique_inn')).toHaveLength(1);
  });

  it('preserves each raw exact code/source pair and never treats partial or whitespace state as writable', () => {
    const candidates = Array.from({ length: 6 }, (_, index) => candidate(index + 1));
    const exactStates = [
      { okved_code_exact: null, okved_exact_source: null },
      { okved_code_exact: EXACT_CODE, okved_exact_source: 'dadata' },
      { okved_code_exact: '62.02', okved_exact_source: 'sbis_registry' },
      { okved_code_exact: null, okved_exact_source: 'sbis_registry' },
      { okved_code_exact: EXACT_CODE, okved_exact_source: null },
      { okved_code_exact: '   ', okved_exact_source: '  ' },
    ];
    const snapshot = buildSbisExactDecisionSnapshot({
      source: 'sbis_registry',
      candidates,
      targetRows: candidates.map((row, index) => target(
        row,
        String(200 + index),
        exactStates[index],
      )),
    });

    expect(snapshot.decisions.map((row) => row.category)).toEqual([
      'eligible_null_unique_inn',
      'occupied_same',
      'occupied_different',
      'partial_exact_state',
      'partial_exact_state',
      'partial_exact_state',
    ]);
    expect(snapshot.decisions.map((row) => row.target && ({
      okved_code_exact: row.target.okved_code_exact,
      okved_exact_source: row.target.okved_exact_source,
    }))).toEqual(exactStates);
    expect(snapshot.decisions.slice(3)).not.toContainEqual(
      expect.objectContaining({ category: 'eligible_null_unique_inn' }),
    );
  });

  it('is deterministic across input order and changes its decision digest when target state changes', () => {
    const candidates = [candidate(1), candidate(2), candidate(3)];
    const targetRows = [
      target(candidates[0], '301'),
      target(candidates[1], '302', {
        okved_code_exact: EXACT_CODE,
        okved_exact_source: 'dadata',
      }),
    ];
    const first = buildSbisExactDecisionSnapshot({
      source: 'sbis_registry',
      candidates,
      targetRows,
    });
    const reordered = buildSbisExactDecisionSnapshot({
      source: 'sbis_registry',
      candidates: [...candidates].reverse(),
      targetRows: [...targetRows].reverse(),
    });

    expect(first.decisions).toEqual(reordered.decisions);
    expect(first.decision_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.decision_sha256).toBe(reordered.decision_sha256);

    const changed = buildSbisExactDecisionSnapshot({
      source: 'sbis_registry',
      candidates,
      targetRows: [
        targetRows[0],
        { ...targetRows[1], okved_exact_source: 'sbis_registry' },
      ],
    });
    expect(changed.decision_sha256).not.toBe(first.decision_sha256);
  });

  it('hard-fails an untrusted source or a candidate whose ordinal no longer matches its pinned key', () => {
    const valid = candidate(1);

    expect(() => buildSbisExactDecisionSnapshot({
      source: 'fns_sme_registry' as never,
      candidates: [valid],
      targetRows: [],
    })).toThrow(/source.*sbis_registry/i);

    expect(() => buildSbisExactDecisionSnapshot({
      source: 'sbis_registry',
      candidates: [{ ...valid, ordinal: 2 }],
      targetRows: [],
    })).toThrow(/candidate.*(?:ordinal|key|sha)/i);

    expect(() => buildSbisExactDecisionSnapshot({
      source: 'sbis_registry',
      candidates: [{ ...valid, candidate_key_sha256: 'f'.repeat(64) }],
      targetRows: [],
    })).toThrow(/candidate.*(?:key|sha)/i);
  });

  it('classifies a live row with NULL OGRN as a non-matching target identity', () => {
    const source = candidate(1);
    const snapshot = buildSbisExactDecisionSnapshot({
      source: 'sbis_registry',
      candidates: [source],
      targetRows: [target(source, '401', { ogrn: null })],
    });

    expect(snapshot.decisions).toEqual([
      expect.objectContaining({
        category: 'ogrn_mismatch',
        inn_match_count: 1,
        identity_match_count: 0,
        target: null,
      }),
    ]);
  });
});
