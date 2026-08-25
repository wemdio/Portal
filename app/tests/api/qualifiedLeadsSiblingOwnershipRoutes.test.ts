/** @jest-environment node */

import type { NextRequest, NextResponse } from 'next/server';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockMainDb: MockSupabaseClient | null = null;
let mockInstantlyDb: MockSupabaseClient | null = null;
let mockUserId = 'specialist-a';

const mockGetEmail = jest.fn(async (_id?: string, _options?: unknown) => ({
  id: 'instantly-email-1',
  eaccount: 'sender@example.com',
  thread_id: 'thread-1',
}));
const mockGetLeadsByEmail = jest.fn(async (_params?: unknown) => []);
const mockListEmails = jest.fn(async (_params?: unknown, _options?: unknown) => ({
  items: [
    {
      id: 'outbound-1',
      campaign_id: 'campaign-shared',
      thread_id: 'thread-1',
      from_address_email: 'sender@example.com',
      to_address_email_list: 'lead@example.com',
      ue_type: 1,
      timestamp_email: '2026-08-24T07:00:00Z',
      body: { text: 'Our offer' },
    },
  ],
}));
const mockReplyToEmail = jest.fn(async (_payload?: unknown, _options?: unknown) => ({ id: 'reply-1' }));
const mockSendLeadNotification = jest.fn(async (_chatId?: number, _data?: unknown) => ({ messageId: 123 }));

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/instantly/client', () => ({
  getEmail: (id: string, options?: unknown) => mockGetEmail(id, options),
  getLeadsByEmail: (params: unknown) => mockGetLeadsByEmail(params),
  listEmails: (params: unknown, options?: unknown) => mockListEmails(params, options),
  replyToEmail: (payload: unknown, options?: unknown) => mockReplyToEmail(payload, options),
}));

jest.mock('@/lib/instantly/leadNotifier', () => ({
  sendLeadNotification: (chatId: number, data: unknown) =>
    mockSendLeadNotification(chatId, data),
}));

jest.mock('@/lib/instantly/apiRouteHelper', () => {
  const { NextResponse: Response } = jest.requireActual('next/server') as typeof import('next/server');
  type Handler = (
    req: NextRequest,
    user: { id: string; email?: string },
    params?: Record<string, string>,
  ) => Promise<NextResponse>;

  return {
    jsonError: (message: string, status: number) => Response.json({ error: message }, { status }),
    withAuth: (handler: Handler) => async (
      req: NextRequest,
      context?: { params: Promise<Record<string, string>> },
    ) => {
      try {
        return await handler(
          req,
          { id: mockUserId },
          context?.params ? await context.params : undefined,
        );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Unexpected error' },
          { status: 500 },
        );
      }
    },
  };
});

const QUALIFICATION = {
  id: 'qualification-1',
  campaign_id: 'campaign-shared',
  campaign_name: 'Campaign shared',
  status: 'lead',
  lead_name: 'Lead Name',
  lead_email: 'lead@example.com',
  company_name: 'Lead Company',
  reply_subject: 'Re: Offer',
  reply_body: 'Interested',
  reply_preview: 'Interested',
  last_outbound_preview: 'Our offer',
  reply_timestamp: '2026-08-24T08:00:00Z',
  ai_reason: 'Direct interest',
  instantly_email_id: 'instantly-email-1',
  thread_id: 'thread-1',
  qualified_project_id: null,
  qualified_project_owner_proven: false,
};

type OwnershipTable =
  | 'project_instantly_campaigns'
  | 'project_period_instantly_campaigns';

function makeMainDb(
  role = 'technician',
  errorTable?: 'profiles' | 'projects',
  campaignLeads: Array<Record<string, unknown>> = [],
) {
  return createMockSupabase({
    ...(errorTable ? { errorTables: { [errorTable]: `${errorTable} unavailable` } } : {}),
    tables: {
      profiles: [
        { id: mockUserId, role },
      ],
      projects: [
        { id: 'project-a', specialist_user_id: 'specialist-a' },
        { id: 'project-b', specialist_user_id: 'specialist-b' },
      ],
      client_campaign_leads: campaignLeads,
    },
  });
}

