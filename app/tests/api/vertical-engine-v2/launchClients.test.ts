/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const TECHNICIAN_ID = '00000000-0000-4000-8000-000000000801';
const CLIENT_ID = '00000000-0000-4000-8000-000000000802';
const TEMPLATE_ID = 'template-client-onboarding-1';
const BASE_ID = 'base-client-onboarding-1';
const PROJECT_ID = 'project-client-onboarding-1';
const PROJECT_NAME = 'Альфа Логистика';
const LOGIN_EMAIL = 'client.owner@example.test';
const PASSWORD = 'Dont-log-this-123!';
const WORKSPACE_ID = 'workspace-b';
const WORKSPACE_LABEL = 'Команда B';
const TAG_ID = 'tag-client-alpha';
const TAG_NAME = 'Alpha senders';
const MAILBOXES = ['sender.one@example.test', 'sender.two@example.test'];

type PortalDb = MockSupabaseClient & {
  auth: {
    admin: {
      createUser: jest.Mock;
      deleteUser: jest.Mock;
    };
  };
};

let mockPortalDb: PortalDb;
let mockInstantlyDb: MockSupabaseClient;
let mockActorRole = 'technician';

const mockCreateUser = jest.fn();
const mockDeleteUser = jest.fn();
const mockRequireInternalToolAuth = jest.fn();
const mockListCustomTags = jest.fn();
const mockListAccounts = jest.fn();
const mockLogAudit = jest.fn();
const mockLogError = jest.fn();
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockPortalDb;
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: (...args: unknown[]) => mockRequireInternalToolAuth(...args),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_options: unknown, handler: () => Promise<unknown>) => handler(),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
  logInfo: (...args: unknown[]) => mockLogInfo(...args),
  logWarn: (...args: unknown[]) => mockLogWarn(...args),
}));

jest.mock('@/lib/instantly/accounts', () => ({
  listInstantlyAccounts: jest.fn(() => [
    { id: 'main', label: 'Основной Instantly', isDefault: true },
    { id: WORKSPACE_ID, label: WORKSPACE_LABEL, isDefault: false },
  ]),
  resolveInstantlyAccountId: jest.fn((value?: string | null) =>
    typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'main',
  ),
}));

jest.mock('@/lib/instantly/client', () => ({
  listCustomTags: (...args: unknown[]) => mockListCustomTags(...args),
  listAccounts: (...args: unknown[]) => mockListAccounts(...args),
}));

import { POST } from '@/app/api/tools/vertical-engine-v2/launch-clients/route';

interface SeedOptions {
  role?: string;
  duplicateUser?: boolean;
  profileFailure?: boolean;
  presetFailure?: boolean;
}

