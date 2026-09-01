/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextRequest } from 'next/server';

const BASE_ID = 'base-export-1';
const COLUMNS = ['company', 'email'];
const ROWS: Array<Record<string, unknown>> = [
  { company: 'Alpha', email: 'alpha@example.com', _email_status: 'ok' },
  { company: 'Bad status', email: 'status@example.com', _email_status: 'invalid' },
  {
    company: 'Unchecked relevance',
    email: 'unchecked@example.com',
    _email_status: 'ok',
    _relevance_unchecked: true,
  },
  {
    company: 'Low relevance',
    email: 'low@example.com',
    _email_status: 'ok',
    _low_relevance: true,
  },
  { company: 'Alpha duplicate', email: 'ALPHA@example.com', _email_status: 'ok' },
  { company: 'Beta', email: 'beta@example.com', _email_status: 'ok' },
  { company: 'Broken email', email: 'not-an-email', _email_status: 'ok' },
];

let mockPortalDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockPortalDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockPortalDb, userId: 'user-1', role: 'technician' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_options: unknown, handler: () => Promise<unknown>) => handler(),
}));

import { GET } from '@/app/api/tools/vertical-engine-v2/bases/[id]/export/route';

function request(mode?: 'raw' | 'launch-ready'): NextRequest {
  const query = mode ? `?mode=${mode}` : '';
  return new NextRequest(
    `http://portal.test/api/tools/vertical-engine-v2/bases/${BASE_ID}/export${query}`,
    { headers: { authorization: 'Bearer test-token' } },
  );
}

function seed() {
  mockPortalDb = createMockSupabase({
    tables: {
      ve_bases: [
        {
          id: BASE_ID,
          filename: 'contacts.csv',
          row_count: ROWS.length,
          columns: COLUMNS,
          data: ROWS,
          source: 'auto',
        },
      ],
    },
  });
}

describe('Vertical Engine v2 base CSV export', () => {
  beforeEach(seed);

  it('builds launch-ready CSV through the canonical launch gates', async () => {
    const response = await GET(request('launch-ready'), {
      params: Promise.resolve({ id: BASE_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('contacts-launch-ready.csv');

    const csv = await response.text();
    expect(csv.split('\r\n')).toEqual([
      'company;email',
      'Alpha;alpha@example.com',
      'Beta;beta@example.com',
    ]);
    expect(csv).not.toContain('status@example.com');
    expect(csv).not.toContain('unchecked@example.com');
    expect(csv).not.toContain('low@example.com');
    expect(csv).not.toContain('ALPHA@example.com');
    expect(csv).not.toContain('not-an-email');
  });

  it('keeps both explicit and legacy raw modes unfiltered', async () => {
    const explicit = await GET(request('raw'), { params: Promise.resolve({ id: BASE_ID }) });
    const legacy = await GET(request(), { params: Promise.resolve({ id: BASE_ID }) });

    expect(explicit.status).toBe(200);
    expect(legacy.status).toBe(200);
    expect(explicit.headers.get('content-disposition')).toContain('contacts-raw.csv');
    expect(legacy.headers.get('content-disposition')).toContain('contacts.csv');
    const csv = await explicit.text();
    expect(csv).toBe(await legacy.text());

    expect(csv.split('\r\n')).toHaveLength(ROWS.length + 1);
    expect(csv).toContain('status@example.com');
    expect(csv).toContain('unchecked@example.com');
    expect(csv).toContain('low@example.com');
    expect(csv).toContain('ALPHA@example.com');
    expect(csv).toContain('not-an-email');
  });
});
