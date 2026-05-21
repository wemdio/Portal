/** @jest-environment node */

/**
 * Tests for POST /api/client/brief/autofill.
 *
 * Endpoint shape (must match implementation):
 *
 *   POST /api/client/brief/autofill
 *   Body:    { website: string }
 *   Auth:    requireClientAuth (same as other /api/client/* routes)
 *
 *   200 -> { ok: true, fieldsPatch: Partial<ClientBriefFields>,
 *            questions: string[], sources: Record<string, string> }
 *   400 -> { error } for missing / invalid website
 *   401 -> when requireClientAuth fails
 *   500 -> when OPENROUTER_BRIEF_API_KEY is missing
 *   502 -> when AI call throws
 *
 * The route MUST NOT save anything to the database. The client UI is the one
 * that decides what to apply and when to save (separate PUT /api/client/brief).
 */

const AUTH_USER_ID = 'user-A';

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => ({
      auth: { userId: AUTH_USER_ID, accessRows: [] },
    })),
  };
});

// Старый мок остался для совместимости с enricher'ами (они используют
// callOpenRouterChat). Главный autofill flow с 2026-05-20 ходит через
// callOpenRouterChatRaw — чтобы читать finish_reason — поэтому второй мок.
const callOpenRouterChatMock: jest.Mock = jest.fn();
const callOpenRouterChatRawMock: jest.Mock = jest.fn();
jest.mock('@/lib/openrouter/client', () => ({
  callOpenRouterChat: (arg: unknown) => callOpenRouterChatMock(arg),
  callOpenRouterChatRaw: (arg: unknown) => callOpenRouterChatRawMock(arg),
}));

const logAuditMock: jest.Mock = jest.fn(async () => {});
const logErrorMock: jest.Mock = jest.fn(async () => {});
jest.mock('@/lib/loggerServer', () => ({
  logAudit: (event: unknown, message?: unknown, meta?: unknown) =>
    logAuditMock(event, message, meta),
  logError: (event: unknown, err?: unknown, meta?: unknown) =>
    logErrorMock(event, err, meta),
}));

import { NextRequest } from 'next/server';

const ORIGINAL_ENV = { ...process.env };

function makeReq(body: unknown): NextRequest {
  const req = new Request('http://x/api/client/brief/autofill', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return req as unknown as NextRequest;
}

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.OPENROUTER_BRIEF_API_KEY = 'test-key';
  callOpenRouterChatMock.mockReset();
  callOpenRouterChatRawMock.mockReset();
  logAuditMock.mockClear();
  logErrorMock.mockClear();
  // Default fetchImpl returns a tiny but valid HTML page.
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () =>
    new Response(
      '<html><head><title>Acme</title><meta name="description" content="We sell widgets"></head><body><p>Body text about widgets</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
  );
  const { requireClientAuth } = jest.requireMock('@/lib/clientApiHelper') as {
    requireClientAuth: jest.Mock;
  };
  requireClientAuth.mockImplementation(async () => ({
    auth: { userId: AUTH_USER_ID, accessRows: [] },
  }));
});