function makeInstantlyDb(options: {
  legacy?: Array<Record<string, unknown>>;
  periods?: Array<Record<string, unknown>>;
  errorTable?: OwnershipTable;
  qualification?: Record<string, unknown>;
  snapshotColumnMissing?: boolean;
  snapshotSchemaCacheStale?: boolean;
  beforeQualificationUpdate?: (rows: Array<Record<string, unknown>>) =>
    Array<Record<string, unknown>>;
} = {}) {
  const errorSelects: Record<string, { columnsInclude: string; message: string }> = {};
  if (options.errorTable) {
    errorSelects[options.errorTable] = {
      columnsInclude: 'project_id',
      message: `${options.errorTable} unavailable`,
    };
  }
  if (options.snapshotColumnMissing) {
    errorSelects.instantly_lead_qualifications = {
      columnsInclude: 'qualified_project_id',
      message: 'qualified_project_id does not exist',
    };
  }
  if (options.snapshotSchemaCacheStale) {
    errorSelects.instantly_lead_qualifications = {
      columnsInclude: 'qualified_project_id',
      message:
        "Could not find the 'qualified_project_id' column of " +
        "'instantly_lead_qualifications' in the schema cache",
    };
  }
  return createMockSupabase({
    ...(Object.keys(errorSelects).length > 0 ? { errorSelects } : {}),
    ...(options.beforeQualificationUpdate
      ? {
          beforeFirstUpdates: {
            instantly_lead_qualifications: options.beforeQualificationUpdate,
          },
        }
      : {}),
    tables: {
      instantly_lead_qualifications: [{ ...QUALIFICATION, ...(options.qualification ?? {}) }],
      project_instantly_campaigns: options.legacy ?? [],
      project_period_instantly_campaigns: options.periods ?? [],
      client_forwarded_leads: [
        {
          id: 'forwarded-1',
          qualification_id: QUALIFICATION.id,
          client_user_id: 'client-private',
        },
      ],
      client_lead_comments: [
        {
          id: 'comment-1',
          forwarded_lead_id: 'forwarded-1',
          comment: 'Private client comment',
          created_at: '2026-08-24T09:00:00Z',
        },
      ],
    },
  });
}

function jsonReq(path: string, body: Record<string, unknown>): NextRequest {
  return new Request(`http://x${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function mainGetReq(query = ''): NextRequest {
  return new Request(`http://x/api/instantly/qualified-leads${query}`, {
    headers: { authorization: 'Bearer test' },
  }) as unknown as NextRequest;
}

function mainPatchReq(): NextRequest {
  return new Request('http://x/api/instantly/qualified-leads', {
    method: 'PATCH',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [QUALIFICATION.id] }),
  }) as unknown as NextRequest;
}

function threadOutboundReq(overrides: {
  qualificationId?: string | null;
  campaignId?: string;
  leadEmail?: string;
} = {}): NextRequest {
  const params = new URLSearchParams({
    campaign_id: overrides.campaignId ?? QUALIFICATION.campaign_id,
    lead_email: overrides.leadEmail ?? QUALIFICATION.lead_email,
  });
  const qualificationId = overrides.qualificationId === undefined
    ? QUALIFICATION.id
    : overrides.qualificationId;
  if (qualificationId) params.set('qualification_id', qualificationId);
  return new Request(
    `http://x/api/instantly/qualified-leads/thread-outbound?${params.toString()}`,
    { headers: { authorization: 'Bearer test' } },
  ) as unknown as NextRequest;
}

type SiblingRoute = 'forward' | 'forward-email' | 'thread-outbound' | 'comments';

async function invokeRoute(route: SiblingRoute): Promise<Response> {
  if (route === 'forward') {
    const { POST } = await import('@/app/api/instantly/qualified-leads/forward/route');
    return POST(jsonReq('/api/instantly/qualified-leads/forward', {
      qualification_id: QUALIFICATION.id,
      telegram_chat_id: 777,
    }));
  }
  if (route === 'forward-email') {
    const { POST } = await import('@/app/api/instantly/qualified-leads/forward-email/route');
    return POST(jsonReq('/api/instantly/qualified-leads/forward-email', {
      qualification_id: QUALIFICATION.id,
      reply_text: 'Thanks, let us continue.',
    }));
  }
  if (route === 'thread-outbound') {
    const { GET } = await import('@/app/api/instantly/qualified-leads/thread-outbound/route');
    return GET(threadOutboundReq());
  }

  const { GET } = await import('@/app/api/instantly/qualified-leads/[id]/comments/route');
  const req = new Request(
    `http://x/api/instantly/qualified-leads/${QUALIFICATION.id}/comments`,
    { headers: { authorization: 'Bearer test' } },
  ) as unknown as NextRequest;
  return GET(req, { params: Promise.resolve({ id: QUALIFICATION.id }) });
}

