/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const AUTH_USER_ID = 'client-user-1';

let mockInstantlyDb: MockSupabaseClient = createMockSupabase();

const mockCreateCampaign = jest.fn();
const mockUpdateCampaign = jest.fn();
const mockCreateLeads = jest.fn();
const mockActivateCampaign = jest.fn();
const mockUpsertInstantlyCatalogFromCampaign = jest.fn();
const mockGetClientTariffRow = jest.fn();
const mockGetClientStatus = jest.fn();
const mockResolveEffectiveLimits = jest.fn();
const mockGetBillingPeriodStart = jest.fn();
const mockCountClientContacts = jest.fn();
const mockGetClientTariffUsage = jest.fn();

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

// Main DB — only the base_constructor_jobs lookup goes through it here.
let mockMainDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => ({
      auth: {
        userId: AUTH_USER_ID,
        accessRows: [],
        isDemo: false,
      },
    })),
  };
});

jest.mock('@/lib/instantly/client', () => ({
  createCampaign: (...args: unknown[]) => mockCreateCampaign(...args),
  updateCampaign: (...args: unknown[]) => mockUpdateCampaign(...args),
  createLeads: (...args: unknown[]) => mockCreateLeads(...args),
  activateCampaign: (...args: unknown[]) => mockActivateCampaign(...args),
}));

jest.mock('@/lib/tools/instantlyCampaignCatalog', () => ({
  upsertInstantlyCatalogFromCampaign: (...args: unknown[]) =>
    mockUpsertInstantlyCatalogFromCampaign(...args),
}));

jest.mock('@/lib/tariffs', () => ({
  getClientTariffRow: (...args: unknown[]) => mockGetClientTariffRow(...args),
  getClientStatus: (...args: unknown[]) => mockGetClientStatus(...args),
  resolveEffectiveLimits: (...args: unknown[]) => mockResolveEffectiveLimits(...args),
  getBillingPeriodStart: (...args: unknown[]) => mockGetBillingPeriodStart(...args),
  countClientContacts: (...args: unknown[]) => mockCountClientContacts(...args),
  getClientTariffUsage: (...args: unknown[]) => mockGetClientTariffUsage(...args),
  // Гейт «оформил, но не оплатил»: в этих тестах клиент оплачен → false.
  isAwaitingFirstPayment: () => false,
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

function seedDb(accountId: string | null = 'client-b') {
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_campaign_presets: [
        {
          id: 'preset-1',
          client_user_id: AUTH_USER_ID,
          instantly_account_id: accountId,
          email_account_ids: ['sender@client-b.test'],
          daily_limit: 100,
          daily_max_leads: 50,
          email_gap_minutes: 15,
          open_tracking: true,
          link_tracking: true,
          stop_on_reply: true,
          text_only: false,
          schedule_from: '09:00',
          schedule_to: '18:00',
          schedule_days: [1, 2, 3, 4, 5],
          schedule_timezone: 'Europe/Moscow',
          created_by: 'admin-1',
          created_at: '2026-05-01T00:00:00.000Z',
          updated_at: '2026-05-01T00:00:00.000Z',
        },
      ],
      client_campaign_launches: [],
      client_instantly_access: [],
    },
  });
}

function makeLaunchReq(): NextRequest {
  return new Request('http://x/api/client/launches', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      campaign_name: 'Client B Launch',
      sequence_steps: [{ subject: 'Hello', body: 'Body text', wait_days: 0 }],
      headers: ['Email', 'First Name'],
      rows: [['lead@example.com', 'Ada']],
      mapping: { email: 'Email', first_name: 'First Name' },
    }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  jest.resetModules();
  seedDb();
  mockCreateCampaign.mockReset().mockResolvedValue({ id: 'cmp-new', name: 'Client B Launch', status: 0 });
  mockUpdateCampaign.mockReset().mockResolvedValue({ id: 'cmp-new', name: 'Client B Launch', status: 0 });
  mockCreateLeads.mockReset().mockResolvedValue({ uploaded: 1 });
  mockActivateCampaign.mockReset().mockResolvedValue({ id: 'cmp-new', name: 'Client B Launch', status: 1 });
  mockUpsertInstantlyCatalogFromCampaign.mockReset().mockResolvedValue(undefined);
  mockGetClientTariffRow.mockReset().mockResolvedValue({ id: 'tariff-1' });
  mockGetClientStatus.mockReset().mockReturnValue('active');
  mockResolveEffectiveLimits.mockReset().mockReturnValue({ max_contacts: 1000, max_emails: 10 });
  mockGetBillingPeriodStart.mockReset().mockReturnValue('2026-05-01T00:00:00.000Z');
  mockCountClientContacts.mockReset().mockResolvedValue(0);
  mockGetClientTariffUsage.mockReset().mockResolvedValue({ contacts_used: 1 });
});

