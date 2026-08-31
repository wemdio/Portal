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