function expectNoProtectedSideEffects(): void {
  expect(mockGetEmail).not.toHaveBeenCalled();
  expect(mockGetLeadsByEmail).not.toHaveBeenCalled();
  expect(mockListEmails).not.toHaveBeenCalled();
  expect(mockReplyToEmail).not.toHaveBeenCalled();
  expect(mockSendLeadNotification).not.toHaveBeenCalled();
  expect(mockInstantlyDb?.inserts).toHaveLength(0);
  expect(mockInstantlyDb?.selects.some(({ table }) => table === 'client_forwarded_leads')).toBe(false);
  expect(mockInstantlyDb?.selects.some(({ table }) => table === 'client_lead_comments')).toBe(false);
}

describe.each([
  'forward',
  'forward-email',
  'thread-outbound',
  'comments',
] as const)('%s qualified-lead ownership authorization', (route) => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
  });

  it('rejects a foreign project before reading or sending protected data', async () => {
    mockInstantlyDb = makeInstantlyDb({
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });

    const response = await invokeRoute(route);

    expect(response.status).toBe(403);
    expectNoProtectedSideEffects();
  });

  it('fails closed for an ambiguously owned campaign', async () => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });

    const response = await invokeRoute(route);

    expect(response.status).toBe(409);
    expectNoProtectedSideEffects();
  });

  it('fails closed when the campaign has no managed project owner', async () => {
    mockInstantlyDb = makeInstantlyDb();

    const response = await invokeRoute(route);

    expect(response.status).toBe(403);
    expectNoProtectedSideEffects();
  });

  it.each([
    'project_instantly_campaigns',
    'project_period_instantly_campaigns',
  ] as const)('fails closed when %s cannot be read', async (errorTable) => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
      errorTable,
    });

    const response = await invokeRoute(route);

    expect(response.status).toBe(500);
    expectNoProtectedSideEffects();
  });

  it.each(['profiles', 'projects'] as const)(
    'fails closed when Portal %s access cannot be resolved',
    async (errorTable) => {
      mockMainDb = makeMainDb('technician', errorTable);
      mockInstantlyDb = makeInstantlyDb({
        periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
      });

      const response = await invokeRoute(route);

      expect(response.status).toBe(500);
      expectNoProtectedSideEffects();
    },
  );

  it('fails closed while the qualification snapshot schema cache is stale', async () => {
    mockInstantlyDb = makeInstantlyDb({
      snapshotSchemaCacheStale: true,
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
    });

    const response = await invokeRoute(route);

    expect(response.status).toBe(500);
    expectNoProtectedSideEffects();
  });

  it('allows the responsible specialist', async () => {
    mockInstantlyDb = makeInstantlyDb({
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
    });

    const response = await invokeRoute(route);

    expect(response.status).toBe(200);
  });

  it('preserves supervisor access to an unambiguously owned foreign project', async () => {
    mockUserId = 'supervisor';
    mockMainDb = makeMainDb('manager');
    mockInstantlyDb = makeInstantlyDb({
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });

    const response = await invokeRoute(route);

    expect(response.status).toBe(200);
  });
});

