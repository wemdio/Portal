import { act, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import { UserProvider, useUser } from '@/lib/UserProvider';

type AuthCallback = (event: string, session: Session | null) => void;

const mockAuthFetch = jest.fn();
const mockFrom = jest.fn();
const mockRpc = jest.fn();
let mockAuthCallback: AuthCallback | null = null;
let profileRole = 'admin';
let submitCapability: { data: boolean | null; error: unknown } = { data: false, error: null };
let sharedCapability: { data: boolean | null; error: unknown } = { data: false, error: null };
let privateCapability: { data: boolean | null; error: unknown } = { data: false, error: null };

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

function session(id: string, email: string): Session {
  return { user: { id, email } } as Session;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => { resolve = resolveValue; });
  return { promise, resolve };
}

function CapabilityProbe() {
  const {
    userRole,
    canAccessTeamPrivate,
    canSubmitTeamReviewRequest,
    canViewTeamReviewRequestsShared,
  } = useUser();

  return (
    <output aria-label="team-review-capabilities">
      {JSON.stringify({
        userRole,
        canAccessTeamPrivate,
        canSubmitTeamReviewRequest,
        canViewTeamReviewRequestsShared,
      })}
    </output>
  );
}

function capabilities() {
  return JSON.parse(screen.getByLabelText('team-review-capabilities').textContent || '{}') as {
    userRole: string | null;
    canAccessTeamPrivate: boolean;
    canSubmitTeamReviewRequest: boolean;
    canViewTeamReviewRequestsShared: boolean;
  };
}

describe('<UserProvider /> Team review capabilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAuthCallback = null;
    profileRole = 'admin';
    submitCapability = { data: false, error: null };
    sharedCapability = { data: false, error: null };
    privateCapability = { data: false, error: null };
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ toolIds: [], requests: [], unread_count: 0 }),
    });
    mockFrom.mockImplementation((table: string) => ({
      select: (columns: string) => ({
        eq: () => ({
          single: () => Promise.resolve({
            data: columns.includes('is_hr')
              ? { is_hr: false }
              : { role: profileRole, full_name: 'Руководитель', avatar_url: null, locale: 'ru' },
            error: null,
          }),
          in: () => Promise.resolve({ data: table === 'user_tool_visibility' ? [] : null, error: null }),
        }),
      }),
    }));
    mockRpc.mockImplementation((functionName: string) => {
      if (functionName === 'can_access_team') return Promise.resolve(privateCapability);
      if (functionName === 'can_submit_team_review_request') return Promise.resolve(submitCapability);
      if (functionName === 'can_view_team_review_requests_shared') return Promise.resolve(sharedCapability);
      throw new Error(`Unexpected RPC: ${functionName}`);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['Grid4ina.an@gmail.com', 'sorichev@polzaagency.ru'])(
    'loads private-submit access for executive %s from server capabilities, without granting the shared queue',
    async (email) => {
      submitCapability = { data: true, error: null };
      render(<UserProvider><CapabilityProbe /></UserProvider>);

      await act(async () => {
        mockAuthCallback?.('SIGNED_IN', session('executive-1', email));
      });

      await waitFor(() => expect(capabilities()).toMatchObject({
        userRole: 'admin',
        canAccessTeamPrivate: false,
        canSubmitTeamReviewRequest: true,
        canViewTeamReviewRequestsShared: false,
      }));
      expect(mockRpc).toHaveBeenCalledWith('can_submit_team_review_request');
      expect(mockRpc).toHaveBeenCalledWith('can_view_team_review_requests_shared');
    },
  );

  it('does not infer access from the executive email or admin role when the server denies it', async () => {
    render(<UserProvider><CapabilityProbe /></UserProvider>);

    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('executive-1', 'Grid4ina.an@gmail.com'));
    });

    await waitFor(() => expect(capabilities()).toEqual({
      userRole: 'admin',
      canAccessTeamPrivate: false,
      canSubmitTeamReviewRequest: false,
      canViewTeamReviewRequestsShared: false,
    }));
  });

  it('loads lead submission and shared-read independently from private Team access', async () => {
    profileRole = 'lead';
    submitCapability = { data: true, error: null };
    sharedCapability = { data: true, error: null };
    render(<UserProvider><CapabilityProbe /></UserProvider>);

    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('lead-1', 'lead@example.com'));
    });

    await waitFor(() => expect(capabilities()).toEqual({
      userRole: 'lead',
      canAccessTeamPrivate: false,
      canSubmitTeamReviewRequest: true,
      canViewTeamReviewRequestsShared: true,
    }));
  });

  it('publishes related capabilities atomically so shared requests never look private while loading', async () => {
    profileRole = 'lead';
    const privateRequest = deferred<{ data: boolean; error: null }>();
    const submitRequest = deferred<{ data: boolean; error: null }>();
    const sharedRequest = deferred<{ data: boolean; error: null }>();
    mockRpc.mockImplementation((functionName: string) => {
      if (functionName === 'can_access_team') return privateRequest.promise;
      if (functionName === 'can_submit_team_review_request') return submitRequest.promise;
      if (functionName === 'can_view_team_review_requests_shared') return sharedRequest.promise;
      throw new Error(`Unexpected RPC: ${functionName}`);
    });
    render(<UserProvider><CapabilityProbe /></UserProvider>);

    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('lead-1', 'lead@example.com'));
    });
    await waitFor(() => expect(capabilities().userRole).toBe('lead'));

    await act(async () => {
      privateRequest.resolve({ data: false, error: null });
      submitRequest.resolve({ data: true, error: null });
      await Promise.all([privateRequest.promise, submitRequest.promise]);
    });

    expect(capabilities()).toEqual({
      userRole: 'lead',
      canAccessTeamPrivate: false,
      canSubmitTeamReviewRequest: false,
      canViewTeamReviewRequestsShared: false,
    });

    await act(async () => {
      sharedRequest.resolve({ data: true, error: null });
      await sharedRequest.promise;
    });
    await waitFor(() => expect(capabilities()).toEqual({
      userRole: 'lead',
      canAccessTeamPrivate: false,
      canSubmitTeamReviewRequest: true,
      canViewTeamReviewRequestsShared: true,
    }));
  });

  it('fails each new capability closed without discarding the other successful capability', async () => {
    profileRole = 'lead';
    submitCapability = { data: null, error: { message: 'submit RPC unavailable' } };
    sharedCapability = { data: true, error: null };
    render(<UserProvider><CapabilityProbe /></UserProvider>);

    await act(async () => {
      mockAuthCallback?.('SIGNED_IN', session('lead-1', 'lead@example.com'));
    });

    await waitFor(() => expect(capabilities()).toEqual({
      userRole: 'lead',
      canAccessTeamPrivate: false,
      canSubmitTeamReviewRequest: false,
      canViewTeamReviewRequestsShared: true,
    }));
    expect(console.error).toHaveBeenCalledWith(
      '[UserProvider] Failed to load Team review submit capability:',
      expect.anything(),
    );
  });
});
