/** @jest-environment node */

describe('telegram API routes', () => {
  it('verify route module loads', async () => {
    await expect(import('@/app/api/telegram/verify/route')).resolves.toBeDefined();
  });

  it('link route module loads', async () => {
    await expect(import('@/app/api/telegram/link/route')).resolves.toBeDefined();
  });
});

