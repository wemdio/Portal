import type { SupabaseClient } from '@supabase/supabase-js';
import { isLeadershipUser } from '@/lib/auth/internalGuard';

type Profile = {
  role: string | null;
  is_demo: boolean;
} | null;

function clientWithProfile(profile: Profile): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: profile, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('isLeadershipUser', () => {
  it.each([
    ['lead', true],
    ['director', true],
    ['admin', true],
    ['technician', false],
    ['manager', false],
    ['sales', false],
    ['marketer', false],
    ['client', false],
    [null, false],
  ] as const)('returns %s access as %s', async (role, expected) => {
    const result = await isLeadershipUser(
      clientWithProfile({ role, is_demo: false }),
      'user-id',
    );

    expect(result).toBe(expected);
  });

  it('rejects a demo account even when its stored role is leadership', async () => {
    const result = await isLeadershipUser(
      clientWithProfile({ role: 'admin', is_demo: true }),
      'demo-user-id',
    );

    expect(result).toBe(false);
  });

  it('fails closed when the profile is missing', async () => {
    const result = await isLeadershipUser(clientWithProfile(null), 'missing-user-id');

    expect(result).toBe(false);
  });
});
