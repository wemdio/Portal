/** @jest-environment node */

export {};

const ORIGINAL_API_KEY = process.env.INSTANTLY_API_KEY;
const originalFetch = global.fetch;

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(() => {
  process.env.INSTANTLY_API_KEY = 'test-api-key';
});

afterAll(() => {
  global.fetch = originalFetch;
  if (ORIGINAL_API_KEY === undefined) delete process.env.INSTANTLY_API_KEY;
  else process.env.INSTANTLY_API_KEY = ORIGINAL_API_KEY;
});

it('drains every cursor page of exact mailbox campaign mappings', async () => {
  const fetchMock = jest
    .fn()
    .mockResolvedValueOnce(okJson({
      items: [{ campaign_id: 'campaign-a', status: 1 }],
      next_starting_after: 'cursor-1',
    }))
    .mockResolvedValueOnce(okJson({
      items: [{ campaign_id: 'campaign-b', status: 1 }],
      next_starting_after: null,
    }));
  global.fetch = fetchMock as unknown as typeof fetch;

  const { getAccountCampaignMappings } = await import('@/lib/instantly/client');
  const result = await getAccountCampaignMappings('Owner+Box@Example.com');

  expect(result.items).toEqual([
    { campaign_id: 'campaign-a', status: 1 },
    { campaign_id: 'campaign-b', status: 1 },
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[0][0])).toBe(
    'https://api.instantly.ai/api/v2/account-campaign-mappings/Owner%2BBox%40Example.com?limit=100',
  );
  expect(String(fetchMock.mock.calls[1][0])).toBe(
    'https://api.instantly.ai/api/v2/account-campaign-mappings/Owner%2BBox%40Example.com?limit=100&starting_after=cursor-1',
  );
});

it('fails closed when the provider repeats a pagination cursor', async () => {
  const fetchMock = jest.fn().mockImplementation(async () => okJson({
    items: [{ campaign_id: 'campaign-a', status: 1 }],
    next_starting_after: 'stuck-cursor',
  }));
  global.fetch = fetchMock as unknown as typeof fetch;

  const { getAccountCampaignMappings } = await import('@/lib/instantly/client');

  await expect(
    getAccountCampaignMappings('owner@example.com'),
  ).rejects.toThrow(/pagination cursor/i);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
