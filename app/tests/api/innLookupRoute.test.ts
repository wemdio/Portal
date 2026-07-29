/** @jest-environment node */

const fetchInnFromWebsiteMock = jest.fn();

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: jest.fn(() => 'test-token'),
  createAuthedSupabaseClient: jest.fn(() => ({
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: { id: 'user-1' } },
      })),
    },
  })),
}));

jest.mock('@/lib/enrich/websiteParser', () => ({
  fetchInnFromWebsite: (...args: unknown[]) => fetchInnFromWebsiteMock(...args),
}));

jest.mock('@/lib/enrich/dadataClient', () => ({
  hasDadataKey: jest.fn(() => false),
  findByInn: jest.fn(),
}));

import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/enrich/inn-lookup/route';

function makeRequest(items: Array<{ url: string }>): NextRequest {
  return new Request('http://localhost/api/enrich/inn-lookup', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ items }),
  }) as unknown as NextRequest;
}

describe('POST /api/enrich/inn-lookup', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchInnFromWebsiteMock.mockReset();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('checks a full batch concurrently and preserves result order', async () => {
    let active = 0;
    let maxActive = 0;

    fetchInnFromWebsiteMock.mockImplementation(async (url: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return url === 'https://site-3.test' ? '7707083893' : null;
    });

    const items = Array.from({ length: 5 }, (_, index) => ({
      url: `https://site-${index + 1}.test`,
    }));
    const response = await POST(makeRequest(items));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(maxActive).toBe(5);
    expect(fetchInnFromWebsiteMock).toHaveBeenCalledTimes(5);
    expect(fetchInnFromWebsiteMock).toHaveBeenCalledWith(
      'https://site-1.test',
      { timeout: 10_000 },
    );
    expect(body.results).toHaveLength(5);
    expect(body.results[2]).toEqual({ inn: '7707083893', companyName: null });
    expect(body.results[0]).toEqual(
      expect.objectContaining({ inn: null, error: 'no INN found on site' }),
    );
  });

  it('rejects requests larger than the server concurrency cap', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      url: `https://site-${index + 1}.test`,
    }));

    const response = await POST(makeRequest(items));

    expect(response.status).toBe(400);
    expect(fetchInnFromWebsiteMock).not.toHaveBeenCalled();
  });
});
