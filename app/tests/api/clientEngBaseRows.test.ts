/** @jest-environment node */

/**
 * Tests for GET /api/client/eng/bases/[id]/rows.
 *
 *   200 -> { columns, rows, total, status, row_count } — страница data-базы
 *          (offset/limit; limit default 100, max 500). Только чтение.
 *   404 -> чужая/несуществующая база (существование не раскрываем).
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

import { GET } from '@/app/api/client/eng/bases/[id]/rows/route';

function makeReq(query = ''): NextRequest {
  return new Request(`http://x/api/client/eng/bases/b1/rows${query}`, {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'b1' }) };

function rows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    company: `Co ${i}`,
    website: `https://co${i}.example/`,
    email: `hi@co${i}.example`,
    _email_status: 'ok',
  }));
}

function seed(createdBy: string = USER_ID, data: Array<Record<string, unknown>> = rows(3)) {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        { id: 'p1', created_by: createdBy, name: 'Mine', website_url: 'https://mine.example/', status: 'researched', market: 'us' },
      ],
      he_bases: [
        {
          id: 'b1',
          project_id: 'p1',
          vertical_id: 'v1',
          status: 'analyzed',
          row_count: data.length,
          columns: ['company', 'website', 'email'],
          data,
        },
      ],
    },
  });
}

beforeEach(() => {
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  seed();
});

describe('GET /api/client/eng/bases/[id]/rows', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await GET(makeReq(), params);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a foreign base', async () => {
    seed(OTHER_USER_ID);
    const res = await GET(makeReq(), params);
    expect(res.status).toBe(404);
  });

  it('returns the first page with defaults (limit 100)', async () => {
    const res = await GET(makeReq(), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      columns: string[];
      rows: Array<Record<string, unknown>>;
      total: number;
      status: string;
      row_count: number;
    };
    expect(body.columns).toEqual(['company', 'website', 'email']);
    expect(body.rows).toHaveLength(3);
    expect(body.total).toBe(3);
    expect(body.status).toBe('analyzed');
    expect(body.row_count).toBe(3);
    expect(body.rows[0]).toEqual(expect.objectContaining({ company: 'Co 0' }));
  });

  it('slices by offset/limit', async () => {
    const res = await GET(makeReq('?offset=1&limit=1'), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { rows: Array<Record<string, unknown>>; total: number };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toEqual(expect.objectContaining({ company: 'Co 1' }));
    expect(body.total).toBe(3);
  });

  it('returns an empty page beyond the end', async () => {
    const res = await GET(makeReq('?offset=10'), params);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    expect(body.rows).toHaveLength(0);
    expect(body.total).toBe(3);
  });

  it('clamps the limit to 500', async () => {
    seed(USER_ID, rows(600));
    const res = await GET(makeReq('?limit=9999'), params);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    expect(body.rows).toHaveLength(500);
    expect(body.total).toBe(600);
  });

  it('falls back to defaults on malformed query values', async () => {
    const res = await GET(makeReq('?offset=abc&limit=-5'), params);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(3);
  });
});
