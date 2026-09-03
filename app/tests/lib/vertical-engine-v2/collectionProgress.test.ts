/** @jest-environment node */

import { getCollectionProgress, getCollectionQueue } from '@/components/vertical-engine-v2/engine/collectionProgress';
import type { VeBaseSummary } from '@/components/vertical-engine-v2/engine/api';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { loadVeProjectDetail } from '@/lib/verticalEngineV2/projectDetail';

jest.mock('@/lib/verticalEngineV2/actualsReconcile', () => ({ reconcileProjectVerticals: jest.fn(async () => {}) }));

function base(id: string, createdAt: string, info: VeBaseSummary['collect_info'] = {}): VeBaseSummary {
  return {
    id, created_at: createdAt, collect_info: info, status: 'collecting', source: 'auto',
    vertical_id: id, hypothesis_id: null, filename: id, row_count: 0,
    analysis: null, columns: [], sample_rows: [],
  };
}

describe('VE2 collection progress presentation', () => {
  it('keeps old public previews and active supply visible beyond the server page cap, without loading completed supply history', async () => {
    const makeBase = (id: string, mode: string | null, status: string, createdAt: string) => ({
      ...base(id, createdAt), project_id: 'project-1', vertical_id: 'vertical-1', status,
      // The shared mock filters literal column names; this mirrors the PostgREST JSON text path.
      'collect_info->>collection_mode': mode,
      collect_info: mode ? { collection_mode: mode, target_checkpoint: { processed_rows: [{ private: true }] }, tasks: [{ status: 'done', rows: 3, harvest: [{ private: true }] }] } : null,
    });
    const publicBases = [
      makeBase('preview-old', 'preview', 'analyzed', '2026-09-01T10:00:00Z'),
      makeBase('legacy-old', null, 'analyzed', '2026-09-01T11:00:00Z'),
      makeBase('preview-new', 'preview', 'collecting', '2026-09-01T12:00:00Z'),
    ];
    const historical = ['1', '2', '3'].map((id) => makeBase(`supply-${id}`, 'supply', 'analyzed', `2026-09-02T1${id}:00:00Z`));
    const db = createMockSupabase({ enforceQueryWindows: true, maxRowsPerQuery: 2, tables: {
      ve_projects: [{ id: 'project-1' }], ve_verticals: [{ id: 'vertical-1', project_id: 'project-1', rank: 1 }],
      ve_bases: [...publicBases, ...historical, makeBase('supply-active', 'supply', 'collecting', '2026-09-02T14:00:00Z')],
      ve_templates: [...publicBases, ...historical].map((row) => ({
        id: `template-${row.id}`, base_id: row.id, vertical_id: 'vertical-1', created_at: row.created_at,
        supply_batch_id: row['collect_info->>collection_mode'] === 'supply' ? `batch-${row.id}` : null,
      })),
    } });
    const result = await loadVeProjectDetail(db as never, 'project-1');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const bases = result.detail.bases as VeBaseSummary[];
    expect(bases.map((row) => row.id)).toEqual(['supply-active', 'preview-new', 'legacy-old', 'preview-old']);
    expect(result.detail.templates.map((row) => (row as { id: string }).id)).toEqual(['template-preview-new', 'template-legacy-old', 'template-preview-old']);
    expect(['ve_bases', 've_templates'].map((table) => db.selects.filter((query) => query.table === table).length)).toEqual([2, 2]);
    expect(bases[0].collect_info).toEqual({ collection_mode: 'supply', tasks: [{ status: 'done', rows: 3 }] });
    expect(getCollectionQueue(bases, [{ stage: 'base_collect', status: 'running', payload: { base_id: 'supply-active' } }]).current?.id).toBe('supply-active');
  });

  it('selects the working project base, not the newest vertical base, and releases stale waits', () => {
    const active = base('active', '2026-09-02T12:10:00Z', { tasks: [{ source: 'registry', status: 'done', rows: 1477 }] });
    const waiting = base('waiting', '2026-09-02T12:10:01Z', { waiting_for_base_id: 'active' });
    const newest = base('newest', '2026-09-02T12:10:02Z', { waiting_for_base_id: 'active' });
    const bases = [newest, waiting, active];
    expect(getCollectionQueue(bases)).toEqual({ current: active, queued: [waiting, newest] });
    // Even before the next worker snapshot, a finished predecessor cannot block the UI.
    active.status = 'analyzed';
    expect(getCollectionQueue(bases)).toEqual({ current: waiting, queued: [newest] });
    // Equal creation times follow the worker's deterministic ID order; input stays untouched.
    newest.created_at = waiting.created_at;
    expect(getCollectionQueue(bases).current).toBe(newest);
    expect(bases.map((b) => b.id)).toEqual(['newest', 'waiting', 'active']);
    expect(getCollectionQueue([])).toEqual({ current: undefined, queued: [] });
    const orphan = base('orphan', '2026-09-01T12:10:00Z', { tasks: [{ status: 'done', rows: 10 }] });
    waiting.collect_info = { tasks: [{ status: 'dispatched' }] };
    const recentJobs = [{ stage: 'base_collect' as const, status: 'pending' as const, payload: { base_id: waiting.id } }];
    expect(getCollectionQueue([orphan, waiting], recentJobs).current).toBe(waiting);
    const unclaimed = base('unclaimed', '2026-09-02T12:11:00Z');
    const held = base('held', '2026-09-01T12:10:00Z', { collection_mode: 'supply', supply_hold: true, tasks: [{ status: 'dispatched' }] });
    expect(getCollectionQueue([held, waiting], recentJobs)).toEqual({ current: waiting, queued: [] });
    // The active collector may have fallen outside the latest-30-jobs response.
    expect(getCollectionQueue([waiting, unclaimed], [
      { stage: 'base_collect', status: 'pending', payload: { base_id: unclaimed.id } },
    ]).current).toBe(waiting);
  });

  it('keeps unknown counts, source rows, candidates and step progress distinct from the run cap', () => {
    const collecting = base('active', '2026-09-02T12:10:00Z', { limit: 10000 });
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ phase: 'planning', candidates: null, sourceRows: null, stepPercent: null });
    collecting.collect_info = {
      limit: 10000,
      tasks: [{ status: 'done', rows: 1477 }, { status: 'dispatched', rows: 0 }, { status: 'failed', rows: 99 }],
    };
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ phase: 'collecting', candidates: null, sourceRows: 1477, stepPercent: null });
    collecting.collect_info.stats = { rows_total: 1250 };
    collecting.collect_info.construct = { status: 'dispatched', progress: { status: 'pending' } };
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ phase: 'construct_queued', candidates: 1250, stepPercent: null });
    collecting.collect_info.construct.progress = { status: 'processing', current_step_key: 'validate_emails', current_step_progress: 37 };
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ phase: 'processing', candidates: 1250, stepPercent: 37 });
    collecting.collect_info.construct.progress.current_step_progress = 130;
    expect(getCollectionProgress(collecting.collect_info).stepPercent).toBeNull();
    collecting.collect_info.construct.progress = { status: 'completed', current_step_progress: 100 };
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ phase: 'finishing', stepPercent: null });
    collecting.collect_info = { stats: { rows_total: Number.NaN }, tasks: [{ status: 'done', rows: -1 }] };
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ candidates: null, sourceRows: null });
    collecting.collect_info.stats = { rows_total: 0 };
    expect(getCollectionProgress(collecting.collect_info).candidates).toBe(0);
  });
});
