/**
 * @jest-environment node
 *
 * Контракт GET /api/ai-caller/calls/[id]/recording.
 *
 * Инцидент 30.07.2026: «Скачать запись» в AI-звонилке открывала XML
 * `<Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>`.
 * Причина — Vapi отдаёт `recordingUrl` как сырую ссылку на приватный R2-бакет;
 * рабочие ссылки лежат в `artifact.presigned*Url`.
 *
 * Что фиксируем:
 *  1. Прослушивание (без ?download) — редирект на ПОДПИСАННУЮ ссылку.
 *  2. Скачивание (?download=1) — портал сам тянет файл и отдаёт его как
 *     attachment (прямая ссылка на R2 открылась бы вкладкой, а не скачалась).
 *  3. Если подписанная ссылка протухла — 502 JSON, а не XML провайдера в лицо.
 *  4. Нет записи — 404; нет токена — 401.
 */

import type { NextRequest } from 'next/server';

const RAW_URL =
  'https://acc.r2.cloudflarestorage.com/hipaa-recordings/call-1-mono.wav';
const PRESIGNED_MONO =
  'https://hipaa-recordings.acc.r2.cloudflarestorage.com/call-1-mono.wav?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc';

/* ── mocks ───────────────────────────────────────────────────────────────── */

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

describe('GET /api/ai-caller/calls/[id]/recording (vapi)', () => {
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

  it('401 without a token', async () => {
    const req = { headers: new Headers(), url: 'https://portal.local/x' } as unknown as NextRequest;
    const res = await GET(req, { params: Promise.resolve({ id: 'call-1' }) });
    expect(res.status).toBe(401);
  });

  it('redirects playback to the signed URL, never to the raw R2 URL', async () => {
    const res = await GET(makeReq(), ctx);

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('location')).toBe(PRESIGNED_MONO);
  });

  it('streams the file as an attachment for ?download=1', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { 'content-type': 'audio/wav', 'content-length': '4' },
      }),
    ) as unknown as typeof fetch;

    const res = await GET(makeReq('?download=1'), ctx);

    expect(global.fetch).toHaveBeenCalledWith(PRESIGNED_MONO);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="call-call-1.wav"',
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([82, 73, 70, 70]),
    );
  });

  it('502 instead of leaking the provider XML when the signed URL fails', async () => {
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

  it('404 when the call has no recording', async () => {
    mockGetCall.mockResolvedValue({ id: 'call-1', status: 'queued' });

    const res = await GET(makeReq('?download=1'), ctx);

    expect(res.status).toBe(404);
  });
});
