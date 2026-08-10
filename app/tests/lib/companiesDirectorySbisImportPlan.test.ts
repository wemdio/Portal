/** @jest-environment node */

import {
  applySbisImportPlan,
  buildSbisContactImportPlan,
  buildSbisIndustryImportPlan,
  buildStrictSbisContactImportPlan,
  buildStrictSbisContactImportPlanV2,
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

const STRICT_CONTACT_OPTIONS = {
  sourceFile: 'strict-contacts.xlsx',
};

const STRICT_CONTACT_V2_OPTIONS = {
  sourceFile: 'selecom-2026-08-03',
};

type StrictSbisDirectoryInputRow = SbisDirectoryInputRow & {
  source_activity?: unknown;
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

function strictSourceRow(
  overrides: Partial<StrictSbisDirectoryInputRow> = {},
): StrictSbisDirectoryInputRow {
  return {
    ...sourceRow(),
    activity_type: 'Agriculture',
    source_activity: '01.00 - Agriculture',
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

describe('strict SBIS contact import contract', () => {
  it('drops technical service email domains and their subdomains but keeps a company email', () => {
    const plan = buildStrictSbisContactImportPlan(
      [
        strictSourceRow({
          email: [
            'robot@eo.tensor.ru',
            'docs@notify.diadoc.ru',
            'dealer@sub.saby.ru',
            'SALES@ALPHA.RU',
          ].join(', '),
          website: null,
        }),
        strictSourceRow({
          rowNumber: 3,
          inn: '7729058675',
          email: 'robot@sub.eo.tensor.ru, dealer@saby.ru',
          website: null,
        }),
      ],
      [],
      STRICT_CONTACT_OPTIONS,
    );

    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      inn: '7704414297',
      email: 'sales@alpha.ru',
      website: null,
    });
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        inn: '7729058675',
        reason: 'missing_website_or_email',
      }),
    );
  });

  it('drops pseudo-sites, aggregators and social profiles but keeps a corporate domain', () => {
    const blockedWebsites = [
      'company.aspx',
      'https://online.sbis.ru/Company.aspx?id=1',
      'https://2gis.ru/moscow/firm/1',
      'https://m.avito.ru/example',
      'https://biziq.ru/company/example',
      'https://instagram.com/example',
      'https://list-org.com/company/1',
      'https://ok.ru/example',
      'https://rusprofile.ru/id/1',
      'https://t.me/example',
      'https://vk.com/example',
      'https://maps.yandex.ru/example',
      'https://youtube.com/@example',
    ];
    const plan = buildStrictSbisContactImportPlan(
      [
        strictSourceRow({
          email: null,
          website: [...blockedWebsites, 'https://www.alpha.ru/about'].join(', '),
        }),
        strictSourceRow({
          rowNumber: 3,
          inn: '7729058675',
          email: null,
          website: blockedWebsites.join(', '),
        }),
      ],
      [],
      STRICT_CONTACT_OPTIONS,
    );

    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      inn: '7704414297',
      email: null,
      website: 'alpha.ru',
    });
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        inn: '7729058675',
        reason: 'missing_website_or_email',
      }),
    );
  });

  it('updates only blank website or email fields and never changes phones or OKVED', () => {
    const existing: ExistingDirectoryRow = {
      id: 60,
      inn: '7704414297',
      website: null,
      email: 'current@alpha.ru',
      phones: null,
      okved_code: null,
      okved_code_exact: '62.01',
      okved_exact_source: 'fns',
    };
    const plan = buildStrictSbisContactImportPlan(
      [
        strictSourceRow({
          website: 'https://www.alpha.ru/about',
          email: 'incoming@alpha.ru',
          phones: '+7 (495) 111-22-33',
          source_activity: '01.00 - Agriculture',
        }),
      ],
      [existing],
      STRICT_CONTACT_OPTIONS,
    );

    expect(plan.updates).toEqual([
      {
        id: 60,
        inn: '7704414297',
        patch: { website: 'alpha.ru' },
      },
    ]);
    expect(applySbisImportPlan([existing], plan)[0]).toMatchObject({
      website: 'alpha.ru',
      email: 'current@alpha.ru',
      phones: null,
      okved_code: null,
      okved_code_exact: '62.01',
      okved_exact_source: 'fns',
    });
  });

  it('blocks inserts and updates when the target contains duplicate rows for one INN', () => {
    const plan = buildStrictSbisContactImportPlan(
      [strictSourceRow()],
      [
        { id: 70, inn: '7704414297', website: null, email: null },
        { id: 71, inn: '7704414297', website: null, email: null },
      ],
      STRICT_CONTACT_OPTIONS,
    );

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.metrics.blockedExistingDuplicates).toBe(1);
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({
        inn: '7704414297',
        kind: 'duplicate_existing_inn',
        existingIds: [70, 71],
      }),
    );
  });

  it('inserts new companies only when at least one cleaned website or email remains', () => {
    const plan = buildStrictSbisContactImportPlan(
      [
        strictSourceRow({
          email: 'sales@alpha.ru',
          website: null,
          phones: '+7 495 111-22-33',
        }),
        strictSourceRow({
          rowNumber: 3,
          inn: '7729058675',
          email: null,
          website: 'https://jet.su/products',
        }),
        strictSourceRow({
          rowNumber: 4,
          inn: '7811643020',
          email: 'robot@eo.tensor.ru',
          website: 'company.aspx',
          phones: '+7 812 123-45-67',
        }),
      ],
      [],
      STRICT_CONTACT_OPTIONS,
    );

    expect(plan.inserts.map((row) => row.inn)).toEqual([
      '7704414297',
      '7729058675',
    ]);
    expect(plan.inserts.every((row) => row.phones === null)).toBe(true);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        inn: '7811643020',
        reason: 'missing_website_or_email',
      }),
    );
  });

  it('maps source classification to a parent approximate OKVED and never to exact OKVED', () => {
    const mapped = mapSbisWorksheetRecord(
      {
        'Название': 'ООО "АЛЬФА"',
        'ИНН': '7704414297',
        'Адрес': 'г. Москва',
        'Количество сотрудников': 12,
        'Телефоны': null,
        email: 'sales@alpha.ru',
        'Выручка': null,
        'Источник': '01.00 - Agriculture',
      },
      2,
    ) as StrictSbisDirectoryInputRow;

    expect(mapped.source_activity).toBe('01.00 - Agriculture');

    const plan = buildStrictSbisContactImportPlan(
      [mapped],
      [],
      STRICT_CONTACT_OPTIONS,
    );
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      inn: '7704414297',
      okved_code: '01',
      okved_code_exact: null,
      okved_exact_source: null,
    });

    const invalidParent = buildStrictSbisContactImportPlan(
      [strictSourceRow({ source_activity: '00.00 - Not an OKVED class' })],
      [],
      STRICT_CONTACT_OPTIONS,
    );
    expect(invalidParent.inserts[0]?.okved_code).toBeNull();
  });
});

