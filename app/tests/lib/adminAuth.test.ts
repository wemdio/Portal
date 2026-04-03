/** @jest-environment node */

describe('adminAuth', () => {
  it('module loads and exports requireAdmin and jsonError', async () => {
    const mod = await import('@/lib/adminAuth');
    expect(typeof mod.requireAdmin).toBe('function');
    expect(typeof mod.jsonError).toBe('function');
  });

  it('jsonError returns a NextResponse with correct status and body', async () => {
    const { jsonError } = await import('@/lib/adminAuth');
    const res = jsonError('test error', 422);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ error: 'test error' });
  });
});

describe('envPath', () => {
  it('module loads and exports resolveEnvPath', async () => {
    const mod = await import('@/lib/envPath');
    expect(typeof mod.resolveEnvPath).toBe('function');
  });
});
