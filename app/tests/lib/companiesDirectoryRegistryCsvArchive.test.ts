/** @jest-environment node */

import archiver from 'archiver';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  readRegistryV2Archive,
  readRegistryV2CsvFile,
} from '@/lib/companiesDirectory/registryCsvArchive';

const LEGAL_CORE_HEADERS = [
  'Сокращенное наименование', 'Полное наименование', 'ОГРН', 'ИНН', 'КПП',
  'Телефоны', 'Email', 'Веб-сайт', 'Статус', 'Дата регистрации', 'Регион',
  'Юридический адрес', 'Код ОКВЭД-2', 'Основной вид деятельности',
  'Руководитель', 'Должность', 'ИНН руководителя', 'ССЧ', 'Реестр МСП',
  'Уставный капитал', 'Специальные налоговые режимы', 'Уплаченные налоги',
  'Сумма контрактов - заказчик', 'Сумма контрактов - поставщик',
] as const;

const ENTREPRENEUR_HEADERS = [
  'Тип', 'ФИО', 'ОГРНИП', 'ИНН', 'Email', 'Статус', 'Дата регистрации',
  'Регион', 'Населенный пункт', 'Код ОКВЭД-2', 'Основной вид деятельности',
  'Реестр МСП', 'Специальные налоговые режимы',
  'Сумма контрактов - заказчик', 'Сумма контрактов - поставщик',
] as const;

function legalHeaders(years: number[]): string[] {
  return [
    ...LEGAL_CORE_HEADERS.slice(0, 20),
    ...years.flatMap((year) => [
      `Капитал (${year})`, `Выручка (${year})`, `Чистая прибыль (${year})`,
    ]),
    ...LEGAL_CORE_HEADERS.slice(20),
  ];
}

function csv(headers: readonly string[], rows: Array<Record<string, unknown>>): string {
  const encode = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return [
    headers.map(encode).join(';'),
    ...rows.map((row) => headers.map((header) => encode(row[header])).join(';')),
  ].join('\r\n');
}

async function zipBuffer(entries: Array<{ name: string; contents: string | Buffer }>): Promise<Buffer> {
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
  for (const entry of entries) archive.append(entry.contents, { name: entry.name });
  await archive.finalize();
  await completed;
  return Buffer.concat(chunks);
}

