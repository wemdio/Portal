/**
 * Contract test for the worker → smtp-proxy HTTP request.
 *
 * After migrating HELO selection to the proxy side (Вариант Б),
 * the worker must no longer send heloDomain/heloFrom in the body —
 * the proxy picks them itself from its own env / os.hostname().
 */

type CapturedCall = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

describe('smtpVerifyViaProxy → request body', () => {
  const originalFetch = global.fetch;
  const savedEnv = { ...process.env };

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...savedEnv };
    jest.resetModules();
  });

  async function runVerify(): Promise<CapturedCall> {
    jest.resetModules();
    process.env.SMTP_PROXY_URLS = 'http://fake-proxy:3100';
    process.env.SMTP_PROXY_API_KEY = 'test-key';

    const captured: CapturedCall = { url: '', headers: {}, body: {} };
    global.fetch = jest.fn(async (url: unknown, init: unknown) => {
      const req = init as { headers?: Record<string, string>; body?: string };
      captured.url = String(url);
      captured.headers = req.headers ?? {};
      captured.body = req.body ? JSON.parse(req.body) : {};
      return new Response(
        JSON.stringify({ code: 250, exists: true, isCatchAll: null, greylist: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const mod = await import('@/lib/emailValidation/validator');
    await mod.smtpVerify('user@example.com', 'mx.example.com');
    return captured;
  }

  it('does NOT include heloDomain/heloFrom in body — proxy decides the HELO itself', async () => {
    const call = await runVerify();

    expect(call.body.email).toBe('user@example.com');
    expect(call.body.mxHost).toBe('mx.example.com');
    expect(call.body).not.toHaveProperty('heloDomain');
    expect(call.body).not.toHaveProperty('heloFrom');
  });

  it('still includes email, mxHost, checkCatchAll, timeout in body', async () => {
    const call = await runVerify();

    expect(call.body).toHaveProperty('email');
    expect(call.body).toHaveProperty('mxHost');
    expect(call.body).toHaveProperty('checkCatchAll');
    expect(call.body).toHaveProperty('timeout');
  });

  it('sends Bearer auth header when SMTP_PROXY_API_KEY is set', async () => {
    const call = await runVerify();

    expect(call.headers.Authorization).toBe('Bearer test-key');
  });

  it('POSTs to <proxyUrl>/smtp-check', async () => {
    const call = await runVerify();

    expect(call.url).toBe('http://fake-proxy:3100/smtp-check');
  });
});
