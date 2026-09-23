import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';
import { Step5Template, useTemplateLaunch } from '@/components/vertical-engine-v2/engine/steps/Step5Template';

const mockVeEngineCall = jest.fn();
const mockVeEnginePost = jest.fn();
const mockStartAudit = jest.fn();
const mockAuthFetch = jest.fn();
const mockDownloadBaseCsvResponse = jest.fn();
const mockPreviewDeliveryPlan = jest.fn();

jest.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

jest.mock('@/lib/verticalEngineV2/baseCsv', () => ({
  downloadBaseCsvResponse: (...args: unknown[]) => mockDownloadBaseCsvResponse(...args),
}));

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEngineCall: (...args: unknown[]) => mockVeEngineCall(...args),
  veEnginePost: (...args: unknown[]) => mockVeEnginePost(...args),
  vePreviewDeliveryPlan: (...args: unknown[]) => mockPreviewDeliveryPlan(...args),
}));

jest.mock('@/components/vertical-engine-v2/engine/steps/SegmentationAuditPanel', () => ({
  SegmentationAuditPanel: () => <div>Сегментация проверена</div>,
  useSegmentationAudit: () => ({
    templateId: 'template-1',
    phase: 'ready',
    audit: null,
    error: null,
    start: mockStartAudit,
    refresh: jest.fn(),
    markRejected: jest.fn(),
    resolveLaunch: jest.fn(),
    resolving: false,
    resolutionError: null,
    canLaunch: true,
    auditId: 'audit-1',
    summary: {
      status: 'complete',
      totalBaseRows: 10,
      launchableRows: 10,
      unclassifiedCount: 0,
      excluded: {
        lowRelevance: 0,
        relevanceUnchecked: 0,
        invalidEmailStatus: 0,
        invalidEmail: 0,
        duplicateEmail: 0,
      },
      segments: [],
      defaultGroup: { count: 10, sharePct: 100, examples: [] },
    },
    launchInfo: null,
  }),
}));

const template: VeTemplate = {
  id: 'template-1',
  base_id: 'base-1',
  vertical_id: 'vertical-1',
  fixed_block: 'Короткое предложение',
  personalization_plan: { letters: [], additions: [], operator_mapping: [] },
  letters: [{ subject: 'Тема', body: 'Текст письма', wait_days: 0 }],
  status: 'ready',
  tokens_used: 0,
  cost_usd: 0,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
};

describe('Vertical Engine v2 Step 5 client onboarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthFetch.mockResolvedValue({ ok: true });
    mockDownloadBaseCsvResponse.mockResolvedValue(undefined);
    mockVeEngineCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        presets: [],
        bound_preset_id: null,
        can_create_client: true,
        mailbox_tag_options: [
          {
            id: 'tag-vbi',
            name: 'VBI',
            instantly_account_id: 'workspace-main',
            instantly_account_label: 'Основной Instantly',
            mailbox_count: null,
            mailbox_ids: ['sender-one@secret.test', 'sender-two@secret.test'],
          },
        ],
      },
    });
    mockVeEnginePost.mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        ok: true,
        client: { id: 'client-1', email: 'client@example.test' },
        preset: {
          id: 'preset-1',
          name: 'VBI Новый клиент',
          instantly_account_id: 'workspace-main',
          instantly_account_label: 'Основной Instantly',
          mailbox_count: 2,
          mailbox_tags: [{ id: 'tag-vbi', name: 'VBI' }],
          mailbox_tag_resolution: 'exact',
          mailbox_ids: ['sender-one@secret.test', 'sender-two@secret.test'],
        },
      },
    });
  });

  it('creates a client preset from a workspace tag without exposing sender addresses', async () => {
    const user = userEvent.setup();
    render(
      <Step5Template
        template={template}
        base={{
          id: 'base-1',
          vertical_id: 'vertical-1',
          hypothesis_id: null,
          filename: 'base.csv',
          row_count: 10,
          columns: ['email'],
          sample_rows: [],
          analysis: null,
          created_at: '2026-09-01T00:00:00.000Z',
          status: 'analyzed',
        }}
        jobs={[]}
        onBuildTemplate={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Скачать CSV для запуска' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /исходный CSV/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Проверить перед запуском' }));
    const createAction = await screen.findByRole('button', { name: 'Создать клиентский кабинет' });
    expect(screen.queryByRole('button', { name: 'Скачать CSV для запуска' })).not.toBeInTheDocument();
    expect(screen.queryByText(/sender-(one|two)@secret\.test/)).not.toBeInTheDocument();
    expect(createAction).toBeEnabled();

    await user.click(createAction);
    await user.type(screen.getByLabelText('Почта для входа'), 'client@example.test');
    await user.type(screen.getByLabelText('Пароль для входа'), 'safe-password');
    await user.selectOptions(
      screen.getByLabelText('Тег почт в Instantly'),
      JSON.stringify(['workspace-main', 'tag-vbi']),
    );
    expect(
      screen.getByRole('option', { name: 'Основной Instantly · VBI · будет проверено при создании' }),
    ).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Создать клиентский кабинет' }));

    await waitFor(() => {
      expect(mockVeEnginePost).toHaveBeenCalledWith('/api/tools/vertical-engine-v2/launch-clients', {
        template_id: 'template-1',
        email: 'client@example.test',
        password: 'safe-password',
        instantly_account_id: 'workspace-main',
        mailbox_tag_id: 'tag-vbi',
      });
    });

    const presetSelect = await screen.findByLabelText('Настройки отправки');
    expect(presetSelect).toHaveValue('preset-1');
    expect((screen.getByRole('option', { name: 'VBI Новый клиент' }) as HTMLOptionElement).selected).toBe(true);
    expect(screen.getByText('Основной Instantly')).toBeInTheDocument();
    expect(screen.getByText('VBI')).toBeInTheDocument();
    expect(screen.queryByText(/sender-(one|two)@secret\.test/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Скачать CSV для запуска' }));
    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/tools/vertical-engine-v2/bases/base-1/export?mode=launch-ready&template_id=template-1&segmentation_audit_id=audit-1&preset_id=preset-1',
      );
    });
  });
});

