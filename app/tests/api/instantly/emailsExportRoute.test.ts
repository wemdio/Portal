/** @jest-environment node */

describe('instantly emails export route', () => {
  it('route module loads without errors', async () => {
    await expect(
      import('@/app/api/instantly/emails/export/route'),
    ).resolves.toBeDefined();
  });
});
