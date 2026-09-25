import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';
import type { VeOutreachSetupResponse } from '@/lib/verticalEngineV2/outreachSetup';
import { ContactUploadNotice } from '@/components/vertical-engine-v2/engine/ContactUploadNotice';
import { OutreachLaunchPanel } from '@/components/vertical-engine-v2/engine/OutreachLaunchPanel';

const mockVeEnginePost = jest.fn();
const mockVeEngineCall = jest.fn();
// Поля useTemplateLaunch, которые читает панель автоаутрича.
const mockLaunch: Record<string, unknown> = {};

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEngineCall: (...args: unknown[]) => mockVeEngineCall(...args),
  veEnginePost: (...args: unknown[]) => mockVeEnginePost(...args),
}));

jest.mock('@/components/vertical-engine-v2/engine/steps/Step5Template', () => ({
  useTemplateLaunch: () => mockLaunch,
  CreateClientPresetInline: () => null,
  DeliveryPlanBlock: () => null,
}));

// Staff Line · «Аутрич»: у проекта в Portal нет ни одного периода.
const STAFF_LINE_ID = '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c';
const PROJECT_ID = 've-project-1';

const template = {
  id: 'template-1',
  base_id: 'base-1',
  vertical_id: 'vertical-1',
  letters: [{ subject: 'Тема', body: 'Письмо', wait_days: 0 }],
  status: 'ready',
} as unknown as VeTemplate;

const snapshot: VeOutreachSetupResponse = {
  setup: {
    project_id: PROJECT_ID,
    selected_hypothesis_ids: ['hypothesis-1'],
    approved_bases: {
      'base-1': { template_id: 'template-1', revision: 'rev-1', approved_at: '2026-09-23T09:00:00.000Z', approved_by: 'staff-1' },
    },
    language: 'ru',
    revision: 3,
  },
  preparations: [{
    project_id: PROJECT_ID, hypothesis_id: 'hypothesis-1', base_id: 'base-1', template_id: 'template-1',
    status: 'ready', language: 'ru', last_error: null,
  }],
  reviews: { 'base-1': { template_id: 'template-1', revision: 'rev-1' } },
};

const PREPARE_URL = `/api/tools/vertical-engine-v2/projects/${PROJECT_ID}/outreach/prepare-launch`;
const START_URL = `/api/tools/vertical-engine-v2/projects/${PROJECT_ID}/outreach/start`;

function renderPanel(expectedPortalPeriodId: string | null | undefined) {
  Object.assign(mockLaunch, {
    presetId: 'preset-1',
    portalProjectId: STAFF_LINE_ID,
    expectedPortalPeriodId,
    targetContacts: 4000,
    presets: [{ id: 'preset-1', name: 'Staff Line', instantly_account_label: 'Основной', mailbox_tags: [], mailbox_count: 3 }],
    boundPresetId: null,
    canCreateClient: false,
    loadError: null,
    openForm: jest.fn(),
    setPresetId: jest.fn(),
  });
  const onStarted = jest.fn();
  render(
    <OutreachLaunchPanel
      projectId={PROJECT_ID}
      snapshot={snapshot}
      templates={[template]}
      titles={{ 'hypothesis-1': 'Кадровые агентства' }}
      onStarted={onStarted}
      onPresetChange={jest.fn()}
    />,
  );
  return { onStarted };
}

