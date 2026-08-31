/** @jest-environment node */

import { NextRequest } from 'next/server';
// unzipper has no bundled declarations; this test only uses the two methods typed below.
// @ts-expect-error missing optional @types/unzipper package
import * as unzipper from 'unzipper';

type ZipEntry = { path: string; buffer: () => Promise<Buffer> };
type OpenedZip = { files: ZipEntry[] };

const mockRpc = jest.fn();
const mockGetUser = jest.fn();
const mockLogError = jest.fn(async (
  _event: unknown,
  _error: unknown,
  _context?: unknown,
  _meta?: unknown,
) => {});

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) => (header?.startsWith('Bearer ') ? header.slice(7) : null),
  createAuthedSupabaseClient: () => ({
    auth: { getUser: () => mockGetUser() },
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logError: (event: unknown, error: unknown, context?: unknown, meta?: unknown) =>
    mockLogError(event, error, context, meta),
}));

const ROW = {
  id: 'pdl-001',
  name: 'Acme Systems',
  website: 'acme.test',
  industry: 'information technology and services',
  size: '11-50',
  country: 'germany',
  locality: 'berlin',
  description: null,
};

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { authorization: 'Bearer test-token' },
  });
}

let searchGET: (req: NextRequest) => Promise<Response>;
let exportGET: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  ({ GET: searchGET } = await import('@/app/api/company-base/search/route'));
  ({ GET: exportGET } = await import('@/app/api/company-base/export/route'));
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.COMPANY_BASE_PDL_RETRY_DELAYS_MS = '0';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockRpc.mockResolvedValue({ data: [ROW], error: null });
});

afterAll(() => {
  delete process.env.COMPANY_BASE_PDL_RETRY_DELAYS_MS;
});

describe('GET /api/company-base/search', () => {
  it('uses the fast catalog RPC and returns a keyset cursor', async () => {
    const res = await searchGET(req(
      '/api/company-base/search?country=Germany&industry=information%20technology%20and%20services&size=11-50&limit=1',
    ));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toEqual([ROW]);
    expect(body.next_cursor).toBe('pdl-001');
    expect(mockRpc).toHaveBeenCalledWith('search_pdl_companies', {
      p_industries: ['information technology and services'],
      p_sizes: ['11-50'],
      p_countries: ['germany'],
      p_name: null,
      p_after_id: null,
      p_limit: 1,
    });
  });

  it('returns a friendly retryable error instead of raw maintenance HTML', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: '<!doctype html><html><title>Портал обновляется</title></html>' },
    });

    const res = await searchGET(req('/api/company-base/search?country=germany'));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toContain('временно не ответила');
    expect(JSON.stringify(body)).not.toContain('<html');
    expect(mockLogError).toHaveBeenCalled();
  });
});

describe('GET /api/company-base/export', () => {
  it('does not create a header-only ZIP when no companies match', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const res = await exportGET(req('/api/company-base/export?country=nowhere&all=1&format=zip'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(body.error).toContain('не найдены');
  });

  it('returns JSON error rather than an empty ZIP when the first page fails', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: '<!doctype html><html><title>Портал обновляется</title></html>' },
    });

    const res = await exportGET(req('/api/company-base/export?country=germany&all=1&format=zip'));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(body.error).toContain('временно не ответила');
    expect(JSON.stringify(body)).not.toContain('<html');
  });

  it('creates a ZIP whose CSV contains actual company rows', async () => {
    const res = await exportGET(req(
      '/api/company-base/export?country=germany&industry=information%20technology%20and%20services&size=11-50&all=1&format=zip',
    ));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const zip = await unzipper.Open.buffer(Buffer.from(await res.arrayBuffer())) as OpenedZip;
    const csvEntry = zip.files.find((file: ZipEntry) => file.path === 'eu_us_companies_part01.csv');
    expect(csvEntry).toBeDefined();
    const csv = (await csvEntry!.buffer()).toString('utf8');
    expect(csv).toContain('Company,Site,Industry,Size,Country,City,Description,Source');
    expect(csv).toContain('Acme Systems');
    expect(csv).toContain('acme.test');
    expect(csv).toContain('Company data: People Data Labs, CC BY 4.0');
    expect(mockRpc).toHaveBeenCalledWith(
      'search_pdl_companies',
      expect.objectContaining({ p_limit: 100_000 }),
    );
  });
});
