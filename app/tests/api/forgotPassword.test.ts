/** @jest-environment node */

/**
 * Coverage for public password-reset route /api/auth/forgot-password.
 *
 * Risks under test:
 *   1. Account enumeration — unknown email returns the same shape as known.
 *   2. Throttle — second hit within RESET_COOLDOWN_MS doesn't issue another
 *      password or another email.
 *   3. Update path — found profile triggers updateUserById then sendEmail
 *      with the generated password.
 *   4. Email destination — we always send to the profile's email, never to
 *      the input string verbatim (defends against future refactors).
 *   5. Failure isolation — SMTP errors don't surface as a 500 / don't leak.
 */

import { NextRequest } from 'next/server';

const mockFromMaybeSingle = jest.fn();
const mockUpdateUserById = jest.fn();
const mockSendTransactionalEmail = jest.fn();
const mockLogAudit = jest.fn();
const mockLogError = jest.fn();

const mockFrom: jest.Mock = jest.fn(() => ({
  select: () => ({
    eq: () => ({
      maybeSingle: () => mockFromMaybeSingle(),
    }),
  }),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (...a: unknown[]) => mockFrom(...a),
    auth: {
      admin: {
        updateUserById: (...a: unknown[]) => mockUpdateUserById(...a),
      },
    },
  },
}));

jest.mock('@/lib/email/smtpClient', () => ({
  sendTransactionalEmail: (...a: unknown[]) => mockSendTransactionalEmail(...a),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
  logError: (...a: unknown[]) => mockLogError(...a),
}));

function makeReq(body: unknown, email?: string): NextRequest {
  const req = new Request('http://x/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  // Body is passed through; email param is for documentation only — the
  // endpoint reads it from JSON.
  void email;
  return req as unknown as NextRequest;
}

// Cooldown is per-email; vary emails between tests so they don't block each other.
let counter = 0;
function freshEmail() {
  counter++;
  return `user${counter}@example.com`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendTransactionalEmail.mockResolvedValue({ id: '<msg>', status: 'accepted' });
  mockUpdateUserById.mockResolvedValue({ data: {}, error: null });
});

describe('POST /api/auth/forgot-password', () => {
  it('возвращает ok=true для неизвестного email и НЕ зовёт updateUserById/sendEmail', async () => {
    const email = freshEmail();
    mockFromMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const { POST } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(makeReq({ email }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockSendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('для известного email: меняет пароль и шлёт письмо на привязанный адрес', async () => {
    const email = freshEmail();
    mockFromMaybeSingle.mockResolvedValueOnce({
      data: { id: 'user-42', email },
      error: null,
    });

    const { POST } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(makeReq({ email }));
    expect(res.status).toBe(200);
    await res.json();

    expect(mockUpdateUserById).toHaveBeenCalledTimes(1);
    expect(mockUpdateUserById.mock.calls[0][0]).toBe('user-42');
    const passwordPassed = mockUpdateUserById.mock.calls[0][1].password;
    expect(typeof passwordPassed).toBe('string');
    expect(passwordPassed.length).toBeGreaterThanOrEqual(14);

    expect(mockSendTransactionalEmail).toHaveBeenCalledTimes(1);
    const emailArg = mockSendTransactionalEmail.mock.calls[0][0];
    expect(emailArg.to).toBe(email);
    // Password contains chars from SPECIALS (!@#$%^&*-_+=), some of which are
    // HTML-special (&). The template escapes them before injecting into HTML
    // — the test would flake on a password containing & or " otherwise. The
    // text version sees the raw password.
    const escapeHtml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    expect(emailArg.html).toContain(escapeHtml(passwordPassed));
    expect(emailArg.text).toContain(passwordPassed);
  });

  it('email отправляется ТОЛЬКО на профильный email, даже если ввели разную регистровую/пробельную форму', async () => {
    const profileEmail = freshEmail();
    mockFromMaybeSingle.mockResolvedValueOnce({
      data: { id: 'user-7', email: profileEmail },
      error: null,
    });

    const { POST } = await import('@/app/api/auth/forgot-password/route');
    // Вход в верхнем регистре + пробелы — endpoint нормализует к lowercase.
    await POST(makeReq({ email: `  ${profileEmail.toUpperCase()}  ` }));

    expect(mockSendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTransactionalEmail.mock.calls[0][0].to).toBe(profileEmail);
  });

  it('второй запрос подряд для того же email throttle: не зовёт update/send', async () => {
    const email = freshEmail();
    mockFromMaybeSingle.mockResolvedValue({
      data: { id: 'user-9', email },
      error: null,
    });

    const { POST } = await import('@/app/api/auth/forgot-password/route');
    await POST(makeReq({ email }));
    expect(mockUpdateUserById).toHaveBeenCalledTimes(1);
    expect(mockSendTransactionalEmail).toHaveBeenCalledTimes(1);

    // Сразу повтор — должен срезаться по cooldown
    const res2 = await POST(makeReq({ email }));
    expect(res2.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledTimes(1); // не выросло
    expect(mockSendTransactionalEmail).toHaveBeenCalledTimes(1); // не выросло
  });

  it('невалидный email (пустой, без @) возвращает ok=true без обращений к БД', async () => {
    const { POST } = await import('@/app/api/auth/forgot-password/route');

    for (const bad of ['', '   ', 'not-an-email', 'no-at-sign']) {
      mockFromMaybeSingle.mockReset();
      const res = await POST(makeReq({ email: bad }));
      expect(res.status).toBe(200);
      expect(mockFromMaybeSingle).not.toHaveBeenCalled();
    }
  });

  it('невалидный JSON возвращает 400', async () => {
    const { POST } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(makeReq('not-json'));
    expect(res.status).toBe(400);
  });

  it('падение SMTP логируется но ответ остаётся ok=true (не палим инфра-проблемы)', async () => {
    const email = freshEmail();
    mockFromMaybeSingle.mockResolvedValueOnce({
      data: { id: 'user-77', email },
      error: null,
    });
    mockSendTransactionalEmail.mockRejectedValueOnce(new Error('SMTP timeout'));

    const { POST } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(makeReq({ email }));
    expect(res.status).toBe(200);
    expect(mockLogError).toHaveBeenCalledWith(
      'auth.forgot.email.failed',
      expect.any(Error),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('падение updateUserById не блокирует ответ и не шлёт письмо', async () => {
    const email = freshEmail();
    mockFromMaybeSingle.mockResolvedValueOnce({
      data: { id: 'user-66', email },
      error: null,
    });
    mockUpdateUserById.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });

    const { POST } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(makeReq({ email }));
    expect(res.status).toBe(200);
    expect(mockSendTransactionalEmail).not.toHaveBeenCalled();
  });
});
