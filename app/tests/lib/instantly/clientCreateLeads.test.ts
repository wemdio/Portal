/** @jest-environment node */

export {};

const ORIGINAL_API_KEY = process.env.INSTANTLY_API_KEY;

beforeAll(() => {
  process.env.INSTANTLY_API_KEY = 'test-api-key';
});

afterAll(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.INSTANTLY_API_KEY;
  else process.env.INSTANTLY_API_KEY = ORIGINAL_API_KEY;
});

let fetchMock: jest.Mock;

function bulkResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: 'success',
    total_sent: 1,
    leads_uploaded: 1,
    in_blocklist: 0,
    blocklist_used: null,
    duplicated_leads: 0,
    skipped_count: 0,
    invalid_email_count: 0,
    incomplete_count: 0,
    duplicate_email_count: 0,
    remaining_in_plan: 999,
    created_leads: [{ id: 'lead-1', email: 'lead@example.com', index: 0 }],
    ...overrides,
  };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('createLeads - current Instantly bulk response contract', () => {
  it('returns the official leads_uploaded and skip counters without guessing', async () => {
    fetchMock.mockResolvedValueOnce(okJson(bulkResponse({
      total_sent: 2,
      leads_uploaded: 0,
      skipped_count: 2,
      created_leads: [],
    })));
    const { createLeads } = await import('@/lib/instantly/client');

    const result = await createLeads(
      [{ email: 'a@example.com' }, { email: 'b@example.com' }],
      { campaign_id: 'cmp-1', skip_if_in_campaign: false },
    );

    expect(result.leads_uploaded).toBe(0);
    expect(result.total_sent).toBe(2);
    expect(result.skipped_count).toBe(2);
  });

  it('normalizes the legacy uploaded counter but never treats request size as success', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ uploaded: 1 }));
    const { createLeads } = await import('@/lib/instantly/client');

    const result = await createLeads(
      [{ email: 'a@example.com' }, { email: 'b@example.com' }],
      { campaign_id: 'cmp-1' },
    );

    expect(result.leads_uploaded).toBe(1);
    expect(result.total_sent).toBe(2);
    expect(result.skipped_count).toBe(1);
  });

  it('fails closed when Instantly omits every recognized upload counter', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ status: 'success' }));
    const { createLeads } = await import('@/lib/instantly/client');

    await expect(createLeads(
      [{ email: 'a@example.com' }],
      { campaign_id: 'cmp-1' },
    )).rejects.toThrow(/leads_uploaded/i);
  });

  it('aggregates current counters and created-lead indices across 1000-row chunks', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson(bulkResponse({
        total_sent: 1000,
        leads_uploaded: 998,
        skipped_count: 1,
        duplicate_email_count: 1,
        remaining_in_plan: 500,
        created_leads: [{ id: 'first', email: 'u0@example.com', index: 0 }],
      })))
      .mockResolvedValueOnce(okJson(bulkResponse({
        total_sent: 1,
        leads_uploaded: 1,
        remaining_in_plan: 499,
        created_leads: [{ id: 'last', email: 'u1000@example.com', index: 0 }],
      })));
    const { createLeads } = await import('@/lib/instantly/client');
    const leads = Array.from({ length: 1001 }, (_, i) => ({ email: `u${i}@example.com` }));

    const result = await createLeads(leads, { campaign_id: 'cmp-1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { leads: unknown[] };
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string) as { leads: unknown[] };
    expect(firstBody.leads).toHaveLength(1000);
    expect(secondBody.leads).toHaveLength(1);
    expect(result).toEqual(expect.objectContaining({
      total_sent: 1001,
      leads_uploaded: 999,
      skipped_count: 1,
      duplicate_email_count: 1,
      remaining_in_plan: 499,
    }));
    expect(result.created_leads).toEqual([
      expect.objectContaining({ id: 'first', index: 0 }),
      expect.objectContaining({ id: 'last', index: 1000 }),
    ]);
  });
});