describe('POST /api/client/launches — Instantly account selection', () => {
  it('uses the Instantly account selected in the client preset for campaign creation, lead upload, and activation', async () => {
    const { POST } = await import('@/app/api/client/launches/route');

    const res = await POST(makeLaunchReq());
    expect(res.status).toBe(200);

    expect(mockCreateCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Client B Launch',
        email_list: ['sender@client-b.test'],
      }),
      { accountId: 'client-b' },
    );
    expect(mockCreateLeads).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ email: 'lead@example.com' })]),
      expect.objectContaining({ campaign_id: 'cmp-new', skip_if_in_campaign: true }),
      { accountId: 'client-b' },
    );
    expect(mockActivateCampaign).toHaveBeenCalledWith('cmp-new', { accountId: 'client-b' });

    expect(mockInstantlyDb.upserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'client_instantly_access',
          rows: [
            expect.objectContaining({
              client_user_id: AUTH_USER_ID,
              resource_type: 'campaign',
              resource_id: 'cmp-new',
              instantly_account_id: 'client-b',
            }),
          ],
        }),
      ]),
    );
  });

  it('repairs campaign sequences before activation when Instantly create response omits them', async () => {
    mockCreateCampaign.mockResolvedValueOnce({
      id: 'cmp-new',
      name: 'Client B Launch',
      status: 0,
      sequences: [],
    });
    const { POST } = await import('@/app/api/client/launches/route');

    const res = await POST(makeLaunchReq());
    expect(res.status).toBe(200);

    const createPayload = mockCreateCampaign.mock.calls[0][0] as { sequences?: unknown };
    expect(createPayload.sequences).toEqual([
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            variants: [expect.objectContaining({ subject: 'Hello', body: '<div>Body text</div>' })],
          }),
        ],
      }),
    ]);
    expect(mockUpdateCampaign).toHaveBeenCalledWith(
      'cmp-new',
      { sequences: createPayload.sequences },
      { accountId: 'client-b' },
    );
    expect(mockUpdateCampaign.mock.invocationCallOrder[0]).toBeLessThan(
      mockActivateCampaign.mock.invocationCallOrder[0],
    );
  });
});

