/** @jest-environment node */

import { withApiTiming } from '@/lib/apiTiming';

describe('withApiTiming', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('returns callback result and logs duration metadata', async () => {
    await expect(
      withApiTiming('client.auth.profile', async () => ({ role: 'client' }), {
        route: '/api/client/tariff',
        method: 'GET',
      }),
    ).resolves.toEqual({ role: 'client' });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      '[api-timing]',
      expect.objectContaining({
        operation: 'client.auth.profile',
        route: '/api/client/tariff',
        method: 'GET',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('logs duration even when callback throws', async () => {
    await expect(
      withApiTiming('client.auth.access', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      '[api-timing]',
      expect.objectContaining({
        operation: 'client.auth.access',
        durationMs: expect.any(Number),
      }),
    );
  });
});
