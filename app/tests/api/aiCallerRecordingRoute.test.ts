/**
 * @jest-environment node
 */

import type { NextRequest } from 'next/server';

const RAW_URL =
  'https://acc.r2.cloudflarestorage.com/hipaa-recordings/call-1-mono.wav';
const PRESIGNED_MONO =
  'https://hipaa-recordings.acc.r2.cloudflarestorage.com/call-1-mono.wav?X-Amz-Signature=abc';

const mockGetUser = jest.fn();

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) =>
    header?.startsWith('Bearer ') ? header.slice(7) : '',
  createAuthedSupabaseClient: () => ({ auth: { getUser: mockGetUser } }),
}));

const mockGetCall = jest.fn();

jest.mock('@/lib/ai-caller-provider', () => ({
  ...jest.requireActual('@/lib/ai-caller-provider'),
  getCall: (...args: unknown[]) => mockGetCall(...args),
}));

import { GET } from '@/app/api/ai-caller/calls/[id]/recording/route';

function makeReq(query = ''): NextRequest {
  return {
    headers: new Headers({ authorization: 'Bearer tok' }),
    url: `https://portal.local/api/ai-caller/calls/call-1/recording${query}`,
  } as unknown as NextRequest;
}

const ctx = { params: Promise.resolve({ id: 'call-1' }) };

describe('GET /api/ai-caller/calls/[id]/recording', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AI_CALLER_PROVIDER = 'vapi';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    mockGetCall.mockResolvedValue({
      id: 'call-1',
      recordingUrl: RAW_URL,
      artifact: { recordingUrl: RAW_URL, presignedMonoUrl: PRESIGNED_MONO },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('redirects playback to the signed URL', async () => {
    const res = await GET(makeReq(), ctx);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('location')).toBe(PRESIGNED_MONO);
  });

  it('streams downloads with an attachment filename', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { 'content-type': 'audio/wav', 'content-length': '4' },
      }),
    ) as unknown as typeof fetch;

    const res = await GET(makeReq('?download=1'), ctx);

    expect(global.fetch).toHaveBeenCalledWith(PRESIGNED_MONO);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="call-call-1.wav"',
    );
  });

  it('returns JSON instead of leaking the provider XML on failure', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('<Error><Code>InvalidArgument</Code></Error>', {
        status: 400,
        headers: { 'content-type': 'application/xml' },
      }),
    ) as unknown as typeof fetch;

    const res = await GET(makeReq('?download=1'), ctx);
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
