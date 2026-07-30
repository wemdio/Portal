/** @jest-environment node */

/**
 * Tests for /api/tools/hypothesis-engine/projects.
 *
 *   POST { website_url, name? }
 *     201 -> { project } (name defaults to hostname, url normalized)
 *     400 -> { error } for missing / invalid website_url
 *   GET
 *     200 -> { projects } with vertical_count per project
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000001';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockDb, userId: USER_ID, role: 'admin' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _o: unknown,
    h: (t: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => h({ end: async () => {}, fail: async () => {} }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { GET, POST } from '@/app/api/tools/hypothesis-engine/projects/route';
import { PATCH } from '@/app/api/tools/hypothesis-engine/projects/[id]/route';

function makeReq(body?: unknown, method = 'POST'): NextRequest {
  return new Request('http://x/api/tools/hypothesis-engine/projects', {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

function makePatchReq(body: unknown): NextRequest {
  return new Request('http://x/api/tools/hypothesis-engine/projects/p1', {
    method: 'PATCH',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const patchParams = { params: Promise.resolve({ id: 'p1' }) };

beforeEach(() => {
  mockDb = createMockSupabase({ tables: { he_projects: [], he_verticals: [] } });
});

describe('POST /api/tools/hypothesis-engine/projects — validation', () => {
  it('returns 400 when website_url is missing', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 when website_url is blank', async () => {
    const res = await POST(makeReq({ website_url: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-http(s) input (mailto:)', async () => {
    const res = await POST(makeReq({ website_url: 'mailto:foo@bar' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for free text with spaces', async () => {
    const res = await POST(makeReq({ website_url: 'не сайт а текст' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a hostname without a dot', async () => {
    const res = await POST(makeReq({ website_url: 'localhost' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tools/hypothesis-engine/projects — happy path', () => {
  it('normalizes a bare domain, defaults name to hostname, returns 201', async () => {
    const res = await POST(makeReq({ website_url: 'example.com' }));
    expect(res.status).toBe(201);

    const body = (await res.json()) as { project: Record<string, unknown> };
    expect(body.project.website_url).toBe('https://example.com/');
    expect(body.project.name).toBe('example.com');
    expect(body.project.status).toBe('draft');
    expect(body.project.created_by).toBe(USER_ID);

    const rows = mockDb.getRows('he_projects');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ website_url: 'https://example.com/' }));
  });

  it('keeps an explicit name and an https URL', async () => {
    const res = await POST(makeReq({ website_url: 'https://acme.io/about', name: 'Acme' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: Record<string, unknown> };
    expect(body.project.name).toBe('Acme');
    expect(body.project.website_url).toBe('https://acme.io/about');
  });
});

describe('GET /api/tools/hypothesis-engine/projects', () => {
  it('lists projects with per-project vertical counts', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [
          { id: 'p1', name: 'One', website_url: 'https://one.example/', status: 'draft' },
          { id: 'p2', name: 'Two', website_url: 'https://two.example/', status: 'researched' },
        ],
        he_verticals: [
          { id: 'v1', project_id: 'p2', name: 'Banks' },
          { id: 'v2', project_id: 'p2', name: 'Fintech' },
        ],
      },
    });

    const res = await GET(makeReq(undefined, 'GET'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      projects: Array<{ id: string; vertical_count: number }>;
    };
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p.vertical_count]));
    expect(byId).toEqual({ p1: 0, p2: 2 });
  });
});

describe('PATCH /api/tools/hypothesis-engine/projects/[id] — validation', () => {
  it('returns 400 when offer_override is missing', async () => {
    const res = await PATCH(makePatchReq({}), patchParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when offer_override is not a string', async () => {
    const res = await PATCH(makePatchReq({ offer_override: 42 }), patchParams);
    expect(res.status).toBe(400);
    expect(mockDb.updates).toHaveLength(0);
  });
});

describe('PATCH /api/tools/hypothesis-engine/projects/[id] — offer_override', () => {
  it('merges offer_override into the existing brief without clobbering other keys', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [
          {
            id: 'p1',
            name: 'One',
            website_url: 'https://one.example/',
            status: 'draft',
            brief: { site_profile: { usp: 'seo' } },
          },
        ],
      },
    });

    const res = await PATCH(makePatchReq({ offer_override: '3–5 встреч в месяц с HRD' }), patchParams);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { project: { id: string } };
    expect(body.project.id).toBe('p1');

    expect(mockDb.getRows('he_projects')[0].brief).toEqual({
      site_profile: { usp: 'seo' },
      offer_override: '3–5 встреч в месяц с HRD',
    });
  });

  it('removes offer_override from brief on an empty string', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [
          {
            id: 'p1',
            name: 'One',
            website_url: 'https://one.example/',
            status: 'draft',
            brief: { site_profile: { usp: 'seo' }, offer_override: 'старый оффер' },
          },
        ],
      },
    });

    const res = await PATCH(makePatchReq({ offer_override: '' }), patchParams);
    expect(res.status).toBe(200);

    const brief = mockDb.getRows('he_projects')[0].brief as Record<string, unknown>;
    expect(brief).toEqual({ site_profile: { usp: 'seo' } });
    expect(brief).not.toHaveProperty('offer_override');
  });
});

describe('PATCH /api/tools/hypothesis-engine/projects/[id] — style_override', () => {
  it('merges style_override without clobbering offer_override/site_profile', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [
          {
            id: 'p1',
            name: 'One',
            website_url: 'https://one.example/',
            status: 'draft',
            brief: { site_profile: { usp: 'seo' }, offer_override: '3–5 встреч в месяц' },
          },
        ],
      },
    });

    const res = await PATCH(makePatchReq({ style_override: 'Здравствуйте, Иван! …' }), patchParams);
    expect(res.status).toBe(200);

    expect(mockDb.getRows('he_projects')[0].brief).toEqual({
      site_profile: { usp: 'seo' },
      offer_override: '3–5 встреч в месяц',
      style_override: 'Здравствуйте, Иван! …',
    });
  });

  it('accepts offer_override and style_override in one request', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [
          {
            id: 'p1',
            name: 'One',
            website_url: 'https://one.example/',
            status: 'draft',
            brief: { site_profile: { usp: 'seo' } },
          },
        ],
      },
    });

    const res = await PATCH(
      makePatchReq({ offer_override: 'тест за 2 недели', style_override: 'Добрый день! …', junk: 1 }),
      patchParams,
    );
    expect(res.status).toBe(200);

    expect(mockDb.getRows('he_projects')[0].brief).toEqual({
      site_profile: { usp: 'seo' },
      offer_override: 'тест за 2 недели',
      style_override: 'Добрый день! …',
    });
  });

  it('returns 400 when style_override is not a string', async () => {
    const res = await PATCH(makePatchReq({ style_override: 42 }), patchParams);
    expect(res.status).toBe(400);
    expect(mockDb.updates).toHaveLength(0);
  });

  it('returns 413 when style_override exceeds 8000 chars after trim', async () => {
    const res = await PATCH(makePatchReq({ style_override: `  ${'д'.repeat(8001)}  ` }), patchParams);
    expect(res.status).toBe(413);
    expect(mockDb.updates).toHaveLength(0);
  });

  it('removes style_override from brief on an empty string', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [
          {
            id: 'p1',
            name: 'One',
            website_url: 'https://one.example/',
            status: 'draft',
            brief: { site_profile: { usp: 'seo' }, style_override: 'старый эталон' },
          },
        ],
      },
    });

    const res = await PATCH(makePatchReq({ style_override: '' }), patchParams);
    expect(res.status).toBe(200);

    const brief = mockDb.getRows('he_projects')[0].brief as Record<string, unknown>;
    expect(brief).toEqual({ site_profile: { usp: 'seo' } });
    expect(brief).not.toHaveProperty('style_override');
  });
});
