/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const TEMPLATE_ID = 'template-preset-list-1';
const BASE_ID = 'base-preset-list-1';
const PROJECT_ID = 'project-preset-list-1';
const USER_ID = '00000000-0000-4000-8000-000000000731';

let mockPortalDb: MockSupabaseClient = createMockSupabase();
let mockInstantlyDb: MockSupabaseClient = createMockSupabase();

const mockListAllCustomTags = jest.fn();
const mockListAllCustomTagMappings = jest.fn();

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
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockPortalDb, userId: USER_ID, role: 'specialist' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_options: unknown, handler: () => Promise<unknown>) => handler(),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

jest.mock('@/lib/instantly/accounts', () => ({
  listInstantlyAccounts: jest.fn(() => [
    { id: 'main', label: 'Основной Instantly', isDefault: true },
    { id: 'workspace-b', label: 'Команда B', isDefault: false },
  ]),
  resolveInstantlyAccountId: jest.fn((value?: string | null) =>
    typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'main',
  ),
}));

jest.mock('@/lib/instantly/client', () => ({
  listAllCustomTags: (...args: unknown[]) => mockListAllCustomTags(...args),
  listAllCustomTagMappings: (...args: unknown[]) => mockListAllCustomTagMappings(...args),
  createCampaign: jest.fn(),
  createLeads: jest.fn(),
  updateCampaign: jest.fn(),
}));

import { GET } from '@/app/api/tools/vertical-engine-v2/templates/[id]/launch/route';

function request(): NextRequest {
  return new Request(
    `http://x/api/tools/vertical-engine-v2/templates/${TEMPLATE_ID}/launch`,
    { headers: { authorization: 'Bearer test-token' } },
  ) as unknown as NextRequest;
}

function seed() {
  mockPortalDb = createMockSupabase({
    tables: {
      ve_templates: [{ id: TEMPLATE_ID, base_id: BASE_ID }],
      ve_bases: [{ id: BASE_ID, project_id: PROJECT_ID }],
      ve_projects: [{
        id: PROJECT_ID,
        launch_preset_id: 'preset-b',
        launch_instantly_account_id: 'workspace-b',
      }],
      profiles: [
        { id: 'client-a', full_name: 'Альфа' },
        { id: 'client-b', full_name: 'Бета' },
      ],
    },
  });
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_campaign_presets: [
        {
          id: 'preset-a',
          client_user_id: 'client-a',
          instantly_account_id: 'main',
          email_account_ids: ['sender-a1@example.test', 'sender-a2@example.test'],
        },
        {
          id: 'preset-b',
          client_user_id: 'client-b',
          instantly_account_id: 'workspace-b',
          email_account_ids: ['sender-b1@example.test', 'sender-b2@example.test'],
        },
      ],
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  mockListAllCustomTags.mockImplementation(async ({ accountId }: { accountId: string }) =>
    accountId === 'workspace-b'
      ? [{ id: 'tag-b', name: 'B2B Beta' }]
      : [{ id: 'tag-a', name: 'VBI' }],
  );
  mockListAllCustomTagMappings.mockImplementation(
    async (_resourceType: string, { accountId }: { accountId: string }) =>
      accountId === 'workspace-b'
        ? [
            { id: 'b1', tag_id: 'tag-b', resource_type: 'account', resource_id: 'sender-b1@example.test' },
            { id: 'b2', tag_id: 'tag-b', resource_type: 'account', resource_id: 'sender-b2@example.test' },
            { id: 'b3', tag_id: 'tag-b', resource_type: 'account', resource_id: 'extra-b@example.test' },
          ]
        : [
            { id: 'a1', tag_id: 'tag-a', resource_type: 'account', resource_id: 'sender-a1@example.test' },
            { id: 'a2', tag_id: 'tag-a', resource_type: 'account', resource_id: 'sender-a2@example.test' },
          ],
  );
});

describe('GET /api/tools/vertical-engine-v2/templates/[id]/launch', () => {
  it('returns client, workspace and mailbox tags without exposing mailbox addresses', async () => {
    const response = await GET(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({
      bound_preset_id: 'preset-b',
      presets: [
        {
          id: 'preset-a',
          name: 'Альфа',
          instantly_account_id: 'main',
          instantly_account_label: 'Основной Instantly',
          mailbox_count: 2,
          mailbox_tags: [{ id: 'tag-a', name: 'VBI' }],
          mailbox_tag_resolution: 'exact',
        },
        {
          id: 'preset-b',
          name: 'Бета',
          instantly_account_id: 'workspace-b',
          instantly_account_label: 'Команда B',
          mailbox_count: 2,
          mailbox_tags: [{ id: 'tag-b', name: 'B2B Beta' }],
          mailbox_tag_resolution: 'shared',
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/email_account_ids|@/i);
    expect(mockListAllCustomTags).toHaveBeenCalledTimes(2);
    expect(mockListAllCustomTags).toHaveBeenCalledWith({
      accountId: 'main',
      timeoutMs: 15_000,
      retryRateLimits: false,
    });
    expect(mockListAllCustomTags).toHaveBeenCalledWith({
      accountId: 'workspace-b',
      timeoutMs: 15_000,
      retryRateLimits: false,
    });
    expect(mockListAllCustomTagMappings).toHaveBeenCalledWith('account', {
      accountId: 'main',
      timeoutMs: 15_000,
      retryRateLimits: false,
    });
    expect(mockListAllCustomTagMappings).toHaveBeenCalledWith('account', {
      accountId: 'workspace-b',
      timeoutMs: 15_000,
      retryRateLimits: false,
    });
  });

  it('degrades only the unavailable workspace and never borrows tags from another one', async () => {
    mockListAllCustomTags.mockImplementation(async ({ accountId }: { accountId: string }) => {
      if (accountId === 'workspace-b') throw new Error('workspace unavailable');
      return [{ id: 'tag-a', name: 'VBI' }];
    });

    const response = await GET(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    const body = (await response.json()) as {
      presets: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.presets.find((preset) => preset.id === 'preset-a')).toEqual(
      expect.objectContaining({
        mailbox_tags: [{ id: 'tag-a', name: 'VBI' }],
        mailbox_tag_resolution: 'exact',
      }),
    );
    expect(body.presets.find((preset) => preset.id === 'preset-b')).toEqual(
      expect.objectContaining({ mailbox_tags: [], mailbox_tag_resolution: 'unavailable' }),
    );
  });
});