describe('Polza registry v2 ZIP/CSV reader', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'registry-v2-archive-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    [[2023, 2024], 30],
    [[2022, 2023, 2024, 2025], 36],
  ])('accepts a legal-entity CSV with %s finance years (%i columns)', async (years) => {
    const headers = legalHeaders(years as number[]);
    const active = {
      'Сокращенное наименование': 'ООО "АЛЬФА"',
      'Полное наименование': 'ООО «АЛЬФА; ТЕХ»\nвторая строка',
      ОГРН: '1177746494166', ИНН: '7704414297', КПП: '770401001',
      Телефоны: '8 (495) 111-22-33', Email: 'sales@alpha.ru',
      'Веб-сайт': 'https://alpha.ru/about', Статус: 'Действующее',
      Регион: 'Москва', 'Юридический адрес': 'г. Москва',
      'Код ОКВЭД-2': '62.01', 'Основной вид деятельности': 'Разработка ПО',
      Руководитель: 'Иванов Иван Иванович', ССЧ: '12',
      [`Выручка (${Math.max(...(years as number[]))})`]: '123456',
    };
    const inactive = { ...active, ИНН: '7729058675', Статус: 'Ликвидировано' };
    const archivePath = join(directory, `legal-${headers.length}.zip`);
    await writeFile(archivePath, await zipBuffer([{
      name: `legal-${headers.length}.csv`,
      contents: csv(headers, [active, inactive]),
    }]));

    const result = await readRegistryV2Archive(archivePath);

    expect(result).toMatchObject({
      schema: 'legal-entity',
      entryName: `legal-${headers.length}.csv`,
      inputRows: 2,
    });
    expect(result.activeRows).toHaveLength(1);
    expect(result.activeRows[0]).toMatchObject({
      inn: '7704414297',
      phones: '8 (495) 111-22-33',
      email: 'sales@alpha.ru',
      website: 'https://alpha.ru/about',
      source_activity: '62.01 - Разработка ПО',
      revenue: '123456',
    });
    expect(result.filteredStatuses).toEqual([
      expect.objectContaining({ inn: '7729058675', status: 'Ликвидировано' }),
    ]);
  });

  it('accepts the 15-column entrepreneur schema and an ENT archive/member name mismatch', async () => {
    const archivePath = join(directory, 'ENT42QCEM.csv.zip');
    await writeFile(archivePath, await zipBuffer([{
      name: '42QCEM.csv',
      contents: csv(ENTREPRENEUR_HEADERS, [{
        Тип: 'ИП', ФИО: 'Иванов Иван Иванович', ОГРНИП: '322774600000001',
        ИНН: '772138583200', Email: 'owner@example.ru',
        Статус: 'Действующий ИП', Регион: 'Москва',
        'Населенный пункт': 'Москва', 'Код ОКВЭД-2': '47.91',
        'Основной вид деятельности': 'Торговля через Интернет',
      }]),
    }]));

    const result = await readRegistryV2Archive(archivePath);

    expect(result).toMatchObject({
      schema: 'entrepreneur',
      archiveName: 'ENT42QCEM.csv.zip',
      entryName: '42QCEM.csv',
      inputRows: 1,
    });
    expect(result.activeRows[0]).toMatchObject({
      name: 'ИП Иванов Иван Иванович',
      inn: '772138583200',
      ogrn: '322774600000001',
      email: 'owner@example.ru',
      source_activity: '47.91 - Торговля через Интернет',
    });
  });

  it('reads the same guarded schema from a standalone CSV source', async () => {
    const headers = legalHeaders([2023, 2024]);
    const csvPath = join(directory, 'WIRUJA.csv');
    await writeFile(csvPath, csv(headers, [{
      'Сокращенное наименование': 'ООО "АЛЬФА"',
      ОГРН: '1177746494166', ИНН: '7704414297', Статус: 'Действующее',
      Email: 'sales@alpha.ru', 'Код ОКВЭД-2': '62.01',
      'Основной вид деятельности': 'Разработка ПО',
    }]), 'utf8');

    const result = await readRegistryV2CsvFile(csvPath);

    expect(result).toMatchObject({
      sourceFile: 'WIRUJA.csv',
      schema: 'legal-entity',
      inputRows: 1,
    });
    expect(result.fileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.activeRows[0]).toMatchObject({ inn: '7704414297' });
  });

  it('rejects empty, nested, multiple-member and non-CSV archives', async () => {
    const fixtures = [
      { name: 'empty.zip', entries: [] },
      { name: 'nested.zip', entries: [{ name: 'nested/data.csv', contents: 'x' }] },
      { name: 'multiple.zip', entries: [
        { name: 'a.csv', contents: 'x' }, { name: 'b.csv', contents: 'x' },
      ] },
      { name: 'text.zip', entries: [{ name: 'data.txt', contents: 'x' }] },
    ];
    for (const fixture of fixtures) {
      const archivePath = join(directory, fixture.name);
      await writeFile(archivePath, await zipBuffer(fixture.entries));
      const reading = readRegistryV2Archive(archivePath);
      if (fixture.name === 'empty.zip') {
        await expect(reading).rejects.toMatchObject({ code: 'empty_archive' });
      } else {
        await expect(reading).rejects.toThrow(/archive|CSV|root|empty/i);
      }
    }
  });

  it('rejects invalid UTF-8 and an entry over the configured size limit', async () => {
    const invalidPath = join(directory, 'invalid-utf8.zip');
    await writeFile(invalidPath, await zipBuffer([{
      name: 'data.csv',
      contents: Buffer.from([0xff, 0xfe, 0xfd]),
    }]));
    await expect(readRegistryV2Archive(invalidPath)).rejects.toThrow(/UTF-8/i);

    const oversizedPath = join(directory, 'oversized.zip');
    await writeFile(oversizedPath, await zipBuffer([{
      name: 'data.csv',
      contents: Buffer.alloc(2_048, 65),
    }]));
    await expect(readRegistryV2Archive(oversizedPath, {
      maxUncompressedBytes: 1_024,
    })).rejects.toThrow(/size|large|bytes/i);
  });
});
