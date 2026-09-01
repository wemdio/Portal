/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

const LOGIN_EMAIL = 'client.owner@example.test';
const PASSWORD = 'Dont-log-this-123!';

type PortalDb = MockSupabaseClient & {
  auth: {
    admin: {
      createUser: jest.Mock;
      getUserById: jest.Mock;
      deleteUser: jest.Mock;
    };
  };
};

let mockPortalDb: PortalDb;
const mockCreateUser = jest.fn();
const mockGetUserById = jest.fn();
const mockDeleteUser = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockPortalDb;
  },
}));

import { createManagedPortalUser } from '@/lib/auth/managedUserProvisioning';

beforeEach(() => {
  jest.clearAllMocks();
  mockPortalDb = Object.assign(
    createMockSupabase({ tables: { profiles: [] } }),
    {
      auth: {
        admin: {
          createUser: mockCreateUser,
          getUserById: mockGetUserById,
          deleteUser: mockDeleteUser,
        },
      },
    },
  );
  mockDeleteUser.mockResolvedValue({ data: { user: null }, error: null });
});

describe('createManagedPortalUser', () => {
  it('reconciles an auth user committed before the create response was lost', async () => {
    mockCreateUser.mockRejectedValue(new Error('socket closed after write'));
    mockGetUserById
      .mockResolvedValueOnce({
        data: { user: null },
        error: { status: 404, message: 'User not found yet' },
      })
      .mockImplementation(async (userId: string) => ({
        data: {
          user: {
            id: userId,
            email: LOGIN_EMAIL,
          },
        },
        error: null,
      }));

    const result = await createManagedPortalUser({
      email: LOGIN_EMAIL,
      password: PASSWORD,
      fullName: 'Альфа Логистика',
      role: 'client',
    });

    expect(result).toEqual({
      ok: true,
      user: {
        id: expect.any(String),
        email: LOGIN_EMAIL,
      },
    });
    const requestedId = mockCreateUser.mock.calls[0]?.[0]?.id;
    expect(requestedId).toEqual(expect.any(String));
    expect(mockGetUserById).toHaveBeenCalledWith(requestedId);
    expect(mockGetUserById).toHaveBeenCalledTimes(2);
    expect(mockPortalDb.getRows('profiles')).toEqual([
      expect.objectContaining({ id: requestedId, email: LOGIN_EMAIL, role: 'client' }),
    ]);
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it('does not delete an unrelated account when an ambiguous create cannot be reconciled', async () => {
    const transportError = new Error('socket closed after write');
    mockCreateUser.mockRejectedValue(transportError);
    mockGetUserById.mockResolvedValue({
      data: { user: null },
      error: { status: 404, message: 'User not found' },
    });

    const result = await createManagedPortalUser({
      email: LOGIN_EMAIL,
      password: PASSWORD,
      fullName: 'Альфа Логистика',
      role: 'client',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      kind: 'auth',
      error: transportError,
    }));
    expect(mockGetUserById).toHaveBeenCalledTimes(3);
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockPortalDb.getRows('profiles')).toEqual([]);
  });
});
