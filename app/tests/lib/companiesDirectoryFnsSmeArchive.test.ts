/** @jest-environment node */

import archiver from 'archiver';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  inspectFnsSmeArchive,
  parseInspectedFnsSmeArchive,
} from '@/lib/companiesDirectory/fnsSmeArchive';

const XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Файл ИдФайл="VO_RRMSP_TEST_20260710_001"',
  ' ВерсФорм="4.06" ТипИнф="РЕЕСТРМСП" КолДок="1">',
  '<Документ ИдДок="doc-1" ДатаСост="10.07.2026">',
  '<ОргВклМСП ИННЮЛ="7704414297" ОГРН="1177746494166"/>',
  '<СвОКВЭД><СвОКВЭДОсн КодОКВЭД="62.01"',
  ' ВерсОКВЭД="2014"/></СвОКВЭД>',
  '</Документ></Файл>',
].join('');

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

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function replaceAllAscii(
  value: Buffer,
  search: string,
  replacement: string,
): Buffer {
  if (Buffer.byteLength(search) !== Buffer.byteLength(replacement)) {
    throw new Error('ZIP fixture replacement must preserve byte length');
  }
  const result = Buffer.from(value);
  const searchBytes = Buffer.from(search);
  const replacementBytes = Buffer.from(replacement);
  let offset = 0;
  let replacements = 0;
  while ((offset = result.indexOf(searchBytes, offset)) >= 0) {
    replacementBytes.copy(result, offset);
    offset += replacementBytes.length;
    replacements += 1;
  }
  if (replacements < 2) {
    throw new Error('ZIP fixture did not contain local and central filenames');
  }
  return result;
}

describe('official FNS SME archive guardrails', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fns-sme-archive-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('pins archive bytes/SHA and central-directory member CRC metadata', async () => {
    const bytes = await zipBuffer([{
      name: 'VO_RRMSP_TEST_20260710_001.xml',
      contents: XML,
    }]);
    const archivePath = join(directory, 'official.zip');
    await writeFile(archivePath, bytes);

    const inspection = await inspectFnsSmeArchive({
      archivePath,
      expectedBytes: bytes.length,
      expectedSha256: sha256(bytes),
    });

    expect(inspection).toMatchObject({
      archivePath,
      archiveBytes: bytes.length,
      archiveSha256: sha256(bytes),
      xmlEntryCount: 1,
    });
    expect(inspection.entries).toEqual([
      expect.objectContaining({
        entryName: 'VO_RRMSP_TEST_20260710_001.xml',
        uncompressedSize: Buffer.byteLength(XML),
      }),
    ]);
    expect(inspection.entries[0].crc32).toBeGreaterThanOrEqual(0);

    const records: string[] = [];
    await expect(parseInspectedFnsSmeArchive({
      inspection,
      onRecord: async (record) => {
        records.push(`${record.inn}:${record.okvedCodeExact}`);
      },
      onInvalidIdentity: async () => undefined,
    })).resolves.toMatchObject({
      metrics: {
        xmlEntryCount: 1,
        documentCount: 1,
        emittedRecordCount: 1,
      },
    });
    expect(records).toEqual(['7704414297:62.01']);
  });

  it('rejects size/SHA drift before XML parsing', async () => {
    const bytes = await zipBuffer([{
      name: 'VO_RRMSP_TEST_20260710_001.xml',
      contents: XML,
    }]);
    const archivePath = join(directory, 'official.zip');
    await writeFile(archivePath, bytes);

    await expect(inspectFnsSmeArchive({
      archivePath,
      expectedBytes: bytes.length + 1,
      expectedSha256: sha256(bytes),
    })).rejects.toThrow(/size|bytes/i);
    await expect(inspectFnsSmeArchive({
      archivePath,
      expectedBytes: bytes.length,
      expectedSha256: '0'.repeat(64),
    })).rejects.toThrow(/SHA-256/i);
  });

  it.each([
    ['nested path', 'nested/VO_RRMSP_TEST_20260710_001.xml'],
    ['non XML member', 'README.txt'],
  ])('rejects an unexpected %s member', async (_label, name) => {
    const bytes = await zipBuffer([{ name, contents: XML }]);
    const archivePath = join(directory, 'unexpected.zip');
    await writeFile(archivePath, bytes);

    await expect(inspectFnsSmeArchive({
      archivePath,
      expectedBytes: bytes.length,
      expectedSha256: sha256(bytes),
    })).rejects.toThrow(/entry|path|XML/i);
  });

  it('rejects a path-traversal member', async () => {
    const regular = await zipBuffer([{
      name: 'aa/VO_RRMSP_TEST_20260710_001.xml',
      contents: XML,
    }]);
    const bytes = replaceAllAscii(regular, 'aa/', '../');
    const archivePath = join(directory, 'traversal.zip');
    await writeFile(archivePath, bytes);

    await expect(inspectFnsSmeArchive({
      archivePath,
      expectedBytes: bytes.length,
      expectedSha256: sha256(bytes),
    })).rejects.toThrow(/entry|path|unsafe/i);
  });

  it('rejects a truncated ZIP central directory', async () => {
    const bytes = await zipBuffer([{
      name: 'VO_RRMSP_TEST_20260710_001.xml',
      contents: XML,
    }]);
    const archivePath = join(directory, 'truncated.zip');
    const truncated = bytes.subarray(0, bytes.length - 20);
    await writeFile(archivePath, truncated);

    await expect(inspectFnsSmeArchive({
      archivePath,
      expectedBytes: truncated.length,
      expectedSha256: sha256(truncated),
    })).rejects.toThrow(/ZIP|central|end of central|invalid/i);
  });

  it('detects archive drift between inspection and parsing', async () => {
    const bytes = await zipBuffer([{
      name: 'VO_RRMSP_TEST_20260710_001.xml',
      contents: XML,
    }]);
    const archivePath = join(directory, 'official.zip');
    await writeFile(archivePath, bytes);
    const inspection = await inspectFnsSmeArchive({
      archivePath,
      expectedBytes: bytes.length,
      expectedSha256: sha256(bytes),
    });

    const changed = Buffer.from(await readFile(archivePath));
    changed[10] ^= 1;
    await writeFile(archivePath, changed);

    await expect(parseInspectedFnsSmeArchive({
      inspection,
      onRecord: async () => undefined,
      onInvalidIdentity: async () => undefined,
    })).rejects.toThrow(/changed|drift|SHA-256/i);
  });
});
