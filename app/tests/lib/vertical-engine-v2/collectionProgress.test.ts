/** @jest-environment node */

import { getCollectionProgress, getCollectionQueue } from '@/components/vertical-engine-v2/engine/collectionProgress';
import type { VeBaseSummary } from '@/components/vertical-engine-v2/engine/api';

function base(id: string, createdAt: string, info: VeBaseSummary['collect_info'] = {}): VeBaseSummary {
  return {
    id, created_at: createdAt, collect_info: info, status: 'collecting', source: 'auto',
    vertical_id: id, hypothesis_id: null, filename: id, row_count: 0,
    analysis: null, columns: [], sample_rows: [],
  };
}

describe('VE2 collection progress presentation', () => {
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