describe('POST /api/client/brief/autofill — happy path', () => {
  it('returns the AI-derived patch (200) and never overwrites with empty strings', async () => {
    callOpenRouterChatRawMock.mockResolvedValueOnce({
      content: JSON.stringify({
        company_website: 'acme.com',
        company_description: 'We make widgets.',
        product_description: '',
        // disallowed field — should be silently dropped by the mapper.
        // persona_name остаётся вне whitelist'а (deal_cycle с 9290c7a
        // уже валидный, и использовать его здесь — обманчиво).
        persona_name: 'should not leak',
        questions: ['Какой средний чек?'],
        sources: { company_website: 'из <title>' },
      }),
      finishReason: 'stop',
    });

    const { POST } = await import('@/app/api/client/brief/autofill/route');
    const res = await POST(makeReq({ website: 'acme.com' }));
    const body = (await (res as Response).json()) as {
      ok: boolean;
      fieldsPatch: Record<string, unknown>;
      questions: string[];
      sources: Record<string, string>;
    };

    expect((res as Response).status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.fieldsPatch.company_website).toBe('acme.com');
    expect(body.fieldsPatch.company_description).toBe('We make widgets.');
    expect(body.fieldsPatch.product_description).toBeUndefined();
    expect(body.fieldsPatch.persona_name).toBeUndefined();
    expect(body.questions).toEqual(['Какой средний чек?']);
    expect(body.sources.company_website).toBe('из <title>');
  });

  it('passes website text to the AI (includes <title> and meta description)', async () => {
    callOpenRouterChatRawMock.mockResolvedValueOnce({
      content: JSON.stringify({ company_website: 'acme.com' }),
      finishReason: 'stop',
    });
    const { POST } = await import('@/app/api/client/brief/autofill/route');
    await POST(makeReq({ website: 'acme.com' }));

    // Main autofill идёт через Raw-вариант. Enricher'ы используют обычный
    // callOpenRouterChat, но в этом тесте HTML не содержит ссылок на
    // /cases/reviews/etc — discovery вернёт 0 кандидатов, enricher'ы скипнут.
    expect(callOpenRouterChatRawMock).toHaveBeenCalledTimes(1);
    expect(callOpenRouterChatMock).not.toHaveBeenCalled();
    const callArg = callOpenRouterChatRawMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessage = callArg.messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage!.content).toContain('Acme');
    expect(userMessage!.content).toContain('We sell widgets');
    expect(userMessage!.content).toContain('Body text about widgets');
  });

  it('audits success', async () => {
    callOpenRouterChatRawMock.mockResolvedValueOnce({
      content: JSON.stringify({ company_website: 'acme.com' }),
      finishReason: 'stop',
    });
    const { POST } = await import('@/app/api/client/brief/autofill/route');
    await POST(makeReq({ website: 'acme.com' }));
    expect(logAuditMock).toHaveBeenCalled();
    const auditCalls = logAuditMock.mock.calls.map((c) => c[0]);
    expect(auditCalls.some((c) => /autofill/i.test(String(c)))).toBe(true);
  });
});

describe('POST /api/client/brief/autofill — validation', () => {
  it('returns 400 when website is missing', async () => {
    const { POST } = await import('@/app/api/client/brief/autofill/route');
    const res = await POST(makeReq({}));
    expect((res as Response).status).toBe(400);
  });

  it('returns 400 when website is empty string', async () => {
    const { POST } = await import('@/app/api/client/brief/autofill/route');
    const res = await POST(makeReq({ website: '   ' }));
    expect((res as Response).status).toBe(400);
  });

  it('returns 400 when website is not http/https or bare domain (mailto:)', async () => {
    const { POST } = await import('@/app/api/client/brief/autofill/route');
    const res = await POST(makeReq({ website: 'mailto:foo@bar' }));
    expect((res as Response).status).toBe(400);
  });

  it('accepts plain domains like redev.ru', async () => {
    callOpenRouterChatRawMock.mockResolvedValueOnce({
      content: JSON.stringify({ company_website: 'redev.ru' }),
      finishReason: 'stop',
    });
    const { POST } = await import('@/app/api/client/brief/autofill/route');
    const res = await POST(makeReq({ website: 'redev.ru' }));
    expect((res as Response).status).toBe(200);
  });
});

describe('POST /api/client/brief/autofill — auth', () => {
  it('returns 401 when requireClientAuth fails', async () => {
    const { requireClientAuth } = jest.requireMock('@/lib/clientApiHelper') as {
      requireClientAuth: jest.Mock;
    };
    const { NextResponse } = jest.requireActual('next/server');
    requireClientAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });

    const { POST } = await import('@/app/api/client/brief/autofill/route');
    const res = await POST(makeReq({ website: 'acme.com' }));
    expect((res as Response).status).toBe(401);
  });
});

describe('POST /api/client/brief/autofill — server config / failures', () => {
  it('returns 500 when OPENROUTER_BRIEF_API_KEY is missing', async () => {
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const { POST } = await import('@/app/api/client/brief/autofill/route');
    const res = await POST(makeReq({ website: 'acme.com' }));
    expect((res as Response).status).toBe(500);
  });

  it('returns 502 when the AI call throws', async () => {
    callOpenRouterChatRawMock.mockRejectedValueOnce(new Error('upstream boom'));
    const { POST } = await import('@/app/api/client/brief/autofill/route');
    const res = await POST(makeReq({ website: 'acme.com' }));
    expect((res as Response).status).toBe(502);
    const body = (await (res as Response).json()) as { error: string };
    expect(body.error).toMatch(/AI|boom|сгенерировать|не удалось/i);
    expect(logErrorMock).toHaveBeenCalled();
  });

  it('returns 502 when the website fetch fails (non-2xx)', async () => {
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      async () => new Response('not found', { status: 404 }),
    );
    const { POST } = await import('@/app/api/client/brief/autofill/route');
    const res = await POST(makeReq({ website: 'acme.com' }));
    expect((res as Response).status).toBe(502);
  });
});
