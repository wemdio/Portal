/** @jest-environment node */

import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import {
  createTwoGisHeaderValidator,
  createSepDirectiveStripper,
  validateTwoGisLiveSnapshot,
  validateTwoGisImportStats,
} from '@/lib/twoGis/importSnapshot';
import { TWO_GIS_SOURCE_COLUMNS } from '@/lib/twoGis/types';

async function readUtf8(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('2GIS snapshot import core', () => {
  it('wires the CLI importer through the target, hash and statistics guards', () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), 'scripts', '2gis-dataset', 'import-snapshot.ts'),
      'utf8',
    );
    expect(script).toContain('assertTwoGisImportTarget');
    expect(script).toContain('calculateFileSha256');
    expect(script).toContain('validateTwoGisImportStats');
    expect(script).toContain('createTwoGisHeaderValidator');
    expect(script).toContain('HEADER false');
    expect(script).toContain('TWOGIS_IMPORT_DATABASE_URL');
    expect(script).toContain('regexp_split_to_table');
    expect(script).toContain('public.card_subcategories');
  });

  it('removes only the first physical sep directive and streams the CSV unchanged', async () => {
    const input = [
      '\uFEFFsep=;\r\n',
      '"id";"name";"city_name"\r\n',
      '"1";"Кафе ""Волна"";\nфилиал";"Москва"\r\n',
    ].join('');
    const source = Readable.from([
      Buffer.from(input.slice(0, 5)),
      Buffer.from(input.slice(5, 17)),
      Buffer.from(input.slice(17)),
    ]);

    const output = await readUtf8(source.pipe(createSepDirectiveStripper()));

    expect(output).toBe(
      '"id";"name";"city_name"\r\n'
      + '"1";"Кафе ""Волна"";\nфилиал";"Москва"\r\n',
    );
  });

  it('requires the exact 14-column header order before COPY and removes it', async () => {
    const header = TWO_GIS_SOURCE_COLUMNS.map((column) => `"${column}"`).join(';');
    const source = Readable.from([
      Buffer.from(`\uFEFFsep=;\r\n${header}\r\n"1";"Кафе"`),
    ]);

    const output = await readUtf8(
      source
        .pipe(createSepDirectiveStripper())
        .pipe(createTwoGisHeaderValidator(TWO_GIS_SOURCE_COLUMNS)),
    );

    expect(output).toBe('"1";"Кафе"');
  });

  it('rejects a reordered source header before COPY can map fields incorrectly', async () => {
    const wrongColumns = [...TWO_GIS_SOURCE_COLUMNS];
    [wrongColumns[5], wrongColumns[6]] = [wrongColumns[6], wrongColumns[5]];
    const source = Readable.from([
      Buffer.from(`${wrongColumns.map((column) => `"${column}"`).join(';')}\r\n"1"`),
    ]);

    await expect(
      readUtf8(source.pipe(createTwoGisHeaderValidator(TWO_GIS_SOURCE_COLUMNS))),
    ).rejects.toThrow(/header/i);
  });

  it('accepts the verified Russia snapshot counts', () => {
    expect(() =>
      validateTwoGisImportStats(
        {
          sourceRows: 4_284_928,
          acceptedRows: 4_284_927,
          rejectedRows: 1,
          duplicateIds: 0,
        },
        {
          expectedSourceRows: 4_284_928,
          expectedAcceptedRows: 4_284_927,
        },
      ),
    ).not.toThrow();
  });

  it.each([
    [{ sourceRows: 10, acceptedRows: 9, rejectedRows: 1, duplicateIds: 1 }, /duplicate/i],
    [{ sourceRows: 10, acceptedRows: 8, rejectedRows: 2, duplicateIds: 0 }, /accepted/i],
    [{ sourceRows: 9, acceptedRows: 8, rejectedRows: 1, duplicateIds: 0 }, /source/i],
  ])('rejects unsafe import statistics %#', (stats, message) => {
    expect(() =>
      validateTwoGisImportStats(stats, {
        expectedSourceRows: 10,
        expectedAcceptedRows: 9,
      }),
    ).toThrow(message);
  });

  it('does not accept an old snapshot with empty normalized subcategory tables', () => {
    expect(() =>
      validateTwoGisLiveSnapshot(
        {
          cards: 9,
          uniqueIds: 9,
          acceptedRows: 9,
          normalizedSubcategories: 0,
          subcategoryFacets: 0,
        },
        9,
      ),
    ).toThrow(/normalized subcategor/i);
  });
});
