/** @jest-environment node */

/**
 * Red-phase contract for the pure pre-launch segmentation audit helpers.
 *
 * The report is calculated over the exact audience that can reach Instantly,
 * while excluded source rows are reconciled separately. Its launch groups and
 * hash are part of the same pure contract so the reviewed distribution cannot
 * drift from the eventual campaign split.
 */

import type { VeOperatorMapping } from '@/lib/verticalEngineV2/types';
import {
  buildSegmentationAudit,
  buildSegmentationLaunchGroups,
  collectSegmentationConditions,
  computeSegmentationAuditHash,
  prepareSegmentationAudience,
} from '@/lib/verticalEngineV2/segmentationAudit';

const COLUMNS = ['Email', 'Компания', 'Отрасль'];
const OPERATOR_MAPPING: VeOperatorMapping[] = [
  { operator: 'companyName', column: 'Компания', matched: true },
];

function cleanRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    Email: `lead-${i}@example.test`,
    Компания: `Компания ${i}`,
    Отрасль: i < 4 ? 'Образование' : 'Медицина',
  }));
}

describe('collectSegmentationConditions', () => {
  it('trims and deduplicates conditions case-insensitively while preserving first spelling', () => {
    expect(
      collectSegmentationConditions([
        {
          subject: 'S1',
          body: 'B1',
          wait_days: 0,
          segment_variants: [
            { when: '  Школы  ', text: 'School copy' },
            { when: 'Клиники', text: 'Clinic copy' },
          ],
        },
        {
          subject: null,
          body: 'B2',
          wait_days: 2,
          segment_variants: [
            { when: 'шКоЛы', text: 'Duplicate spelling' },
            { when: '   ', text: 'Empty' },
            { when: 'Вузы', text: 'University copy' },
          ],
        },
      ]),
    ).toEqual(['Школы', 'Клиники', 'Вузы']);
  });
});

describe('prepareSegmentationAudience', () => {
  it('reconciles auto-base quality filters, invalid emails and duplicates', () => {
    const sourceRows = [
      { Email: 'school@example.test', Компания: 'Школа №1', Отрасль: 'Образование' },
      {
        Email: 'noise@example.test',
        Компания: 'Шум',
        Отрасль: 'Другое',
        _low_relevance: true,
      },
      {
        Email: 'risky@example.test',
        Компания: 'Риск',
        Отрасль: 'Образование',
        _email_status: 'risky',
      },
      { Email: 'not-an-email', Компания: 'Без почты', Отрасль: 'Образование' },
      { Email: 'SCHOOL@example.test', Компания: 'Дубль школы', Отрасль: 'Образование' },
      { Email: 'clinic@example.test', Компания: 'Клиника №1', Отрасль: 'Медицина' },
      { Email: 'default@example.test', Компания: 'Другое ООО', Отрасль: 'Услуги' },
    ];

    const audience = prepareSegmentationAudience({
      rows: sourceRows,
      columns: COLUMNS,
      source: 'auto',
      operatorMapping: OPERATOR_MAPPING,
    });

    expect(audience.totalRows).toBe(7);
    expect(audience.rows).toEqual([sourceRows[0], sourceRows[5], sourceRows[6]]);
    expect(audience.originalRowIndices).toEqual([0, 5, 6]);
    expect(audience.leads.map((lead) => lead.email)).toEqual([
      'school@example.test',
      'clinic@example.test',
      'default@example.test',
    ]);
    expect(audience.excluded).toEqual({
      lowRelevance: 1,
      relevanceUnchecked: 0,
      invalidEmailStatus: 1,
      invalidEmail: 1,
      duplicateEmail: 1,
    });
    expect(
      Object.values(audience.excluded).reduce((sum, count) => sum + count, audience.rows.length),
    ).toBe(audience.totalRows);
  });

  it('excludes unchecked auto rows separately without calling them low relevance', () => {
    const sourceRows = [
      {
        Email: 'checked@example.test',
        Компания: 'Проверенная клиника',
        Отрасль: 'Медицина',
        _email_status: 'ok',
      },
      {
        Email: 'unchecked@example.test',
        Компания: 'Клиника без вердикта',
        Отрасль: 'Медицина',
        _email_status: 'ok',
        _relevance_unchecked: true,
      },
    ];

    const audience = prepareSegmentationAudience({
      rows: sourceRows,
      columns: COLUMNS,
      source: 'auto',
      operatorMapping: OPERATOR_MAPPING,
    });

    expect(audience.totalRows).toBe(2);
    expect(audience.rows).toEqual([sourceRows[0]]);
    expect(audience.originalRowIndices).toEqual([0]);
    expect(audience.leads.map((lead) => lead.email)).toEqual(['checked@example.test']);
    expect(audience.excluded).toEqual({
      lowRelevance: 0,
      relevanceUnchecked: 1,
      invalidEmailStatus: 0,
      invalidEmail: 0,
      duplicateEmail: 0,
    });
    expect(
      Object.values(audience.excluded).reduce((sum, count) => sum + count, audience.rows.length),
    ).toBe(audience.totalRows);
  });

  it('does not interpret system-looking columns in an uploaded base as auto quality flags', () => {
    const sourceRows = [
      {
        Email: 'one@example.test',
        Компания: 'Пользовательская строка 1',
        _low_relevance: true,
      },
      {
        Email: 'two@example.test',
        Компания: 'Пользовательская строка 2',
        _email_status: 'invalid',
      },
    ];

    const audience = prepareSegmentationAudience({
      rows: sourceRows,
      columns: [...COLUMNS, '_low_relevance', '_email_status'],
      source: 'upload',
      operatorMapping: OPERATOR_MAPPING,
    });

    expect(audience.rows).toEqual(sourceRows);
    expect(audience.leads).toHaveLength(2);
    expect(audience.excluded).toEqual({
      lowRelevance: 0,
      relevanceUnchecked: 0,
      invalidEmailStatus: 0,
      invalidEmail: 0,
      duplicateEmail: 0,
    });
  });
});

