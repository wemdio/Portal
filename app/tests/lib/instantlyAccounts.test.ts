/** @jest-environment node */

const ORIGINAL_ENV = {
  INSTANTLY_API_KEY: process.env.INSTANTLY_API_KEY,
  INSTANTLY_PORTAL_API_KEY: process.env.INSTANTLY_PORTAL_API_KEY,
  INSTANTLY_ACCOUNTS_JSON: process.env.INSTANTLY_ACCOUNTS_JSON,
};

afterEach(() => {
  jest.resetModules();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Instantly account registry', () => {
  it('lists the main account plus configured additional accounts without leaking API keys', async () => {
    delete process.env.INSTANTLY_API_KEY;
    process.env.INSTANTLY_PORTAL_API_KEY = 'main-secret-key';
    process.env.INSTANTLY_ACCOUNTS_JSON = JSON.stringify([
      { id: 'client-b', label: 'Client B Instantly', apiKey: 'client-b-secret-key' },
    ]);

    const {
      getInstantlyAccountApiKey,
      listInstantlyAccounts,
      resolveInstantlyAccountId,
    } = await import('@/lib/instantly/accounts');

    expect(resolveInstantlyAccountId(undefined)).toBe('main');
    expect(getInstantlyAccountApiKey('client-b')).toBe('client-b-secret-key');
    expect(getInstantlyAccountApiKey('main')).toBe('main-secret-key');

    const accounts = listInstantlyAccounts();
    expect(accounts).toEqual([
      { id: 'main', label: 'Основной Instantly', isDefault: true },
      { id: 'client-b', label: 'Client B Instantly', isDefault: false },
    ]);
    expect(JSON.stringify(accounts)).not.toContain('secret-key');
  });
});
