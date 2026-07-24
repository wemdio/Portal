/** @jest-environment node */

import {
  applySbisImportPlan,
  buildSbisContactImportPlan,
  buildSbisIndustryImportPlan,
  collapseSbisRowsByInn,
  mapSbisWorksheetRecord,
  normalizeSbisInn,
  validateSbisWorksheetHeaders,
  type ExistingDirectoryRow,
  type SbisDirectoryInputRow,
} from '@/lib/companiesDirectory/sbisImportPlan';
import { collectDescendantCodes } from '@/lib/companiesSearch/okved2';

const OPTIONS = {
  approximateOkvedCode: '62',
  sourceFile: 'Компании (1).xlsx',
};

const CONTACT_OPTIONS = {
  sourceFile: 'Компании (2).xlsx',
};

function sourceRow(
  overrides: Partial<SbisDirectoryInputRow> = {},
): SbisDirectoryInputRow {
  return {
    rowNumber: 2,
    name: 'ООО "АЛЬФА"',
    inn: '7704414297',
    kpp: '770401001',
    address: '119021, г. Москва, ул. Льва Толстого, д. 16',
    activity_type: 'Программное обеспечение',
    employees_count: 12,
    phones: '+7 (495) 111-22-33',
    email: 'HELLO@ALPHA.RU',
    revenue: 100_000_000,
    website: 'https://www.alpha.ru/about',
    ogrn: '1177746494166',
    ...overrides,
  };
}

