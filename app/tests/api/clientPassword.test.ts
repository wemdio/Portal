/** @jest-environment node */

/**
 * Coverage for self-service password change route /api/client/password.
 *
 * Risks under test:
 *   1. Auth — unauthenticated callers blocked by requireClientAuth.
 *   2. Validation — short, long, identical-to-current new passwords rejected.
 *   3. Re-auth — wrong current password returns 401, not 500.
 *   4. Email — sendBrevoEmail is invoked with correct args; its failure
 *      does NOT poison the response (fire-and-forget pattern).
 *   5. Audit — successful change is logged via logAudit.
 */

import { NextRequest } from 'next/server';

const mockRequireClientAuth = jest.fn();
const mockUpdateUserById = jest.fn();
const mockGetUserById = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockSendTransactionalEmail = jest.fn();
const mockLogAudit = jest.fn();
const mockLogError = jest.fn();

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (msg: string, status: number) =>
      NextResponse.json({ error: msg }, { status }),
    requireClientAuth: (...args: unknown[]) => mockRequireClientAuth(...args),
  };
});

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        getUserById: (...a: unknown[]) => mockGetUserById(...a),
        updateUserById: (...a: unknown[]) => mockUpdateUserById(...a),
      },
    },
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'test-token',
  createAuthedSupabaseClient: () => ({
    auth: { signInWithPassword: (...a: unknown[]) => mockSignInWithPassword(...a) },
  }),
}));

jest.mock('@/lib/email/notisendClient', () => ({
  sendTransactionalEmail: (...a: unknown[]) => mockSendTransactionalEmail(...a),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
  logError: (...a: unknown[]) => mockLogError(...a),
}));

const okAuth = { auth: { userId: 'user-1', accessRows: [], isDemo: false } };

function makeReq(body: unknown): NextRequest {
  const req = new Request('http://x/api/client/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return req as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireClientAuth.mockResolvedValue(okAuth);
  mockGetUserById.mockResolvedValue({
    data: { user: { id: 'user-1', email: 'me@example.com' } },
    error: null,
  });
  mockSignInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  mockUpdateUserById.mockResolvedValue({ data: {}, error: null });
  mockSendTransactionalEmail.mockResolvedValue({ id: 1, status: 'queued' });
});

describe('POST /api/client/password', () => {
  it('возвращает 401 если auth провалился', async () => {
    const { NextResponse } = jest.requireActual('next/server');
    mockRequireClientAuth.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'old', newPassword: 'NewPass123!' }));
    expect(res.status).toBe(401);
  });

  it('возвращает 400 на невалидный JSON', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq('not json'));
    expect(res.status).toBe(400);
  });

  it('возвращает 400 если currentPassword пустой', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: '', newPassword: 'NewPass123!' }));
    expect(res.status).toBe(400);
  });

  it('возвращает 400 если newPassword короче 8 символов', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'old', newPassword: 'short' }));
    expect(res.status).toBe(400);
  });

  it('возвращает 400 если newPassword длиннее 72 (bcrypt cap)', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'old', newPassword: 'A'.repeat(73) }));
    expect(res.status).toBe(400);
  });

  it('возвращает 400 если newPassword === currentPassword', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(
      makeReq({ currentPassword: 'SamePass1!', newPassword: 'SamePass1!' }),
    );
    expect(res.status).toBe(400);
  });

  it('возвращает 401 если currentPassword неверный', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: {},
      error: { message: 'Invalid credentials' },
    });
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'wrong', newPassword: 'NewPass123!' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/текущ/i);
  });

  it('успех: обновляет пароль через admin API', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    expect(mockUpdateUserById).toHaveBeenCalledWith('user-1', { password: 'NewPass123!' });
  });

  it('успех: отправляет письмо через NotiSend с правильными аргументами', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    await new Promise((r) => setImmediate(r));
    expect(mockSendTransactionalEmail).toHaveBeenCalled();
    const arg = mockSendTransactionalEmail.mock.calls[0][0];
    expect(arg.to).toBe('me@example.com');
    expect(arg.html).toContain('NewPass123!');
    expect(arg.text).toContain('NewPass123!');
  });

  it('успех: пишет audit лог', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      'client.password.change.success',
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('успех: возвращает 200 даже если email отправка упала', async () => {
    mockSendTransactionalEmail.mockRejectedValue(new Error('NotiSend 500'));
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    await new Promise((r) => setImmediate(r));
    expect(res.status).toBe(200);
    expect(mockLogError).toHaveBeenCalledWith(
      'client.password.email.failed',
      expect.anything(),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('возвращает 500 если supabase.auth.admin.updateUserById упал', async () => {
    mockUpdateUserById.mockResolvedValue({ data: null, error: { message: 'DB down' } });
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    expect(res.status).toBe(500);
  });

  it('возвращает 500 если admin.getUserById не вернул email', async () => {
    mockGetUserById.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    expect(res.status).toBe(500);
  });
});
