/** @jest-environment node */

describe('project brief API route', () => {
  it('route module loads', async () => {
    await expect(import('@/app/api/projects/[id]/brief/route')).resolves.toBeDefined();
  });
});
