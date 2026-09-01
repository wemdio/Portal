/** @jest-environment node */

/**
 * Regression test for Instantly /leads/list parameter naming.
 *
 * Background (May 2026):
 *   Our `listLeads()` client used to send `lead_list_id` AND `campaign_id` in
 *   the POST body. Instantly API v2 actually expects `list_id` and `campaign`
 *   respectively — when the wrong keys are sent, Instantly silently ignores
 *   them and returns leads from the entire workspace, not just the requested
 *   list/campaign.
 *
 *   This was confirmed empirically against the live API:
 *     - `lead_list_id=df704506-…`  → 500 rows, ZERO with that list_id.
 *     - `list_id=df704506-…`       → 500 rows, ALL with that list_id. ✓
 *     - `campaign_id=49ac2ff7-…`   → 300 rows, ZERO with that campaign.
 *     - `campaign=49ac2ff7-…`      → 0 rows (matches UI: empty campaign). ✓
 *
 *   Impact: portal page `/instantly/leads?lead_list_id=…` showed wrong leads.
 *           Bulk export scripts pulled tens of thousands of unrelated leads.
 *           `listAllLeads(campaignId)` paginated through the whole workspace.
 *
 * Contract these tests lock in:
 *   - When caller passes `lead_list_id`, the outgoing POST body must contain
 *     `list_id` (NOT `lead_list_id`) so Instantly actually filters.
 *   - When caller passes `campaign_id`, the outgoing POST body must contain
 *     `campaign` (NOT `campaign_id`) so Instantly actually filters.
 *   - Other fields (limit, search, interest_status, starting_after) pass through.
 */

const ORIGINAL_API_KEY = process.env.INSTANTLY_API_KEY;

beforeAll(() => {
  process.env.INSTANTLY_API_KEY = 'test-api-key';
});

afterAll(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.INSTANTLY_API_KEY;
  else process.env.INSTANTLY_API_KEY = ORIGINAL_API_KEY;
});

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn().mockResolvedValue(
    new Response(JSON.stringify({ items: [], next_starting_after: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

function lastFetchBody(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0][1] as { body?: string };
  expect(init.body).toBeDefined();
  return JSON.parse(init.body!) as Record<string, unknown>;
}

describe('listLeads → Instantly POST /leads/list body shape', () => {
  it('translates lead_list_id → list_id (the actual Instantly API key)', async () => {
    const { listLeads } = await import('@/lib/instantly/client');
    await listLeads({ lead_list_id: 'list-xyz', limit: 100 });

    const body = lastFetchBody();
    expect(body).toEqual({ list_id: 'list-xyz', limit: 100 });
    expect(body).not.toHaveProperty('lead_list_id');
  });

  it('marks a provider attempt only when the transport is about to start', async () => {
    const onRequestAttempt = jest.fn();
    fetchMock.mockRejectedValueOnce(new Error('provider timeout'));
    const { createLeads } = await import('@/lib/instantly/client');

    await expect(createLeads(
      [{ email: 'person@example.test' }],
      { campaign_id: 'campaign-1' },
      { skipRateLimiter: true, onRequestAttempt },
    )).rejects.toThrow('provider timeout');

    expect(onRequestAttempt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('translates campaign_id → campaign (the actual Instantly API key)', async () => {
    const { listLeads } = await import('@/lib/instantly/client');
    await listLeads({ campaign_id: 'camp-abc', limit: 100 });

    const body = lastFetchBody();
    expect(body).toEqual({ campaign: 'camp-abc', limit: 100 });
    expect(body).not.toHaveProperty('campaign_id');
  });

  it('handles both lead_list_id and campaign_id together with extra fields', async () => {
    const { listLeads } = await import('@/lib/instantly/client');
    await listLeads({
      lead_list_id: 'list-xyz',
      campaign_id: 'camp-abc',
      limit: 50,
      starting_after: 'cursor-1',
      search: 'foo@bar.com',
      interest_status: 1,
    });

    const body = lastFetchBody();
    expect(body).toEqual({
      list_id: 'list-xyz',
      campaign: 'camp-abc',
      limit: 50,
      starting_after: 'cursor-1',
      search: 'foo@bar.com',
      interest_status: 1,
    });
    expect(body).not.toHaveProperty('lead_list_id');
    expect(body).not.toHaveProperty('campaign_id');
  });

  it('does not add campaign/list_id keys when corresponding inputs are absent', async () => {
    const { listLeads } = await import('@/lib/instantly/client');
    await listLeads({ search: 'foo@bar.com', limit: 10 });

    const body = lastFetchBody();
    expect(body).toEqual({ search: 'foo@bar.com', limit: 10 });
    expect(body).not.toHaveProperty('campaign');
    expect(body).not.toHaveProperty('list_id');
  });

  it('hits the correct endpoint with POST', async () => {
    const { listLeads } = await import('@/lib/instantly/client');
    await listLeads({ lead_list_id: 'list-xyz' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.instantly.ai/api/v2/leads/list');
    expect((init as { method?: string }).method).toBe('POST');
  });
});
