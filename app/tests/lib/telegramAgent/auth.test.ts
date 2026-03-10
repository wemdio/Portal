/** @jest-environment node */

const mockFrom = jest.fn();
jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));

import { identifyUser } from '@/lib/telegramAgent/auth';

function mockChain(result: { data: unknown; error: unknown }) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(result),
    maybeSingle: jest.fn().mockResolvedValue(result),
  };
  return chain;
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('telegramAgent/auth', () => {
  it('returns user when telegram_id is linked', async () => {
    const linkChain = mockChain({ data: { user_id: 'u-1' }, error: null });
    const profileChain = mockChain({
      data: { id: 'u-1', full_name: 'Иван', role: 'admin', email: 'ivan@test.com' },
      error: null,
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'telegram_links') return linkChain;
      if (table === 'profiles') return profileChain;
      return mockChain({ data: null, error: null });
    });

    const user = await identifyUser(99999);
    expect(user).toEqual({
      userId: 'u-1',
      fullName: 'Иван',
      role: 'admin',
      email: 'ivan@test.com',
      telegramId: 99999,
    });
  });

  it('returns null when telegram_id is not found', async () => {
    const linkChain = mockChain({ data: null, error: null });
    mockFrom.mockReturnValue(linkChain);

    const user = await identifyUser(11111);
    expect(user).toBeNull();
  });

  it('returns null when profile lookup fails', async () => {
    const linkChain = mockChain({ data: { user_id: 'u-2' }, error: null });
    const profileChain = mockChain({ data: null, error: { message: 'Not found' } });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'telegram_links') return linkChain;
      return profileChain;
    });

    const user = await identifyUser(22222);
    expect(user).toBeNull();
  });

  it('uses fallback name when full_name is null', async () => {
    const linkChain = mockChain({ data: { user_id: 'u-3' }, error: null });
    const profileChain = mockChain({
      data: { id: 'u-3', full_name: null, role: 'technician', email: 'user@test.com' },
      error: null,
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'telegram_links') return linkChain;
      return profileChain;
    });

    const user = await identifyUser(33333);
    expect(user?.fullName).toBe('user@test.com');
  });
});
