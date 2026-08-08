/** @jest-environment node */

import { NextRequest } from 'next/server';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

const requireClientAuthMock = jest.fn();
const createDownloadUrlMock = jest.fn();
let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/clientApiHelper', () => ({
  requireClientAuth: (...args: unknown[]) => requireClientAuthMock(...args),
  jsonError: (message: string, status: number) => Response.json({ error: message }, { status }),
}));
jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() { return mockDb; },
}));
jest.mock('@/lib/mainS3Server', () => ({
  createMainS3DownloadUrl: (...args: unknown[]) => createDownloadUrlMock(...args),
}));

import { POST } from '@/app/api/client/reports/exports/route';
import { GET } from '@/app/api/client/reports/exports/[id]/route';

const accessRows = [{ resource_type: 'campaign', resource_id: 'campaign-a' }];
const persistedFilters = {
  preset: 'last_30_days',
  from: '2026-07-08',
  to: '2026-08-06',
  fromUtc: '2026-07-07T21:00:00.000Z',
  toExclusiveUtc: '2026-08-06T21:00:00.000Z',
  score: 'all',
  campaignId: null,
  allowedCampaignIds: ['campaign-a'],
};

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/client/reports/exports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('client report export jobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requireClientAuthMock.mockResolvedValue({
      auth: { userId: 'client-1', accessRows, isDemo: false },
    });
    mockDb = createMockSupabase({ tables: { client_report_export_jobs: [] } });
    createDownloadUrlMock.mockResolvedValue('https://signed.example/report.csv.gz');
  });

  it('queues only one of the three supported export kinds', async () => {
    const bad = await POST(post({ kind: 'everything', filters: { preset: 'last_30_days' } }));
    expect(bad.status).toBe(400);

    const ok = await POST(post({ kind: 'working', filters: { preset: 'last_30_days', score: 'C' } }));
    expect(ok.status).toBe(202);
    expect(mockDb.getRows('client_report_export_jobs')[0]).toMatchObject({
      client_user_id: 'client-1',
      kind: 'working',
      status: 'pending',
    });
  });

  it('rejects a campaign outside the client access scope', async () => {
    const response = await POST(post({
      kind: 'submitted',
      filters: { preset: 'last_30_days', campaign: 'campaign-foreign' },
    }));
    expect(response.status).toBe(403);
    expect(mockDb.getRows('client_report_export_jobs')).toHaveLength(0);
  });

  it('does not enqueue durable exports for the read-only demo account', async () => {
    requireClientAuthMock.mockResolvedValue({
      auth: { userId: 'demo', accessRows: [], isDemo: true },
    });

    const response = await POST(post({ kind: 'working', filters: { preset: 'last_30_days' } }));
    expect(response.status).toBe(403);
    expect(mockDb.getRows('client_report_export_jobs')).toHaveLength(0);
  });

  it('returns a clear conflict when the same export kind is already active', async () => {
    mockDb = createMockSupabase({
      tables: { client_report_export_jobs: [] },
      errorInserts: {
        client_report_export_jobs: {
          code: '23505',
          message: 'duplicate key value violates unique constraint',
        },
      },
    });

    const response = await POST(post({
      kind: 'working',
      filters: { preset: 'last_30_days' },
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Выгрузка этого типа уже формируется. Дождитесь её завершения.',
    });
  });

  it('only exposes a completed export owned by the authenticated client', async () => {
    mockDb = createMockSupabase({ tables: { client_report_export_jobs: [{
      id: 'job-1', client_user_id: 'client-1', kind: 'working', status: 'completed',
      filters: persistedFilters,
      storage_key: 'client-reports/client-1/job-1.csv.gz', row_count: 12,
      checksum_sha256: 'abc', created_at: '2026-08-06T10:00:00Z',
      finished_at: '2026-08-06T10:01:00Z', expires_at: '2099-08-07T10:01:00Z',
    }] } });

    const response = await GET(requestForJob('job-1'), { params: Promise.resolve({ id: 'job-1' }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job.downloadUrl).toBe('https://signed.example/report.csv.gz');
    expect(body.job.completedAt).toBe('2026-08-06T10:01:00Z');
    expect(createDownloadUrlMock).toHaveBeenCalledWith(expect.objectContaining({
      key: 'client-reports/client-1/job-1.csv.gz',
    }));
  });

  it('denies polling and download after any persisted campaign access is revoked', async () => {
    requireClientAuthMock.mockResolvedValue({
      auth: {
        userId: 'client-1',
        accessRows: [{ resource_type: 'campaign', resource_id: 'campaign-b' }],
        isDemo: false,
      },
    });
    mockDb = createMockSupabase({ tables: { client_report_export_jobs: [{
      id: 'job-revoked', client_user_id: 'client-1', kind: 'submitted', status: 'completed',
      filters: persistedFilters,
      storage_key: 'client-reports/client-1/job-revoked.csv.gz', row_count: 12,
      created_at: '2026-08-06T10:00:00Z', finished_at: '2026-08-06T10:01:00Z',
      expires_at: '2099-08-07T10:01:00Z',
    }] } });

    const response = await GET(requestForJob('job-revoked'), {
      params: Promise.resolve({ id: 'job-revoked' }),
    });

    expect(response.status).toBe(403);
    expect(createDownloadUrlMock).not.toHaveBeenCalled();
  });

  it('does not sign a completed export after its stored expiry', async () => {
    mockDb = createMockSupabase({ tables: { client_report_export_jobs: [{
      id: 'job-expired', client_user_id: 'client-1', kind: 'submitted', status: 'completed',
      filters: persistedFilters,
      storage_key: 'client-reports/client-1/job-expired.csv.gz', row_count: 1,
      created_at: '2026-08-01T10:00:00Z', finished_at: '2026-08-01T10:01:00Z',
      expires_at: '2026-08-02T10:01:00Z',
    }] } });

    const response = await GET(requestForJob('job-expired'), { params: Promise.resolve({ id: 'job-expired' }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job.downloadUrl).toBeUndefined();
    expect(createDownloadUrlMock).not.toHaveBeenCalled();
  });

  it('returns cancelled as terminal without signing a stored object', async () => {
    mockDb = createMockSupabase({ tables: { client_report_export_jobs: [{
      id: 'job-cancelled', client_user_id: 'client-1', kind: 'working', status: 'cancelled',
      filters: persistedFilters,
      storage_key: 'client-reports/client-1/job-cancelled.csv.gz', row_count: 12,
      checksum_sha256: 'abc', error_message: 'expired',
      created_at: '2026-08-06T10:00:00Z', finished_at: '2026-08-06T10:01:00Z',
      expires_at: '2099-08-07T10:01:00Z',
    }] } });

    const response = await GET(requestForJob('job-cancelled'), {
      params: Promise.resolve({ id: 'job-cancelled' }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job).toMatchObject({ status: 'cancelled', error: 'expired' });
    expect(body.job.downloadUrl).toBeUndefined();
    expect(createDownloadUrlMock).not.toHaveBeenCalled();
  });
});

function requestForJob(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/client/reports/exports/${id}`);
}
