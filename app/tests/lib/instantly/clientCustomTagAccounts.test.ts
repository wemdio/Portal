/** @jest-environment node */

export {};

const ORIGINAL_ENV = {
  INSTANTLY_API_KEY: process.env.INSTANTLY_API_KEY,
  INSTANTLY_ACCOUNTS_JSON: process.env.INSTANTLY_ACCOUNTS_JSON,
};

const WORKSPACE_ID = 'workspace-b';
const WORKSPACE_KEY = 'workspace-b-secret';
const ORIGINAL_FETCH = global.fetch;

let fetchMock: jest.Mock;

function okPage(items: unknown[] = []): Response {
  return new Response(JSON.stringify({ items, next_starting_after: null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  jest.resetModules();
  process.env.INSTANTLY_API_KEY = 'main-secret';
  process.env.INSTANTLY_ACCOUNTS_JSON = JSON.stringify([
    { id: WORKSPACE_ID, label: 'Workspace B', apiKey: WORKSPACE_KEY },
  ]);
  fetchMock = jest.fn().mockImplementation(() => Promise.resolve(okPage()));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function expectWorkspaceAuthorization(callIndex: number): void {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${WORKSPACE_KEY}`);
}

describe('Instantly custom tags — workspace request options', () => {
  it('uses the selected workspace for paginated and all-pages custom tag reads', async () => {
    const { listAllCustomTags, listCustomTags } = await import('@/lib/instantly/client');

    await listCustomTags({ limit: 25 }, { accountId: WORKSPACE_ID });
    await listAllCustomTags({ accountId: WORKSPACE_ID });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.instantly.ai/api/v2/custom-tags?limit=25',
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://api.instantly.ai/api/v2/custom-tags?limit=100',
    );
    expectWorkspaceAuthorization(0);
    expectWorkspaceAuthorization(1);
  });

  it('uses the selected workspace for paginated and all-pages tag-mapping reads', async () => {
    const { listAllCustomTagMappings, listCustomTagMappings } = await import('@/lib/instantly/client');

    await listCustomTagMappings(
      { limit: 40, resource_type: 'account' },
      { accountId: WORKSPACE_ID },
    );
    await listAllCustomTagMappings('account', { accountId: WORKSPACE_ID });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.instantly.ai/api/v2/custom-tag-mappings?limit=40&resource_type=account',
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://api.instantly.ai/api/v2/custom-tag-mappings?limit=100&resource_type=account',
    );
    expectWorkspaceAuthorization(0);
    expectWorkspaceAuthorization(1);
  });
});

describe('Instantly campaign scope guard', () => {
  it('flags reserve-pool campaign tags but ignores project tags, account mappings and completed history', async () => {
    const { detectReservedCampaignScopeIssues } = await import(
      '@/lib/instantly/campaignScopeRules'
    );

    const issues = detectReservedCampaignScopeIssues(
      [
        { id: 'active-bad', name: 'Вороной 1', status: 1 },
        { id: 'draft-bad', name: 'Вороной 2', status: 0 },
        { id: 'active-good', name: 'Другой проект', status: 1 },
        { id: 'completed-bad', name: 'Старая', status: 3 },
      ],
      [
        { id: 'reserve-a', name: 'неименные maildoso' },
        { id: 'reserve-b', name: 'Неименные почты' },
        { id: 'project', name: 'Вороной' },
      ],
      [
        { id: '1', tag_id: 'reserve-a', resource_id: 'active-bad', resource_type: 'campaign' },
        { id: '2', tag_id: 'reserve-b', resource_id: 'draft-bad', resource_type: 'campaign' },
        { id: '3', tag_id: 'project', resource_id: 'active-good', resource_type: 'campaign' },
        { id: '4', tag_id: 'reserve-a', resource_id: 'completed-bad', resource_type: 'campaign' },
        { id: '5', tag_id: 'reserve-a', resource_id: 'active-good', resource_type: 'account' },
      ],
    );

    expect(issues).toEqual([
      expect.objectContaining({
        campaignId: 'active-bad',
        campaignName: 'Вороной 1',
        reserveTagNames: ['неименные maildoso'],
      }),
      expect.objectContaining({
        campaignId: 'draft-bad',
        campaignName: 'Вороной 2',
        reserveTagNames: ['Неименные почты'],
      }),
    ]);
  });
});
