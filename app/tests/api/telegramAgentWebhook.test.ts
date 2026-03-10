/** @jest-environment node */

describe('telegram agent webhook route', () => {
  it('webhook route module loads', async () => {
    await expect(import('@/app/api/telegram/agent/webhook/route')).resolves.toBeDefined();
  });

  it('register route module loads', async () => {
    await expect(import('@/app/api/telegram/agent/register/route')).resolves.toBeDefined();
  });
});