describe('main qualified-leads immutable owner snapshot', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it.each([
    '?limit=0',
    '?limit=-1',
    '?limit=abc',
    '?limit=1.5',
    '?offset=-1',
    '?offset=abc',
    '?offset=1.5',
    '?offset=10001',
  ])('rejects invalid pagination before querying lead rows: %s', async (query) => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(mainGetReq(query));

    expect(response.status).toBe(400);
  });

  it('keeps a historical snapshot visible to the former project specialist after reassignment', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(mainGetReq());
    const body = await response.json() as { items: Array<{ id: string }>; total: number };

    expect(response.status).toBe(200);
    expect(body.items).toEqual([expect.objectContaining({ id: QUALIFICATION.id })]);
    expect(body.total).toBe(1);
  });

  it('allows the former project specialist to filter by the reassigned campaign', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(mainGetReq(`?campaign_id=${QUALIFICATION.campaign_id}`));
    const body = await response.json() as { items: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.items).toEqual([expect.objectContaining({ id: QUALIFICATION.id })]);
  });

  it('does not expose a historical snapshot to the campaign new project specialist', async () => {
    mockUserId = 'specialist-b';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(mainGetReq());
    const body = await response.json() as { items: unknown[]; total: number };

    expect(response.status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('lets the former project specialist mark its snapshotted qualification read', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
        read_at: null,
      },
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await PATCH(mainPatchReq());

    expect(response.status).toBe(200);
    expect(mockInstantlyDb.getRows('instantly_lead_qualifications')[0]).toEqual(
      expect.objectContaining({ read_by: 'specialist-a', read_at: expect.any(String) }),
    );
  });

  it('does not let the campaign new project specialist mark the historical snapshot read', async () => {
    mockUserId = 'specialist-b';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
        read_at: null,
      },
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await PATCH(mainPatchReq());

    expect(response.status).toBe(403);
    expect(mockInstantlyDb.updates).toHaveLength(0);
    expect(mockInstantlyDb.getRows('instantly_lead_qualifications')[0].read_at).toBeNull();
  });

  it('does not mark a row read when ownership is proven to another project after authorization', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: null,
        qualified_project_owner_proven: false,
        read_at: null,
      },
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
      beforeQualificationUpdate: (rows) => rows.map((row) => ({
        ...row,
        qualified_project_id: 'project-b',
        qualified_project_owner_proven: true,
      })),
    });
    const { PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await PATCH(mainPatchReq());

    expect(response.status).toBe(409);
    expect(mockInstantlyDb.getRows('instantly_lead_qualifications')[0]).toEqual(
      expect.objectContaining({
        qualified_project_id: 'project-b',
        qualified_project_owner_proven: true,
        read_at: null,
      }),
    );
  });

  it('treats an initially already-read authorized row as an idempotent no-op', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
        read_at: '2026-08-24T09:00:00Z',
        read_by: 'specialist-a',
      },
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await PATCH(mainPatchReq());

    expect(response.status).toBe(200);
    expect(mockInstantlyDb.updates).toHaveLength(0);
    expect(mockInstantlyDb.getRows('instantly_lead_qualifications')[0]).toEqual(
      expect.objectContaining({
        read_at: '2026-08-24T09:00:00Z',
        read_by: 'specialist-a',
      }),
    );
  });

  it('keeps a null legacy snapshot on the live campaign owner', async () => {
    mockUserId = 'specialist-b';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: null,
        qualified_project_owner_proven: null,
      },
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(mainGetReq());
    const body = await response.json() as { items: Array<{ id: string }>; total: number };

    expect(response.status).toBe(200);
    expect(body.items).toEqual([expect.objectContaining({ id: QUALIFICATION.id })]);
    expect(body.total).toBe(1);
  });

  it('does not reinterpret a proven self-serve qualification as a later managed campaign', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: null,
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { GET, PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const getResponse = await GET(mainGetReq());
    const getBody = await getResponse.json() as { items: unknown[]; total: number };
    const patchResponse = await PATCH(mainPatchReq());

    expect(getResponse.status).toBe(200);
    expect(getBody.items).toEqual([]);
    expect(getBody.total).toBe(0);
    expect(patchResponse.status).toBe(403);
    expect(mockInstantlyDb.updates).toHaveLength(0);
  });

  it('uses the live-owner compatibility path while the snapshot column is unavailable', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      snapshotColumnMissing: true,
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(mainGetReq());
    const body = await response.json() as { items: Array<{ id: string }>; total: number };

    expect(response.status).toBe(200);
    expect(body.items).toEqual([expect.objectContaining({ id: QUALIFICATION.id })]);
    expect(body.total).toBe(1);
  });

  it('fails closed instead of live-owner fallback while the snapshot schema cache is stale', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      snapshotSchemaCacheStale: true,
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
    });
    const { GET, PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const getResponse = await GET(mainGetReq());
    const patchResponse = await PATCH(mainPatchReq());

    expect(getResponse.status).toBe(500);
    expect(patchResponse.status).toBe(500);
    expect(mockInstantlyDb.updates).toHaveLength(0);
  });

  it('merges snapshot and legacy rows before applying global offset and limit', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    const rows = [
      {
        ...QUALIFICATION,
        id: 'snapshot-newest',
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
        created_at: '2026-08-24T10:00:00Z',
      },
      {
        ...QUALIFICATION,
        id: 'legacy-second',
        created_at: '2026-08-24T09:00:00Z',
      },
      {
        ...QUALIFICATION,
        id: 'legacy-third',
        qualified_project_owner_proven: null,
        created_at: '2026-08-24T08:00:00Z',
      },
      {
        ...QUALIFICATION,
        id: 'snapshot-oldest',
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
        created_at: '2026-08-24T07:00:00Z',
      },
    ];
    mockInstantlyDb = createMockSupabase({
      enforceQueryWindows: true,
      tables: {
        instantly_lead_qualifications: rows,
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [
          { project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id },
        ],
      },
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(mainGetReq('?limit=2&offset=1'));
    const body = await response.json() as {
      items: Array<{ id: string }>;
      total: number;
      counts: Record<string, number>;
    };

    expect(response.status).toBe(200);
    expect(body.items.map(({ id }) => id)).toEqual(['legacy-second', 'legacy-third']);
    expect(body.total).toBe(4);
    expect(body.counts.lead).toBe(4);
  });

  it('uses the same id tie-break in each source before globally paginating equal timestamps', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    const sameCreatedAt = '2026-08-24T10:00:00Z';
    const rows = [
      {
        ...QUALIFICATION,
        id: 'z-snapshot',
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
        created_at: sameCreatedAt,
      },
      {
        ...QUALIFICATION,
        id: 'a-snapshot',
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
        created_at: sameCreatedAt,
      },
      { ...QUALIFICATION, id: 'y-legacy', created_at: sameCreatedAt },
      { ...QUALIFICATION, id: 'b-legacy', created_at: sameCreatedAt },
    ];
    mockInstantlyDb = createMockSupabase({
      enforceQueryWindows: true,
      tables: {
        instantly_lead_qualifications: rows,
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [
          { project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id },
        ],
      },
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(mainGetReq('?limit=1&offset=0'));
    const body = await response.json() as { items: Array<{ id: string }>; total: number };

    expect(response.status).toBe(200);
    expect(body.items.map(({ id }) => id)).toEqual(['a-snapshot']);
    expect(body.total).toBe(4);
  });

  it('pages each source in bounded chunks beyond the PostgREST row cap', async () => {
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    const rows = Array.from({ length: 1002 }, (_, index) => ({
      ...QUALIFICATION,
      id: `snapshot-${String(index).padStart(4, '0')}`,
      qualified_project_id: 'project-a',
      qualified_project_owner_proven: true,
      created_at: '2026-08-24T10:00:00Z',
    }));
    mockInstantlyDb = createMockSupabase({
      enforceQueryWindows: true,
      maxRowsPerQuery: 1000,
      tables: {
        instantly_lead_qualifications: rows,
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [
          { project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id },
        ],
      },
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(mainGetReq('?limit=1&offset=1000'));
    const body = await response.json() as { items: Array<{ id: string }>; total: number };

    expect(response.status).toBe(200);
    expect(body.items.map(({ id }) => id)).toEqual(['snapshot-1000']);
    expect(body.total).toBe(1002);
  });
});

describe.each([
  'forward',
  'forward-email',
  'thread-outbound',
  'comments',
] as const)('%s immutable qualification owner snapshot', (route) => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
  });

  it('authorizes the snapshotted project without following a later campaign reassignment', async () => {
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });

    const response = await invokeRoute(route);

    expect(response.status).toBe(200);
    expect(mockInstantlyDb.selects.filter(
      ({ table }) =>
        table === 'project_instantly_campaigns' ||
        table === 'project_period_instantly_campaigns',
    )).toHaveLength(0);
  });

  it('does not grant the new campaign owner access to a qualification snapshotted to another project', async () => {
    mockUserId = 'specialist-b';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-b', campaign_id: QUALIFICATION.campaign_id }],
    });

    const response = await invokeRoute(route);

    expect(response.status).toBe(403);
    expectNoProtectedSideEffects();
    expect(mockInstantlyDb.selects.filter(
      ({ table }) =>
        table === 'project_instantly_campaigns' ||
        table === 'project_period_instantly_campaigns',
    )).toHaveLength(0);
  });

  it.each([false, null])(
    'uses the campaign resolver for an unresolved/legacy row (proven=%s)',
    async (ownerProven) => {
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: null,
        qualified_project_owner_proven: ownerProven,
      },
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
    });

    const response = await invokeRoute(route);

    expect(response.status).toBe(200);
    expect(mockInstantlyDb.selects.filter(
      ({ table, columns }) =>
        (table === 'project_instantly_campaigns' ||
          table === 'project_period_instantly_campaigns') &&
        columns.includes('project_id'),
    )).toHaveLength(2);
    },
  );

  it('does not fall back to live ownership for a proven self-serve qualification', async () => {
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: null,
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
    });

    const response = await invokeRoute(route);

    expect(response.status).toBe(403);
    expectNoProtectedSideEffects();
    expect(mockInstantlyDb.selects.filter(
      ({ table }) =>
        table === 'project_instantly_campaigns' ||
        table === 'project_period_instantly_campaigns',
    )).toHaveLength(0);
  });
});

