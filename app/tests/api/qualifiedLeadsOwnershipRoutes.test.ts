/** @jest-environment node */

import type { NextRequest, NextResponse } from 'next/server';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockMainDb: MockSupabaseClient | null = null;
let mockInstantlyDb: MockSupabaseClient | null = null;
let mockUserId = 'specialist-a';
const mockBuildHandoffDraft = jest.fn(async ({ legend }: { legend: string }) => legend);

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

jest.mock('@/lib/instantly/handoffLegend', () => ({
  buildHandoffDraft: (input: { legend: string }) => mockBuildHandoffDraft(input),
}));

jest.mock('@/lib/instantly/apiRouteHelper', () => {
  const { NextResponse: Response } = jest.requireActual('next/server') as typeof import('next/server');
  type Handler = (
    req: NextRequest,
    user: { id: string; email?: string },
  ) => Promise<NextResponse>;

  return {
    jsonError: (message: string, status: number) => Response.json({ error: message }, { status }),
    withAuth: (handler: Handler) => async (req: NextRequest) => {
      try {
        return await handler(req, { id: mockUserId });
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
  status: 'lead',
  lead_name: 'Lead Name',
  lead_email: 'lead@example.com',
  reply_body: 'Interested',
  reply_preview: 'Interested',
  last_outbound_preview: 'Our offer',
  created_at: '2026-08-24T08:00:00Z',
  read_at: null,
  qualified_project_id: null,
  qualified_project_owner_proven: false,
};

function makeMainDb() {
  return createMockSupabase({
    tables: {
      profiles: [
        { id: 'specialist-a', role: 'technician' },
        { id: 'specialist-b', role: 'technician' },
        { id: 'supervisor', role: 'manager' },
      ],
      projects: [
        {
          id: 'project-a',
          specialist_user_id: 'specialist-a',
          handoff_legend: 'Legend A',
          handoff_ai_adapt: false,
        },
        {
          id: 'project-b',
          specialist_user_id: 'specialist-b',
          handoff_legend: 'Private legend B',
          handoff_ai_adapt: false,
        },
      ],
    },
  });
}

function makeInstantlyDb(options: {
  legacy?: Array<Record<string, unknown>>;
  periods?: Array<Record<string, unknown>>;
  errorTable?: 'project_instantly_campaigns' | 'project_period_instantly_campaigns';
  qualification?: Record<string, unknown>;
} = {}) {
  return createMockSupabase({
    ...(options.errorTable
      ? {
          errorSelects: {
            [options.errorTable]: {
              columnsInclude: 'project_id',
              message: `${options.errorTable} unavailable`,
            },
          },
        }
      : {}),
    tables: {
      instantly_lead_qualifications: [{ ...QUALIFICATION, ...(options.qualification ?? {}) }],
      project_instantly_campaigns: options.legacy ?? [],
      project_period_instantly_campaigns: options.periods ?? [],
    },
  });
}

function getReq(query = ''): NextRequest {
  return new Request(`http://x/api/instantly/qualified-leads${query}`, {
    headers: { authorization: 'Bearer test' },
  }) as unknown as NextRequest;
}

function patchReq(ids: string[] = [QUALIFICATION.id]): NextRequest {
  return new Request('http://x/api/instantly/qualified-leads', {
    method: 'PATCH',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  }) as unknown as NextRequest;
}

function draftReq(framing?: string): NextRequest {
  return new Request('http://x/api/instantly/qualified-leads/handoff-draft', {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ qualification_id: QUALIFICATION.id, ...(framing ? { framing } : {}) }),
  }) as unknown as NextRequest;
}

async function getJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

describe('PATCH /api/instantly/qualified-leads ownership isolation', () => {
  beforeEach(() => {
    jest.resetModules();
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
  });

  it('rejects a foreign qualification id without updating it', async () => {
    mockInstantlyDb = makeInstantlyDb({
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await PATCH(patchReq());

    expect(response.status).toBe(403);
    expect(mockInstantlyDb.updates).toHaveLength(0);
    expect(mockInstantlyDb.getRows('instantly_lead_qualifications')[0].read_at).toBeNull();
  });

  it('rejects an ambiguously owned qualification without updating it', async () => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await PATCH(patchReq());

    expect(response.status).toBe(409);
    expect(mockInstantlyDb.updates).toHaveLength(0);
  });

  it.each([
    'project_period_instantly_campaigns',
    'project_instantly_campaigns',
  ] as const)('fails closed without an update when the %s ownership read fails', async (errorTable) => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      periods: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      errorTable,
    });
    const { PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await PATCH(patchReq());

    expect(response.status).toBe(500);
    expect(mockInstantlyDb.updates).toHaveLength(0);
  });

  it('allows the responsible specialist and CAS-guards the unresolved owner state', async () => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      periods: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
    });
    const { PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await PATCH(patchReq());

    expect(response.status).toBe(200);
    expect(mockInstantlyDb.updates).toHaveLength(1);
    expect(mockInstantlyDb.updates[0].filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'id', op: 'in', value: [QUALIFICATION.id] }),
      expect.objectContaining({ column: 'campaign_id', op: 'eq', value: 'campaign-shared' }),
      expect.objectContaining({
        column: 'qualified_project_owner_proven',
        op: 'eq',
        value: false,
      }),
      expect.objectContaining({ column: 'qualified_project_id', op: 'is', value: null }),
    ]));
    expect(mockInstantlyDb.getRows('instantly_lead_qualifications')[0]).toEqual(
      expect.objectContaining({ read_by: 'specialist-a', read_at: expect.any(String) }),
    );
  });

  it('preserves supervisor access to an unambiguously owned qualification', async () => {
    mockUserId = 'supervisor';
    mockMainDb = createMockSupabase({
      tables: {
        profiles: [{ id: 'supervisor', role: 'manager' }],
        projects: [
          { id: 'project-a', specialist_user_id: 'specialist-a' },
          { id: 'project-b', specialist_user_id: 'specialist-b' },
        ],
      },
    });
    mockInstantlyDb = makeInstantlyDb({
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { PATCH } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await PATCH(patchReq());

    expect(response.status).toBe(200);
    expect(mockInstantlyDb.getRows('instantly_lead_qualifications')[0]).toEqual(
      expect.objectContaining({ read_by: 'supervisor', read_at: expect.any(String) }),
    );
  });
});

