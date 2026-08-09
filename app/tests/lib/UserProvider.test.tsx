import { act, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import { UserProvider, useUser } from '@/lib/UserProvider';

type AuthCallback = (event: string, session: Session | null) => void;

const mockAuthFetch = jest.fn();
const mockFrom = jest.fn();
let mockAuthCallback: AuthCallback | null = null;

jest.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
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

function session(id: string, email: string): Session {
  return { user: { id, email } } as Session;
}

function ContextProbe() {
  const { userId, userRole, isHr, userFullName, locale } = useUser();
  return (
    <output aria-label="user-context">
      {JSON.stringify({ userId, userRole, isHr, userFullName, locale })}
    </output>
  );
}

function contextValue() {
  return JSON.parse(screen.getByLabelText('user-context').textContent || '{}') as {
    userId: string | null;
    userRole: string | null;
    isHr: boolean;
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
});
