/** @jest-environment node */

/**
 * Tests for POST /api/client/eng/projects/[id]/autopilot.
 *
 *   200 -> { ok, chains_enqueued, collects_enqueued, templates_enqueued,
 *            verticals_skipped } — идемпотентный резолвер: доставляет только
 *            недостающие стадии по каждой вертикали + he_projects.autopilot=true.
 *   409 -> проект не 'researched' / нет вертикалей.
 *   404 -> чужой проект (существование не раскрываем).
 *   401 -> unauthenticated.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

let mockDb: MockSupabaseClient = createMockSupabase();
let mockAuthResult: unknown;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/clientApiHelper', () => ({
  jsonError: (message: string, status: number) =>
    NextResponse.json({ error: message }, { status }),
  requireClientAuth: jest.fn(async () => mockAuthResult),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { POST } from '@/app/api/client/eng/projects/[id]/autopilot/route';

function makeReq(): NextRequest {
  return new Request('http://x/api/client/eng/projects/p1/autopilot', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'p1' }) };

interface SeedOpts {
  createdBy?: string;
  status?: string;
  verticals?: Array<Record<string, unknown>>;
  hypotheses?: Array<Record<string, unknown>>;
  chains?: Array<Record<string, unknown>>;
  bases?: Array<Record<string, unknown>>;
  templates?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
}

function seed(opts: SeedOpts = {}) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        {
          id: 'p1',
          created_by: opts.createdBy ?? USER_ID,
          name: 'Mine',
          website_url: 'https://mine.example/',
          status: opts.status ?? 'researched',
          market: 'us',
          autopilot: false,
        },
      ],
      he_verticals: opts.verticals ?? [
        { id: 'v1', project_id: 'p1', name: 'Banks' },
        { id: 'v2', project_id: 'p1', name: 'Fintech' },
      ],
      // Дефолт: у обеих вертикалей есть accepted-гипотеза (иначе вертикаль
      // не клиент-выбрана и автопилот её пропускает).
      he_hypotheses: opts.hypotheses ?? [
        { id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted' },
        { id: 'h2', project_id: 'p1', vertical_id: 'v2', status: 'accepted' },
      ],
      he_chains: opts.chains ?? [],
      he_bases: opts.bases ?? [],
      he_templates: opts.templates ?? [],
      he_jobs: opts.jobs ?? [],
    },
  });
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  seed();
});

describe('POST /api/client/eng/projects/[id]/autopilot — guards', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a foreign project and changes nothing', async () => {
    seed({ createdBy: OTHER_USER_ID });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
    expect(mockDb.getRows('he_projects')[0].autopilot).toBe(false);
  });

  it('returns 409 when the project is not researched yet', async () => {
    seed({ status: 'researching' });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
    expect(mockDb.getRows('he_projects')[0].autopilot).toBe(false);
  });

  it('returns 409 when the project has no verticals', async () => {
    seed({ verticals: [] });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(409);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
  });
});

describe('POST /api/client/eng/projects/[id]/autopilot — resolver', () => {
  it('enqueues a chain per vertical (language from market) and sets the flag', async () => {
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      chains_enqueued: number;
      collects_enqueued: number;
      templates_enqueued: number;
      verticals_skipped: number;
    };
    expect(body).toEqual({
      ok: true,
      chains_enqueued: 2,
      collects_enqueued: 0,
      templates_enqueued: 0,
      verticals_skipped: 0,
    });

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j).toEqual(expect.objectContaining({ project_id: 'p1', stage: 'chain', status: 'pending' }));
      expect((j.payload as { language?: string }).language).toBe('en');
    }
    expect(new Set(jobs.map((j) => (j.payload as { vertical_id?: string }).vertical_id))).toEqual(
      new Set(['v1', 'v2']),
    );

    expect(mockDb.getRows('he_projects')[0].autopilot).toBe(true);
  });

  it('is idempotent: a second call enqueues nothing and reports skips', async () => {
    await POST(makeReq(), params);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      chains_enqueued: number;
      collects_enqueued: number;
      templates_enqueued: number;
      verticals_skipped: number;
    };
    expect(body.chains_enqueued).toBe(0);
    expect(body.collects_enqueued).toBe(0);
    expect(body.templates_enqueued).toBe(0);
    expect(body.verticals_skipped).toBe(2);
    expect(mockDb.getRows('he_jobs')).toHaveLength(2);
  });

  it('enqueues base_collect for a vertical with a ready chain (accepted hypotheses)', async () => {
    seed({
      verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks' }],
      chains: [{ id: 'c1', vertical_id: 'v1', status: 'ready' }],
      hypotheses: [
        { id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted' },
        { id: 'h2', project_id: 'p1', vertical_id: 'v1', status: 'rejected' },
      ],
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { chains_enqueued: number; collects_enqueued: number };
    expect(body.chains_enqueued).toBe(0);
    expect(body.collects_enqueued).toBe(1);

    const bases = mockDb.getRows('he_bases');
    expect(bases).toHaveLength(1);
    expect(bases[0]).toEqual(
      expect.objectContaining({ vertical_id: 'v1', source: 'auto', status: 'collecting' }),
    );

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(
      expect.objectContaining({
        stage: 'base_collect',
        payload: { base_id: bases[0].id, limit: 2000, hypothesis_ids: ['h1'] },
      }),
    );
  });

  it('enqueues template for an analyzed base without a template', async () => {
    seed({
      verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks' }],
      chains: [{ id: 'c1', vertical_id: 'v1', status: 'ready' }],
      bases: [{ id: 'b1', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'analyzed' }],
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { collects_enqueued: number; templates_enqueued: number };
    expect(body.collects_enqueued).toBe(0);
    expect(body.templates_enqueued).toBe(1);

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(
      expect.objectContaining({ stage: 'template', status: 'pending', payload: { base_id: 'b1' } }),
    );
  });

  it('skips a fully covered vertical (chain ready, base analyzed, template exists)', async () => {
    seed({
      verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks' }],
      chains: [{ id: 'c1', vertical_id: 'v1', status: 'ready' }],
      bases: [{ id: 'b1', project_id: 'p1', vertical_id: 'v1', source: 'auto', status: 'analyzed' }],
      templates: [{ id: 't1', vertical_id: 'v1', base_id: 'b1', status: 'ready' }],
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      chains_enqueued: number;
      collects_enqueued: number;
      templates_enqueued: number;
      verticals_skipped: number;
    };
    expect(body.chains_enqueued).toBe(0);
    expect(body.collects_enqueued).toBe(0);
    expect(body.templates_enqueued).toBe(0);
    expect(body.verticals_skipped).toBe(1);
    expect(mockDb.getRows('he_jobs')).toHaveLength(0);
    // Флаг ставится и на «всё уже готово» — воркер подхватит следующие стадии.
    expect(mockDb.getRows('he_projects')[0].autopilot).toBe(true);
  });

  it('drives only client-chosen verticals: 0 accepted hypotheses → skip', async () => {
    seed({
      hypotheses: [
        { id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted' },
        { id: 'h2', project_id: 'p1', vertical_id: 'v2', status: 'rejected' },
        { id: 'h3', project_id: 'p1', vertical_id: 'v2', status: 'proposed' },
      ],
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { chains_enqueued: number; verticals_skipped: number };
    // Только v1 (accepted) получает chain; v2 (0 accepted) — пропуск.
    expect(body.chains_enqueued).toBe(1);
    expect(body.verticals_skipped).toBe(1);

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect((jobs[0].payload as { vertical_id?: string }).vertical_id).toBe('v1');
  });

  it('ignores refill bases: an auto-refill base is not the vertical main base', async () => {
    seed({
      verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks' }],
      chains: [{ id: 'c1', vertical_id: 'v1', status: 'ready' }],
      // Refill-база auto-pipeline: analyzed, но это НЕ основная база вертикали —
      // шаблон по ней строить нельзя, сборку основной базы она не блокирует.
      bases: [
        {
          id: 'b-refill',
          project_id: 'p1',
          vertical_id: 'v1',
          source: 'auto',
          status: 'analyzed',
          filename: 'auto-refill: Banks · 2026-08-12',
        },
      ],
    });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { collects_enqueued: number; templates_enqueued: number };
    // Основной базы нет → ставим сборку; шаблон по refill-базе НЕ ставим.
    expect(body.collects_enqueued).toBe(1);
    expect(body.templates_enqueued).toBe(0);

    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({ stage: 'base_collect' }));
  });
});
