/** @jest-environment node */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { VeJob } from '@/lib/verticalEngineV2/types';
import { computeSegmentationAuditHash } from '@/lib/verticalEngineV2/segmentationAudit';
import { VE_LAUNCH_MAX_LEADS } from '@/lib/verticalEngineV2/launchHandoff';

const mockClassifyDetailed = jest.fn();

jest.mock('@/lib/verticalEngineV2/segmentClassify', () => ({
  classifyBaseRowsIntoSegmentsDetailed: (...args: unknown[]) => mockClassifyDetailed(...args),
  detectSegmentLanguage: jest.fn(() => 'ru'),
}));

import {
  markSegmentationAuditFailed,
  prepareAuditSnapshot,
  runSegmentationAuditStage,
  toStoredAuditSummary,
  validateStoredAuditSnapshot,
} from '@/lib/verticalEngineV2/stages/segmentationAudit';

const PROJECT_ID = 'project-stage-audit-1';
const TEMPLATE_ID = 'template-stage-audit-1';
const BASE_ID = 'base-stage-audit-1';
const AUDIT_ID = 'audit-stage-1';

const TEMPLATE = {
  id: TEMPLATE_ID,
  base_id: BASE_ID,
  vertical_id: 'vertical-stage-audit-1',
  status: 'ready',
  letters: [
    {
      subject: 'Тема',
      body: 'Основной текст',
      wait_days: 0,
      segment_variants: [{ when: 'Школы', text: 'Текст для школ' }],
    },
  ],
  personalization_plan: {
    operator_mapping: [{ operator: 'companyName', column: 'Компания', matched: true }],
  },
};

const BASE = {
  id: BASE_ID,
  project_id: PROJECT_ID,
  vertical_id: 'vertical-stage-audit-1',
  source: 'upload',
  columns: ['Email', 'Компания', 'Отрасль'],
  data: [
    { Email: 'school@example.test', Компания: 'Школа', Отрасль: 'Образование' },
    { Email: 'default@example.test', Компания: 'Другое', Отрасль: 'Услуги' },
  ],
};

function auditRow() {
  return {
    id: AUDIT_ID,
    project_id: PROJECT_ID,
    template_id: TEMPLATE_ID,
    base_id: BASE_ID,
    requested_by: 'user-stage-audit-1',
    status: 'pending',
    input_hash: null,
    segment_keys: [],
    summary: null,
    assignments: [],
    error: null,
    tokens_used: 0,
    cost_usd: 0,
    completed_at: null,
    created_at: '2026-08-28T12:00:00.000Z',
    updated_at: '2026-08-28T12:00:00.000Z',
  };
}

function makeJob(): VeJob {
  return {
    id: 'job-stage-audit-1',
    project_id: PROJECT_ID,
    stage: 'segmentation_audit',
    status: 'running',
    payload: { audit_id: AUDIT_ID, template_id: TEMPLATE_ID, base_id: BASE_ID },
    result: null,
    attempts: 0,
    error: null,
    started_at: '2026-08-28T12:00:01.000Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-28T12:00:00.000Z',
    updated_at: '2026-08-28T12:00:01.000Z',
  };
}