describe('thread-outbound qualification binding', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
    });
  });

  it('requires a qualification id before fetching the external thread', async () => {
    const { GET } = await import('@/app/api/instantly/qualified-leads/thread-outbound/route');

    const response = await GET(threadOutboundReq({ qualificationId: null }));

    expect(response.status).toBe(400);
    expect(mockListEmails).not.toHaveBeenCalled();
  });

  it('rejects campaign or lead parameters that do not match the authorized qualification', async () => {
    const { GET } = await import('@/app/api/instantly/qualified-leads/thread-outbound/route');

    const response = await GET(threadOutboundReq({ leadEmail: 'other@example.com' }));

    expect(response.status).toBe(403);
    expect(mockListEmails).not.toHaveBeenCalled();
  });

  it('returns the proposal only from the qualification exact thread', async () => {
    mockListEmails.mockResolvedValueOnce({
      items: [
        {
          id: 'foreign-opener',
          campaign_id: QUALIFICATION.campaign_id,
          thread_id: 'thread-foreign',
          from_address_email: 'sender@example.com',
          to_address_email_list: QUALIFICATION.lead_email,
          ue_type: 1,
          timestamp_email: '2026-08-24T06:00:00Z',
          body: { text: 'Foreign opener' },
        },
        {
          id: 'foreign-proposal',
          campaign_id: QUALIFICATION.campaign_id,
          thread_id: 'thread-foreign',
          from_address_email: 'sender@example.com',
          to_address_email_list: QUALIFICATION.lead_email,
          ue_type: 1,
          timestamp_email: '2026-08-24T06:30:00Z',
          body: { text: 'Foreign proposal' },
        },
        {
          id: 'authorized-opener',
          campaign_id: QUALIFICATION.campaign_id,
          thread_id: QUALIFICATION.thread_id,
          from_address_email: 'sender@example.com',
          to_address_email_list: QUALIFICATION.lead_email,
          ue_type: 1,
          timestamp_email: '2026-08-24T07:00:00Z',
          body: { text: 'Authorized opener' },
        },
        {
          id: 'authorized-proposal',
          campaign_id: QUALIFICATION.campaign_id,
          thread_id: QUALIFICATION.thread_id,
          from_address_email: 'sender@example.com',
          to_address_email_list: QUALIFICATION.lead_email,
          ue_type: 1,
          timestamp_email: '2026-08-24T07:30:00Z',
          body: { text: 'Authorized proposal' },
        },
      ],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/thread-outbound/route');

    const response = await GET(threadOutboundReq());
    const body = await response.json() as { text: string | null; step: number };

    expect(response.status).toBe(200);
    expect(body).toEqual({ text: 'Authorized proposal', step: 2 });
  });

  it('fails closed when a legacy qualification has no thread id', async () => {
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        thread_id: null,
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
      },
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/thread-outbound/route');

    const response = await GET(threadOutboundReq());

    expect(response.status).toBe(409);
    expect(mockListEmails).not.toHaveBeenCalled();
  });
});

