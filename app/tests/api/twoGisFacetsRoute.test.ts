/** @jest-environment node */

import type { NextRequest } from 'next/server';

const mockRequireInternalToolAuth = jest.fn();
const mockIsConfigured = jest.fn();
const mockGetFacets = jest.fn();

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: (...args: unknown[]) => mockRequireInternalToolAuth(...args),
}));
jest.mock('@/lib/twoGisDataset', () => ({
  isTwoGisDatasetConfigured: () => mockIsConfigured(),
}));
jest.mock('@/lib/twoGis/repository', () => ({
  getTwoGisFacets: (...args: unknown[]) => mockGetFacets(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireInternalToolAuth.mockResolvedValue({
    auth: { userId: 'staff-1', role: 'technician' },
  });
  mockIsConfigured.mockReturnValue(true);
  mockGetFacets.mockResolvedValue({
    cities: [],
    categories: [],
    subcategories: [],
    snapshot: { scope: 'Россия', date: '2026-07-26', rows: 4_284_927 },
  });
});

describe('GET /api/tools/2gis-parser/facets', () => {
  it('requires internal authentication', async () => {
    const { NextResponse } = await import('next/server');
    mockRequireInternalToolAuth.mockResolvedValue({
      error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { GET } = await import('@/app/api/tools/2gis-parser/facets/route');
    const response = await GET(
      new Request('http://x/api/tools/2gis-parser/facets') as unknown as NextRequest,
    );
    expect(response.status).toBe(403);
    expect(mockGetFacets).not.toHaveBeenCalled();
  });

  it('returns the isolated snapshot facets', async () => {
    const { GET } = await import('@/app/api/tools/2gis-parser/facets/route');
    const response = await GET(
      new Request('http://x/api/tools/2gis-parser/facets') as unknown as NextRequest,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({ rows: 4_284_927 }),
      }),
    );
  });
});