describe('buildSegmentationAudit', () => {
  it('shows every declared segment, keeps default separate and caps examples at three', () => {
    const audience = prepareSegmentationAudience({
      rows: cleanRows(6),
      columns: COLUMNS,
      source: 'auto',
      operatorMapping: OPERATOR_MAPPING,
    });
    const classification = {
      assignments: new Map<number, string | null>([
        [0, 'Школы'],
        [1, 'Школы'],
        [2, 'Школы'],
        [3, 'Школы'],
        [4, 'Клиники'],
        [5, null],
      ]),
      unclassifiedRows: [],
      failedBatches: 0,
      totalBatches: 1,
      usage: { tokensUsed: 50, costUsd: 0.01 },
    };

    const audit = buildSegmentationAudit({
      templateId: 'tpl-1',
      baseId: 'base-1',
      segments: ['Школы', 'Клиники', 'Вузы'],
      audience,
      classification,
    });

    expect(audit.status).toBe('complete');
    expect(audit.totalRows).toBe(6);
    expect(audit.launchableRows).toBe(6);
    expect(audit.unclassifiedCount).toBe(0);
    expect(audit.segments.map((segment) => [segment.when, segment.count])).toEqual([
      ['Школы', 4],
      ['Клиники', 1],
      ['Вузы', 0],
    ]);
    expect(audit.segments[0].examples).toEqual([
      { rowIndex: 0, label: 'Компания 0', email: 'lead-0@example.test' },
      { rowIndex: 1, label: 'Компания 1', email: 'lead-1@example.test' },
      { rowIndex: 2, label: 'Компания 2', email: 'lead-2@example.test' },
    ]);
    expect(audit.segments[2].examples).toEqual([]);
    expect(audit.default).toEqual({
      count: 1,
      sharePct: expect.any(Number),
      examples: [{ rowIndex: 5, label: 'Компания 5', email: 'lead-5@example.test' }],
    });
    expect(audit.segments.reduce((sum, segment) => sum + segment.count, 0) + audit.default.count).toBe(
      audit.launchableRows,
    );
    expect(audit.inputHash).toBe(
      computeSegmentationAuditHash({
        templateId: 'tpl-1',
        baseId: 'base-1',
        segments: ['Школы', 'Клиники', 'Вузы'],
        audience,
        assignments: classification.assignments,
      }),
    );
  });

  it('never folds missing or failed classifications into the default count', () => {
    const audience = prepareSegmentationAudience({
      rows: cleanRows(3),
      columns: COLUMNS,
      source: 'auto',
      operatorMapping: OPERATOR_MAPPING,
    });

    const audit = buildSegmentationAudit({
      templateId: 'tpl-1',
      baseId: 'base-1',
      segments: ['Школы', 'Клиники'],
      audience,
      classification: {
        assignments: new Map<number, string | null>([
          [0, 'Школы'],
          [1, null],
          // row 2 is absent because its batch failed.
        ]),
        unclassifiedRows: [2],
        failedBatches: 1,
        totalBatches: 2,
        usage: { tokensUsed: 20, costUsd: 0.005 },
      },
    });

    expect(audit.status).toBe('incomplete');
    expect(audit.segments.map((segment) => [segment.when, segment.count])).toEqual([
      ['Школы', 1],
      ['Клиники', 0],
    ]);
    expect(audit.default.count).toBe(1);
    expect(audit.unclassifiedCount).toBe(1);
    expect(
      audit.segments.reduce((sum, segment) => sum + segment.count, 0) +
        audit.default.count +
        audit.unclassifiedCount,
    ).toBe(audit.launchableRows);
  });
});