describe('forward qualification-scoped enrichment', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb('technician', undefined, [
      {
        campaign_id: 'campaign-foreign',
        email: QUALIFICATION.lead_email,
        company_name: 'Foreign Company',
        website: 'https://foreign.example',
      },
      {
        campaign_id: QUALIFICATION.campaign_id,
        email: QUALIFICATION.lead_email,
        company_name: 'Authorized Company',
        website: 'https://authorized.example',
      },
    ]);
    mockInstantlyDb = makeInstantlyDb({
      qualification: { company_name: null },
      periods: [{ project_id: 'project-a', campaign_id: QUALIFICATION.campaign_id }],
    });
  });

  it('never enriches a forwarded lead from another campaign with the same email', async () => {
    const response = await invokeRoute('forward');
    const forwarded = mockInstantlyDb!.getRows('client_forwarded_leads').find(
      (row) => row.telegram_chat_id === 777,
    );

    expect(response.status).toBe(200);
    expect(mockGetLeadsByEmail).toHaveBeenCalledWith({
      email: QUALIFICATION.lead_email,
      campaign_id: QUALIFICATION.campaign_id,
    });
    expect(forwarded).toEqual(expect.objectContaining({
      company_name: 'Authorized Company',
      website: 'https://authorized.example',
    }));
  });
});
