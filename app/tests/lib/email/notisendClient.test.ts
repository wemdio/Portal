/**
 * @jest-environment node
 */
import { sendTransactionalEmail } from '@/lib/email/notisendClient';

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.NOTISEND_API_KEY = 'test-token';
  process.env.NOTISEND_FROM_EMAIL = 'no-reply@outreachos.pro';
  process.env.NOTISEND_FROM_NAME = 'Portal';
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe('sendTransactionalEmail (NotiSend)', () => {
  it('POSTит на правильный URL с Bearer токеном', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 42, status: 'queued' }),
    })) as unknown as typeof fetch;
    global.fetch = fetchSpy;

    await sendTransactionalEmail({
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.notisend.ru/v1/email/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('передаёт плоский body с from_email/from_name/to/subject/html/text', async () => {
    let captured: unknown = null;
    global.fetch = jest.fn(async (_url: unknown, init: unknown) => {
      captured = JSON.parse(String((init as RequestInit).body));
      return { ok: true, status: 200, json: async () => ({ id: 1, status: 'queued' }) };
    }) as unknown as typeof fetch;

    await sendTransactionalEmail({
      to: 'bob@example.org',
      subject: 'Пароль изменён',
      html: '<h1>Hi</h1>',
      text: 'Hi',
    });

    expect(captured).toEqual({
      from_email: 'no-reply@outreachos.pro',
      from_name: 'Portal',
      to: 'bob@example.org',
      subject: 'Пароль изменён',
      text: 'Hi',
      html: '<h1>Hi</h1>',
    });
  });

  it('возвращает { id, status } из ответа NotiSend', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 999, status: 'queued', extra: 'ignored' }),
    })) as unknown as typeof fetch;

    const res = await sendTransactionalEmail({
      to: 'a@b.com',
      subject: 's',
      html: 'h',
      text: 't',
    });
    expect(res).toEqual({ id: 999, status: 'queued' });
  });

  it('кидает ошибку при !ok ответе с телом', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid token"}',
    })) as unknown as typeof fetch;

    await expect(
      sendTransactionalEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/NotiSend.*401/);
  });

  it('кидает ошибку если NOTISEND_API_KEY отсутствует', async () => {
    delete process.env.NOTISEND_API_KEY;
    await expect(
      sendTransactionalEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/NOTISEND_API_KEY/);
  });

  it('кидает ошибку если NOTISEND_FROM_EMAIL отсутствует', async () => {
    delete process.env.NOTISEND_FROM_EMAIL;
    await expect(
      sendTransactionalEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/NOTISEND_FROM_EMAIL/);
  });

  it('использует "Portal" как from_name по умолчанию если NOTISEND_FROM_NAME не задан', async () => {
    delete process.env.NOTISEND_FROM_NAME;
    let captured: { from_name?: string } = {};
    global.fetch = jest.fn(async (_url: unknown, init: unknown) => {
      captured = JSON.parse(String((init as RequestInit).body));
      return { ok: true, status: 200, json: async () => ({ id: 1, status: 'queued' }) };
    }) as unknown as typeof fetch;

    await sendTransactionalEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' });
    expect(captured.from_name).toBe('Portal');
  });
});
