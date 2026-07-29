/** @jest-environment node */

import archiver from 'archiver';
import { PassThrough, Readable } from 'node:stream';

import {
  mergeFnsSmeExactOkvedRecord,
  parseFnsSmeXmlStream,
  parseFnsSmeZipStream,
  type FnsSmeExactOkvedRecord,
  type FnsSmeInvalidExactOkvedRecord,
} from '@/lib/companiesDirectory/fnsSmeXml';

const ENTRY_NAME = 'VO_RRMSP_TEST_20260710_001.xml';
const FILE_ID = 'VO_RRMSP_TEST_20260710_001';
const REGISTRY_DATE = '10.07.2026';

type DocumentOptions = {
  id?: string;
  taxpayerType?: 'legal_entity' | 'individual_entrepreneur';
  inn?: string;
  ogrn?: string | null;
  registryDate?: string | null;
  mainOkved?: string | null;
  mainOkvedVersion?: '2001' | '2014';
  additionalOkveds?: string[];
  reportingMainOkved?: string | null;
  reportingAdditionalOkveds?: string[];
};

type FileOptions = {
  fileId?: string | null;
  formatVersion?: string;
  informationType?: string;
  declaredDocumentCount?: number;
};

function documentXml({
  id = 'doc-1',
  taxpayerType = 'legal_entity',
  inn = '7704414297',
  ogrn = taxpayerType === 'legal_entity'
    ? '1177746494166'
    : '322890100023953',
  registryDate = REGISTRY_DATE,
  mainOkved = '62.01',
  mainOkvedVersion = '2014',
  additionalOkveds = [],
  reportingMainOkved = null,
  reportingAdditionalOkveds = [],
}: DocumentOptions = {}): string {
  const registrationAttribute = ogrn === null
    ? ''
    : taxpayerType === 'legal_entity'
      ? ` ОГРН="${ogrn}"`
      : ` ОГРНИП="${ogrn}"`;
  const taxpayer = taxpayerType === 'legal_entity'
    ? `<ОргВклМСП НаимОрг="ООО ТЕСТ" ИННЮЛ="${inn}"${registrationAttribute}/>`
    : `<ИПВклМСП ИННФЛ="${inn}"${registrationAttribute}/>`;
  const registryDateAttribute = registryDate === null
    ? ''
    : ` ДатаСост="${registryDate}"`;
  const declaredOkved = mainOkved !== null || additionalOkveds.length > 0
    ? [
      '<СвОКВЭД>',
      mainOkved === null
        ? ''
        : `<СвОКВЭДОсн КодОКВЭД="${mainOkved}" НаимОКВЭД="Основной" ВерсОКВЭД="${mainOkvedVersion}"/>`,
      ...additionalOkveds.map((code) =>
        `<СвОКВЭДДоп КодОКВЭД="${code}" НаимОКВЭД="Дополнительный" ВерсОКВЭД="2014"/>`
      ),
      '</СвОКВЭД>',
    ].join('')
    : '';
  const reportingOkved = reportingMainOkved !== null
    || reportingAdditionalOkveds.length > 0
    ? [
      '<СвОКВЭДотч>',
      reportingMainOkved === null
        ? ''
        : `<СвОКВЭДОсн КодОКВЭД="${reportingMainOkved}" НаимОКВЭД="Отчетный основной" ВерсОКВЭД="2014"/>`,
      ...reportingAdditionalOkveds.map((code) =>
        `<СвОКВЭДДоп КодОКВЭД="${code}" НаимОКВЭД="Отчетный дополнительный" ВерсОКВЭД="2014"/>`
      ),
      '</СвОКВЭДотч>',
    ].join('')
    : '';

  return [
    `<Документ ИдДок="${id}"${registryDateAttribute} ДатаВклМСП="10.07.2020"`,
    ' ВидСубМСП="1" КатСубМСП="1" ПризНовМСП="2" СведСоцПред="2">',
    taxpayer,
    '<СвМН КодРегион="77"/>',
    declaredOkved,
    reportingOkved,
    '</Документ>',
  ].join('');
}

