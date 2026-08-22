/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000201';

let mockDb: MockSupabaseClient = createMockSupabase();
let mockAuthorized = true;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () =>
    mockAuthorized
      ? { auth: { supabase: mockDb, userId: USER_ID, role: 'specialist' } }
      : {
          error: new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
        },
  ),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _options: unknown,
    handler: (trace: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => handler({ end: async () => {}, fail: async () => {} }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { GET, POST } from '@/app/api/tools/vertical-engine-v2/projects/route';

function request(body?: unknown, method = 'POST'): NextRequest {
  return new Request('http://x/api/tools/vertical-engine-v2/projects', {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  mockAuthorized = true;
  mockDb = createMockSupabase({
    tables: {
      ve_projects: [],
      he_projects: [{ id: 'legacy-1', name: 'Must stay untouched' }],
    },
  });
});

describe('POST /api/tools/vertical-engine-v2/projects', () => {
  it('requires internal tool authorization', async () => {
    mockAuthorized = false;
    const response = await POST(request({ website_url: 'example.com' }));
    expect(response.status).toBe(403);
    expect(mockDb.mutations).toHaveLength(0);
  });

  it('rejects invalid website input', async () => {
    const response = await POST(request({ website_url: 'not a website' }));
    expect(response.status).toBe(400);
    expect(mockDb.mutations).toHaveLength(0);
  });

  it('creates a draft only in ve_projects', async () => {
    const response = await POST(request({ website_url: 'example.com', name: 'Example' }));
    expect(response.status).toBe(201);

    const body = (await response.json()) as { project: Record<string, unknown> };
    expect(body.project).toEqual(
      expect.objectContaining({
        created_by: USER_ID,
        name: 'Example',
        website_url: 'https://example.com/',
        status: 'draft',
      }),
    );
    expect(mockDb.getRows('ve_projects')).toHaveLength(1);
    expect(mockDb.getRows('he_projects')).toEqual([
      { id: 'legacy-1', name: 'Must stay untouched' },
    ]);
    expect(mockDb.mutations.map((call) => call.table)).toEqual(['ve_projects']);
  });
});

describe('GET /api/tools/vertical-engine-v2/projects', () => {
  it('lists only v2 projects', async () => {
    mockDb = createMockSupabase({
      tables: {
        ve_projects: [
          {
            id: 've-1',
            created_by: USER_ID,
            name: 'New engine project',
            website_url: 'https://new.example/',
            status: 'draft',
          },
        ],
        he_projects: [
          { id: 'he-1', name: 'Legacy project', website_url: 'https://legacy.example/' },
        ],
      },
    });

    const response = await GET(request(undefined, 'GET'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: Array<{ id: string }> };
    expect(body.projects.map((project) => project.id)).toEqual(['ve-1']);
    expect(mockDb.selects.map((call) => call.table)).toEqual(['ve_projects', 've_verticals']);
  });
});
