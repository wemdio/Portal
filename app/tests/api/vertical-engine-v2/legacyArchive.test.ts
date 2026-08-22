/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000202';
const INTERNAL_PROJECT_ID = '00000000-0000-4000-8000-000000000211';
const ENG_PROJECT_ID = '00000000-0000-4000-8000-000000000212';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockDb, userId: USER_ID, role: 'specialist' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _options: unknown,
    handler: (trace: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => handler({ end: async () => {}, fail: async () => {} }),
}));

import { GET as GET_ARCHIVE } from '@/app/api/tools/vertical-engine-v2/legacy/projects/route';
import { GET as GET_ARCHIVE_DETAIL } from '@/app/api/tools/vertical-engine-v2/legacy/projects/[id]/route';

function request(path = ''): NextRequest {
  return new Request(`http://x/api/tools/vertical-engine-v2/legacy/projects${path}`, {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: {
      ve_legacy_project_links: [
        {
          legacy_he_project_id: INTERNAL_PROJECT_ID,
          verified_by: USER_ID,
          verified_at: '2026-08-20T08:00:00.000Z',
          review_notes: 'Подтверждено специалистом',
          backfill_batch_id: 'manual-1',
        },
      ],
      he_projects: [
        {
          id: INTERNAL_PROJECT_ID,
          created_by: USER_ID,
          name: 'Internal legacy',
          website_url: 'https://internal.example/',
          status: 'researched',
          created_at: '2026-08-01T00:00:00.000Z',
          updated_at: '2026-08-02T00:00:00.000Z',
        },
        {
          id: ENG_PROJECT_ID,
          created_by: 'eng-client',
          name: 'ENG must stay hidden',
          website_url: 'https://eng.example/',
          status: 'researched',
          market: 'us',
          autopilot: true,
        },
      ],
      he_hypotheses: [
        {
          id: 'hyp-1',
          project_id: INTERNAL_PROJECT_ID,
          vertical_id: 'vertical-1',
          title: 'Internal hypothesis',
          tier: 1,
        },
      ],
      he_verticals: [
        {
          id: 'vertical-1',
          project_id: INTERNAL_PROJECT_ID,
          name: 'Internal vertical',
          rank: 1,
        },
      ],
      he_bases: [
        {
          id: 'base-1',
          project_id: INTERNAL_PROJECT_ID,
          vertical_id: 'vertical-1',
          filename: 'legacy.csv',
          row_count: 10,
          data: [{ secret: 'heavy row must not be returned' }],
          collect_info: {
            tasks: [{ source: 'pdl', status: 'done', harvest: [{ secret: 'heavy' }] }],
          },
        },
      ],
      he_jobs: [{ id: 'job-1', project_id: INTERNAL_PROJECT_ID, stage: 'clustering' }],
      he_vertical_dossiers: [],
      he_cases: [],
      he_chains: [
        {
          id: 'chain-1',
          vertical_id: 'vertical-1',
          language: 'ru',
          letters: [{ subject: 'Тема', body: 'Текст', wait_days: 0 }],
        },
      ],
      he_vocab: [],
      he_templates: [
        {
          id: 'template-1',
          vertical_id: 'vertical-1',
          base_id: 'base-1',
          status: 'ready',
        },
      ],
    },
  });
});

describe('GET /api/tools/vertical-engine-v2/legacy/projects', () => {
  it('returns only projects present in the verified link registry', async () => {
    const response = await GET_ARCHIVE(request());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      projects: Array<{ id: string; origin: string; read_only: boolean }>;
    };

    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toEqual(
      expect.objectContaining({
        id: INTERNAL_PROJECT_ID,
        origin: 'legacy',
        read_only: true,
      }),
    );
    expect(body.projects.some((project) => project.id === ENG_PROJECT_ID)).toBe(false);
    expect(mockDb.mutations).toHaveLength(0);
  });
});

describe('GET /api/tools/vertical-engine-v2/legacy/projects/[id]', () => {
  it('returns 404 for an unlinked he_projects id', async () => {
    const response = await GET_ARCHIVE_DETAIL(request(`/${ENG_PROJECT_ID}`), {
      params: Promise.resolve({ id: ENG_PROJECT_ID }),
    });
    expect(response.status).toBe(404);
    expect(mockDb.selects.map((call) => call.table)).toEqual(['ve_legacy_project_links']);
  });

  it('returns an independent read-only snapshot without heavy base data or writes', async () => {
    const response = await GET_ARCHIVE_DETAIL(request(`/${INTERNAL_PROJECT_ID}`), {
      params: Promise.resolve({ id: INTERNAL_PROJECT_ID }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      detail: {
        origin: string;
        read_only: boolean;
        project: { id: string };
        hypotheses: unknown[];
        verticals: unknown[];
        chains: unknown[];
        bases: Array<{ data?: unknown; collect_info?: { tasks?: Array<Record<string, unknown>> } }>;
        templates: unknown[];
      };
    };
    expect(body.detail.origin).toBe('legacy');
    expect(body.detail.read_only).toBe(true);
    expect(body.detail.project.id).toBe(INTERNAL_PROJECT_ID);
    expect(body.detail.hypotheses).toHaveLength(1);
    expect(body.detail.verticals).toHaveLength(1);
    expect(body.detail.chains).toHaveLength(1);
    expect(body.detail.templates).toHaveLength(1);
    expect(body.detail.bases[0]).not.toHaveProperty('data');
    expect(body.detail.bases[0].collect_info?.tasks?.[0]).not.toHaveProperty('harvest');
    expect(mockDb.mutations.filter((call) => call.table.startsWith('he_'))).toHaveLength(0);
  });
});
