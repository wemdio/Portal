/** @jest-environment node */

import { readApiError } from '@/lib/apiError';

describe('readApiError', () => {
  it('keeps a structured API error', async () => {
    const response = new Response(JSON.stringify({ error: 'Нет данных' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });

    await expect(readApiError(response)).resolves.toBe('Нет данных');
  });

  it('does not expose an HTML maintenance page to the interface', async () => {
    const response = new Response('<!doctype html><html><title>Портал обновляется</title></html>', {
      status: 504,
      headers: { 'content-type': 'text/html' },
    });

    const message = await readApiError(response);
    expect(message).toContain('Попробуйте позже');
    expect(message).not.toContain('<html');
    expect(message).not.toContain('<!doctype');
  });
});