describe('Vertical Engine v2 Step 5 launch plan for Portal projects without periods', () => {
  const STAFF_LINE_ID = '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c';
  const PERIOD_PROJECT_ID = '00000000-0000-4000-8000-000000000741';
  const PERIOD_ID = '00000000-0000-4000-8000-000000000742';
  const CLOSED_ID = '00000000-0000-4000-8000-000000000752';
  const ENAGENCY_ID = '00000000-0000-4000-8000-000000000751';
  const preset = {
    id: 'preset-1', name: 'Staff Line', instantly_account_id: 'main', instantly_account_label: 'Основной Instantly',
    mailbox_count: 2, mailbox_tags: [{ id: 'tag-1', name: 'SL' }], mailbox_tag_resolution: 'exact',
  };
  const projects = [
    {
      id: PERIOD_PROJECT_ID, name: 'Клиент Портала',
      active_period: { id: PERIOD_ID, label: 'Сентябрь', starts_at: '2026-09-01', deadline: '2026-09-30', contacts_done_count: 17 },
    },
    {
      id: STAFF_LINE_ID, name: 'Staff Line', active_period: null,
      project_term: { deadline: '2026-09-30', starts_at: '2026-08-30', contacts_obligation: '4000', contacts_done_total: 25905, issue: null },
    },
    {
      id: CLOSED_ID, name: 'Закрытый', active_period: null, periods_closed: true,
      project_term: {
        deadline: '2026-12-01', starts_at: null, contacts_obligation: '8000-16000', contacts_done_total: 120,
        issue: 'Все периоды проекта закрыты. Откройте новый период в карточке проекта.',
      },
    },
    {
      id: ENAGENCY_ID, name: 'ENagency', active_period: null,
      project_term: {
        deadline: null, starts_at: null, contacts_obligation: null, contacts_done_total: 6360,
        issue: 'В карточке проекта не заполнено поле «Дедлайн». Укажите дату в формате ГГГГ-ММ-ДД — темп рассчитается до неё.',
      },
    },
  ];

  const EXTEND_BY_DEADLINE =
    'Продлевайте проект полем «Дедлайн» в карточке. Если создать проекту период, загрузка по этому плану остановится.';

  function launchSettings(extra: Record<string, unknown> = {}) {
    mockVeEngineCall.mockImplementation(async (url: string) => (
      url.endsWith('/templates/template-1/launch')
        ? { ok: true, status: 200, data: {
            presets: [preset], bound_preset_id: 'preset-1', can_create_client: false, mailbox_tag_options: [],
            portal_projects: projects, delivery_plan: null, ...extra,
          } }
        : { ok: false, status: 404, data: {} }
    ));
  }

  async function openLaunchForm() {
    const user = userEvent.setup();
    render(
      <Step5Template
        template={template}
        base={{
          id: 'base-1', vertical_id: 'vertical-1', hypothesis_id: null, filename: 'base.csv', row_count: 10,
          columns: ['email'], sample_rows: [], analysis: null, created_at: '2026-09-01T00:00:00.000Z', status: 'analyzed',
        }}
        jobs={[]}
        onBuildTemplate={jest.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Проверить перед запуском' }));
    const projectSelect = await screen.findByLabelText('Проект клиента');
    return { user, projectSelect };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPreviewDeliveryPlan.mockImplementation(async (_templateId: string, body: Record<string, unknown>) => ({
      ok: true,
      status: 200,
      data: {
        preview: {
          portal_project_id: body.portal_project_id,
          portal_period_id: body.expected_portal_period_id,
          deadline: '2026-09-30',
          contacts_done_count: 0,
          target_contacts: body.target_contacts,
          remaining: body.target_contacts,
          remaining_workdays: 6,
          required_daily: 667,
          effective_daily: 20,
          ready_remaining: 10,
          sender_capacity: 20,
          supply_deficit: 3990,
          capacity_deficit: 3880,
          project_term: body.expected_portal_period_id === null
            ? { deadline: '2026-09-30', starts_at: '2026-08-30', contacts_obligation: '4000', contacts_done_total: 25905 }
            : null,
        },
      },
    }));
  });

  it('lets the specialist choose a project without periods and plans to its card deadline', async () => {
    launchSettings();
    const { user, projectSelect } = await openLaunchForm();
    await user.selectOptions(projectSelect, STAFF_LINE_ID);
    expect(screen.queryByText(/Новый запуск заблокирован/)).not.toBeInTheDocument();
    expect(screen.getByText(/Без периода/)).toHaveTextContent(
      /^Без периода · дедлайн 30\.09\.2026 · обязательство в карточке «4000» · всего контактов по проекту 25\s905 \(в расчёт не входит\)$/,
    );
    // Продление через период остановило бы план: предупреждаем до запуска.
    expect(screen.getByText(EXTEND_BY_DEADLINE)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Цель контактов до дедлайна'), '4000');
    await waitFor(() => expect(mockPreviewDeliveryPlan).toHaveBeenCalledWith('template-1', {
      portal_project_id: STAFF_LINE_ID,
      expected_portal_period_id: null,
      target_contacts: 4000,
      preset_id: 'preset-1',
      segmentation_audit_id: 'audit-1',
    }));
    expect(await screen.findByText('Осталось')).toBeInTheDocument();

    // Сам запуск уходит с явным null: сервер отличает его от забытого поля.
    mockVeEnginePost.mockResolvedValueOnce({ ok: false, status: 409, data: { error: 'Проверка тела запроса' } });
    const create = screen.getByRole('button', { name: 'Создать кампанию (на паузе)' });
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await waitFor(() => expect(mockVeEnginePost).toHaveBeenCalledWith('/api/tools/vertical-engine-v2/templates/template-1/launch', {
      preset_id: 'preset-1',
      segmentation_audit_id: 'audit-1',
      confirm_segmentation: true,
      portal_project_id: STAFF_LINE_ID,
      expected_portal_period_id: null,
      target_contacts: 4000,
    }));
    expect(await screen.findByText('Проверка тела запроса')).toBeInTheDocument();
  });

  it.each([
    [CLOSED_ID, 'Все периоды проекта закрыты. Откройте новый период в карточке проекта.'],
    [ENAGENCY_ID, 'В карточке проекта не заполнено поле «Дедлайн». Укажите дату в формате ГГГГ-ММ-ДД — темп рассчитается до неё.'],
  ])('explains why project %s cannot be launched', async (projectId, reason) => {
    launchSettings();
    const { user, projectSelect } = await openLaunchForm();
    await user.selectOptions(projectSelect, projectId);
    expect(screen.getByText(`${reason} Новый запуск заблокирован.`)).toBeInTheDocument();
    // A project with closed periods is not «без периода»; only its reason is shown.
    expect(Boolean(screen.queryByText(/Без периода/))).toBe(projectId === ENAGENCY_ID);
    await user.type(screen.getByLabelText('Цель контактов до дедлайна'), '4000');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockPreviewDeliveryPlan).not.toHaveBeenCalled();
  });

  it('locks an immutable binding whose plan cannot deliver now and shows the reason', async () => {
    const issue = 'Проекту в Portal создан период. Загрузка новых контактов по этому плану остановлена: план рассчитан на проект без периодов. Уже загруженные контакты продолжают отправляться.';
    launchSettings({
      delivery_plan_binding: { portal_project_id: STAFF_LINE_ID, portal_period_id: null, target_contacts: 4000 },
      delivery_plan_issue: issue,
    });
    const { projectSelect } = await openLaunchForm();
    await waitFor(() => expect(projectSelect).toHaveValue(STAFF_LINE_ID));
    expect(projectSelect).toBeDisabled();
    expect(screen.getByLabelText('Цель контактов до дедлайна')).toHaveValue(4000);
    expect(screen.getByText(`${issue} Новый запуск заблокирован.`)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockPreviewDeliveryPlan).not.toHaveBeenCalled();
  });

  it('locks a plan bound to a period that is no longer active and shows the reason', async () => {
    const issue = 'Выбранный период больше не является активным периодом этого проекта';
    launchSettings({
      portal_projects: projects.map((project) => (project.id === PERIOD_PROJECT_ID
        ? {
            id: PERIOD_PROJECT_ID, name: 'Клиент Портала', active_period: null, periods_closed: true,
            project_term: {
              deadline: '2026-09-30', starts_at: null, contacts_obligation: '500', contacts_done_total: 17,
              issue: 'Все периоды проекта закрыты. Откройте новый период в карточке проекта.',
            },
          }
        : project)),
      delivery_plan_binding: { portal_project_id: PERIOD_PROJECT_ID, portal_period_id: PERIOD_ID, target_contacts: 23 },
      delivery_plan_issue: issue,
    });
    const { projectSelect } = await openLaunchForm();
    await waitFor(() => expect(projectSelect).toHaveValue(PERIOD_PROJECT_ID));
    expect(projectSelect).toBeDisabled();
    expect(screen.getByText(`${issue} Новый запуск заблокирован.`)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockPreviewDeliveryPlan).not.toHaveBeenCalled();
  });

  it('keeps the active-period flow unchanged', async () => {
    launchSettings();
    const { user, projectSelect } = await openLaunchForm();
    await user.selectOptions(projectSelect, PERIOD_PROJECT_ID);
    expect(screen.queryByText(/Без периода/)).not.toBeInTheDocument();
    expect(screen.queryByText(EXTEND_BY_DEADLINE)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Цель контактов за период'), '23');
    await waitFor(() => expect(mockPreviewDeliveryPlan).toHaveBeenCalledWith('template-1', expect.objectContaining({
      portal_project_id: PERIOD_PROJECT_ID, expected_portal_period_id: PERIOD_ID, target_contacts: 23,
    })));
  });

  // Панель автоаутрича (OutreachLaunchPanel) строит запрос только по этому
  // значению: undefined — проект выбрать нельзя, запрос не отправляется.
  async function openLaunchHook() {
    const { result } = renderHook(() => useTemplateLaunch(template, 'audit-1', jest.fn()));
    act(() => result.current.openForm());
    await waitFor(() => expect(result.current.portalProjects).not.toBeNull());
    return result;
  }

  it('offers a period to the auto-outreach launch only for a project that can be chosen', async () => {
    launchSettings();
    const result = await openLaunchHook();
    const expectedFor = (projectId: string) => {
      act(() => result.current.selectPortalProject(projectId));
      return result.current.expectedPortalPeriodId;
    };
    expect(expectedFor(PERIOD_PROJECT_ID)).toBe(PERIOD_ID);
    expect(expectedFor(STAFF_LINE_ID)).toBeNull();
    // Only closed periods, or a card that blocks the launch: nothing to send.
    expect(expectedFor(CLOSED_ID)).toBeUndefined();
    expect(expectedFor(ENAGENCY_ID)).toBeUndefined();
    expect(expectedFor('')).toBeUndefined();
  });

  it('offers no period while a bound plan cannot deliver', async () => {
    launchSettings({
      delivery_plan_binding: { portal_project_id: STAFF_LINE_ID, portal_period_id: null, target_contacts: 4000 },
      delivery_plan_issue: 'Проекту в Portal создан период.',
    });
    const result = await openLaunchHook();
    await waitFor(() => expect(result.current.portalProjectId).toBe(STAFF_LINE_ID));
    expect(result.current.expectedPortalPeriodId).toBeUndefined();
  });
});
