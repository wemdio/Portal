/** @jest-environment node */

import { NextRequest } from 'next/server';

const mockEq = jest.fn();
const mockIn = jest.fn(() => ({ eq: mockEq }));
const mockSelect = jest.fn(() => ({ in: mockIn }));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: jest.requireActual('@/lib/supabaseRouteClient').getBearerToken,
  createAuthedSupabaseClient: jest.fn(() => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: { id: 'test-user' } }, error: null })),
    },
  })),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: mockSelect,
    })),
  },
}));

function makeReq(body: unknown, auth = 'Bearer test-token'): NextRequest {
  const req = new Request('http://x/api/enrich/fns-revenue', {
    method: 'POST',
    headers: {
      authorization: auth,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return req as unknown as NextRequest;
}

describe('POST /api/enrich/fns-revenue', () => {
  beforeEach(() => {
    mockEq.mockClear();
    mockIn.mockClear();
    mockSelect.mockClear();
    mockIn.mockImplementation(() => ({ eq: mockEq }));
    mockSelect.mockImplementation(() => ({ in: mockIn }));
    mockEq.mockResolvedValue({
      data: [
        {
          inn: '7707083893',
          org_name: 'Example LLC',
          income: 100,
          expense: 20,
          report_year: 2025,
        },
      ],
      error: null,
    });
  });

  it('filters by report_year=2025 when requested', async () => {
    const { POST } = await import('@/app/api/enrich/fns-revenue/route');
    const res = await POST(makeReq({ inns: ['7707083893'], report_year: 2025 }));
    expect(res.status).toBe(200);

    expect(mockSelect).toHaveBeenCalledWith('inn, org_name, income, expense, report_year');
    expect(mockIn).toHaveBeenCalledWith('inn', ['7707083893']);
    expect(mockEq).toHaveBeenCalledWith('report_year', 2025);

    const json = (await res.json()) as {
      results: Record<string, { income: number; report_year: number }>;
      report_year: number;
    };
    expect(json.report_year).toBe(2025);
    expect(json.results['7707083893'].income).toBe(100);
  });

  it('defaults report_year to 2024 when omitted', async () => {
    const { POST } = await import('@/app/api/enrich/fns-revenue/route');
    const res = await POST(makeReq({ inns: ['7707083893'] }));
    expect(res.status).toBe(200);
    expect(mockEq).toHaveBeenCalledWith('report_year', 2024);
    const json = (await res.json()) as { report_year: number };
    expect(json.report_year).toBe(2024);
  });

  it('rejects unsupported report_year', async () => {
    const { POST } = await import('@/app/api/enrich/fns-revenue/route');
    const res = await POST(makeReq({ inns: ['7707083893'], report_year: 2023 }));
    expect(res.status).toBe(400);
    expect(mockEq).not.toHaveBeenCalled();
  });

  it('returns 401 without bearer token', async () => {
    const { POST } = await import('@/app/api/enrich/fns-revenue/route');
    const res = await POST(makeReq({ inns: ['1'] }, ''));
    expect(res.status).toBe(401);
  });
});
