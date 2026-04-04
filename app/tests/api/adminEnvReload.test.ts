/** @jest-environment node */

describe('admin env reload API route', () => {
  it('reload route module loads', async () => {
    await expect(import('@/app/api/admin/env/reload/route')).resolves.toBeDefined();
  });

  it('exports a POST handler', async () => {
    const mod = await import('@/app/api/admin/env/reload/route');
    expect(typeof mod.POST).toBe('function');
  });
});

describe('admin env route (refactored)', () => {
  it('env route module loads', async () => {
    await expect(import('@/app/api/admin/env/route')).resolves.toBeDefined();
  });

  it('exports GET and PUT handlers', async () => {
    const mod = await import('@/app/api/admin/env/route');
    expect(typeof mod.GET).toBe('function');
    expect(typeof mod.PUT).toBe('function');
  });
});
