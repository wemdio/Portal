/**
 * @jest-environment node
 *
 * Locks the export-artifact contract (Fix B of the slow-download incident):
 *  - the gzipped artifact decompresses to EXACTLY rowsToCsvFile(rows) — the
 *    same bytes the download route streams (BOM first);
 *  - uploadExportArtifact never throws: storage error, timeout, or a broken
 *    client all yield null (job completion must never depend on storage).
 */

import { gunzipSync } from 'node:zlib';
import {
  buildCsvGzip,
  uploadExportArtifact,
  EXPORT_BUCKET,
  type ExportStorageClient,
} from '@/lib/tools/csvExportArtifact';
import { rowsToCsvFile } from '@/lib/tools/rowsToCsv';

const rows = [
  ['компания', 'Сайт', 'email', 'Описание'],
  ['ООО "Ромашка"', 'r.ru', 'a@r.ru', 'многострочное\nописание, с запятой'],
  ['Beta', '', '', ''],
  ...Array.from({ length: 2500 }, (_, i) => [`C${i}`, `c${i}.ru`, `x@c${i}.ru`, `d-${i}`]),
];

function mockClient(
  upload: (
    path: string,
    body: Buffer,
    opts: { contentType: string; upsert: boolean },
  ) => Promise<{ error: { message: string } | null }>,
): ExportStorageClient {
  return { storage: { from: () => ({ upload }) } };
}

describe('buildCsvGzip', () => {
  it('decompresses to exactly rowsToCsvFile bytes (BOM included)', async () => {
    const gz = await buildCsvGzip(rows);
    const unzipped = gunzipSync(gz);
    const expected = Buffer.from(rowsToCsvFile(rows), 'utf8');
    expect(unzipped.equals(expected)).toBe(true);
    // UTF-8 BOM leads the decompressed output.
    expect([...unzipped.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // And it actually compresses.
    expect(gz.length).toBeLessThan(expected.length / 2);
  });
});

describe('uploadExportArtifact', () => {
  it('uploads <jobId>.csv.gz with upsert and returns path+bytes', async () => {
    const calls: { path: string; bytes: number; opts: { contentType: string; upsert: boolean } }[] = [];
    const client = mockClient(async (path, body, opts) => {
      calls.push({ path, bytes: body.length, opts });
      return { error: null };
    });
    const res = await uploadExportArtifact(client, 'job-123', rows);
    expect(res).not.toBeNull();
    expect(res!.path).toBe('job-123.csv.gz');
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('job-123.csv.gz');
    expect(calls[0].bytes).toBe(res!.bytes);
    expect(calls[0].opts).toEqual({ contentType: 'application/gzip', upsert: true });
    expect(EXPORT_BUCKET).toBe('base-constructor-exports');
  });

  it('returns null (no throw) on storage error', async () => {
    const client = mockClient(async () => ({ error: { message: 'bucket missing' } }));
    await expect(uploadExportArtifact(client, 'j', rows)).resolves.toBeNull();
  });

  it('returns null (no throw) when upload hangs past the timeout', async () => {
    const client = mockClient(() => new Promise(() => {})); // never resolves
    await expect(uploadExportArtifact(client, 'j', rows, 60)).resolves.toBeNull();
  });

  it('returns null (no throw) on a broken client (no storage at all)', async () => {
    await expect(
      uploadExportArtifact({} as unknown as ExportStorageClient, 'j', rows),
    ).resolves.toBeNull();
  });
});
