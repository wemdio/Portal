/** @jest-environment node */

import { sendTestEmail } from '@/lib/instantly/client';
import { InstantlyApiError } from '@/lib/instantly/errors';

const fetchMock = jest.fn();

describe('sendTestEmail (client)', () => {
  const oldFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.INSTANTLY_PORTAL_API_KEY = 'test-key';
  });

  afterAll(() => {
    global.fetch = oldFetch;
  });

  it('шлёт POST /emails/test с нужным payload и авторизацией; success-ответ резолвится', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'success' }),
    });

    const res = await sendTestEmail({
      eaccount: 'sender@example.com',
      to_address_email_list: 'lead@example.com, client@example.com',
      subject: 'Re: тема',
      body: { html: '<p>draft</p>' },
    });

    expect(res).toEqual({ status: 'success' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.instantly.ai/api/v2/emails/test');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toEqual({
      eaccount: 'sender@example.com',
      to_address_email_list: 'lead@example.com, client@example.com',
      subject: 'Re: тема',
      body: { html: '<p>draft</p>' },
    });
  });

  it('HTTP 200 с телом {error: ACC_*} → бросает InstantlyApiError (иначе ложный sent)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 'ACC_AUTH_ERROR' }),
    });

    await expect(
      sendTestEmail({
        eaccount: 'bad@example.com',
        to_address_email_list: 'lead@example.com',
        subject: 'x',
        body: { html: '<p>x</p>' },
      }),
    ).rejects.toThrow(InstantlyApiError);
  });
});