function seed(options: SeedOptions = {}) {
  mockActorRole = options.role ?? 'technician';
  const profileError = { code: 'XX000', message: 'profile write failed' };
  const presetError = { code: 'XX000', message: 'preset write failed' };

  mockCreateUser.mockResolvedValue(
    options.duplicateUser
      ? {
          data: { user: null },
          error: { code: 'user_exists', message: 'User already registered', status: 422 },
        }
      : {
          data: { user: { id: CLIENT_ID, email: LOGIN_EMAIL } },
          error: null,
        },
  );
  mockDeleteUser.mockResolvedValue({ data: { user: {} }, error: null });

  mockPortalDb = Object.assign(
    createMockSupabase({
      tables: {
        ve_templates: [{ id: TEMPLATE_ID, base_id: BASE_ID }],
        ve_bases: [{ id: BASE_ID, project_id: PROJECT_ID }],
        ve_projects: [{ id: PROJECT_ID, name: PROJECT_NAME }],
        profiles: [],
      },
      errorInserts: options.profileFailure ? { profiles: profileError } : undefined,
      errorUpserts: options.profileFailure ? { profiles: profileError } : undefined,
    }),
    { auth: { admin: { createUser: mockCreateUser, deleteUser: mockDeleteUser } } },
  );

  mockInstantlyDb = createMockSupabase({
    tables: { client_campaign_presets: [] },
    errorInserts: options.presetFailure
      ? { client_campaign_presets: presetError }
      : undefined,
    errorUpserts: options.presetFailure
      ? { client_campaign_presets: presetError }
      : undefined,
  });

  mockRequireInternalToolAuth.mockImplementation(async () => ({
    auth: {
      supabase: mockPortalDb,
      userId: TECHNICIAN_ID,
      role: mockActorRole,
    },
  }));
  mockListCustomTags.mockImplementation(
    async (
      params: { starting_after?: string; limit?: number },
      { accountId }: { accountId: string },
    ) => {
      if (accountId !== WORKSPACE_ID) throw new Error(`unexpected workspace ${accountId}`);
      if (params.limit !== 100) throw new Error(`unexpected tag page size ${params.limit}`);
      if (params.starting_after) throw new Error(`unexpected tag cursor ${params.starting_after}`);
      return {
        items: [
          { id: TAG_ID, name: TAG_NAME },
          { id: 'tag-other', name: 'Other pool' },
        ],
        next_starting_after: null,
      };
    },
  );
  mockListAccounts.mockImplementation(
    async (
      params: { tag_ids?: string; starting_after?: string; limit?: number },
      { accountId }: { accountId: string },
    ) => {
      if (accountId !== WORKSPACE_ID) throw new Error(`unexpected workspace ${accountId}`);
      if (params.tag_ids !== TAG_ID || params.limit !== 100) {
        throw new Error(`unexpected account filter ${JSON.stringify(params)}`);
      }
      if (!params.starting_after) {
        return {
          items: [
            { email: ' Sender.One@Example.test ' },
            { email: 'sender.one@example.test' },
          ],
          next_starting_after: 'mailbox-page-2',
        };
      }
      if (params.starting_after === 'mailbox-page-2') {
        return {
          items: [{ email: 'Sender.Two@Example.test' }],
          next_starting_after: null,
        };
      }
      throw new Error(`unexpected cursor ${params.starting_after}`);
    },
  );
}

function request(): NextRequest {
  return new Request('http://x/api/tools/vertical-engine-v2/launch-clients', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      template_id: TEMPLATE_ID,
      email: ` ${LOGIN_EMAIL.toUpperCase()} `,
      password: PASSWORD,
      // Client-controlled role/name must never override the VE2 project or
      // elevate the account created by this specialist-only route.
      role: 'admin',
      full_name: 'Подменённое имя',
      instantly_account_id: ` ${WORKSPACE_ID.toUpperCase()} `,
      mailbox_tag_id: TAG_ID,
    }),
  }) as unknown as NextRequest;
}

function allLogCalls(): unknown[] {
  return [
    ...mockLogAudit.mock.calls,
    ...mockLogError.mock.calls,
    ...mockLogInfo.mock.calls,
    ...mockLogWarn.mock.calls,
  ];
}

function expectNoSecretLeak(value: unknown) {
  const serialized = JSON.stringify(value).toLowerCase();
  expect(serialized).not.toContain(PASSWORD.toLowerCase());
  for (const mailbox of MAILBOXES) expect(serialized).not.toContain(mailbox);
}

beforeEach(() => {
  jest.clearAllMocks();
  seed();
});

