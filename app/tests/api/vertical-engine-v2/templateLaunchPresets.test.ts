/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const TEMPLATE_ID = 'template-preset-list-1';
const BASE_ID = 'base-preset-list-1';
const PROJECT_ID = 'project-preset-list-1';
const PORTAL_PROJECT_ID = '00000000-0000-4000-8000-000000000741';
const PORTAL_PERIOD_ID = '00000000-0000-4000-8000-000000000742';
const USER_ID = '00000000-0000-4000-8000-000000000731';

let mockPortalDb: MockSupabaseClient = createMockSupabase();
let mockInstantlyDb: MockSupabaseClient = createMockSupabase();

const mockListCustomTags = jest.fn();
const mockListCustomTagMappings = jest.fn();

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
    auth: { supabase: mockPortalDb, userId: USER_ID, role: 'technician' },
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
    { id: 'workspace-c', label: 'Команда C', isDefault: false },
  ]),
  resolveInstantlyAccountId: jest.fn((value?: string | null) =>
    typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'main',
  ),
}));

jest.mock('@/lib/instantly/client', () => ({
  listCustomTags: (...args: unknown[]) => mockListCustomTags(...args),
  listCustomTagMappings: (...args: unknown[]) => mockListCustomTagMappings(...args),
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
      projects: [{
        id: PORTAL_PROJECT_ID,
        client: 'Клиент Портала',
        name: 'Аутрич',
        status: 'В работе',
      }],
      project_periods: [{
        id: PORTAL_PERIOD_ID,
        project_id: PORTAL_PROJECT_ID,
        name: 'Сентябрь',
        status: 'active',
        period_start: '2026-09-01',
        deadline: '2026-09-30',
        contacts_done: '17',
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

function tagsForWorkspace(accountId: string) {
  return accountId === 'workspace-b'
    ? [{ id: 'tag-b', name: 'B2B Beta' }]
    : accountId === 'workspace-c'
      ? [{ id: 'tag-c', name: 'Gamma' }]
      : [{ id: 'tag-a', name: 'VBI' }];
}

function mappingsForWorkspace(accountId: string) {
  return accountId === 'workspace-b'
    ? [
        { id: 'b1', tag_id: 'tag-b', resource_type: 'account', resource_id: 'sender-b1@example.test' },
        { id: 'b2', tag_id: 'tag-b', resource_type: 'account', resource_id: 'sender-b2@example.test' },
        { id: 'b3', tag_id: 'tag-b', resource_type: 'account', resource_id: 'extra-b@example.test' },
      ]
    : accountId === 'workspace-c'
      ? [
          { id: 'c1', tag_id: 'tag-c', resource_type: 'account', resource_id: 'sender-c1@example.test' },
        ]
      : [
          { id: 'a1', tag_id: 'tag-a', resource_type: 'account', resource_id: 'sender-a1@example.test' },
          { id: 'a2', tag_id: 'tag-a', resource_type: 'account', resource_id: 'sender-a2@example.test' },
        ];
}

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  mockListCustomTags.mockImplementation(
    async (
      _params: { starting_after?: string; limit?: number },
      requestOptions: { accountId: string },
    ) => ({
      items: tagsForWorkspace(requestOptions.accountId),
      next_starting_after: null,
    }),
  );
  mockListCustomTagMappings.mockImplementation(
    async (
      _params: { starting_after?: string; limit?: number; resource_type?: string },
      requestOptions: { accountId: string },
    ) => ({
      items: mappingsForWorkspace(requestOptions.accountId),
      next_starting_after: null,
    }),
  );
});

describe('GET /api/tools/vertical-engine-v2/templates/[id]/launch', () => {
  it('returns client, workspace and mailbox tags without exposing mailbox addresses', async () => {
    const response = await GET(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({
      bound_preset_id: 'preset-b',
      can_create_client: true,
      mailbox_tag_options: [
        {
          id: 'tag-b',
          name: 'B2B Beta',
          instantly_account_id: 'workspace-b',
          instantly_account_label: 'Команда B',
          mailbox_count: 3,
        },
        {
          id: 'tag-c',
          name: 'Gamma',
          instantly_account_id: 'workspace-c',
          instantly_account_label: 'Команда C',
          mailbox_count: 1,
        },
        {
          id: 'tag-a',
          name: 'VBI',
          instantly_account_id: 'main',
          instantly_account_label: 'Основной Instantly',
          mailbox_count: 2,
        },
      ],
      delivery_plan: null,
      portal_projects: [{
        id: PORTAL_PROJECT_ID,
        name: 'Клиент Портала',
        active_period: {
          id: PORTAL_PERIOD_ID,
          label: 'Сентябрь',
          starts_at: '2026-09-01',
          deadline: '2026-09-30',
          contacts_done_count: 17,
        },
      }],
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
    expect(mockListCustomTags).toHaveBeenCalledTimes(3);
    expect(mockListCustomTagMappings).toHaveBeenCalledTimes(3);
    for (const accountId of ['main', 'workspace-b', 'workspace-c']) {
      expect(mockListCustomTags).toHaveBeenCalledWith(
        { limit: 100 },
        { accountId, timeoutMs: 15_000, retryRateLimits: false },
      );
      expect(mockListCustomTagMappings).toHaveBeenCalledWith(
        { limit: 100, resource_type: 'account' },
        { accountId, timeoutMs: 15_000, retryRateLimits: false },
      );
    }
  });

  it('degrades only the unavailable workspace and never borrows tags from another one', async () => {
    mockListCustomTags.mockImplementation(async (
      _params: unknown,
      { accountId }: { accountId: string },
    ) => {
      if (accountId === 'workspace-b') throw new Error('workspace unavailable');
      return { items: tagsForWorkspace(accountId), next_starting_after: null };
    });

    const response = await GET(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    const body = (await response.json()) as {
      presets: Array<Record<string, unknown>>;
      mailbox_tag_options: Array<Record<string, unknown>>;
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
    expect(body.mailbox_tag_options).toEqual([
      expect.objectContaining({ id: 'tag-c', instantly_account_id: 'workspace-c' }),
      expect.objectContaining({ id: 'tag-a', instantly_account_id: 'main' }),
    ]);
  });

  it('keeps live tags selectable when display mappings are unavailable or empty', async () => {
    mockListCustomTagMappings.mockImplementation(
      async (_params: unknown, { accountId }: { accountId: string }) => {
        if (accountId === 'workspace-c') throw new Error('mapping index unavailable');
        const items = accountId === 'workspace-b'
          ? [
              { id: 'b1', tag_id: 'tag-b', resource_type: 'account', resource_id: 'sender-b1@example.test' },
              { id: 'b2', tag_id: 'tag-b', resource_type: 'account', resource_id: 'sender-b2@example.test' },
            ]
          : [];
        return { items, next_starting_after: null };
      },
    );

    const response = await GET(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    const body = (await response.json()) as {
      mailbox_tag_options: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.mailbox_tag_options).toContainEqual({
      id: 'tag-c',
      name: 'Gamma',
      instantly_account_id: 'workspace-c',
      instantly_account_label: 'Команда C',
      mailbox_count: null,
    });
    expect(body.mailbox_tag_options).toContainEqual({
      id: 'tag-a',
      name: 'VBI',
      instantly_account_id: 'main',
      instantly_account_label: 'Основной Instantly',
      mailbox_count: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/email_account_ids|@/i);
  });

  it('degrades only the workspace whose mapping cursor repeats', async () => {
    mockListCustomTagMappings.mockImplementation(
      async (
        params: { starting_after?: string },
        { accountId }: { accountId: string },
      ) => {
        if (accountId !== 'workspace-b') {
          return {
            items: mappingsForWorkspace(accountId),
            next_starting_after: null,
          };
        }
        return {
          items: params.starting_after
            ? []
            : [{
                id: 'b1',
                tag_id: 'tag-b',
                resource_type: 'account',
                resource_id: 'sender-b1@example.test',
              }],
          next_starting_after: 'repeated-mapping-cursor',
        };
      },
    );

    const response = await GET(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    const body = (await response.json()) as {
      presets: Array<Record<string, unknown>>;
      mailbox_tag_options: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(mockListCustomTagMappings).toHaveBeenCalledTimes(4);
    expect(body.presets.find((preset) => preset.id === 'preset-a')).toEqual(
      expect.objectContaining({ mailbox_tag_resolution: 'exact' }),
    );
    expect(body.presets.find((preset) => preset.id === 'preset-b')).toEqual(
      expect.objectContaining({ mailbox_tags: [], mailbox_tag_resolution: 'unavailable' }),
    );
    expect(body.mailbox_tag_options).toContainEqual(
      expect.objectContaining({
        id: 'tag-b',
        instantly_account_id: 'workspace-b',
        mailbox_count: null,
      }),
    );
    expect(body.mailbox_tag_options).toContainEqual(
      expect.objectContaining({
        id: 'tag-a',
        instantly_account_id: 'main',
        mailbox_count: 2,
      }),
    );
  });
});
