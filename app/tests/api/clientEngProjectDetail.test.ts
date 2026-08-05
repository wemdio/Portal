/** @jest-environment node */

/**
 * Tests for /api/client/eng/projects/[id] (client ENG cabinet).
 *
 *   GET  -> 200 full detail (project, verticals, hypotheses, chains, bases,
 *           templates, jobs) for the caller's project;
 *           404 for a foreign or missing project (existence is not leaked).
 *   PATCH { offer_override | style_override | signature_override }
 *         -> 200 merges into he_projects.brief; 404 foreign; 400 validation.
 *   401  -> unauthenticated.
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

jest.mock('@/lib/clientDemo/demoResponse', () => ({
  serveClientDemo: jest.fn(async () => NextResponse.json({ demo: true })),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { GET, PATCH } from '@/app/api/client/eng/projects/[id]/route';

function makeReq(method: string, body?: unknown): NextRequest {
  return new Request('http://x/api/client/eng/projects/p1', {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'p1' }) };

function seed(createdBy: string = USER_ID) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        {
          id: 'p1',
          created_by: createdBy,
          name: 'Mine',
          website_url: 'https://mine.example/',
          status: 'researched',
          market: 'us',
          brief: { site_profile: { usp: 'seo' } },
        },
      ],
      he_hypotheses: [
        { id: 'h1', project_id: 'p1', tier: 1, title: 'Banks', status: 'proposed', potential_pct: 40 },
      ],
      he_verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks', rank: 1 }],
      he_chains: [{ id: 'c1', vertical_id: 'v1', language: 'en', letters: [] }],
      he_vocab: [],
      he_bases: [{ id: 'b1', project_id: 'p1', vertical_id: 'v1', status: 'analyzed', source: 'auto', collect_info: { limit: 2000 } }],
      he_templates: [{ id: 't1', vertical_id: 'v1', base_id: 'b1', status: 'ready' }],
      he_jobs: [],
      he_vertical_dossiers: [],
      he_cases: [],
    },
  });
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  seed();
});

describe('GET /api/client/eng/projects/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await GET(makeReq('GET'), params);
    expect(res.status).toBe(401);
  });

  it('returns the full detail for the caller\'s project', async () => {
    const res = await GET(makeReq('GET'), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.project).toEqual(expect.objectContaining({ id: 'p1', market: 'us' }));
    expect(body.hypotheses).toHaveLength(1);
    expect(body.verticals).toHaveLength(1);
    expect(body.chains).toHaveLength(1);
    expect(body.bases).toHaveLength(1);
    expect(body.templates).toHaveLength(1);
    expect(body.jobs).toEqual([]);
  });

  it('returns 404 for a foreign project (existence is not leaked)', async () => {
    seed(OTHER_USER_ID);
    const res = await GET(makeReq('GET'), params);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a missing project', async () => {
    const res = await GET(makeReq('GET'), { params: Promise.resolve({ id: 'nope' }) });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/client/eng/projects/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await PATCH(makeReq('PATCH', { offer_override: 'x' }), params);
    expect(res.status).toBe(401);
  });

  it('merges overrides into the existing brief without clobbering other keys', async () => {
    const res = await PATCH(
      makeReq('PATCH', { offer_override: '5 meetings a month', signature_override: 'Jane Doe, Acme' }),
      params,
    );
    expect(res.status).toBe(200);

    expect(mockDb.getRows('he_projects')[0].brief).toEqual({
      site_profile: { usp: 'seo' },
      offer_override: '5 meetings a month',
      signature_override: 'Jane Doe, Acme',
    });
  });

  it('removes an override on an empty string', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [
          {
            id: 'p1',
            created_by: USER_ID,
            name: 'Mine',
            website_url: 'https://mine.example/',
            status: 'researched',
            market: 'us',
            brief: { site_profile: { usp: 'seo' }, offer_override: 'old offer' },
          },
        ],
      },
    });
    const res = await PATCH(makeReq('PATCH', { offer_override: '' }), params);
    expect(res.status).toBe(200);
    const brief = mockDb.getRows('he_projects')[0].brief as Record<string, unknown>;
    expect(brief).toEqual({ site_profile: { usp: 'seo' } });
  });

  it('returns 404 for a foreign project and does not touch it', async () => {
    seed(OTHER_USER_ID);
    const res = await PATCH(makeReq('PATCH', { offer_override: 'hack' }), params);
    expect(res.status).toBe(404);
    expect(mockDb.updates).toHaveLength(0);
  });

  it('returns 400 when no override field is present', async () => {
    const res = await PATCH(makeReq('PATCH', {}), params);
    expect(res.status).toBe(400);
  });

  it('returns 400 when offer_override is not a string', async () => {
    const res = await PATCH(makeReq('PATCH', { offer_override: 42 }), params);
    expect(res.status).toBe(400);
  });

  it('returns 413 when style_override exceeds 8000 chars', async () => {
    const res = await PATCH(makeReq('PATCH', { style_override: 'x'.repeat(8001) }), params);
    expect(res.status).toBe(413);
  });
});