describe('segmentation audit hash and launch-group parity', () => {
  it('builds launch groups with exactly the counts reviewed in a complete audit', () => {
    const audience = prepareSegmentationAudience({
      rows: cleanRows(4),
      columns: COLUMNS,
      source: 'auto',
      operatorMapping: OPERATOR_MAPPING,
    });
    const classification = {
      assignments: new Map<number, string | null>([
        [0, 'Школы'],
        [1, null],
        [2, 'Клиники'],
        [3, 'Школы'],
      ]),
      unclassifiedRows: [],
      failedBatches: 0,
      totalBatches: 1,
      usage: { tokensUsed: 10, costUsd: 0.002 },
    };
    const input = {
      templateId: 'tpl-1',
      baseId: 'base-1',
      segments: ['Школы', 'Клиники', 'Вузы'],
      audience,
      classification,
    };

    const audit = buildSegmentationAudit(input);
    const groups = buildSegmentationLaunchGroups({
      segments: input.segments,
      leadCount: audience.leads.length,
      classification,
    });

    expect(groups).toEqual([
      { segment: null, leadIndices: [1] },
      { segment: 'Школы', leadIndices: [0, 3] },
      { segment: 'Клиники', leadIndices: [2] },
    ]);
    expect(groups.find((group) => group.segment === null)?.leadIndices).toHaveLength(
      audit.default.count,
    );
    for (const segment of audit.segments) {
      const group = groups.find((candidate) => candidate.segment === segment.when);
      expect(group?.leadIndices.length ?? 0).toBe(segment.count);
    }
  });

  it('refuses to build launch groups from an incomplete classification', () => {
    expect(() =>
      buildSegmentationLaunchGroups({
        segments: ['Школы'],
        leadCount: 2,
        classification: {
          assignments: new Map<number, string | null>([[0, 'Школы']]),
          unclassifiedRows: [1],
          failedBatches: 1,
          totalBatches: 1,
          usage: { tokensUsed: 0, costUsd: 0 },
        },
      }),
    ).toThrow(/incomplete|не заверш/i);
  });

  it('hash is deterministic for Map insertion order and changes with an assignment', () => {
    const audience = prepareSegmentationAudience({
      rows: cleanRows(3),
      columns: COLUMNS,
      source: 'auto',
      operatorMapping: OPERATOR_MAPPING,
    });
    const common = {
      templateId: 'tpl-1',
      baseId: 'base-1',
      segments: ['Школы', 'Клиники'],
      audience,
    };

    const first = computeSegmentationAuditHash({
      ...common,
      assignments: new Map<number, string | null>([
        [0, 'Школы'],
        [1, null],
        [2, 'Клиники'],
      ]),
    });
    const reordered = computeSegmentationAuditHash({
      ...common,
      assignments: new Map<number, string | null>([
        [2, 'Клиники'],
        [0, 'Школы'],
        [1, null],
      ]),
    });
    const changed = computeSegmentationAuditHash({
      ...common,
      assignments: new Map<number, string | null>([
        [0, 'Школы'],
        [1, 'Школы'],
        [2, 'Клиники'],
      ]),
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });
});
