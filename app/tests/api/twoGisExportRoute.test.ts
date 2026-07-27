/** @jest-environment node */

import type { NextRequest } from 'next/server';

const mockRequireInternalToolAuth = jest.fn();
const mockIsConfigured = jest.fn();
const mockReserveExportConnection = jest.fn();
const mockCreateTicket = jest.fn();
const mockGetTicket = jest.fn();
const mockIterate = jest.fn();

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: (...args: unknown[]) => mockRequireInternalToolAuth(...args),
}));
jest.mock('@/lib/twoGisDataset', () => ({
  isTwoGisDatasetConfigured: () => mockIsConfigured(),
  twoGisDatasetExportConnect: () => mockReserveExportConnection(),
}));
jest.mock('@/lib/twoGis/repository', () => ({
  createTwoGisExportTicket: (...args: unknown[]) => mockCreateTicket(...args),
  getTwoGisExportTicket: (...args: unknown[]) => mockGetTicket(...args),
  iterateTwoGisCards: (...args: unknown[]) => mockIterate(...args),
}));

function postRequest(body: unknown): NextRequest {
  return new Request('http://x/api/tools/2gis-parser/export', {
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
  mockReserveExportConnection.mockResolvedValue({ release: jest.fn() });
  mockCreateTicket.mockResolvedValue({
    token: 'download-token',
    rowCount: 2,
  });
  mockGetTicket.mockResolvedValue({ filters: {}, rowCount: 1, snapshotId: 42 });
  mockIterate.mockImplementation(async function* () {
    yield [
      {
        id: '4504127908669251',
        name: 'Кафе "Волна"',
        city_name: 'Москва',
        geometry_name: 'улица 1',
        post_code: '001234',
        phone: '+74950000000',
        email: '',
        website: 'https://example.ru',
        vkontakte: '',
        instagram: '',
        lon: '37.61',
        lat: '55.75',
        category: 'Еда',
        subcategory: 'Кафе',
      },
    ];
  });
});

describe('2GIS export routes', () => {
  it('creates a short-lived native-download ticket using the same filters', async () => {
    const { POST } = await import('@/app/api/tools/2gis-parser/export/route');
    const response = await POST(postRequest({ filters: { cities: ['Москва'] } }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rowCount: 2,
      downloadUrl: '/api/tools/2gis-parser/export/download-token',
    });
    expect(mockCreateTicket).toHaveBeenCalledWith(
      'staff-1',
      expect.objectContaining({ cities: ['Москва'] }),
    );
  });

  it('uses the same normalized grouped rubric selections for export tickets', async () => {
    const { POST } = await import('@/app/api/tools/2gis-parser/export/route');
    const response = await POST(
      postRequest({
        filters: {
          rubricGroups: [
            { category: ' Еда ', mode: 'all' },
            {
              category: 'Услуги',
              mode: 'some',
              subcategories: [' Ремонт ', 'Ремонт'],
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateTicket).toHaveBeenCalledWith(
      'staff-1',
      expect.objectContaining({
        rubricGroups: [
          { category: 'Еда', mode: 'all' },
          {
            category: 'Услуги',
            mode: 'some',
            subcategories: ['Ремонт'],
          },
        ],
      }),
    );
  });

  it('requires internal authentication before creating a ticket', async () => {
    const { NextResponse } = await import('next/server');
    mockRequireInternalToolAuth.mockResolvedValue({
      error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { POST } = await import('@/app/api/tools/2gis-parser/export/route');
    const response = await POST(postRequest({ filters: {} }));
    expect(response.status).toBe(403);
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it('returns 404 instead of an empty file', async () => {
    mockCreateTicket.mockResolvedValue(null);
    const { POST } = await import('@/app/api/tools/2gis-parser/export/route');
    const response = await POST(postRequest({ filters: {} }));
    expect(response.status).toBe(404);
    expect(mockCreateTicket).toHaveBeenCalledTimes(1);
  });

  it('returns 413 when more than 500,000 rows match the export', async () => {
    mockCreateTicket.mockResolvedValue({
      limited: true,
      rowCount: 500_001,
      maxRows: 500_000,
    });
    const { POST } = await import('@/app/api/tools/2gis-parser/export/route');
    const response = await POST(postRequest({ filters: {} }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Экспорт доступен до 500 000 строк. Уточните фильтры.',
      code: 'EXPORT_ROW_LIMIT',
      rowCount: 500_001,
      maxRows: 500_000,
    });
  });

  it('streams an exact UTF-8 semicolon CSV without buffering all rows', async () => {
    const { GET } = await import('@/app/api/tools/2gis-parser/export/[token]/route');
    const response = await GET(
      new Request('http://x/api/tools/2gis-parser/export/download-token') as unknown as NextRequest,
      { params: Promise.resolve({ token: 'download-token' }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('2gis_russia_');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    expect(text.startsWith('\uFEFFsep=;\r\n')).toBe(true);
    expect(text).toContain('"\'4504127908669251"');
    expect(text).toContain('"Кафе ""Волна"""');
    expect(mockIterate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        batchSize: 5_000,
        snapshotId: 42,
        client: expect.objectContaining({ release: expect.any(Function) }),
      }),
    );
  });

  it('keeps the one-use ticket intact when all export connections are busy', async () => {
    mockReserveExportConnection.mockRejectedValue(new Error('connection timeout'));
    const { GET } = await import('@/app/api/tools/2gis-parser/export/[token]/route');
    const response = await GET(
      new Request('http://x/api/tools/2gis-parser/export/download-token') as unknown as NextRequest,
      { params: Promise.resolve({ token: 'download-token' }) },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('10');
    expect(mockGetTicket).not.toHaveBeenCalled();
  });
});
