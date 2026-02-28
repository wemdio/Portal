/** @jest-environment node */

describe('brief scoring jobs API routes', () => {
  it('jobs route module loads', async () => {
    await expect(import('@/app/api/brief-scoring/jobs/route')).resolves.toBeDefined();
  });

  it('job detail route module loads', async () => {
    await expect(import('@/app/api/brief-scoring/jobs/[jobId]/route')).resolves.toBeDefined();
  });

  it('job results route module loads', async () => {
    await expect(import('@/app/api/brief-scoring/jobs/[jobId]/results/route')).resolves.toBeDefined();
  });
});