describe('GET /api/instantly/qualified-leads ownership isolation', () => {
  beforeEach(() => {
    jest.resetModules();
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockBuildHandoffDraft.mockClear();
  });

  it('hides a historically duplicated campaign from both specialists', async () => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const first = await GET(getReq());
    expect(first.status).toBe(200);
    expect((await getJson(first)).items).toEqual([]);

    mockUserId = 'specialist-b';
    const second = await GET(getReq());
    expect(second.status).toBe(200);
    expect((await getJson(second)).items).toEqual([]);
  });

  it.each([
    '?campaign_id=campaign-shared&use_preferences=false',
    '?campaign_ids=campaign-shared&use_preferences=false',
  ])('does not let explicit campaign parameters bypass specialist ownership (%s)', async (query) => {
    mockInstantlyDb = makeInstantlyDb({
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(getReq(query));

    expect(response.status).toBe(403);
    expect((await getJson(response)).items).toBeUndefined();
  });

  it.each([
    'project_period_instantly_campaigns',
    'project_instantly_campaigns',
  ] as const)('fails closed when the %s ownership read fails', async (errorTable) => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      periods: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      errorTable,
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(getReq('?campaign_id=campaign-shared'));

    expect(response.status).toBe(500);
    expect((await getJson(response)).items).toBeUndefined();
  });

  it('shows a same-project legacy/period duplicate only to its responsible specialist', async () => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      periods: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const ownerResponse = await GET(getReq());
    expect((await getJson(ownerResponse)).items).toEqual([
      expect.objectContaining({ id: QUALIFICATION.id }),
    ]);

    mockUserId = 'specialist-b';
    const otherResponse = await GET(getReq());
    expect((await getJson(otherResponse)).items).toEqual([]);
  });

  it('preserves supervisor access to an unambiguously owned campaign', async () => {
    mockUserId = 'supervisor';
    mockMainDb = createMockSupabase({
      tables: {
        profiles: [{ id: 'supervisor', role: 'manager' }],
        projects: [
          { id: 'project-a', specialist_user_id: 'specialist-a' },
          { id: 'project-b', specialist_user_id: 'specialist-b' },
        ],
      },
    });
    mockInstantlyDb = makeInstantlyDb({
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(getReq());

    expect(response.status).toBe(200);
    expect((await getJson(response)).items).toEqual([
      expect.objectContaining({ id: QUALIFICATION.id }),
    ]);
  });

  it('uses two bounded ownership reads for multiple visible campaigns instead of N+1', async () => {
    const campaignIds = ['campaign-1', 'campaign-2', 'campaign-3'];
    mockInstantlyDb = createMockSupabase({
      tables: {
        instantly_lead_qualifications: campaignIds.map((campaignId, index) => ({
          ...QUALIFICATION,
          id: `qualification-${index + 1}`,
          campaign_id: campaignId,
        })),
        project_instantly_campaigns: campaignIds.map((campaignId) => ({
          project_id: 'project-a',
          campaign_id: campaignId,
        })),
        project_period_instantly_campaigns: campaignIds.map((campaignId) => ({
          project_id: 'project-a',
          campaign_id: campaignId,
        })),
      },
    });
    const { GET } = await import('@/app/api/instantly/qualified-leads/route');

    const response = await GET(getReq());

    expect(response.status).toBe(200);
    expect((await getJson(response)).items).toHaveLength(3);
    const ownershipReads = mockInstantlyDb.selects.filter(
      ({ table, columns }) =>
        (table === 'project_instantly_campaigns' ||
          table === 'project_period_instantly_campaigns') &&
        columns.includes('project_id'),
    );
    expect(ownershipReads).toEqual([
      { table: 'project_period_instantly_campaigns', columns: 'campaign_id, project_id' },
      { table: 'project_instantly_campaigns', columns: 'campaign_id, project_id' },
    ]);
  });
});

describe('POST /api/instantly/qualified-leads/handoff-draft ownership isolation', () => {
  beforeEach(() => {
    jest.resetModules();
    mockUserId = 'specialist-a';
    mockMainDb = makeMainDb();
    mockBuildHandoffDraft.mockClear();
  });

  it('does not choose the first project or expose either legend for an ambiguous campaign', async () => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { POST } = await import('@/app/api/instantly/qualified-leads/handoff-draft/route');

    const response = await POST(draftReq());

    expect(response.status).toBe(409);
    expect(mockBuildHandoffDraft).not.toHaveBeenCalled();
  });

  it.each([
    'project_period_instantly_campaigns',
    'project_instantly_campaigns',
  ] as const)('fails closed when the %s ownership read fails', async (errorTable) => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      periods: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      errorTable,
    });
    const { POST } = await import('@/app/api/instantly/qualified-leads/handoff-draft/route');

    const response = await POST(draftReq());

    expect(response.status).toBe(500);
    expect(mockBuildHandoffDraft).not.toHaveBeenCalled();
  });

  it('rejects a foreign specialist even when a per-request framing override is supplied', async () => {
    mockInstantlyDb = makeInstantlyDb({
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { POST } = await import('@/app/api/instantly/qualified-leads/handoff-draft/route');

    const response = await POST(draftReq('Attacker-controlled framing'));

    expect(response.status).toBe(403);
    expect(mockBuildHandoffDraft).not.toHaveBeenCalled();
  });

  it('uses the resolved project legend for its responsible specialist', async () => {
    mockInstantlyDb = makeInstantlyDb({
      legacy: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
      periods: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
    });
    const { POST } = await import('@/app/api/instantly/qualified-leads/handoff-draft/route');

    const response = await POST(draftReq());

    expect(response.status).toBe(200);
    expect(mockBuildHandoffDraft).toHaveBeenCalledWith(expect.objectContaining({ legend: 'Legend A' }));
  });

  it('uses the immutable qualification project after the campaign is reassigned', async () => {
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { POST } = await import('@/app/api/instantly/qualified-leads/handoff-draft/route');

    const response = await POST(draftReq());

    expect(response.status).toBe(200);
    expect(mockBuildHandoffDraft).toHaveBeenCalledWith(expect.objectContaining({ legend: 'Legend A' }));
  });

  it('keeps handoff drafts restricted to the assigned specialist even for supervisors', async () => {
    mockUserId = 'supervisor';
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { POST } = await import('@/app/api/instantly/qualified-leads/handoff-draft/route');

    const response = await POST(draftReq());

    expect(response.status).toBe(403);
    expect(mockBuildHandoffDraft).not.toHaveBeenCalled();
  });

  it('does not expose a historical handoff draft to the campaign new specialist', async () => {
    mockUserId = 'specialist-b';
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: 'project-a',
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-b', campaign_id: 'campaign-shared' }],
    });
    const { POST } = await import('@/app/api/instantly/qualified-leads/handoff-draft/route');

    const response = await POST(draftReq());

    expect(response.status).toBe(403);
    expect(mockBuildHandoffDraft).not.toHaveBeenCalled();
  });

  it('does not use a later managed owner for a proven self-serve qualification', async () => {
    mockInstantlyDb = makeInstantlyDb({
      qualification: {
        qualified_project_id: null,
        qualified_project_owner_proven: true,
      },
      periods: [{ project_id: 'project-a', campaign_id: 'campaign-shared' }],
    });
    const { POST } = await import('@/app/api/instantly/qualified-leads/handoff-draft/route');

    const response = await POST(draftReq());

    expect(response.status).toBe(403);
    expect(mockBuildHandoffDraft).not.toHaveBeenCalled();
    expect(mockInstantlyDb.selects.filter(
      ({ table }) =>
        table === 'project_instantly_campaigns' ||
        table === 'project_period_instantly_campaigns',
    )).toHaveLength(0);
  });
});
