import { act, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import { UserProvider, useUser } from '@/lib/UserProvider';

type AuthCallback = (event: string, session: Session | null) => void;

const mockAuthFetch = jest.fn();
const mockFrom = jest.fn();
const mockRpc = jest.fn();
let mockAuthCallback: AuthCallback | null = null;

jest.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
    auth: {
      onAuthStateChange: (callback: AuthCallback) => {
        mockAuthCallback = callback;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      },
      signOut: jest.fn(),
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

function privateCapabilityCallCount(): number {
  return mockRpc.mock.calls.filter(([name]) => name === 'can_access_team').length;
}

function mockPrivateCapabilities(
  requests: Array<ReturnType<typeof deferred<{ data: unknown; error: unknown }>>>,
) {
  let index = 0;
  mockRpc.mockImplementation((functionName: string) => {
    if (functionName !== 'can_access_team') {
      return Promise.resolve({ data: false, error: null });
    }
    const request = requests[index++];
    if (!request) throw new Error('Unexpected can_access_team request');
    return request.promise;
  });
}

function session(id: string, email: string): Session {
  return { user: { id, email } } as Session;
}

function ContextProbe() {
  const {
    userId,
    userRole,
    isHr,
    canAccessTeamPrivate,
    userEmail,
    userFullName,
    locale,
  } = useUser();
  return (
    <output aria-label="user-context">
      {JSON.stringify({
        userId,
        userRole,
        isHr,
        canAccessTeamPrivate,
        userEmail,
        userFullName,
        locale,
      })}
    </output>
  );
}

function contextValue() {
  return JSON.parse(screen.getByLabelText('user-context').textContent || '{}') as {
    userId: string | null;
    userRole: string | null;
    isHr: boolean;
    canAccessTeamPrivate: boolean;
    userEmail: string | null;
    userFullName: string | null;
    locale: string;
  };
}

describe('<UserProvider /> HR capability lifecycle', () => {
  const profiles: Record<string, Record<string, unknown>> = {};
  const capabilityRequests = new Map<string, ReturnType<typeof deferred<{ data: unknown; error: unknown }>>>();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAuthCallback = null;
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: false, error: null });
    Object.keys(profiles).forEach((key) => delete profiles[key]);
    capabilityRequests.clear();
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ toolIds: [], requests: [], unread_count: 0 }),
    });
    mockFrom.mockImplementation((table: string) => ({
      select: (columns: string) => ({
        eq: (_column: string, userId: string) => ({
          single: () => {
            if (table === 'profiles' && columns.includes('is_hr')) {
              const request = capabilityRequests.get(userId);
              if (!request) throw new Error(`Missing capability request for ${userId}`);
              return request.promise;
            }
            return Promise.resolve({ data: profiles[userId] ?? null, error: null });
          },
          in: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps profile identity and locale when the independent capability query fails', async () => {
    profiles['user-a'] = {
      role: 'admin',
      full_name: 'Алина Ким',
      avatar_url: null,
      locale: 'ru',
    };
    const capability = deferred<{ data: unknown; error: unknown }>();
    capabilityRequests.set('user-a', capability);
    render(<UserProvider initialLocale="en"><ContextProbe /></UserProvider>);

    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('user-a', 'alina@example.com'));
    });
    await waitFor(() => expect(contextValue()).toMatchObject({
      userId: 'user-a',
      userRole: 'admin',
      userFullName: 'Алина Ким',
      locale: 'ru',
    }));

    await act(async () => {
      capability.resolve({ data: null, error: { message: 'column is_hr does not exist' } });
      await capability.promise;
    });

    expect(contextValue()).toEqual({
      userId: 'user-a',
      userRole: 'admin',
      isHr: false,
      canAccessTeamPrivate: false,
      userEmail: 'alina@example.com',
      userFullName: 'Алина Ким',
      locale: 'ru',
    });
    expect(mockFrom).toHaveBeenCalledWith('profiles');
  });

  it('resets HR immediately on session change and ignores a stale capability response', async () => {
    profiles['user-a'] = {
      role: 'admin',
      full_name: 'Алина Ким',
      avatar_url: null,
      locale: 'ru',
    };
    profiles['user-b'] = {
      role: 'technician',
      full_name: 'Новый пользователь',
      avatar_url: null,
      locale: 'en',
    };
    profiles['user-c'] = {
      role: 'manager',
      full_name: 'Текущий пользователь',
      avatar_url: null,
      locale: 'ru',
    };
    const firstCapability = deferred<{ data: unknown; error: unknown }>();
    const secondCapability = deferred<{ data: unknown; error: unknown }>();
    const thirdCapability = deferred<{ data: unknown; error: unknown }>();
    capabilityRequests.set('user-a', firstCapability);
    capabilityRequests.set('user-b', secondCapability);
    capabilityRequests.set('user-c', thirdCapability);
    render(<UserProvider><ContextProbe /></UserProvider>);

    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('user-a', 'alina@example.com'));
    });
    await waitFor(() => expect(contextValue().userRole).toBe('admin'));

    await act(async () => {
      firstCapability.resolve({ data: { is_hr: true }, error: null });
      await firstCapability.promise;
    });
    await waitFor(() => expect(contextValue().isHr).toBe(true));

    act(() => {
      mockAuthCallback?.('SIGNED_IN', session('user-b', 'new@example.com'));
    });
    expect(contextValue()).toMatchObject({ userId: 'user-b', isHr: false });

    await waitFor(() => expect(contextValue()).toMatchObject({
      userId: 'user-b',
      userRole: 'technician',
      userFullName: 'Новый пользователь',
      locale: 'en',
      isHr: false,
    }));

    act(() => {
      mockAuthCallback?.('SIGNED_IN', session('user-c', 'current@example.com'));
    });
    await waitFor(() => expect(contextValue()).toMatchObject({
      userId: 'user-c',
      userRole: 'manager',
      userFullName: 'Текущий пользователь',
      locale: 'ru',
      isHr: false,
    }));

    await act(async () => {
      secondCapability.resolve({ data: { is_hr: true }, error: null });
      await secondCapability.promise;
    });
    expect(contextValue().isHr).toBe(false);

    await act(async () => {
      thirdCapability.resolve({ data: { is_hr: false }, error: null });
      await thirdCapability.promise;
    });
    expect(contextValue().isHr).toBe(false);
  });

  it('loads private-team access from the canonical RPC independently from the HR flag', async () => {
    profiles['user-a'] = {
      role: 'technician',
      full_name: 'Алина Ким',
      avatar_url: null,
      locale: 'ru',
    };
    const hrCapability = deferred<{ data: unknown; error: unknown }>();
    const teamCapability = deferred<{ data: unknown; error: unknown }>();
    capabilityRequests.set('user-a', hrCapability);
    mockPrivateCapabilities([teamCapability]);
    render(<UserProvider><ContextProbe /></UserProvider>);

    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('user-a', 'alina@example.com'));
    });
    await waitFor(() => expect(contextValue()).toMatchObject({
      userId: 'user-a',
      userRole: 'technician',
      isHr: false,
      canAccessTeamPrivate: false,
    }));

    await act(async () => {
      teamCapability.resolve({ data: true, error: null });
      await teamCapability.promise;
    });

    await waitFor(() => expect(contextValue()).toMatchObject({
      isHr: false,
      canAccessTeamPrivate: true,
    }));
    expect(mockRpc).toHaveBeenCalledWith('can_access_team');

    await act(async () => {
      hrCapability.resolve({ data: { is_hr: false }, error: null });
      await hrCapability.promise;
    });
    expect(contextValue()).toMatchObject({ isHr: false, canAccessTeamPrivate: true });
  });

  it('keeps profile identity when the independent private-team capability RPC fails', async () => {
    profiles['user-a'] = {
      role: 'admin',
      full_name: 'Сергей Лазуткин',
      avatar_url: null,
      locale: 'ru',
    };
    const hrCapability = deferred<{ data: unknown; error: unknown }>();
    capabilityRequests.set('user-a', hrCapability);
    mockRpc.mockImplementation((functionName: string) => Promise.resolve(
      functionName === 'can_access_team'
        ? { data: null, error: { message: 'RPC unavailable' } }
        : { data: false, error: null },
    ));
    render(<UserProvider><ContextProbe /></UserProvider>);

    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('user-a', 'vaver1954@mail.ru'));
    });
    await waitFor(() => expect(contextValue()).toMatchObject({
      userId: 'user-a',
      userRole: 'admin',
      userEmail: 'vaver1954@mail.ru',
      userFullName: 'Сергей Лазуткин',
      locale: 'ru',
      canAccessTeamPrivate: false,
    }));

    await act(async () => {
      hrCapability.resolve({ data: { is_hr: false }, error: null });
      await hrCapability.promise;
    });

    expect(contextValue()).toMatchObject({
      userRole: 'admin',
      userEmail: 'vaver1954@mail.ru',
      userFullName: 'Сергей Лазуткин',
      canAccessTeamPrivate: false,
    });
    expect(console.error).toHaveBeenCalledWith(
      '[UserProvider] Failed to load private Team capability:',
      expect.anything(),
    );
  });

  it('resets private-team access on session change and ignores stale RPC responses', async () => {
    profiles['user-a'] = {
      role: 'technician',
      full_name: 'Алина Ким',
      avatar_url: null,
      locale: 'ru',
    };
    profiles['user-b'] = {
      role: 'admin',
      full_name: 'Другой администратор',
      avatar_url: null,
      locale: 'ru',
    };
    profiles['user-c'] = {
      role: 'manager',
      full_name: 'Текущий пользователь',
      avatar_url: null,
      locale: 'en',
    };

    const firstHrCapability = deferred<{ data: unknown; error: unknown }>();
    const secondHrCapability = deferred<{ data: unknown; error: unknown }>();
    const thirdHrCapability = deferred<{ data: unknown; error: unknown }>();
    capabilityRequests.set('user-a', firstHrCapability);
    capabilityRequests.set('user-b', secondHrCapability);
    capabilityRequests.set('user-c', thirdHrCapability);
    firstHrCapability.resolve({ data: { is_hr: false }, error: null });
    secondHrCapability.resolve({ data: { is_hr: false }, error: null });
    thirdHrCapability.resolve({ data: { is_hr: false }, error: null });

    const firstTeamCapability = deferred<{ data: unknown; error: unknown }>();
    const secondTeamCapability = deferred<{ data: unknown; error: unknown }>();
    const thirdTeamCapability = deferred<{ data: unknown; error: unknown }>();
    mockPrivateCapabilities([firstTeamCapability, secondTeamCapability, thirdTeamCapability]);

    render(<UserProvider><ContextProbe /></UserProvider>);

    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('user-a', 'alina@example.com'));
    });
    await waitFor(() => expect(contextValue().userRole).toBe('technician'));

    await act(async () => {
      firstTeamCapability.resolve({ data: true, error: null });
      await firstTeamCapability.promise;
    });
    await waitFor(() => expect(contextValue().canAccessTeamPrivate).toBe(true));

    act(() => {
      mockAuthCallback?.('SIGNED_IN', session('user-b', 'other-admin@example.com'));
    });
    expect(contextValue()).toMatchObject({
      userId: 'user-b',
      userEmail: 'other-admin@example.com',
      canAccessTeamPrivate: false,
    });
    await waitFor(() => expect(contextValue().userRole).toBe('admin'));

    act(() => {
      mockAuthCallback?.('SIGNED_IN', session('user-c', 'current@example.com'));
    });
    expect(contextValue()).toMatchObject({
      userId: 'user-c',
      userEmail: 'current@example.com',
      canAccessTeamPrivate: false,
    });
    await waitFor(() => expect(contextValue().userRole).toBe('manager'));

    await act(async () => {
      secondTeamCapability.resolve({ data: true, error: null });
      await secondTeamCapability.promise;
    });
    expect(contextValue()).toMatchObject({
      userId: 'user-c',
      canAccessTeamPrivate: false,
    });

    await act(async () => {
      thirdTeamCapability.resolve({ data: false, error: null });
      await thirdTeamCapability.promise;
    });
    expect(contextValue()).toMatchObject({
      userId: 'user-c',
      canAccessTeamPrivate: false,
    });

    act(() => {
      mockAuthCallback?.('SIGNED_OUT', null);
    });
    expect(contextValue()).toMatchObject({
      userId: null,
      userEmail: null,
      canAccessTeamPrivate: false,
    });
  });

  it.each(['focus', 'visibilitychange'] as const)(
    'revalidates private-team access without destructive flicker when the current session receives %s',
    async (eventName) => {
      profiles['user-a'] = {
        role: 'technician',
        full_name: 'Алина Ким',
        avatar_url: null,
        locale: 'ru',
      };
      const hrCapability = deferred<{ data: unknown; error: unknown }>();
      capabilityRequests.set('user-a', hrCapability);
      hrCapability.resolve({ data: { is_hr: false }, error: null });

      const initialTeamCapability = deferred<{ data: unknown; error: unknown }>();
      const refreshedTeamCapability = deferred<{ data: unknown; error: unknown }>();
      mockPrivateCapabilities([initialTeamCapability, refreshedTeamCapability]);

      const view = render(<UserProvider><ContextProbe /></UserProvider>);
      await act(async () => {
        mockAuthCallback?.('SIGNED_IN', session('user-a', 'alina@example.com'));
      });
      await waitFor(() => expect(contextValue().userRole).toBe('technician'));

      await act(async () => {
        initialTeamCapability.resolve({ data: true, error: null });
        await initialTeamCapability.promise;
      });
      await waitFor(() => expect(contextValue().canAccessTeamPrivate).toBe(true));

      let visibilityState: DocumentVisibilityState = 'visible';
      const visibilitySpy = jest
        .spyOn(document, 'visibilityState', 'get')
        .mockImplementation(() => visibilityState);

      if (eventName === 'visibilitychange') {
        visibilityState = 'hidden';
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        expect(privateCapabilityCallCount()).toBe(1);
        expect(contextValue().canAccessTeamPrivate).toBe(true);
        visibilityState = 'visible';
      }

      act(() => {
        if (eventName === 'focus') window.dispatchEvent(new Event('focus'));
        else document.dispatchEvent(new Event('visibilitychange'));
      });

      expect(contextValue().canAccessTeamPrivate).toBe(true);
      expect(privateCapabilityCallCount()).toBe(2);
      expect(mockRpc.mock.calls.filter(([name]) => name === 'can_access_team').at(-1)).toEqual(['can_access_team']);

      await act(async () => {
        refreshedTeamCapability.resolve({ data: false, error: null });
        await refreshedTeamCapability.promise;
      });
      expect(contextValue().canAccessTeamPrivate).toBe(false);

      view.unmount();
      act(() => {
        if (eventName === 'focus') window.dispatchEvent(new Event('focus'));
        else document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(privateCapabilityCallCount()).toBe(2);
      visibilitySpy.mockRestore();
    },
  );

  it('ignores an older overlapping private-team refresh for the same session', async () => {
    profiles['user-a'] = {
      role: 'technician',
      full_name: 'Алина Ким',
      avatar_url: null,
      locale: 'ru',
    };
    const hrCapability = deferred<{ data: unknown; error: unknown }>();
    capabilityRequests.set('user-a', hrCapability);
    hrCapability.resolve({ data: { is_hr: false }, error: null });

    const initialTeamCapability = deferred<{ data: unknown; error: unknown }>();
    const olderRefresh = deferred<{ data: unknown; error: unknown }>();
    const latestRefresh = deferred<{ data: unknown; error: unknown }>();
    mockPrivateCapabilities([initialTeamCapability, olderRefresh, latestRefresh]);

    render(<UserProvider><ContextProbe /></UserProvider>);
    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('user-a', 'alina@example.com'));
    });
    await waitFor(() => expect(contextValue().userRole).toBe('technician'));

    await act(async () => {
      initialTeamCapability.resolve({ data: true, error: null });
      await initialTeamCapability.promise;
    });
    await waitFor(() => expect(contextValue().canAccessTeamPrivate).toBe(true));

    act(() => window.dispatchEvent(new Event('focus')));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(privateCapabilityCallCount()).toBe(3);
    expect(contextValue().canAccessTeamPrivate).toBe(true);

    await act(async () => {
      olderRefresh.resolve({ data: false, error: null });
      await olderRefresh.promise;
    });
    expect(contextValue().canAccessTeamPrivate).toBe(true);

    await act(async () => {
      latestRefresh.resolve({ data: true, error: null });
      await latestRefresh.promise;
    });
    await waitFor(() => expect(contextValue().canAccessTeamPrivate).toBe(true));
  });

  it('revokes private-team access when same-session revalidation fails', async () => {
    profiles['user-a'] = {
      role: 'technician',
      full_name: 'Алина Ким',
      avatar_url: null,
      locale: 'ru',
    };
    const hrCapability = deferred<{ data: unknown; error: unknown }>();
    capabilityRequests.set('user-a', hrCapability);
    hrCapability.resolve({ data: { is_hr: false }, error: null });

    const initialTeamCapability = deferred<{ data: unknown; error: unknown }>();
    const failedRefresh = deferred<{ data: unknown; error: unknown }>();
    mockPrivateCapabilities([initialTeamCapability, failedRefresh]);

    render(<UserProvider><ContextProbe /></UserProvider>);
    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('user-a', 'alina@example.com'));
    });
    await waitFor(() => expect(contextValue().userRole).toBe('technician'));

    await act(async () => {
      initialTeamCapability.resolve({ data: true, error: null });
      await initialTeamCapability.promise;
    });
    await waitFor(() => expect(contextValue().canAccessTeamPrivate).toBe(true));

    act(() => window.dispatchEvent(new Event('focus')));
    expect(contextValue().canAccessTeamPrivate).toBe(true);

    await act(async () => {
      failedRefresh.resolve({ data: null, error: { message: 'RPC unavailable' } });
      await failedRefresh.promise;
    });

    await waitFor(() => expect(contextValue().canAccessTeamPrivate).toBe(false));
    expect(console.error).toHaveBeenCalledWith(
      '[UserProvider] Failed to load private Team capability:',
      expect.anything(),
    );
  });
});