describe('POST /api/tools/vertical-engine-v2/launch-clients', () => {
  it('creates a forced client profile and an exact preset from the live workspace tag', async () => {
    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockCreateUser).toHaveBeenCalledWith(expect.objectContaining({
      email: LOGIN_EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: expect.objectContaining({
        full_name: PROJECT_NAME,
        role: 'client',
      }),
    }));
    expect(mockPortalDb.getRows('profiles')).toEqual([
      expect.objectContaining({
        id: CLIENT_ID,
        email: LOGIN_EMAIL,
        full_name: PROJECT_NAME,
        role: 'client',
      }),
    ]);
    expect(mockInstantlyDb.getRows('client_campaign_presets')).toEqual([
      expect.objectContaining({
        client_user_id: CLIENT_ID,
        created_by: TECHNICIAN_ID,
        instantly_account_id: WORKSPACE_ID,
        email_account_ids: MAILBOXES,
      }),
    ]);
    expect(mockListCustomTags).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
      expect.objectContaining({ accountId: WORKSPACE_ID }),
    );
    expect(mockListAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ tag_ids: TAG_ID, limit: 100 }),
      expect.objectContaining({ accountId: WORKSPACE_ID }),
    );
    expect(body).toEqual({
      ok: true,
      client: { id: CLIENT_ID, email: LOGIN_EMAIL },
      preset: {
        id: expect.any(String),
        name: PROJECT_NAME,
        instantly_account_id: WORKSPACE_ID,
        instantly_account_label: WORKSPACE_LABEL,
        mailbox_count: 2,
        mailbox_tags: [{ id: TAG_ID, name: TAG_NAME }],
        mailbox_tag_resolution: 'exact',
      },
    });
    expectNoSecretLeak(body);
    expectNoSecretLeak(allLogCalls());
  });

  it('rejects a non-technician/non-admin role before any side effect', async () => {
    seed({ role: 'manager' });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockPortalDb.mutations).toHaveLength(0);
    expect(mockInstantlyDb.mutations).toHaveLength(0);
    expect(mockListCustomTags).not.toHaveBeenCalled();
    expect(mockListAccounts).not.toHaveBeenCalled();
  });

  it('returns 409 for an existing login without creating a preset or deleting that user', async () => {
    seed({ duplicateUser: true });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockPortalDb.getRows('profiles')).toHaveLength(0);
    expect(mockInstantlyDb.getRows('client_campaign_presets')).toHaveLength(0);
    expectNoSecretLeak(body);
    expectNoSecretLeak(allLogCalls());
  });

  it('fails before user creation when the live tag exceeds the default mailbox limit', async () => {
    mockListAccounts.mockResolvedValue({
      items: Array.from({ length: 17 }, (_, index) => ({
        email: `sender-${index + 1}@example.test`,
      })),
      // The route must stop as soon as the 17th unique mailbox proves the
      // preset cannot fit, instead of spending another external page read.
      next_starting_after: 'must-not-be-read',
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/лимит.*16/i);
    expect(mockListAccounts).toHaveBeenCalledTimes(1);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockInstantlyDb.getRows('client_campaign_presets')).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain('sender-1@example.test');
  });

  it('fails closed when Instantly repeats an accounts pagination cursor', async () => {
    mockListAccounts
      .mockResolvedValueOnce({
        items: [{ email: 'sender-three@example.test' }],
        next_starting_after: 'repeated-cursor',
      })
      .mockResolvedValueOnce({
        items: [],
        next_starting_after: 'repeated-cursor',
      });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(mockListAccounts).toHaveBeenCalledTimes(2);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockInstantlyDb.getRows('client_campaign_presets')).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain('sender-three@example.test');
    expectNoSecretLeak(allLogCalls());
  });

  it('fails closed when Instantly repeats a custom-tags pagination cursor', async () => {
    mockListCustomTags
      .mockResolvedValueOnce({
        items: [{ id: 'tag-before-target', name: 'Before target' }],
        next_starting_after: 'repeated-tag-cursor',
      })
      .mockResolvedValueOnce({
        items: [{ id: TAG_ID, name: TAG_NAME }],
        next_starting_after: 'repeated-tag-cursor',
      });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(mockListCustomTags).toHaveBeenCalledTimes(2);
    expect(mockListAccounts).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockInstantlyDb.getRows('client_campaign_presets')).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain(TAG_NAME);
    expectNoSecretLeak(allLogCalls());
  });

  it('fails closed when Instantly returns a malformed custom-tag item', async () => {
    mockListCustomTags.mockResolvedValue({
      items: [{ id: TAG_ID, name: 42 }],
      next_starting_after: null,
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(mockListCustomTags).toHaveBeenCalledTimes(1);
    expect(mockListAccounts).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockInstantlyDb.getRows('client_campaign_presets')).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain('42');
    expectNoSecretLeak(allLogCalls());
  });

  it('deletes the newly created auth user when profile or preset persistence fails', async () => {
    for (const failure of ['profile', 'preset'] as const) {
      jest.clearAllMocks();
      seed({
        profileFailure: failure === 'profile',
        presetFailure: failure === 'preset',
      });

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(mockCreateUser).toHaveBeenCalledTimes(1);
      expect(mockDeleteUser).toHaveBeenCalledTimes(1);
      expect(mockDeleteUser).toHaveBeenCalledWith(CLIENT_ID);
      expect(mockInstantlyDb.getRows('client_campaign_presets')).toHaveLength(0);
      expectNoSecretLeak(body);
      expectNoSecretLeak(allLogCalls());
    }
  });
});
