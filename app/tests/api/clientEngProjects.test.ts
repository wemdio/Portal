/** @jest-environment node */

/**
 * Tests for /api/client/eng/projects (client ENG cabinet, Hypothesis Engine).
 *
 *   GET  -> { projects } — ONLY the caller's projects (created_by = user id),
 *           with vertical_count / base_count per project.
 *   POST { website_url, name? }
 *     201 -> { project, job } — project created with market='us' and research
 *            (site_profile) enqueued right away; name defaults to hostname.
 *     400 -> { error } for missing / invalid website_url.
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

import { GET, POST } from '@/app/api/client/eng/projects/route';

function makeReq(body?: unknown, method = 'POST'): NextRequest {
  return new Request('http://x/api/client/eng/projects', {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  mockDb = createMockSupabase({ tables: { he_projects: [], he_verticals: [], he_bases: [], he_jobs: [] } });
});

describe('GET /api/client/eng/projects — auth & scope', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await GET(makeReq(undefined, 'GET'));
    expect(res.status).toBe(401);
  });

  it('lists only the caller\'s projects with vertical/base counts', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [
          { id: 'p1', created_by: USER_ID, name: 'Mine', website_url: 'https://mine.example/', status: 'draft', market: 'us' },
          { id: 'p2', created_by: OTHER_USER_ID, name: 'Theirs', website_url: 'https://theirs.example/', status: 'draft', market: 'us' },
          { id: 'p3', created_by: USER_ID, name: 'Mine 2', website_url: 'https://mine2.example/', status: 'researched', market: 'us' },
        ],
        he_verticals: [
          { id: 'v1', project_id: 'p3', name: 'Banks' },
          { id: 'v2', project_id: 'p3', name: 'Fintech' },
          { id: 'vX', project_id: 'p2', name: 'Foreign' },
        ],
        he_bases: [
          { id: 'b1', project_id: 'p3', vertical_id: 'v1' },
          { id: 'bX', project_id: 'p2', vertical_id: 'vX' },
        ],
      },
    });

    const res = await GET(makeReq(undefined, 'GET'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      projects: Array<{ id: string; vertical_count: number; base_count: number }>;
    };
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(['p1', 'p3']);
    expect(byId.p3.vertical_count).toBe(2);
    expect(byId.p3.base_count).toBe(1);
    expect(byId.p1.vertical_count).toBe(0);
    expect(byId.p1.base_count).toBe(0);
  });
});

describe('POST /api/client/eng/projects — validation', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await POST(makeReq({ website_url: 'example.com' }));
    expect(res.status).toBe(401);
    expect(mockDb.getRows('he_projects')).toHaveLength(0);
  });

  it('returns 400 when website_url is missing', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a hostname without a dot', async () => {
    const res = await POST(makeReq({ website_url: 'localhost' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-http(s) input', async () => {
    const res = await POST(makeReq({ website_url: 'mailto:foo@bar' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/client/eng/projects — happy path', () => {
  it('creates a us-market project and enqueues site_profile right away', async () => {
    const res = await POST(makeReq({ website_url: 'example.com' }));
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      project: Record<string, unknown>;
      job: Record<string, unknown>;
    };
    expect(body.project.website_url).toBe('https://example.com/');
    expect(body.project.name).toBe('example.com');
    expect(body.project.market).toBe('us');
    expect(body.project.created_by).toBe(USER_ID);
    expect(body.project.status).toBe('researching');
    expect(body.job.stage).toBe('site_profile');
    expect(body.job.status).toBe('pending');

    const rows = mockDb.getRows('he_projects');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({ market: 'us', created_by: USER_ID, status: 'researching' }),
    );
    const jobs = mockDb.getRows('he_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({ stage: 'site_profile', project_id: body.project.id }));
  });

  it('keeps an explicit name', async () => {
    const res = await POST(makeReq({ website_url: 'https://acme.io/about', name: 'Acme' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: Record<string, unknown> };
    expect(body.project.name).toBe('Acme');
    expect(body.project.website_url).toBe('https://acme.io/about');
  });
});
