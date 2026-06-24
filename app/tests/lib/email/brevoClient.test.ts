/**
 * @jest-environment node
 */
import { sendBrevoEmail } from '@/lib/email/brevoClient';

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  process.env.BREVO_FROM_EMAIL = 'no-reply@outreachos.pro';
  process.env.BREVO_FROM_NAME = 'Portal';
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe('sendBrevoEmail', () => {
  it('POSTит на правильный URL с api-key заголовком', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ messageId: '<msg-1@brevo>' }),
    })) as unknown as typeof fetch;
    global.fetch = fetchSpy;

    await sendBrevoEmail({
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.brevo.com/v3/smtp/email',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'api-key': 'xkeysib-test-key',
          'content-type': 'application/json',
          accept: 'application/json',
        }),
      }),
    );
  });

  it('передаёт sender, to, subject, htmlContent, textContent в body', async () => {
    let capturedBody: unknown = null;
    global.fetch = jest.fn(async (_url: unknown, init: unknown) => {
      capturedBody = JSON.parse(String((init as RequestInit).body));
      return { ok: true, status: 201, json: async () => ({ messageId: 'm1' }) };
    }) as unknown as typeof fetch;

    await sendBrevoEmail({
      to: 'user@example.com',
      subject: 'Пароль изменён',
      html: '<p>html</p>',
      text: 'text',
    });

    expect(capturedBody).toEqual({
      sender: { email: 'no-reply@outreachos.pro', name: 'Portal' },
      to: [{ email: 'user@example.com' }],
      subject: 'Пароль изменён',
      htmlContent: '<p>html</p>',
      textContent: 'text',
    });
  });

  it('возвращает messageId из ответа Brevo', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ messageId: '<abc@brevo>' }),
    })) as unknown as typeof fetch;

    const res = await sendBrevoEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' });
    expect(res.messageId).toBe('<abc@brevo>');
  });

  it('кидает ошибку при !ok ответе с телом', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => '{"message":"Invalid API key"}',
    })) as unknown as typeof fetch;

    await expect(
      sendBrevoEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/Brevo.*401/);
  });

  it('кидает ошибку если BREVO_API_KEY отсутствует', async () => {
    delete process.env.BREVO_API_KEY;
    await expect(
      sendBrevoEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/BREVO_API_KEY/);
  });

  it('кидает ошибку если BREVO_FROM_EMAIL отсутствует', async () => {
    delete process.env.BREVO_FROM_EMAIL;
    await expect(
      sendBrevoEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/BREVO_FROM_EMAIL/);
  });

  it('использует "Portal" как имя отправителя по умолчанию если BREVO_FROM_NAME не задан', async () => {
    delete process.env.BREVO_FROM_NAME;
    let capturedBody: { sender?: { name?: string } } = {};
    global.fetch = jest.fn(async (_url: unknown, init: unknown) => {
      capturedBody = JSON.parse(String((init as RequestInit).body));
      return { ok: true, status: 201, json: async () => ({ messageId: 'm1' }) };
    }) as unknown as typeof fetch;

    await sendBrevoEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' });
    expect(capturedBody.sender?.name).toBe('Portal');
  });
});