describe('VE2 auto-outreach launch panel', () => {
  beforeAll(() => {
    // jsdom не даёт crypto.randomUUID; панель берёт из него ключ идемпотентности.
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => 'idempotency-1', configurable: true });
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(mockLaunch)) delete mockLaunch[key];
    mockVeEnginePost.mockImplementation(async (url: string) => {
      if (url === PREPARE_URL) {
        return {
          ok: true,
          data: {
            ready: true,
            items: [{
              hypothesis_id: 'hypothesis-1', base_id: 'base-1', template_id: 'template-1', preview_revision: 'rev-1',
              segmentation_audit_id: 'audit-1', status: 'ready',
            }],
          },
        };
      }
      return { ok: true, data: { run: { id: 'run-1' } } };
    });
  });

  it('launches a Portal project without periods with an explicit null period', async () => {
    const { onStarted } = renderPanel(null);
    const expected = {
      preset_id: 'preset-1',
      portal_project_id: STAFF_LINE_ID,
      expected_portal_period_id: null,
      target_contacts: 4000,
    };
    await waitFor(() => expect(mockVeEnginePost).toHaveBeenCalledWith(PREPARE_URL, expect.objectContaining(expected)));
    expect(mockVeEnginePost.mock.calls[0][1]).toHaveProperty('expected_portal_period_id', null);

    const approval = await screen.findByRole('checkbox');
    await waitFor(() => expect(approval).toBeEnabled());
    await userEvent.click(approval);
    await userEvent.click(screen.getByRole('button', { name: 'Запустить аутрич' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ id: 'run-1' }));
    const startBody = mockVeEnginePost.mock.calls.find(([url]) => url === START_URL)?.[1];
    expect(startBody).toMatchObject({ ...expected, confirmed_customer_approval: true, items: [expect.objectContaining({ segmentation_audit_id: 'audit-1' })] });
    expect(startBody).toHaveProperty('expected_portal_period_id', null);
  });

  it('keeps the active period of a project that has one', async () => {
    renderPanel('period-1');
    await waitFor(() => expect(mockVeEnginePost).toHaveBeenCalledWith(
      PREPARE_URL,
      expect.objectContaining({ portal_project_id: STAFF_LINE_ID, expected_portal_period_id: 'period-1' }),
    ));
  });

  it('builds no request while the project cannot be chosen', async () => {
    renderPanel(undefined);
    expect(await screen.findByText('Одобрите все выбранные базы, выберите клиента, проект и цель за период.')).toBeInTheDocument();
    expect(mockVeEnginePost).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Запустить аутрич' })).toBeDisabled();
  });
});


describe('VE2 contact upload capacity notice', () => {
  const blocked = { run_id: 'run-1', blocked_at: '2026-09-24T07:00:00.123456Z',
    run_date: '2026-09-24', accepted: 12, pending: 5, uncertain: 2 };
  beforeEach(() => {
    jest.clearAllMocks();
    mockVeEngineCall.mockResolvedValue({ ok: true, data: { blocked } });
  });

  it('shows the reason, preserves unknown contacts and disables duplicate retry while pending', async () => {
    let resolve!: (value: unknown) => void;
    mockVeEnginePost.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<ContactUploadNotice templateId="template-1" />);
    const button = await screen.findByRole('button', { name: 'Дозалить контакты проекта' });
    expect(screen.getByText('Нет места для контактов в Instantly')).toBeInTheDocument();
    expect(screen.getByText(/Результат для 2 контактов не подтверждён/)).toBeInTheDocument();
    await userEvent.click(button);
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(mockVeEnginePost).toHaveBeenCalledTimes(1);
    expect(mockVeEnginePost).toHaveBeenCalledWith('/api/tools/vertical-engine-v2/templates/template-1/upload', {
      action: 'retry', run_id: blocked.run_id, blocked_at: blocked.blocked_at,
    });
    await act(async () => { resolve({ ok: true, data: { ok: true, queued: true } }); });
    expect(await screen.findByText(/Дозаливка запрошена/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Дозалить контакты проекта' })).not.toBeInTheDocument();
  });

  it('keeps the retry available and displays server refusal instead of claiming success', async () => {
    mockVeEnginePost.mockResolvedValue({ ok: false, data: { error: 'Срок проекта завершён' } });
    render(<ContactUploadNotice templateId="template-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Дозалить контакты проекта' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Срок проекта завершён');
    expect(screen.getByRole('button', { name: 'Дозалить контакты проекта' })).toBeEnabled();
    expect(screen.queryByText(/Дозаливка запрошена/)).not.toBeInTheDocument();
  });
});
