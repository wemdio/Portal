/** @jest-environment node */

import { NextRequest } from 'next/server';

const ADMIN_ID = '00000000-0000-4000-8000-000000000901';
const mockCreateManagedPortalUser = jest.fn();
const mockLogAudit = jest.fn();
const mockLogError = jest.fn();

const roleQuery: {
  select: jest.Mock;
  eq: jest.Mock;
  single: jest.Mock;
} = {
  select: jest.fn(() => roleQuery),
  eq: jest.fn(() => roleQuery),
  single: jest.fn(async () => ({ data: { role: 'admin' }, error: null })),
};

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: jest.fn(() => 'test-token'),
  createAuthedSupabaseClient: jest.fn(() => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: { id: ADMIN_ID } }, error: null })),
    },
  })),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: jest.fn(() => roleQuery),
  },
}));

jest.mock('@/lib/roles', () => ({
  isAdmin: jest.fn(() => true),
}));

jest.mock('@/lib/auth/managedUserProvisioning', () => ({
  createManagedPortalUser: (...args: unknown[]) => mockCreateManagedPortalUser(...args),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
}));

import { POST } from '@/app/api/admin/users/route';

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateManagedPortalUser.mockResolvedValue({
    ok: false,
    kind: 'profile',
    error: new Error('profile insert failed'),
    cleanupError: new Error('auth delete failed'),
  });
});

it('does not claim rollback succeeded when deleting the auth user failed', async () => {
  const response = await POST(new NextRequest('http://x/api/admin/users', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: 'client@example.test',
      password: 'safe-password',
      role: 'client',
      full_name: 'Клиент',
    }),
  }));
  if (!response) throw new Error('Admin create route returned no response');
  const body = await response.json();

  expect(response.status).toBe(500);
  expect(body.error).toMatch(/rollback could not be confirmed/i);
  expect(body.error).not.toMatch(/was rolled back/i);
});
