/** @jest-environment node */

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';

import { FnsExactPlanStore } from '@/lib/companiesDirectory/fnsExactPlanStore';
import {
  loadFnsExactSnapshot,
} from '@/lib/companiesDirectory/fnsExactSnapshot';

async function writeGzipLines(
  path: string,
  rows: unknown[],
): Promise<void> {
  const gzip = createGzip();
  const output = createWriteStream(path);
  gzip.pipe(output);
  for (const row of rows) {
    gzip.write(`${JSON.stringify(row)}\n`);
  }
  gzip.end();
  await once(output, 'finish');
}

function meta(version = 2) {
  return {
    kind: 'meta',
    version,
    source: {
      host: '139.60.162.12',
      port: 35434,
      database: 'postgres',
      table: 'companies_directory',
    },
    exported_at: '2026-07-29T00:00:00.000Z',
  };
}

describe('FNS exact OKVED OGRN-aware source snapshot', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fns-exact-snapshot-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('preserves raw OGRN and exact-state values while auditing invalid target identities', async () => {
    const snapshotPath = join(directory, 'snapshot.jsonl.gz');
    await writeGzipLines(snapshotPath, [
      meta(),
      {
        id: '10',
        inn: '7704414297',
        ogrn: '1177746494166',
        okved_code_exact: null,
        okved_exact_source: null,
      },
      {
        id: '11',
        inn: '7729058675',
        ogrn: null,
        okved_code_exact: '',
        okved_exact_source: null,
      },
      {
        id: '12',
        inn: '7810762225',
        ogrn: '1177746494188',
        okved_code_exact: '   ',
        okved_exact_source: 'dadata',
      },
      {
        id: '13',
        inn: '7715332336',
        ogrn: null,
        okved_code_exact: null,
        okved_exact_source: null,
      },
      {
        id: '14',
        inn: '7704414297',
        ogrn: '   ',
        okved_code_exact: null,
        okved_exact_source: null,
      },
      {
        id: '15',
        inn: '7704414297',
        ogrn: '1177746494167',
        okved_code_exact: null,
        okved_exact_source: null,
      },
    ]);
    const store = new FnsExactPlanStore(join(directory, 'plan.sqlite'));
    try {
      const result = await loadFnsExactSnapshot({
        snapshotPath,
        store,
      });
      expect(result).toMatchObject({
        version: 2,
        rows: 6,
        null_exact_rows: 4,
        empty_or_whitespace_exact_rows: 2,
        null_ogrn_rows: 2,
        empty_or_whitespace_ogrn_rows: 1,
        invalid_inn_rows: 1,
        invalid_ogrn_rows: 1,
      });

      store.beginRegistry();
      store.addRegistry({
        inn: '7704414297',
        ogrn: '1177746494166',
        okved_code_exact: '62.01',
        okved_version: '2014',
      });
      store.commitRegistry();

      expect([...store.iterateUpdates()].map((row) => [
        row.id,
        row.expected_ogrn,
        row.match_method,
      ])).toEqual([
        ['10', '1177746494166', 'ogrn_inn'],
        ['14', '   ', 'unique_inn_fallback'],
      ]);
      expect([...store.iterateSkipped()]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: '13',
          reason: 'invalid_target_inn',
        }),
        expect.objectContaining({
          id: '15',
          reason: 'invalid_target_ogrn',
        }),
      ]));
    } finally {
      store.close();
    }
  });

  it.each([
    [
      'an old v1 snapshot',
      [
        meta(1),
        {
          id: '10',
          inn: '7704414297',
          okved_code_exact: null,
          okved_exact_source: null,
        },
      ],
      /version|v2|OGRН|OGRN/i,
    ],
    [
      'a v2 row without OGRN',
      [
        meta(),
        {
          id: '10',
          inn: '7704414297',
          okved_code_exact: null,
          okved_exact_source: null,
        },
      ],
      /fields|OGRН|OGRN/i,
    ],
    [
      'the former production target',
      [
        {
          ...meta(),
          source: {
            host: '144.31.54.166',
            port: 35434,
            database: 'postgres',
            table: 'companies_directory',
          },
        },
      ],
      /target|host|source/i,
    ],
  ])('rejects %s and rolls back', async (_label, rows, expectedError) => {
    const snapshotPath = join(directory, 'bad.jsonl.gz');
    await writeGzipLines(snapshotPath, rows);
    const store = new FnsExactPlanStore(join(directory, 'plan.sqlite'));
    try {
      await expect(loadFnsExactSnapshot({
        snapshotPath,
        store,
      })).rejects.toThrow(expectedError);
    } finally {
      store.close();
    }
  });
});