function seed(options: { template?: boolean; base?: Record<string, unknown> } = {}): MockSupabaseClient {
  return createMockSupabase({
    tables: {
      ve_segmentation_audits: [auditRow()],
      ve_templates: options.template === false ? [] : [TEMPLATE],
      ve_bases: [options.base ?? BASE],
      he_jobs: [{ id: 'legacy-job', status: 'done' }],
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runSegmentationAuditStage', () => {
  it('preserves not_required in storage when a template has no segment variants', () => {
    const summary = toStoredAuditSummary({
      status: 'not_required',
      templateId: TEMPLATE_ID,
      baseId: BASE_ID,
      totalRows: 2,
      launchableRows: 2,
      excluded: {
        lowRelevance: 0,
        invalidEmailStatus: 0,
        invalidEmail: 0,
        duplicateEmail: 0,
      },
      segments: [],
      default: { count: 2, sharePct: 100, examples: [] },
      unclassifiedCount: 0,
      unclassifiedRows: [],
      failedBatches: 0,
      totalBatches: 0,
      usage: { tokensUsed: 0, costUsd: 0 },
      inputHash: '0'.repeat(64),
    });
    expect(summary.status).toBe('not_required');
  });

  it('persists canonical assignments, summary and deterministic 64-hex hash in ve_* only', async () => {
    const db = seed();
    const assignments = new Map<number, string | null>([
      [0, 'Школы'],
      [1, null],
    ]);
    mockClassifyDetailed.mockResolvedValue({
      assignments,
      unclassifiedRows: [],
      failedBatches: 0,
      totalBatches: 1,
      usage: { tokensUsed: 31, costUsd: 0.007 },
    });

    const result = await runSegmentationAuditStage(makeJob(), {
      supabase: db as unknown as SupabaseClient,
    });

    const stored = db.getRows('ve_segmentation_audits')[0];
    const snapshot = prepareAuditSnapshot(TEMPLATE as never, BASE as never);
    const expectedHash = computeSegmentationAuditHash({
      templateId: TEMPLATE_ID,
      baseId: BASE_ID,
      segments: snapshot.segments,
      audience: snapshot.audience,
      assignments,
    });
    expect(stored).toEqual(
      expect.objectContaining({
        status: 'ready',
        input_hash: expectedHash,
        segment_keys: ['Школы'],
        assignments: [
          { row_index: 0, segment: 'Школы' },
          { row_index: 1, segment: null },
        ],
        tokens_used: 31,
        cost_usd: 0.007,
      }),
    );
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.summary).toEqual(
      expect.objectContaining({
        version: 1,
        status: 'complete',
        base_rows_total: 2,
        total_base_rows: 2,
        launchable_rows_total: 2,
        launchable_rows: 2,
        covered_rows_total: 2,
        default_rows_total: 1,
        unclassified_rows_total: 0,
        segments: [expect.objectContaining({ key: 'Школы', count: 1 })],
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          audit_id: AUDIT_ID,
          status: 'complete',
          input_hash: expectedHash,
        }),
        tokensUsed: 31,
        costUsd: 0.007,
      }),
    );
    expect(db.getRows('he_jobs')).toEqual([{ id: 'legacy-job', status: 'done' }]);
    expect(db.mutations.every((mutation) => mutation.table.startsWith('ve_'))).toBe(true);
    const validation = validateStoredAuditSnapshot({
      audit: stored as never,
      template: TEMPLATE as never,
      base: BASE as never,
    });
    expect(validation.state).toBe('current');
    if (validation.state === 'current') {
      expect(validation.assignments).toEqual(assignments);
      expect(validation.snapshot.audience.leads).toHaveLength(2);
    }
  });

  it('persists a visible ready audit with incomplete summary when classification is partial', async () => {
    const db = seed();
    mockClassifyDetailed.mockResolvedValue({
      assignments: new Map<number, string | null>([[0, 'Школы']]),
      unclassifiedRows: [1],
      failedBatches: 1,
      totalBatches: 2,
      usage: { tokensUsed: 11, costUsd: 0.002 },
    });

    await runSegmentationAuditStage(makeJob(), {
      supabase: db as unknown as SupabaseClient,
    });

    const stored = db.getRows('ve_segmentation_audits')[0];
    expect(stored.status).toBe('ready');
    expect(stored.assignments).toEqual([{ row_index: 0, segment: 'Школы' }]);
    expect(stored.summary).toEqual(
      expect.objectContaining({
        status: 'incomplete',
        launchable_rows_total: 2,
        covered_rows_total: 1,
        default_rows_total: 0,
        unclassified_rows_total: 1,
        unclassified_count: 1,
        failed_batches: 1,
        total_batches: 2,
      }),
    );
    expect(stored.input_hash).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(
      validateStoredAuditSnapshot({
        audit: stored as never,
        template: TEMPLATE as never,
        base: BASE as never,
      }),
    ).toEqual(expect.objectContaining({ state: 'incomplete' }));
    expect(db.getRows('he_jobs')).toEqual([{ id: 'legacy-job', status: 'done' }]);
  });

  it('rejects an oversized exact audience before any LLM classification', async () => {
    const oversizedBase = {
      ...BASE,
      data: Array.from({ length: VE_LAUNCH_MAX_LEADS + 1 }, (_, index) => ({
        Email: `lead-${index}@example.test`,
        Компания: `Компания ${index}`,
      })),
    };
    const db = seed({ base: oversizedBase });

    await expect(
      runSegmentationAuditStage(makeJob(), {
        supabase: db as unknown as SupabaseClient,
      }),
    ).rejects.toThrow(/лимит|2.?000/i);
    expect(mockClassifyDetailed).not.toHaveBeenCalled();
  });

  it('marks the audit failed through the final worker-failure hook after a stage error', async () => {
    const db = seed({ template: false });
    const job = makeJob();
    let failure: unknown;
    try {
      await runSegmentationAuditStage(job, {
        supabase: db as unknown as SupabaseClient,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);

    await markSegmentationAuditFailed(
      db as unknown as SupabaseClient,
      job,
      failure,
      new Date('2026-08-28T12:05:00.000Z'),
    );

    expect(db.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringMatching(/ve_templates/),
        completed_at: '2026-08-28T12:05:00.000Z',
      }),
    );
    expect(db.getRows('he_jobs')).toEqual([{ id: 'legacy-job', status: 'done' }]);
  });
});