describe('POST /api/client/launches — источник = база из Конструктора', () => {
  function seedBaseJob(overrides: Record<string, unknown> = {}) {
    mockMainDb = createMockSupabase({
      tables: {
        base_constructor_jobs: [
          {
            id: 'job-1',
            user_id: AUTH_USER_ID,
            status: 'completed',
            file_name: 'clean-base.csv',
            data: [
              ['Email', 'First Name'],
              ['ada@example.com', 'Ada'],
              ['', 'NoEmail'],
              ['bob@example.com', 'Bob'],
            ],
            ...overrides,
          },
        ],
      },
    });
  }

  function makeBaseLaunchReq(jobId = 'job-1'): NextRequest {
    return new Request('http://x/api/client/launches', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        campaign_name: 'From Constructor',
        sequence_steps: [{ subject: 'Hello', body: 'Body text', wait_days: 0 }],
        base_constructor_job_id: jobId,
        mapping: { email: 'Email', first_name: 'First Name' },
      }),
    }) as unknown as NextRequest;
  }

  it('берёт headers/rows из job.data на сервере (в body нет rows) и грузит только валидные email', async () => {
    seedBaseJob();
    const { POST } = await import('@/app/api/client/launches/route');

    const res = await POST(makeBaseLaunchReq());
    expect(res.status).toBe(200);

    const uploaded = mockCreateLeads.mock.calls[0][0] as Array<{ email: string }>;
    expect(uploaded.map((l) => l.email)).toEqual(['ada@example.com', 'bob@example.com']);
    // uploaded_rows = все строки данных (3), не только валидные.
    expect(mockInstantlyDb.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'client_campaign_launches',
          rows: [expect.objectContaining({ uploaded_rows: 3 })],
        }),
      ]),
    );

    // Пин двухшаговой загрузки: первый select — ownership/status БЕЗ блоба
    // (data до 46МБ не должен де-TOAST'иться до authz), второй — только data.
    const jobSelects = mockMainDb.selects.filter((s) => s.table === 'base_constructor_jobs');
    expect(jobSelects).toHaveLength(2);
    expect(jobSelects[0].columns).not.toContain('data');
    expect(jobSelects[1].columns).toBe('data');
  });

  it('чужая база → 404 (неотличимо от несуществующей), ownership проверяется РАНЬШЕ статуса и без загрузки блоба', async () => {
    // status='processing' у чужого джоба: если бы статус проверялся раньше
    // ownership, ответ был бы 400 и палил существование чужой базы.
    seedBaseJob({ user_id: 'someone-else', status: 'processing' });
    const { POST } = await import('@/app/api/client/launches/route');

    const res = await POST(makeBaseLaunchReq());
    expect(res.status).toBe(404);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
    // Для чужого джоба блоб data не запрашивается вовсе.
    const jobSelects = mockMainDb.selects.filter((s) => s.table === 'base_constructor_jobs');
    expect(jobSelects).toHaveLength(1);
    expect(jobSelects[0].columns).not.toContain('data');
  });

  it('несуществующий job id → 404', async () => {
    seedBaseJob();
    const { POST } = await import('@/app/api/client/launches/route');

    const res = await POST(makeBaseLaunchReq('job-missing'));
    expect(res.status).toBe(404);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('незавершённая база → 400 и кампания не создаётся', async () => {
    seedBaseJob({ status: 'processing' });
    const { POST } = await import('@/app/api/client/launches/route');

    const res = await POST(makeBaseLaunchReq());
    expect(res.status).toBe(400);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('пустая база (только заголовок) → 400', async () => {
    seedBaseJob({ data: [['Email', 'First Name']] });
    const { POST } = await import('@/app/api/client/launches/route');

    const res = await POST(makeBaseLaunchReq());
    expect(res.status).toBe(400);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('data = null → 400, кампания не создаётся', async () => {
    seedBaseJob({ data: null });
    const { POST } = await import('@/app/api/client/launches/route');

    const res = await POST(makeBaseLaunchReq());
    expect(res.status).toBe(400);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('body.headers/rows ИГНОРИРУЮТСЯ при base_constructor_job_id (server-authoritative)', async () => {
    seedBaseJob();
    const { POST } = await import('@/app/api/client/launches/route');

    const req = new Request('http://x/api/client/launches', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        campaign_name: 'From Constructor',
        sequence_steps: [{ subject: 'Hello', body: 'Body text', wait_days: 0 }],
        base_constructor_job_id: 'job-1',
        // Подставные данные в body — сервер обязан их проигнорировать.
        headers: ['Email'],
        rows: [['decoy@example.com']],
        mapping: { email: 'Email', first_name: 'First Name' },
      }),
    }) as unknown as NextRequest;

    const res = await POST(req);
    expect(res.status).toBe(200);

    const uploaded = mockCreateLeads.mock.calls[0][0] as Array<{ email: string }>;
    expect(uploaded.map((l) => l.email)).toEqual(['ada@example.com', 'bob@example.com']);
    expect(uploaded.map((l) => l.email)).not.toContain('decoy@example.com');
  });

  it('база больше лимита строк → 400 ДО маппинга, кампания не создаётся', async () => {
    const bigData: unknown[][] = [['Email', 'First Name']];
    // limit+1 строк, из них валидных email мало — кап должен сработать по
    // СЫРЫМ строкам, а не по числу валидных лидов.
    for (let i = 0; i <= 10_000; i++) bigData.push([i % 100 === 0 ? `u${i}@ex.com` : '', 'X']);
    seedBaseJob({ data: bigData });
    const { POST } = await import('@/app/api/client/launches/route');

    const res = await POST(makeBaseLaunchReq());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Лимит');
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('mapping.email указывает на отсутствующую в базе колонку → 400 с базо-специфичным текстом', async () => {
    seedBaseJob();
    const { POST } = await import('@/app/api/client/launches/route');

    const req = new Request('http://x/api/client/launches', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        campaign_name: 'From Constructor',
        sequence_steps: [{ subject: 'Hello', body: 'Body text', wait_days: 0 }],
        base_constructor_job_id: 'job-1',
        mapping: { email: 'Nonexistent Column' },
      }),
    }) as unknown as NextRequest;

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('В выбранной базе нет валидных email-адресов');
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });
});