describe('strict registry contact import v2 contract', () => {
  it('keeps v1 frozen while v2 retains only strict Russian phones for a digital insert', () => {
    const row = strictSourceRow({
      email: 'sales@alpha.ru',
      website: null,
      phones: [
        '+7 (495) 111-22-33',
        '+7 (123) 111-22-33',
        '+375 (29) 111-22-33',
        '12345',
      ].join(', '),
    });

    const v1 = buildStrictSbisContactImportPlan(
      [row],
      [],
      STRICT_CONTACT_OPTIONS,
    );
    const v2 = buildStrictSbisContactImportPlanV2(
      [row],
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(v1.inserts[0].phones).toBeNull();
    expect(v2.inserts[0]).toMatchObject({
      inn: '7704414297',
      email: 'sales@alpha.ru',
      phones: '+74951112233',
    });
  });

  it('still skips a new company when its only usable contact is a phone', () => {
    const plan = buildStrictSbisContactImportPlanV2(
      [strictSourceRow({ email: null, website: null, phones: '8 495 111-22-33' })],
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        inn: '7704414297',
        reason: 'missing_website_or_email',
      }),
    );
  });

  it('allows phone-only enrichment for an existing unique INN with a blank phone', () => {
    const existing: ExistingDirectoryRow = {
      id: 80,
      inn: '7704414297',
      email: null,
      website: null,
      phones: null,
      okved_code: null,
      okved_code_exact: null,
      okved_exact_source: null,
    };
    const plan = buildStrictSbisContactImportPlanV2(
      [strictSourceRow({ email: null, website: null, phones: '8 495 111-22-33' })],
      [existing],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(plan.skipped).toHaveLength(0);
    expect(plan.updates).toEqual([
      {
        id: 80,
        inn: '7704414297',
        patch: { phones: '+74951112233' },
      },
    ]);
  });

  it('preserves populated contacts and records conflicts instead of overwriting them', () => {
    const existing: ExistingDirectoryRow = {
      id: 81,
      inn: '7704414297',
      email: 'current@alpha.ru',
      website: 'current-alpha.ru',
      phones: '+74950000000',
      okved_code: '62',
      okved_code_exact: '62.01',
      okved_exact_source: 'fns',
    };
    const plan = buildStrictSbisContactImportPlanV2(
      [
        strictSourceRow({
          email: 'incoming@alpha.ru',
          website: 'incoming-alpha.ru',
          phones: '+7 495 111-22-33',
          source_activity: '01.00 - Agriculture',
        }),
      ],
      [existing],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(plan.updates).toHaveLength(0);
    expect(plan.noops).toEqual(['7704414297']);
    expect(plan.conflicts).toEqual(
      expect.arrayContaining(
        ['email', 'website', 'phones'].map((field) =>
          expect.objectContaining({
            inn: '7704414297',
            kind: 'existing_value_preserved',
            field,
          })),
      ),
    );
    expect(applySbisImportPlan([existing], plan)[0]).toEqual(existing);
  });

  it('blocks enrichment when the target already has duplicate rows for the INN', () => {
    const plan = buildStrictSbisContactImportPlanV2(
      [strictSourceRow({ email: null, website: null, phones: '+7 495 111-22-33' })],
      [
        { id: 83, inn: '7704414297', phones: null },
        { id: 82, inn: '7704414297', phones: null },
      ],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.metrics.blockedExistingDuplicates).toBe(1);
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({
        inn: '7704414297',
        kind: 'duplicate_existing_inn',
        existingIds: [82, 83],
      }),
    );
  });

  it('stores only a two-digit approximate parent and leaves exact OKVED provenance empty', () => {
    const plan = buildStrictSbisContactImportPlanV2(
      [
        strictSourceRow({
          source_activity: '62.02.3 - IT consulting',
          email: 'sales@alpha.ru',
          website: null,
        }),
      ],
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(plan.inserts[0]).toMatchObject({
      inn: '7704414297',
      okved_code: '62',
      okved_code_exact: null,
      okved_exact_source: null,
    });
  });

  it('quarantines new rows with a missing or conflicting parent OKVED', () => {
    const missing = buildStrictSbisContactImportPlanV2(
      [strictSourceRow({ source_activity: null, email: 'sales@alpha.ru' })],
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );
    const conflicting = buildStrictSbisContactImportPlanV2(
      [
        strictSourceRow({
          rowNumber: 2,
          source_activity: '62.01 - Software development',
          email: 'sales@alpha.ru',
        }),
        strictSourceRow({
          rowNumber: 3,
          source_activity: '46.51 - Wholesale of computers',
          email: 'hello@alpha.ru',
        }),
      ],
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );
    const missingActivity = buildStrictSbisContactImportPlanV2(
      [strictSourceRow({ activity_type: null, email: 'sales@alpha.ru' })],
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(missing.inserts).toHaveLength(0);
    expect(missing.skipped).toContainEqual(expect.objectContaining({
      inn: '7704414297',
      reason: 'missing_parent_okved',
    }));
    expect(conflicting.inserts).toHaveLength(0);
    expect(conflicting.skipped).toContainEqual(expect.objectContaining({
      inn: '7704414297',
      reason: 'conflicting_parent_okved',
    }));
    expect(missingActivity.inserts).toHaveLength(0);
    expect(missingActivity.skipped).toContainEqual(expect.objectContaining({
      inn: '7704414297',
      reason: 'missing_activity_type',
    }));
    expect(missing.metrics.skippedMissingContact).toBe(0);
    expect(conflicting.metrics.skippedMissingContact).toBe(0);
    expect(missingActivity.metrics.skippedMissingContact).toBe(0);
  });

  it('keeps v1 ordering frozen while v2 emits the strict canonical email order', () => {
    const rows = [
      strictSourceRow({
        rowNumber: 2,
        email: 'martin-ufa@mail.ru',
        website: null,
      }),
      strictSourceRow({
        rowNumber: 3,
        email: 'martin-ufa2013@mail.ru',
        website: null,
      }),
    ];

    const v1 = buildStrictSbisContactImportPlan(
      rows,
      [],
      STRICT_CONTACT_OPTIONS,
    );
    const v2 = buildStrictSbisContactImportPlanV2(
      rows,
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(v1.inserts[0]?.email).toBe(
      'martin-ufa@mail.ru, martin-ufa2013@mail.ru',
    );
    expect(v2.inserts[0]?.email).toBe(
      'martin-ufa2013@mail.ru, martin-ufa@mail.ru',
    );
  });

  it('removes malformed websites before freezing a v2 insert', () => {
    const plan = buildStrictSbisContactImportPlanV2(
      [strictSourceRow({
        email: 'sales@alpha.ru',
        website: 'https://moltransavto..ru, moltransavto.su',
      })],
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(plan.inserts[0]?.website).toBe('moltransavto.su');
  });

  it('checks v2 insert eligibility after removing malformed websites', () => {
    const plan = buildStrictSbisContactImportPlanV2(
      [strictSourceRow({
        email: null,
        website: 'https://moltransavto..ru',
        phones: '+7 495 111-22-33',
      })],
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.skipped).toContainEqual(expect.objectContaining({
      inn: '7704414297',
      reason: 'missing_website_or_email',
    }));
  });

  it('does not strip valid leading punctuation from a v2 email local part', () => {
    const plan = buildStrictSbisContactImportPlanV2(
      [strictSourceRow({
        email: "'sales@alpha.ru",
        website: null,
      })],
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(plan.inserts[0]?.email).toBe("'sales@alpha.ru");
  });

  it('deduplicates repeated source rows deterministically regardless of input order', () => {
    const rows = [
      strictSourceRow({
        rowNumber: 2,
        email: 'zeta@alpha.ru',
        website: 'https://zeta.alpha.ru/about',
        phones: '+7 495 999-88-77',
      }),
      strictSourceRow({
        rowNumber: 3,
        email: 'alpha@alpha.ru',
        website: 'https://www.alpha.ru/about',
        phones: '8 495 111-22-33',
      }),
    ];

    const forward = buildStrictSbisContactImportPlanV2(
      rows,
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );
    const reversed = buildStrictSbisContactImportPlanV2(
      [...rows].reverse(),
      [],
      STRICT_CONTACT_V2_OPTIONS,
    );

    expect(forward).toEqual(reversed);
    expect(forward.metrics).toMatchObject({
      inputRows: 2,
      uniqueIncomingInns: 1,
      duplicateIncomingRows: 1,
      inserts: 1,
    });
    expect(forward.inserts[0]).toMatchObject({
      email: 'alpha@alpha.ru, zeta@alpha.ru',
      website: 'alpha.ru, zeta.alpha.ru',
      phones: '+74951112233, +74959998877',
    });
  });
});
