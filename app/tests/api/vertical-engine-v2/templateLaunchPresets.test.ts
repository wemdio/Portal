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
const mockBuildPreview = jest.fn();
const mockRunLaunch = jest.fn();

jest.mock('@/lib/verticalEngineV2/contactDeliveryPreview', () => {
  const actual = jest.requireActual('@/lib/verticalEngineV2/contactDeliveryPreview');
  return { ...actual, buildVeContactDeliveryPreview: (...args: unknown[]) => mockBuildPreview(...args) };
});

jest.mock('@/lib/verticalEngineV2/launchTemplate', () => ({
  runVeTemplateLaunch: (...args: unknown[]) => mockRunLaunch(...args),
}));

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

import { GET, POST } from '@/app/api/tools/vertical-engine-v2/templates/[id]/launch/route';

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
  mockBuildPreview.mockImplementation((...args: unknown[]) =>
    jest.requireActual('@/lib/verticalEngineV2/contactDeliveryPreview').buildVeContactDeliveryPreview(...args));
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

describe('GET launch: plan bound to a Portal period', () => {
  // Привязка неизменяема: выбрать другой проект всё равно нельзя (ve_bind
  // откажет), поэтому форма фиксирует план периода и показывает причину.
  it('locks a plan whose period is no longer active and shows the reason', async () => {
    await mockPortalDb.from('ve_projects').update({
      portal_project_id: PORTAL_PROJECT_ID, portal_period_id: PORTAL_PERIOD_ID, target_contacts: 23,
    }).eq('id', PROJECT_ID);
    await mockPortalDb.from('project_periods').update({ status: 'closed' }).eq('id', PORTAL_PERIOD_ID);
    mockBuildPreview.mockResolvedValue({
      status: 409,
      body: { code: 'PORTAL_PERIOD_NOT_ACTIVE', error: 'Выбранный период больше не является активным периодом этого проекта' },
    });
    const response = await GET(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(mockBuildPreview).toHaveBeenCalledWith(mockPortalDb, mockInstantlyDb, expect.objectContaining({
      portalProjectId: PORTAL_PROJECT_ID, expectedPortalPeriodId: PORTAL_PERIOD_ID, targetContacts: 23,
    }));
    expect(result.delivery_plan).toBeNull();
    expect(result.delivery_plan_binding).toEqual({
      portal_project_id: PORTAL_PROJECT_ID, portal_period_id: PORTAL_PERIOD_ID, target_contacts: 23,
    });
    expect(result.delivery_plan_issue).toBe('Выбранный период больше не является активным периодом этого проекта');
  });

  it('keeps the recalculated plan of a still active period as before', async () => {
    await mockPortalDb.from('ve_projects').update({
      portal_project_id: PORTAL_PROJECT_ID, portal_period_id: PORTAL_PERIOD_ID, target_contacts: 23,
    }).eq('id', PROJECT_ID);
    const preview = { portal_project_id: PORTAL_PROJECT_ID, portal_period_id: PORTAL_PERIOD_ID, target_contacts: 23 };
    mockBuildPreview.mockResolvedValue({ status: 200, body: { preview } });
    const result = await (await GET(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) })).json();
    expect(result.delivery_plan).toEqual(preview);
    expect(result).not.toHaveProperty('delivery_plan_binding');
    expect(result).not.toHaveProperty('delivery_plan_issue');
  });
});