function fileXml(
  documents: string[],
  {
    fileId = FILE_ID,
    formatVersion = '4.06',
    informationType = 'РЕЕСТРМСП',
    declaredDocumentCount = documents.length,
  }: FileOptions = {},
): string {
  const fileIdAttribute = fileId === null ? '' : ` ИдФайл="${fileId}"`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Файл${fileIdAttribute} ВерсФорм="${formatVersion}"`,
    ` ТипИнф="${informationType}" КолДок="${declaredDocumentCount}">`,
    ...documents,
    '</Файл>',
  ].join('');
}

function chunkedReadable(value: string | Buffer, chunkSize = 7): Readable {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const chunks: Buffer[] = [];

  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, offset + chunkSize));
  }

  return Readable.from(chunks);
}

async function parseXml(
  xml: string,
  entryName = ENTRY_NAME,
): Promise<{
  records: FnsSmeExactOkvedRecord[];
  invalidRecords: FnsSmeInvalidExactOkvedRecord[];
  result: Awaited<ReturnType<typeof parseFnsSmeXmlStream>>;
}> {
  const records: FnsSmeExactOkvedRecord[] = [];
  const invalidRecords: FnsSmeInvalidExactOkvedRecord[] = [];
  const result = await parseFnsSmeXmlStream({
    input: chunkedReadable(xml),
    entryName,
    onRecord: async (record) => {
      records.push(record);
    },
    onInvalidIdentity: async (record) => {
      invalidRecords.push(record);
    },
  });

  return { records, invalidRecords, result };
}

async function zipBuffer(entries: Array<{
  name: string;
  contents: string;
}>): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 1 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  const completed = new Promise<void>((resolve, reject) => {
    output.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    output.once('end', resolve);
    output.once('error', reject);
    archive.once('error', reject);
  });

  archive.pipe(output);
  for (const entry of entries) {
    archive.append(entry.contents, { name: entry.name });
  }
  await archive.finalize();
  await completed;

  return Buffer.concat(chunks);
}

function exactRecord(
  overrides: Partial<FnsSmeExactOkvedRecord> = {},
): FnsSmeExactOkvedRecord {
  return {
    inn: '7704414297',
    ogrn: '1177746494166',
    taxpayerType: 'legal_entity',
    okvedCodeExact: '62.01',
    okvedVersion: '2014',
    documentId: 'doc-1',
    registryDate: REGISTRY_DATE,
    sourceEntryName: ENTRY_NAME,
    sourceFileId: FILE_ID,
    ...overrides,
  };
}

describe('FNS SME exact OKVED streaming XML parser', () => {
  it('emits only Документ/СвОКВЭД/СвОКВЭДОсн and ignores additional and reporting codes', async () => {
    const xml = fileXml([
      documentXml({
        id: 'legal-with-main',
        mainOkved: '62.01',
        additionalOkveds: ['47.91', '63.11.1'],
        reportingMainOkved: '01.41.1',
        reportingAdditionalOkveds: ['01.47'],
      }),
      documentXml({
        id: 'ip-without-declared-main',
        taxpayerType: 'individual_entrepreneur',
        inn: '212401514249',
        mainOkved: null,
        additionalOkveds: ['01.41.1'],
        reportingMainOkved: '62.02.2',
      }),
    ]);

    const { records, result } = await parseXml(xml);

    expect(records).toEqual([
      expect.objectContaining({
        inn: '7704414297',
        ogrn: '1177746494166',
        taxpayerType: 'legal_entity',
        okvedCodeExact: '62.01',
        okvedVersion: '2014',
        documentId: 'legal-with-main',
      }),
    ]);
    expect(records.map((record) => record.okvedCodeExact)).not.toEqual(
      expect.arrayContaining(['47.91', '63.11.1', '01.41.1', '01.47', '62.02.2']),
    );
    expect(result.metrics).toEqual(expect.objectContaining({
      documentCount: 2,
      emittedRecordCount: 1,
      skippedWithoutMainOkvedCount: 1,
    }));
  });

  it('accepts checksum-valid ЮЛ and ИП INNs and preserves auditable provenance', async () => {
    const xml = fileXml([
      documentXml({
        id: 'legal',
        inn: '7704414297',
        mainOkved: '62.01',
      }),
      documentXml({
        id: 'entrepreneur',
        taxpayerType: 'individual_entrepreneur',
        inn: '212401514249',
        mainOkved: '01.41.11',
      }),
    ]);

    const { records, result } = await parseXml(xml);

    expect(records).toEqual([
      expect.objectContaining({
        inn: '7704414297',
        taxpayerType: 'legal_entity',
        sourceEntryName: ENTRY_NAME,
        sourceFileId: FILE_ID,
        registryDate: REGISTRY_DATE,
      }),
      expect.objectContaining({
        inn: '212401514249',
        ogrn: '322890100023953',
        taxpayerType: 'individual_entrepreneur',
        sourceEntryName: ENTRY_NAME,
        sourceFileId: FILE_ID,
        registryDate: REGISTRY_DATE,
      }),
    ]);
    expect(result.metadata).toEqual({
      entryName: ENTRY_NAME,
      fileId: FILE_ID,
      formatVersion: '4.06',
      informationType: 'РЕЕСТРМСП',
      declaredDocumentCount: 2,
      registryDate: REGISTRY_DATE,
    });
  });

  it.each([
    ['ЮЛ with a bad checksum', 'legal_entity', '1234567890'],
    ['ЮЛ with an ИП-length INN', 'legal_entity', '212401514249'],
    ['ИП with a bad checksum', 'individual_entrepreneur', '123456789012'],
    ['ИП with a ЮЛ-length INN', 'individual_entrepreneur', '7704414297'],
    ['punctuation in INN', 'legal_entity', '77044-14297'],
  ] as const)('rejects %s', async (_label, taxpayerType, inn) => {
    const xml = fileXml([
      documentXml({ taxpayerType, inn }),
    ]);

    await expect(parseXml(xml)).rejects.toThrow(/ИНН|INN|checksum/i);
  });

  it.each([
    ['ЮЛ with a bad OGRN checksum', 'legal_entity', '1177746494167'],
    ['ИП with a bad OGRNIP checksum', 'individual_entrepreneur', '322890100023954'],
  ] as const)(
    'quarantines %s without emitting it as a registry record',
    async (_label, taxpayerType, ogrn) => {
      const xml = fileXml([
        documentXml({
          taxpayerType,
          inn: taxpayerType === 'legal_entity'
            ? '7704414297'
            : '212401514249',
          ogrn,
        }),
      ]);

      const { records, invalidRecords, result } = await parseXml(xml);

      expect(records).toEqual([]);
      expect(invalidRecords).toEqual([
        expect.objectContaining({
          inn: taxpayerType === 'legal_entity'
            ? '7704414297'
            : '212401514249',
          ogrn,
          taxpayerType,
          okvedCodeExact: '62.01',
          okvedVersion: '2014',
          reason: 'invalid_source_ogrn',
          validationError: expect.stringMatching(/checksum/i),
        }),
      ]);
      expect(result.metrics).toEqual(expect.objectContaining({
        documentCount: 1,
        emittedRecordCount: 0,
        skippedInvalidOgrnCount: 1,
      }));
    },
  );

  it.each([
    ['ЮЛ with an OGRNIP-length value', 'legal_entity', '322890100023953'],
    ['ИП with an OGRN-length value', 'individual_entrepreneur', '1177746494166'],
    ['punctuation in OGRN', 'legal_entity', '1177746-494166'],
  ] as const)('rejects structurally invalid %s', async (_label, taxpayerType, ogrn) => {
    const xml = fileXml([
      documentXml({
        taxpayerType,
        inn: taxpayerType === 'legal_entity'
          ? '7704414297'
          : '212401514249',
        ogrn,
      }),
    ]);

    await expect(parseXml(xml)).rejects.toThrow(/ОГРН|OGRN|checksum/i);
  });

  it.each([
    ['ЮЛ without ОГРН', 'legal_entity'],
    ['ИП without ОГРНИП', 'individual_entrepreneur'],
  ] as const)('rejects %s', async (_label, taxpayerType) => {
    const xml = fileXml([
      documentXml({
        taxpayerType,
        inn: taxpayerType === 'legal_entity'
          ? '7704414297'
          : '212401514249',
        ogrn: null,
      }),
    ]);

    await expect(parseXml(xml)).rejects.toThrow(/ОГРН|OGRN|required|missing/i);
  });

  it.each([
    '01',
    '01.4',
    '62.01',
    '01.41.1',
    '01.41.11',
  ])('accepts the FNS XSD OKVED format %s', async (okvedCodeExact) => {
    const { records } = await parseXml(fileXml([
      documentXml({ mainOkved: okvedCodeExact }),
    ]));

    expect(records[0]).toMatchObject({ okvedCodeExact });
  });

  it.each([
    '1',
    '1.2',
    '62.',
    '62.010',
    '62.1.01',
    '62.01.001',
    'A2.01',
    '62-01',
  ])('rejects a non-XSD OKVED format %s', async (mainOkved) => {
    await expect(parseXml(fileXml([
      documentXml({ mainOkved }),
    ]))).rejects.toThrow(/ОКВЭД|OKVED|format/i);
  });

  it('preserves ВерсОКВЭД so an OKVED-2001 code cannot be mistaken for OKVED-2', async () => {
    const { records } = await parseXml(fileXml([
      documentXml({
        mainOkved: '72.20',
        mainOkvedVersion: '2001',
      }),
    ]));

    expect(records[0]).toMatchObject({
      okvedCodeExact: '72.20',
      okvedVersion: '2001',
    });
  });

  it.each([
    ['unexpected ВерсФорм', { formatVersion: '4.05' }],
    ['unexpected ТипИнф', { informationType: 'ЕГРЮЛ' }],
  ] as const)('rejects an %s before emitting records', async (_label, options) => {
    const records: FnsSmeExactOkvedRecord[] = [];
    const xml = fileXml([documentXml()], options);

    await expect(parseFnsSmeXmlStream({
      input: chunkedReadable(xml),
      entryName: ENTRY_NAME,
      onRecord: async (record) => {
        records.push(record);
      },
      onInvalidIdentity: async () => undefined,
    })).rejects.toThrow(/ВерсФорм|ТипИнф|format|information type/i);
    expect(records).toHaveLength(0);
  });

  it('rejects КолДок drift instead of accepting an incomplete member', async () => {
    const xml = fileXml(
      [documentXml()],
      { declaredDocumentCount: 2 },
    );

    await expect(parseXml(xml)).rejects.toThrow(/КолДок|document count/i);
  });

  it.each([
    ['missing ИдФайл', fileXml([documentXml()], { fileId: null }), /ИдФайл|file id/i],
    [
      'missing ДатаСост',
      fileXml([documentXml({ registryDate: null })]),
      /ДатаСост|registry date/i,
    ],
    [
      'invalid ДатаСост format',
      fileXml([documentXml({ registryDate: '2026-07-10' })]),
      /ДатаСост|registry date/i,
    ],
  ] as const)('rejects %s', async (_label, xml, error) => {
    await expect(parseXml(xml)).rejects.toThrow(error);
  });

  it('rejects different ДатаСост values inside one XML member', async () => {
    const xml = fileXml([
      documentXml({ id: 'doc-1', registryDate: '10.07.2026' }),
      documentXml({
        id: 'doc-2',
        inn: '7729058675',
        registryDate: '11.07.2026',
      }),
    ]);

    await expect(parseXml(xml)).rejects.toThrow(/ДатаСост|registry date/i);
  });

  it('rejects malformed XML even when tags are split across tiny chunks', async () => {
    const malformed = fileXml([documentXml()])
      .replace('</Документ>', '');

    await expect(parseXml(malformed)).rejects.toThrow(/XML|malformed|unexpected/i);
  });
});

describe('FNS SME exact OKVED ZIP streaming parser', () => {
  it('streams every XML member and returns per-member and aggregate audit metadata', async () => {
    const firstEntry = ENTRY_NAME;
    const secondEntry = 'VO_RRMSP_TEST_20260710_002.xml';
    const archive = await zipBuffer([
      {
        name: firstEntry,
        contents: fileXml([
          documentXml({ id: 'legal', mainOkved: '62.01' }),
        ]),
      },
      {
        name: secondEntry,
        contents: fileXml([
          documentXml({
            id: 'ip',
            taxpayerType: 'individual_entrepreneur',
            inn: '212401514249',
            mainOkved: '01.41.11',
          }),
        ], {
          fileId: 'VO_RRMSP_TEST_20260710_002',
        }),
      },
    ]);
    const records: FnsSmeExactOkvedRecord[] = [];

    const result = await parseFnsSmeZipStream({
      input: chunkedReadable(archive, 11),
      onRecord: async (record) => {
        records.push(record);
      },
      onInvalidIdentity: async () => undefined,
    });

    expect(records.map((record) => [
      record.sourceEntryName,
      record.inn,
      record.okvedCodeExact,
    ])).toEqual([
      [firstEntry, '7704414297', '62.01'],
      [secondEntry, '212401514249', '01.41.11'],
    ]);
    expect(result.entries).toEqual([
      expect.objectContaining({
        entryName: firstEntry,
        fileId: FILE_ID,
        registryDate: REGISTRY_DATE,
      }),
      expect.objectContaining({
        entryName: secondEntry,
        fileId: 'VO_RRMSP_TEST_20260710_002',
        registryDate: REGISTRY_DATE,
      }),
    ]);
    expect(result.metrics).toEqual(expect.objectContaining({
      xmlEntryCount: 2,
      documentCount: 2,
      emittedRecordCount: 2,
    }));
  });
});

describe('FNS SME OGRN identity merge semantics', () => {
  it('deduplicates the same OGRN identity while preserving the first provenance', () => {
    const index = new Map<string, FnsSmeExactOkvedRecord>();
    const first = exactRecord();
    const duplicate = exactRecord({
      documentId: 'doc-2',
      sourceEntryName: 'VO_RRMSP_TEST_20260710_002.xml',
      sourceFileId: 'VO_RRMSP_TEST_20260710_002',
    });

    expect(mergeFnsSmeExactOkvedRecord(index, first)).toEqual({
      status: 'added',
      record: first,
    });
    expect(mergeFnsSmeExactOkvedRecord(index, duplicate)).toEqual({
      status: 'duplicate_same',
      record: first,
      duplicate,
    });
    expect(index).toEqual(new Map([['1177746494166', first]]));
  });

  it('keeps different registrations of one INN and rejects conflicting data for one OGRN', () => {
    const index = new Map<string, FnsSmeExactOkvedRecord>();
    mergeFnsSmeExactOkvedRecord(index, exactRecord());

    const secondRegistration = exactRecord({
      ogrn: '1177746494177',
      okvedCodeExact: '62.02.2',
      documentId: 'doc-second-registration',
    });
    expect(
      mergeFnsSmeExactOkvedRecord(index, secondRegistration),
    ).toEqual({
      status: 'added',
      record: secondRegistration,
    });

    expect(() =>
      mergeFnsSmeExactOkvedRecord(
        index,
        exactRecord({
          okvedCodeExact: '62.02.2',
          documentId: 'doc-conflict',
          sourceEntryName: 'VO_RRMSP_TEST_20260710_003.xml',
          sourceFileId: 'VO_RRMSP_TEST_20260710_003',
        }),
      )
    ).toThrow(/conflicting.*OGRN|OGRN.*conflicting|разн.*ОКВЭД/i);
    expect(index.get('1177746494166')?.okvedCodeExact).toBe('62.01');
    expect(index.get('1177746494177')?.okvedCodeExact).toBe('62.02.2');
  });
});
