/** @jest-environment node */

import type { NextRequest } from 'next/server';

const mockRequireInternalToolAuth = jest.fn();
const mockIsConfigured = jest.fn();
const mockSearch = jest.fn();
const mockCount = jest.fn();

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: (...args: unknown[]) => mockRequireInternalToolAuth(...args),
}));
jest.mock('@/lib/twoGisDataset', () => ({
  isTwoGisDatasetConfigured: () => mockIsConfigured(),
}));
jest.mock('@/lib/twoGis/repository', () => ({
  searchTwoGisCards: (...args: unknown[]) => mockSearch(...args),
  countTwoGisCards: (...args: unknown[]) => mockCount(...args),
}));

function request(body: unknown): NextRequest {
  return new Request('http://x/api/tools/2gis-parser/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireInternalToolAuth.mockResolvedValue({
    auth: { userId: 'staff-1', role: 'technician' },
  });
  mockIsConfigured.mockReturnValue(true);
  mockCount.mockResolvedValue(1);
  mockSearch.mockResolvedValue({
    rows: [{ id: '4504127908669251', name: 'Кафе' }],
    nextCursor: null,
  });
});

describe('POST /api/tools/2gis-parser/search', () => {
  it('requires internal authentication', async () => {
    const { NextResponse } = await import('next/server');
    mockRequireInternalToolAuth.mockResolvedValue({
      error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { POST } = await import('@/app/api/tools/2gis-parser/search/route');
    const response = await POST(request({}));
    expect(response.status).toBe(403);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('returns 503 when the isolated dataset is not configured', async () => {
    mockIsConfigured.mockReturnValue(false);
    const { POST } = await import('@/app/api/tools/2gis-parser/search/route');
    const response = await POST(request({ filters: {} }));
    expect(response.status).toBe(503);
  });

  it('returns exact count, preview rows and cursor for normalized filters', async () => {
    const { POST } = await import('@/app/api/tools/2gis-parser/search/route');
    const response = await POST(
      request({
        filters: { cities: [' Москва '], hasPhone: true },
        limit: 100,
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      count: 1,
      rows: [{ id: '4504127908669251', name: 'Кафе' }],
      nextCursor: null,
    });
    expect(mockCount).toHaveBeenCalledWith(
      expect.objectContaining({ cities: ['Москва'], hasPhone: true }),
    );
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ cities: ['Москва'], hasPhone: true }),
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('rejects malformed filter payloads', async () => {
    const { POST } = await import('@/app/api/tools/2gis-parser/search/route');
    const response = await POST(request({ filters: { cities: 'Москва' } }));
    expect(response.status).toBe(400);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('rejects one- and two-character name searches before they scan the dataset', async () => {
    const { POST } = await import('@/app/api/tools/2gis-parser/search/route');
    const response = await POST(request({ filters: { name: 'ab' } }));
    expect(response.status).toBe(400);
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
