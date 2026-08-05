/** @jest-environment node */

import {
  buildRegistryV2PlanBundle,
  type RegistryV2PlanSource,
} from '@/lib/companiesDirectory/registryV2Plan';
import type { ExistingDirectoryRow } from '@/lib/companiesDirectory/sbisImportPlan';

function source(
  sourceFile: string,
  csvSha256: string,
  activeRows: RegistryV2PlanSource['activeRows'],
): RegistryV2PlanSource {
  return {
    sourceFile,
    sourceSha256: sourceFile === 'a.zip' ? 'a'.repeat(64) : 'b'.repeat(64),
    csvSha256,
    entryName: sourceFile.replace(/\.zip$/, '.csv'),
    schema: 'legal-entity',
    inputRows: activeRows.length,
    activeRows,
    filteredStatuses: [],
  };
}

describe('registry v2 deterministic plan bundle', () => {
  it('deduplicates identical source CSVs, preserves provenance and is idempotent', () => {
    const newRow = {
      rowNumber: 2,
      name: 'ООО АЛЬФА',
      inn: '7704414297',
      activity_type: 'Разработка ПО',
      source_activity: '62.01 - Разработка ПО',
      email: 'sales@alpha.ru',
      phones: '8 (495) 111-22-33',
    };
    const existingPhoneRow = {
      rowNumber: 2,
      name: 'ООО БЕТА',
      inn: '7729058675',
      activity_type: 'Разработка ПО',
      source_activity: '62.01 - Разработка ПО',
      phones: '+7 495 999-88-77',
    };
    const sources = [
      source('a.zip', '1'.repeat(64), [newRow]),
      source('a-copy.zip', '1'.repeat(64), [newRow]),
      source('b.zip', '2'.repeat(64), [existingPhoneRow]),
    ];
    const existing: ExistingDirectoryRow[] = [{
      id: '20',
      inn: '7729058675',
      phones: null,
      email: null,
      website: null,
    }];

    const forward = buildRegistryV2PlanBundle(sources, existing);
    const reversed = buildRegistryV2PlanBundle([...sources].reverse(), existing);

    expect(forward).toEqual(reversed);
    expect(forward.plan.inserts).toEqual([
      expect.objectContaining({
        inn: '7704414297',
        phones: '+74951112233',
        email: 'sales@alpha.ru',
        okved_code: '62',
        okved_code_exact: null,
        source_file: 'a-copy.zip',
      }),
    ]);
    expect(forward.plan.updates).toEqual([{
      id: '20',
      inn: '7729058675',
      patch: { phones: '+74959998877' },
    }]);
    expect(forward.sourceArchives).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFile: 'a-copy.zip', status: 'accepted' }),
      expect.objectContaining({
        sourceFile: 'a.zip',
        status: 'duplicate_csv',
        duplicateOf: 'a-copy.zip',
      }),
    ]));
    expect(forward.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'insert', inn: '7704414297' }),
      expect.objectContaining({ action: 'update', inn: '7729058675' }),
    ]));
    expect(forward.rollback).toHaveLength(2);
    expect(forward.summary).toMatchObject({
      dryRunOnly: true,
      mode: 'registry-v2',
      combined: { inserts: 1, updates: 1 },
      idempotencyCheck: { repeatedInserts: 0, repeatedUpdates: 0, passed: true },
    });
    expect(JSON.stringify(forward)).not.toMatch(/[A-Z]:\\|generatedAt|createdAt/);
  });

  it('keeps comma-containing source names intact in insert provenance', () => {
    const sourceFile = 'companies, august.csv';
    const row = {
      rowNumber: 2,
      name: 'OOO ALPHA',
      inn: '7704414297',
      activity_type: 'Software development',
      source_activity: '62.01 - Software development',
      email: 'sales@alpha.ru',
    };

    const bundle = buildRegistryV2PlanBundle(
      [source(sourceFile, '3'.repeat(64), [row])],
      [],
    );

    expect(bundle.plan.inserts[0].source_file).toBe(sourceFile);
    expect(bundle.provenance).toContainEqual({
      action: 'insert',
      inn: '7704414297',
      sources: [{
        source_file: sourceFile,
        sha256: 'b'.repeat(64),
        rowNumbers: [2],
      }],
    });
  });

  it('fails closed for errored or inconsistent source descriptors', () => {
    const row = {
      rowNumber: 2,
      name: 'OOO ALPHA',
      inn: '7704414297',
      activity_type: 'Software development',
      source_activity: '62.01 - Software development',
      email: 'sales@alpha.ru',
    };
    const valid = source('valid.zip', '4'.repeat(64), [row]);
    const validEmpty: RegistryV2PlanSource = {
      sourceFile: 'empty.zip',
      sourceSha256: 'e'.repeat(64),
      csvSha256: null,
      entryName: null,
      schema: null,
      inputRows: 0,
      activeRows: [],
      filteredStatuses: [],
      error: 'empty_archive',
    };

    expect(() => buildRegistryV2PlanBundle([
      { ...valid, error: 'parse_failed' },
    ], [])).toThrow(/descriptor|error/i);
    expect(() => buildRegistryV2PlanBundle([
      { ...valid, schema: null },
    ], [])).toThrow(/descriptor|schema/i);
    expect(() => buildRegistryV2PlanBundle([
      { ...valid, inputRows: 2 },
    ], [])).toThrow(/descriptor|inputRows/i);
    expect(() => buildRegistryV2PlanBundle([
      { ...validEmpty, activeRows: [row] },
    ], [])).toThrow(/descriptor|empty/i);

    expect(buildRegistryV2PlanBundle([validEmpty], []).sourceArchives)
      .toContainEqual(expect.objectContaining({
        sourceFile: 'empty.zip',
        status: 'empty_archive',
      }));
  });
});
