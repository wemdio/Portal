/** @jest-environment node */

/**
 * Автопилот ENG-кабинета (enqueueAutopilotFollowups): дочейн конвейера после
 * done-джобы ТОЛЬКО при he_projects.autopilot=true.
 *
 *   chain done        → сборка базы вертикали (enqueueHeBaseCollect, лимит
 *                       AUTOPILOT_BASE_LIMIT, accepted-гипотезы; пусто → по всем);
 *   base_analyze done → template-джоба (база обязана быть 'analyzed', дедуп
 *                       активных template-джоб этой базы);
 *   прочие стадии / autopilot=false → no-op, в БД ничего не пишется.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeJob, HeStage } from '@/lib/hypothesisEngine/types';
import { AUTOPILOT_BASE_LIMIT, enqueueAutopilotFollowups } from '@/lib/hypothesisEngine/autopilotNext';

function makeJob(stage: HeStage, payload: Record<string, unknown>): HeJob {
  return {
    id: `job-${stage}-1`,
    project_id: 'p1',
    stage,
    status: 'done',
    payload,
    result: {},
    attempts: 0,
    error: null,
    started_at: null,
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-11T00:00:00Z',
    updated_at: '2026-08-11T00:00:00Z',
  };
}

let mockDb: MockSupabaseClient = createMockSupabase();

function seed(autopilot: boolean, extra: Record<string, Array<Record<string, unknown>>> = {}) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [{ id: 'p1', market: 'us', autopilot }],
      he_verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks' }],
      he_hypotheses: [],
      he_bases: [],
      he_jobs: [],
      he_templates: [],
      ...extra,
    },
  });
}

const db = () => mockDb as unknown as SupabaseClient;

describe('enqueueAutopilotFollowups — chain done', () => {
  it('enqueues base_collect with accepted hypotheses when autopilot is on', async () => {
    seed(true, {
      he_hypotheses: [
        { id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted' },
        { id: 'h2', project_id: 'p1', vertical_id: 'v1', status: 'accepted' },
        { id: 'h3', project_id: 'p1', vertical_id: 'v1', status: 'rejected' },
      ],
    });
    const res = await enqueueAutopilotFollowups(db(), makeJob('chain', { vertical_id: 'v1', language: 'en' }));

    expect(res).toEqual({ collect: 'enqueued' });

    const bases = mockDb.getRows('he_bases');
    expect(bases).toHaveLength(1);
    expect(bases[0]).toEqual(
      expect.objectContaining({ vertical_id: 'v1', source: 'auto', status: 'collecting' }),
    );

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(
      expect.objectContaining({
        project_id: 'p1',
        stage: 'base_collect',
        status: 'pending',
        payload: {
          base_id: bases[0].id,
          limit: AUTOPILOT_BASE_LIMIT,
          hypothesis_ids: ['h1', 'h2'],
        },
      }),
    );
  });

  it('collects across all hypotheses when none are accepted (null selection)', async () => {
    seed(true, {
      he_hypotheses: [{ id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'proposed' }],
    });
    const res = await enqueueAutopilotFollowups(db(), makeJob('chain', { vertical_id: 'v1' }));

    expect(res).toEqual({ collect: 'enqueued' });
    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(
      expect.objectContaining({
        stage: 'base_collect',
        payload: expect.objectContaining({ limit: AUTOPILOT_BASE_LIMIT }),
      }),
    );
    expect((jobs[0].payload as Record<string, unknown>).hypothesis_ids).toBeUndefined();
  });

  it('dedups against an already collecting base of the vertical', async () => {
    seed(true, {
      he_bases: [
        { id: 'b-old', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'collecting', collect_info: { limit: 2000 } },
      ],
    });
    const res = await enqueueAutopilotFollowups(db(), makeJob('chain', { vertical_id: 'v1' }));

    expect(res).toEqual({ collect: 'existing' });
    expect(mockDb.getRows('he_bases')).toHaveLength(1);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });

  it('skips when the payload has no vertical_id', async () => {
    seed(true);
    const res = await enqueueAutopilotFollowups(db(), makeJob('chain', {}));
    expect(res).toEqual({ collect: 'skipped' });
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });
});

describe('enqueueAutopilotFollowups — base_analyze done', () => {
  it('enqueues a template job for an analyzed base when autopilot is on', async () => {
    seed(true, {
      he_bases: [{ id: 'b1', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'analyzed' }],
    });
    const res = await enqueueAutopilotFollowups(db(), makeJob('base_analyze', { base_id: 'b1' }));

    expect(res).toEqual({ template: 'enqueued' });
    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(
      expect.objectContaining({
        project_id: 'p1',
        stage: 'template',
        status: 'pending',
        payload: { base_id: 'b1' },
      }),
    );
  });

  it('skips when the base is not analyzed yet', async () => {
    seed(true, {
      he_bases: [{ id: 'b1', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'collecting' }],
    });
    const res = await enqueueAutopilotFollowups(db(), makeJob('base_analyze', { base_id: 'b1' }));

    expect(res).toEqual({ template: 'skipped' });
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });

  it('dedups against an active template job of this base', async () => {
    seed(true, {
      he_bases: [{ id: 'b1', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'analyzed' }],
      he_jobs: [
        { id: 'j-tpl', project_id: 'p1', stage: 'template', status: 'running', payload: { base_id: 'b1' } },
      ],
    });
    const res = await enqueueAutopilotFollowups(db(), makeJob('base_analyze', { base_id: 'b1' }));

    expect(res).toEqual({ template: 'existing' });
    expect(mockDb.getRows('he_jobs')).toHaveLength(1);
  });

  it('ignores active template jobs of OTHER bases', async () => {
    seed(true, {
      he_bases: [{ id: 'b1', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'analyzed' }],
      he_jobs: [
        { id: 'j-tpl', project_id: 'p1', stage: 'template', status: 'pending', payload: { base_id: 'b-other' } },
      ],
    });
    const res = await enqueueAutopilotFollowups(db(), makeJob('base_analyze', { base_id: 'b1' }));

    expect(res).toEqual({ template: 'enqueued' });
    expect(mockDb.getRows('he_jobs')).toHaveLength(2);
  });
});

describe('enqueueAutopilotFollowups — no-op paths', () => {
  it('does nothing when autopilot is off (chain done)', async () => {
    seed(false);
    const res = await enqueueAutopilotFollowups(db(), makeJob('chain', { vertical_id: 'v1' }));
    expect(res).toEqual({});
    expect(mockDb.getRows('he_bases')).toHaveLength(0);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });

  it('does nothing when autopilot is off (base_analyze done)', async () => {
    seed(false, {
      he_bases: [{ id: 'b1', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'analyzed' }],
    });
    const res = await enqueueAutopilotFollowups(db(), makeJob('base_analyze', { base_id: 'b1' }));
    expect(res).toEqual({});
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });

  it('does nothing for non-pipeline stages even when autopilot is on', async () => {
    seed(true);
    for (const stage of ['site_profile', 'clustering', 'base_collect', 'template'] as HeStage[]) {
      const res = await enqueueAutopilotFollowups(db(), makeJob(stage, { vertical_id: 'v1', base_id: 'b1' }));
      expect(res).toEqual({});
    }
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });
});