describe('SBIS companies_directory import plan', () => {
  it('accepts checksum-valid 10/12-digit INNs and rejects malformed or invalid values', () => {
    expect(normalizeSbisInn('7704414297')).toBe('7704414297');
    expect(normalizeSbisInn(772_138_583_200)).toBe('772138583200');
    expect(normalizeSbisInn('77044-14297')).toBeNull();
    expect(normalizeSbisInn('1234567890')).toBeNull();
    expect(normalizeSbisInn('123')).toBeNull();
  });

  it('maps XLSX columns by header name and rejects a missing required header', () => {
    const raw = {
      Сайт: 'alpha.ru',
      ИНН: '7704414297',
      Название: 'ООО "АЛЬФА"',
      Адрес: 'г. Москва',
      'Количество сотрудников': 12,
      Телефоны: '+7 495 111-22-33',
      email: 'hello@alpha.ru',
      Выручка: 100,
    };

    validateSbisWorksheetHeaders(Object.keys(raw));
    expect(mapSbisWorksheetRecord(raw, 7)).toMatchObject({
      rowNumber: 7,
      inn: '7704414297',
      name: 'ООО "АЛЬФА"',
      address: 'г. Москва',
      employees_count: 12,
      website: 'alpha.ru',
    });
    expect(() =>
      validateSbisWorksheetHeaders(['Название', 'ИНН', 'Сайт']),
    ).toThrow('Адрес');
  });

  it('collapses duplicate source rows by INN, unions contacts, and prefers a non-branch row', () => {
    const collapsed = collapseSbisRowsByInn([
      sourceRow({
        rowNumber: 3,
        name: 'ООО "АЛЬФА", филиал',
        address: 'г. Тверь, ул. Советская, д. 1',
        website: 'alpha.ru, branch.alpha.ru',
        email: 'branch@alpha.ru',
        phones: '+7 (495) 111-22-33',
      }),
      sourceRow({
        rowNumber: 2,
        website: 'HTTPS://WWW.ALPHA.RU/about; docs.alpha.ru',
        email: 'hello@alpha.ru, BRANCH@ALPHA.RU',
        phones: '8 (495) 111-22-33, +7 (495) 999-88-77',
      }),
    ]);

    expect(collapsed.rejected).toHaveLength(0);
    expect(collapsed.companies).toHaveLength(1);
    expect(collapsed.duplicateRows).toBe(1);
    expect(collapsed.companies[0]).toMatchObject({
      inn: '7704414297',
      name: 'ООО "АЛЬФА"',
      address: '119021, г. Москва, ул. Льва Толстого, д. 16',
      region_code: '77',
      website: 'alpha.ru, branch.alpha.ru, docs.alpha.ru',
      email: 'branch@alpha.ru, hello@alpha.ru',
      phones: '+74951112233, +74959998877',
    });
    expect(collapsed.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inn: '7704414297',
          kind: 'source_scalar_conflict',
          field: 'name',
        }),
        expect.objectContaining({
          inn: '7704414297',
          kind: 'source_scalar_conflict',
          field: 'address',
        }),
      ]),
    );
  });

  it('plans one insert for a missing INN and labels 62 only as an approximate industry', () => {
    const plan = buildSbisIndustryImportPlan(
      [sourceRow()],
      [],
      OPTIONS,
    );

    expect(plan.inserts).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);
    expect(plan.inserts[0]).toMatchObject({
      inn: '7704414297',
      website: 'alpha.ru',
      region_code: '77',
      okved_code: '62',
      source_file: 'Компании (1).xlsx',
      okved_code_exact: null,
      okved_exact_source: null,
    });
  });

  it('does not confuse Moscow city with Moscow Oblast when the district is named Moskovskiy', () => {
    const plan = buildSbisIndustryImportPlan(
      [
        sourceRow({
          address:
            '108811, г. Москва, вн.тер.г. поселение Московский, Киевское ш., д. 22',
        }),
      ],
      [],
      OPTIONS,
    );

    expect(plan.inserts[0].region_code).toBe('77');
  });

  it('gives an explicit Moscow city marker priority over region-like street names', () => {
    const plan = buildSbisIndustryImportPlan(
      [
        sourceRow({
          address: '109559, г. Москва, ул. Краснодарская, д. 51',
        }),
      ],
      [],
      OPTIONS,
    );

    expect(plan.inserts[0].region_code).toBe('77');
  });

  it('fills only known blank fields and preserves existing values and exact OKVED provenance', () => {
    const existing: ExistingDirectoryRow = {
      id: 10,
      inn: '7704414297',
      name: 'Существующее название',
      website: '',
      email: 'current@alpha.ru',
      phones: null,
      employees_count: 25,
      region_code: null,
      okved_code: '63.11',
      okved_code_exact: '62.01',
      okved_exact_source: 'dadata',
      source_file: 'old.xlsx',
    };

    const plan = buildSbisIndustryImportPlan(
      [sourceRow()],
      [existing],
      OPTIONS,
    );

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toEqual([
      {
        id: 10,
        inn: '7704414297',
        patch: {
          website: 'alpha.ru',
          phones: '+74951112233',
          region_code: '77',
        },
      },
    ]);
    expect(plan.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inn: '7704414297',
          kind: 'existing_value_preserved',
          field: 'email',
        }),
        expect.objectContaining({
          inn: '7704414297',
          kind: 'existing_value_preserved',
          field: 'okved_code',
        }),
      ]),
    );
  });

  it('does not infer blanks for fields absent from a partial existing snapshot', () => {
    const partialExisting: ExistingDirectoryRow = {
      id: 11,
      inn: '7704414297',
      website: null,
    };

    const plan = buildSbisIndustryImportPlan(
      [sourceRow()],
      [partialExisting],
      OPTIONS,
    );

    expect(plan.updates).toEqual([
      {
        id: 11,
        inn: '7704414297',
        patch: { website: 'alpha.ru' },
      },
    ]);
  });

  it('blocks updates when the same INN already has duplicate directory rows', () => {
    const existing: ExistingDirectoryRow[] = [
      { id: 20, inn: '7704414297', website: null },
      { id: 21, inn: '7704414297', website: null },
    ];

    const plan = buildSbisIndustryImportPlan(
      [sourceRow()],
      existing,
      OPTIONS,
    );

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.metrics.blockedExistingDuplicates).toBe(1);
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({
        inn: '7704414297',
        kind: 'duplicate_existing_inn',
      }),
    );
  });

  it('is idempotent after applying the first plan', () => {
    const existing: ExistingDirectoryRow[] = [
      {
        id: 30,
        inn: '7729058675',
        website: null,
        email: null,
        okved_code: '62',
        okved_code_exact: null,
        okved_exact_source: null,
      },
    ];
    const rows = [
      sourceRow(),
      sourceRow({
        rowNumber: 3,
        inn: '7729058675',
        name: 'АО "ИНФОСИСТЕМЫ ДЖЕТ"',
        website: 'jet.su',
        email: 'info@jet.su',
      }),
    ];

    const first = buildSbisIndustryImportPlan(rows, existing, OPTIONS);
    const afterFirst = applySbisImportPlan(existing, first);
    const second = buildSbisIndustryImportPlan(rows, afterFirst, OPTIONS);

    expect(first.metrics.inserts).toBe(1);
    expect(first.metrics.updates).toBe(1);
    expect(second.metrics.inserts).toBe(0);
    expect(second.metrics.updates).toBe(0);
    expect(second.metrics.noops).toBe(2);
  });

  it('keeps accounting metrics internally consistent when rows are rejected', () => {
    const plan = buildSbisIndustryImportPlan(
      [
        sourceRow(),
        sourceRow({ rowNumber: 3, inn: '123' }),
        sourceRow({ rowNumber: 4, website: 'docs.alpha.ru' }),
      ],
      [],
      OPTIONS,
    );

    expect(plan.metrics.inputRows).toBe(3);
    expect(plan.metrics.acceptedRows + plan.metrics.rejectedRows).toBe(3);
    expect(plan.metrics.uniqueIncomingInns).toBe(
      plan.metrics.inserts
      + plan.metrics.updates
      + plan.metrics.noops
      + plan.metrics.blockedExistingDuplicates,
    );
  });

  it('accepts contact-only companies only with a usable website or email', () => {
    const plan = buildSbisContactImportPlan(
      [
        sourceRow({
          inn: '7704414297',
          email: null,
          website: 'alpha.ru',
        }),
        sourceRow({
          rowNumber: 3,
          inn: '7729058675',
          email: 'info@jet.su',
          website: null,
        }),
        sourceRow({
          rowNumber: 4,
          inn: '7811643020',
          email: null,
          website: null,
          phones: '+7 812 123-45-67',
        }),
        sourceRow({
          rowNumber: 5,
          inn: '2311191810',
          email: 'olgaritter@mail.r',
          website: null,
        }),
        sourceRow({
          rowNumber: 6,
          inn: '9909564917',
          email: 'your@mail.com',
          website: null,
        }),
        sourceRow({
          rowNumber: 7,
          inn: '212401514249',
          email: 'Контакт: SALES@JET.SU olgaritter@mail.r',
          website: null,
        }),
      ],
      [],
      CONTACT_OPTIONS,
    );

    expect(plan.inserts.map((row) => row.inn)).toEqual([
      '212401514249',
      '7704414297',
      '7729058675',
    ]);
    expect(plan.inserts[0].email).toBe('sales@jet.su');
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inn: '7811643020',
          reason: 'missing_website_or_email',
        }),
        expect.objectContaining({
          inn: '2311191810',
          reason: 'missing_website_or_email',
        }),
        expect.objectContaining({
          inn: '9909564917',
          reason: 'missing_website_or_email',
        }),
      ]),
    );
    expect(plan.metrics.skippedMissingContact).toBe(3);
  });

  it('maps known SBIS activities to different approximate parent industries', () => {
    const plan = buildSbisContactImportPlan(
      [
        sourceRow(),
        sourceRow({
          rowNumber: 3,
          inn: '7729058675',
          activity_type:
            'Компьютеры и комплектующие, вычислительная техника, оргтехника',
          email: 'info@jet.su',
          website: null,
        }),
        sourceRow({
          rowNumber: 4,
          inn: '212401514249',
          activity_type: 'Неизвестная рубрика',
          email: 'sales@jet.su',
          website: null,
        }),
      ],
      [],
      CONTACT_OPTIONS,
    );

    const insertsByInn = new Map(
      plan.inserts.map((insert) => [insert.inn, insert]),
    );
    expect(insertsByInn.get('7704414297')).toMatchObject({
      activity_type: 'Программное обеспечение',
      okved_code: '62.0',
      okved_code_exact: null,
      okved_exact_source: null,
      source_file: 'Компании (2).xlsx',
    });
    expect(insertsByInn.get('7729058675')).toMatchObject({
      activity_type:
        'Компьютеры и комплектующие, вычислительная техника, оргтехника',
      okved_code: '46.51',
      okved_code_exact: null,
      okved_exact_source: null,
    });
    expect(insertsByInn.get('212401514249')).toMatchObject({
      activity_type: 'Неизвестная рубрика',
      okved_code: null,
      okved_code_exact: null,
      okved_exact_source: null,
    });
  });

  it('keeps approximate software rows in parent 62/62.0 but not in a narrow child branch', () => {
    expect(collectDescendantCodes('62')).toContain('62.0');
    expect(collectDescendantCodes('62.0')).toContain('62.0');
    expect(collectDescendantCodes('62.02')).not.toContain('62.0');
  });

  it('fills only empty contacts in contact-only mode', () => {
    const existing: ExistingDirectoryRow = {
      id: 40,
      inn: '7704414297',
      website: null,
      email: 'current@alpha.ru',
      phones: '+74950000000',
      okved_code: '63.11',
      okved_code_exact: '62.01',
      okved_exact_source: 'dadata',
      name: null,
      employees_count: null,
      region_code: null,
    };

    const plan = buildSbisContactImportPlan(
      [sourceRow()],
      [existing],
      CONTACT_OPTIONS,
    );

    expect(plan.updates).toEqual([
      {
        id: 40,
        inn: '7704414297',
        patch: {
          website: 'alpha.ru',
        },
      },
    ]);
    expect(plan.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inn: '7704414297',
          kind: 'existing_value_preserved',
          field: 'email',
        }),
        expect.objectContaining({
          inn: '7704414297',
          kind: 'existing_value_preserved',
          field: 'phones',
        }),
        expect.objectContaining({
          inn: '7704414297',
          kind: 'existing_value_preserved',
          field: 'okved_code',
        }),
      ]),
    );
  });

  it('fills a missing approximate industry on an existing row without overwriting exact OKVED', () => {
    const existing: ExistingDirectoryRow = {
      id: 41,
      inn: '7704414297',
      website: null,
      email: 'hello@alpha.ru',
      phones: '+74951112233',
      okved_code: null,
      okved_code_exact: '58.29',
      okved_exact_source: 'dadata',
    };

    const plan = buildSbisContactImportPlan(
      [sourceRow()],
      [existing],
      CONTACT_OPTIONS,
    );

    expect(plan.updates).toEqual([
      {
        id: 41,
        inn: '7704414297',
        patch: {
          website: 'alpha.ru',
          okved_code: '62.0',
        },
      },
    ]);
    expect(existing.okved_code_exact).toBe('58.29');
    expect(existing.okved_exact_source).toBe('dadata');
  });

  it('plans two contact files sequentially without duplicate inserts', () => {
    const firstFileRows = [
      sourceRow({
        email: null,
        website: 'alpha.ru',
      }),
    ];
    const secondFileRows = [
      sourceRow({
        email: 'hello@alpha.ru',
        website: null,
      }),
      sourceRow({
        rowNumber: 3,
        inn: '7729058675',
        name: 'АО "ИНФОСИСТЕМЫ ДЖЕТ"',
        email: 'info@jet.su',
        website: null,
      }),
    ];

    const firstPlan = buildSbisContactImportPlan(
      firstFileRows,
      [],
      { sourceFile: 'Компании (1).xlsx' },
    );
    const afterFirst = applySbisImportPlan([], firstPlan);
    const secondPlan = buildSbisContactImportPlan(
      secondFileRows,
      afterFirst,
      CONTACT_OPTIONS,
    );
    const afterSecond = applySbisImportPlan(afterFirst, secondPlan);

    expect(firstPlan.metrics.inserts).toBe(1);
    expect(secondPlan.metrics.inserts).toBe(1);
    expect(secondPlan.metrics.updates).toBe(1);
    expect(afterSecond.map((row) => row.inn)).toEqual([
      '7704414297',
      '7729058675',
    ]);
    expect(new Set(afterSecond.map((row) => row.id)).size).toBe(2);
    expect(afterSecond[0]).toMatchObject({
      website: 'alpha.ru',
      email: 'hello@alpha.ru',
    });

    const repeatedFirst = buildSbisContactImportPlan(
      firstFileRows,
      afterSecond,
      { sourceFile: 'Компании (1).xlsx' },
    );
    const repeatedSecond = buildSbisContactImportPlan(
      secondFileRows,
      applySbisImportPlan(afterSecond, repeatedFirst),
      CONTACT_OPTIONS,
    );
    expect(repeatedFirst.metrics.inserts).toBe(0);
    expect(repeatedFirst.metrics.updates).toBe(0);
    expect(repeatedSecond.metrics.inserts).toBe(0);
    expect(repeatedSecond.metrics.updates).toBe(0);
  });
});