describe('GET/POST launch: Portal projects without periods', () => {
  const STAFF_LINE_ID = '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c';
  const ENAGENCY_ID = '00000000-0000-4000-8000-000000000751';
  const CLOSED_ID = '00000000-0000-4000-8000-000000000752';

  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] });
    jest.setSystemTime(new Date('2026-09-23T09:00:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  async function seedProjectsWithoutPeriods() {
    await mockPortalDb.from('projects').insert([
      {
        id: STAFF_LINE_ID, client: 'Staff Line', name: 'Аутрич', status: 'В работе',
        deadline: '2026-09-30', launch_date: '2026-08-30', contacts_obligation: '4000', contacts_done: '25905',
      },
      {
        id: ENAGENCY_ID, client: 'ENagency', name: 'Аутрич', status: 'В работе',
        deadline: null, launch_date: null, contacts_obligation: null, contacts_done: '6360',
      },
      {
        id: CLOSED_ID, client: 'Закрытый', name: 'Аутрич', status: 'Тестирование',
        deadline: '2026-12-01', launch_date: null, contacts_obligation: '8000-16000', contacts_done: '120',
      },
    ]);
    await mockPortalDb.from('project_periods').insert({
      id: '00000000-0000-4000-8000-000000000753', project_id: CLOSED_ID, name: 'Июль', status: 'closed',
      period_start: '2026-07-01', deadline: '2026-07-31', contacts_done: '5000',
    });
  }

  async function body() {
    const response = await GET(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);
    return response.json() as Promise<Record<string, unknown> & { portal_projects: Array<Record<string, unknown>> }>;
  }

  it('offers projects without an active period with their raw card term, keeping period projects unchanged', async () => {
    await seedProjectsWithoutPeriods();
    const { portal_projects: projects } = await body();
    expect(projects.find((project) => project.id === PORTAL_PROJECT_ID)).toEqual({
      id: PORTAL_PROJECT_ID,
      name: 'Клиент Портала',
      active_period: {
        id: PORTAL_PERIOD_ID, label: 'Сентябрь', starts_at: '2026-09-01', deadline: '2026-09-30', contacts_done_count: 17,
      },
    });
    expect(projects.find((project) => project.id === STAFF_LINE_ID)).toEqual({
      id: STAFF_LINE_ID,
      name: 'Staff Line',
      active_period: null,
      project_term: {
        deadline: '2026-09-30',
        starts_at: '2026-08-30',
        contacts_obligation: '4000',
        contacts_done_total: 25905,
        issue: null,
      },
    });
    expect(projects.find((project) => project.id === ENAGENCY_ID)).toMatchObject({
      active_period: null,
      project_term: {
        deadline: null,
        issue: 'В карточке проекта не заполнено поле «Дедлайн». Укажите дату в формате ГГГГ-ММ-ДД — темп рассчитается до неё.',
      },
    });
  });

  it('marks a project whose periods are all closed', async () => {
    await seedProjectsWithoutPeriods();
    const { portal_projects: projects } = await body();
    expect(projects.find((project) => project.id === CLOSED_ID)).toMatchObject({
      active_period: null,
      periods_closed: true,
      project_term: { issue: 'Все периоды проекта закрыты. Откройте новый период в карточке проекта.' },
    });
  });

  it('recalculates a plan bound without a period', async () => {
    await seedProjectsWithoutPeriods();
    await mockPortalDb.from('ve_projects').update({
      portal_project_id: STAFF_LINE_ID, portal_period_id: null, target_contacts: 4000,
    }).eq('id', PROJECT_ID);
    const preview = { portal_project_id: STAFF_LINE_ID, portal_period_id: null, target_contacts: 4000, deadline: '2026-09-30' };
    mockBuildPreview.mockResolvedValue({ status: 200, body: { preview } });
    const result = await body();
    expect(mockBuildPreview).toHaveBeenCalledWith(mockPortalDb, mockInstantlyDb, expect.objectContaining({
      portalProjectId: STAFF_LINE_ID, expectedPortalPeriodId: null, targetContacts: 4000, presetId: 'preset-b',
    }));
    expect(result.delivery_plan).toEqual(preview);
    expect(result).not.toHaveProperty('delivery_plan_binding');
  });

  it.each([
    {
      name: 'a term reason',
      code: 'PORTAL_PERIOD_CREATED_AFTER_LAUNCH',
      error: 'Проекту в Portal создан период. Загрузка новых контактов по этому плану остановлена: план рассчитан на проект без периодов. Уже загруженные контакты продолжают отправляться.',
      issue: true,
    },
    {
      name: 'a missing audit of this template',
      code: 'SEGMENTATION_AUDIT_REQUIRED',
      error: 'Перед расчётом нужен свежий завершённый аудит сегментации',
      issue: false,
    },
  ])('keeps the immutable binding when its plan fails with $name', async ({ code, error, issue }) => {
    await seedProjectsWithoutPeriods();
    await mockPortalDb.from('ve_projects').update({
      portal_project_id: STAFF_LINE_ID, portal_period_id: null, target_contacts: 4000,
    }).eq('id', PROJECT_ID);
    mockBuildPreview.mockResolvedValue({ status: 409, body: { code, error } });
    const result = await body();
    expect(result.delivery_plan).toBeNull();
    expect(result.delivery_plan_binding).toEqual({
      portal_project_id: STAFF_LINE_ID, portal_period_id: null, target_contacts: 4000,
    });
    expect(result.delivery_plan_issue).toBe(issue ? error : null);
  });

  function launchRequest(body: Record<string, unknown>) {
    return new Request(`http://x/api/tools/vertical-engine-v2/templates/${TEMPLATE_ID}/launch`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        preset_id: 'preset-b', segmentation_audit_id: 'audit-1', confirm_segmentation: true,
        portal_project_id: STAFF_LINE_ID, target_contacts: 4000, ...body,
      }),
    }) as unknown as NextRequest;
  }

  it('launches with an explicit NULL period and still requires the field', async () => {
    mockRunLaunch.mockResolvedValue({ status: 200, body: { ok: true } });
    const launched = await POST(launchRequest({ expected_portal_period_id: null }), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(launched.status).toBe(200);
    expect(mockRunLaunch).toHaveBeenCalledWith(expect.objectContaining({
      portalProjectId: STAFF_LINE_ID, expectedPortalPeriodId: null, targetContacts: 4000,
    }));

    mockRunLaunch.mockClear();
    const missing = await POST(launchRequest({}), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({
      error: 'Укажите проект Portal, его активный период (если у проекта есть периоды) и точную цель по контактам',
    });
    expect(mockRunLaunch).not.toHaveBeenCalled();
  });
});
