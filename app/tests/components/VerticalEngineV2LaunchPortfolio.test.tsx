import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VeEngineWorkspace } from '@/components/vertical-engine-v2/engine/HypothesisEngineView';
import type { VeProject } from '@/lib/verticalEngineV2/types';

const mockEngineCall = jest.fn();
const mockEnginePost = jest.fn();
const mockEnginePatch = jest.fn();

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEngineCall: (...args: unknown[]) => mockEngineCall(...args),
  veEnginePost: (...args: unknown[]) => mockEnginePost(...args),
  veEnginePatch: (...args: unknown[]) => mockEnginePatch(...args),
}));

const PROJECTS_URL = '/api/tools/vertical-engine-v2/projects';
const PORTFOLIO_URL = '/api/tools/vertical-engine-v2/launch-portfolio?market=ru';

function project(id: string, name: string): VeProject {
  return {
    id,
    created_by: 'user-1',
    name,
    website_url: `https://${id}.example`,
    brief: null,
    status: 'researched',
    market: 'ru',
    error: null,
    llm_model: null,
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-20T08:00:00.000Z',
    updated_at: '2026-08-28T08:00:00.000Z',
  };
}

const PROJECTS = [
  project('active-academy', 'Active Academy'),
  project('ready-clinics', 'Ready Clinics'),
  project('prepare-schools', 'Prepare Schools'),
  project('wait-universities', 'Wait Universities'),
  project('holiday-retail', 'Holiday Retail'),
  project('unknown-services', 'Unknown Services'),
];

type SeasonalState =
  | 'launch_now'
  | 'prepare_now'
  | 'neutral'
  | 'unknown'
  | 'wait'
  | 'avoid';

type PortfolioLifecycle =
  | 'prepared'
  | 'queued'
  | 'activating'
  | 'active'
  | 'uncertain'
  | 'released'
  | 'skipped'
  | 'cancelled';

interface PortfolioItemFixture {
  id: string;
  project_id: string;
  project_name: string;
  vertical_id: string;
  hypothesis_id: string;
  base_id: string;
  template_id: string;
  status: PortfolioLifecycle;
  priority_override_decision?: 'activate_next' | 'wait' | null;
  activation_admissible: boolean;
  is_activation_head: boolean;
  activation_head_id: string | null;
  rank: number | null;
  estimated_run_days: number | null;
  capacity?: {
    max_active_bundles: number;
    occupied_bundles: number;
    slot_available: boolean;
  };
  priority_snapshot: {
    version: 1;
    state: SeasonalState;
    priority: number;
    automatic_activation_eligible: boolean;
    evaluated_on: string;
    planned_activation_date: string | null;
    seasonal_deadline_date?: string | null;
    seasonal_urgency_days: number | null;
    confidence: 'high' | 'medium' | 'low';
    potential_pct: number;
    age_days: number;
    manual_order: number | null;
    reasons: string[];
    blockers: string[];
  };
  seasonality: {
    version: 1;
    classification: 'seasonal' | 'neutral' | 'unknown';
    rationale: string;
    confidence: 'high' | 'medium' | 'low';
    windows: Array<{
      kind: 'peak' | 'avoid';
      label: string;
      start_mm_dd: string;
      end_mm_dd: string;
      lead_days?: number;
      evidence: Array<{
        claim: string;
        source_url: string;
        quote: string;
      }>;
    }>;
    evidence: Array<{
      claim: string;
      source_url: string;
      quote: string;
    }>;
  };
  campaigns: Array<{
    campaign_id: string;
    campaign_name?: string | null;
    campaign_url?: string | null;
    segment: string | null;
    leads_count?: number;
    status: 'paused' | 'active' | 'completed';
    status_observed_at: string;
  }>;
}

function portfolioItem(
  overrides: Partial<PortfolioItemFixture> &
    Pick<PortfolioItemFixture, 'id' | 'project_id' | 'project_name'> & {
      seasonalState: SeasonalState;
    },
): PortfolioItemFixture {
  const automaticActivationEligible = ['launch_now', 'neutral'].includes(
    overrides.seasonalState,
  );
  const status = overrides.status ?? 'queued';
  const activationAdmissible = overrides.activation_admissible
    ?? (status === 'queued' && automaticActivationEligible);
  const isActivationHead = overrides.is_activation_head ?? activationAdmissible;

  return {
    id: overrides.id,
    project_id: overrides.project_id,
    project_name: overrides.project_name,
    vertical_id: `vertical-${overrides.id}`,
    hypothesis_id: `hypothesis-${overrides.id}`,
    base_id: `base-${overrides.id}`,
    template_id: `template-${overrides.id}`,
    status,
    activation_admissible: activationAdmissible,
    is_activation_head: isActivationHead,
    activation_head_id: overrides.activation_head_id
      ?? (isActivationHead ? overrides.id : null),
    rank: overrides.rank ?? null,
    estimated_run_days: overrides.estimated_run_days ?? 14,
    priority_snapshot: overrides.priority_snapshot ?? {
      version: 1,
      state: overrides.seasonalState,
      priority: 100,
      automatic_activation_eligible: automaticActivationEligible,
      evaluated_on: '2026-08-28',
      planned_activation_date: null,
      seasonal_deadline_date: null,
      seasonal_urgency_days: null,
      confidence: 'medium',
      potential_pct: 50,
      age_days: 2,
      manual_order: null,
      reasons: ['Сезонное окно соответствует текущей дате'],
      blockers: [],
    },
    seasonality: overrides.seasonality ?? {
      version: 1,
      classification: 'seasonal',
      rationale: 'Спрос привязан к ежегодному циклу закупок.',
      confidence: 'medium',
      windows: [
        {
          kind: 'peak',
          label: 'Текущее окно закупок',
          start_mm_dd: '08-15',
          end_mm_dd: '09-20',
          lead_days: 21,
          evidence: [{
            claim: 'Закупки активны с середины августа.',
            source_url: 'https://research.example/procurement-calendar',
            quote: 'Основное окно закупок открывается во второй половине августа.',
          }],
        },
      ],
      evidence: [
        {
          claim: 'Закупки активны с середины августа.',
          source_url: 'https://research.example/procurement-calendar',
          quote: 'Основное окно закупок открывается во второй половине августа.',
        },
      ],
    },
    campaigns: overrides.campaigns ?? [],
  };
}

const PORTFOLIO = {
  as_of: '2026-08-28T10:00:00.000Z',
  plan_version: 1,
  mode: 'advisory' as const,
  capacity: {
    max_active_bundles: 1,
    active_bundles: 1,
    next_estimated_release_at: '2026-09-02T10:00:00.000Z',
  },
  items: [
    portfolioItem({
      id: 'item-active',
      project_id: 'active-academy',
      project_name: 'Active Academy',
      seasonalState: 'launch_now',
      status: 'active',
      rank: 0,
      campaigns: [
        {
          campaign_id: 'campaign-active',
          segment: null,
          status: 'active',
          status_observed_at: '2026-08-28T09:00:00.000Z',
        },
      ],
    }),
    portfolioItem({
      id: 'item-ready',
      project_id: 'ready-clinics',
      project_name: 'Ready Clinics',
      seasonalState: 'launch_now',
      rank: 1,
      campaigns: [
        {
          campaign_id: 'campaign-ready',
          campaign_name: 'Ready Clinics · Частные клиники Москвы',
          campaign_url: 'https://app.instantly.ai/app/campaign/campaign-ready',
          segment: 'Частные клиники Москвы',
          leads_count: 120,
          status: 'paused',
          status_observed_at: '2026-08-28T09:00:00.000Z',
        },
      ],
    }),
    portfolioItem({
      id: 'item-prepare',
      project_id: 'prepare-schools',
      project_name: 'Prepare Schools',
      seasonalState: 'prepare_now',
      status: 'prepared',
      rank: 2,
      priority_snapshot: {
        version: 1,
        state: 'prepare_now',
        priority: 200,
        automatic_activation_eligible: false,
        evaluated_on: '2026-08-28',
        planned_activation_date: '2026-09-12',
        seasonal_urgency_days: 15,
        confidence: 'high',
        potential_pct: 67,
        age_days: 1,
        manual_order: null,
        reasons: ['До позитивного окна достаточно времени, чтобы собрать PAUSED-кампании'],
        blockers: ['PAUSED-кампании ещё не подготовлены'],
      },
    }),
    portfolioItem({
      id: 'item-wait',
      project_id: 'wait-universities',
      project_name: 'Wait Universities',
      seasonalState: 'wait',
      rank: 3,
      priority_snapshot: {
        version: 1,
        state: 'wait',
        priority: 500,
        automatic_activation_eligible: false,
        evaluated_on: '2026-08-28',
        planned_activation_date: '2026-10-01',
        seasonal_urgency_days: 34,
        confidence: 'medium',
        potential_pct: 61,
        age_days: 2,
        manual_order: null,
        reasons: ['Пиковое окно ещё не вошло в период подготовки'],
        blockers: ['До начала подготовки 13 дней'],
      },
      campaigns: [
        {
          campaign_id: 'campaign-wait',
          segment: null,
          status: 'paused',
          status_observed_at: '2026-08-28T09:00:00.000Z',
        },
      ],
    }),
    portfolioItem({
      id: 'item-avoid',
      project_id: 'holiday-retail',
      project_name: 'Holiday Retail',
      seasonalState: 'avoid',
      rank: 4,
      priority_snapshot: {
        version: 1,
        state: 'avoid',
        priority: 600,
        automatic_activation_eligible: false,
        evaluated_on: '2026-08-28',
        planned_activation_date: null,
        seasonal_urgency_days: null,
        confidence: 'high',
        potential_pct: 71,
        age_days: 4,
        manual_order: null,
        reasons: ['ЛПР заняты текущим пиком продаж'],
        blockers: ['Активно негативное окно'],
      },
      seasonality: {
        version: 1,
        classification: 'seasonal',
        rationale: 'Во время пика продаж ЛПР недоступны для выбора подрядчика.',
        confidence: 'high',
        windows: [
          {
            kind: 'avoid',
            label: 'Пик продаж',
            start_mm_dd: '08-01',
            end_mm_dd: '08-31',
            evidence: [{
              claim: 'Ритейл занят текущим пиком продаж.',
              source_url: 'https://research.example/retail-calendar',
              quote: 'В пиковый период закупочные команды не рассматривают новых подрядчиков.',
            }],
          },
        ],
        evidence: [
          {
            claim: 'Ритейл занят текущим пиком продаж.',
            source_url: 'https://research.example/retail-calendar',
            quote: 'В пиковый период закупочные команды не рассматривают новых подрядчиков.',
          },
        ],
      },
    }),
    portfolioItem({
      id: 'item-unknown',
      project_id: 'unknown-services',
      project_name: 'Unknown Services',
      seasonalState: 'unknown',
      status: 'prepared',
      rank: null,
      priority_snapshot: {
        version: 1,
        state: 'unknown',
        priority: 400,
        automatic_activation_eligible: false,
        evaluated_on: '2026-08-28',
        planned_activation_date: null,
        seasonal_urgency_days: null,
        confidence: 'low',
        potential_pct: 40,
        age_days: 5,
        manual_order: null,
        reasons: [],
        blockers: ['Недостаточно источников для оценки'],
      },
      seasonality: {
        version: 1,
        classification: 'unknown',
        rationale: 'Проверенных данных недостаточно.',
        confidence: 'low',
        windows: [],
        evidence: [],
      },
    }),
  ],
};

function configureApi(portfolio: unknown = PORTFOLIO) {
  mockEngineCall.mockImplementation(async (url: string) => {
    if (url === PROJECTS_URL) {
      return { ok: true, status: 200, data: { projects: PROJECTS } };
    }
    if (url === PORTFOLIO_URL) {
      return { ok: true, status: 200, data: portfolio };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
}

async function openLaunchQueue(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Active Academy');
  await user.click(screen.getByRole('tab', { name: 'Очередь запусков' }));
}

beforeEach(() => {
  mockEngineCall.mockReset();
  mockEnginePost.mockReset();
  mockEnginePatch.mockReset();
});

describe('<VeEngineWorkspace /> — портфельная очередь запусков', () => {
  it('переключает проекты на очередь и группирует активный слот, запуск, подготовку и сезонные решения', async () => {
    configureApi();
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);

    expect(await screen.findByRole('tab', { name: 'Проекты' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await openLaunchQueue(user);

    expect(mockEngineCall).toHaveBeenCalledWith(PORTFOLIO_URL);
    expect(screen.getByRole('tab', { name: 'Очередь запусков' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Активная отправка' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Запускать сейчас' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Подготовить заранее' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ждать окна' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Избегать запуска' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Нужно решение' })).toBeInTheDocument();

    for (const projectName of PROJECTS.map((item) => item.name)) {
      expect(screen.getByText(projectName)).toBeInTheDocument();
    }

    const poolCopy = screen.getByText(/Активные группы отправки.*1/i);
    expect(poolCopy.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.getByText(/считается отдельно для пересекающихся mailbox-пулов/i))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Отметить отправку завершённой/i }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Освободить слот вручную/i })).toBeInTheDocument();

    // Сезонный смысл не кодируется одним цветом: рядом с каждой меткой есть
    // текст и отдельная скрытая от screen reader точка статуса.
    for (const [projectName, label] of [
      ['Active Academy', 'Активная отправка'],
      ['Ready Clinics', 'Запускать сейчас'],
      ['Prepare Schools', 'Готовить сейчас'],
      ['Wait Universities', 'Ждать'],
      ['Holiday Retail', 'Избегать'],
      ['Unknown Services', 'Нужно решение'],
    ] as const) {
      const row = screen.getByText(projectName).closest('li');
      expect(row).not.toBeNull();
      const status = within(row as HTMLElement).getByText(label);
      expect(status.closest('span')?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it('активирует eligible bundle только после QA-confirm и обновляет план очереди', async () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: jest.fn(() => '123e4567-e89b-42d3-a456-426614174000'),
    });
    const readyItem = PORTFOLIO.items.find((item) => item.id === 'item-ready');
    expect(readyItem).toBeDefined();
    const freePortfolio = {
      ...PORTFOLIO,
      capacity: {
        ...PORTFOLIO.capacity,
        active_bundles: 0,
      },
      items: PORTFOLIO.items.filter((item) => item.id !== 'item-active'),
    };
    configureApi(freePortfolio);
    mockEnginePost.mockResolvedValue({
      ok: true,
      status: 200,
      data: { item: { ...readyItem, status: 'active' } },
    });
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);
    await openLaunchQueue(user);

    const readyRow = screen.getByText('Ready Clinics').closest('li');
    expect(readyRow).not.toBeNull();
    const review = within(readyRow as HTMLElement).getByRole('checkbox', {
      name: 'Я проверил тексты, получателей и настройки PAUSED-кампаний',
    });
    const activate = within(readyRow as HTMLElement).getByRole('button', {
      name: 'Активировать отправку',
    });
    expect(review).toBeRequired();
    expect(activate).toBeDisabled();

    await user.click(review);
    expect(activate).toBeEnabled();
    await user.click(activate);

    await waitFor(() => {
      expect(mockEnginePost).toHaveBeenCalledWith(
        '/api/tools/vertical-engine-v2/launch-portfolio/item-ready/activate',
        {
          confirm_campaign_review: true,
          idempotency_key: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
          plan_version: 1,
        },
      );
    });
    await waitFor(() => {
      expect(mockEngineCall).toHaveBeenCalledTimes(3);
    });
  });

  it('не освобождает занятый слот без причины и отправляет аудируемое release-действие', async () => {
    configureApi();
    mockEnginePatch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { item: { ...PORTFOLIO.items[0], campaigns: [] } },
    });
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);
    await openLaunchQueue(user);

    await user.click(screen.getByRole('button', { name: /Освободить слот вручную/i }));
    const reason = screen.getByRole('textbox', { name: 'Причина освобождения слота' });
    const confirm = screen.getByRole('button', { name: 'Подтвердить освобождение' });
    expect(reason).toBeRequired();
    expect(confirm).toBeDisabled();

    await user.type(reason, 'Кампания остановлена в Instantly по просьбе клиента');
    await user.click(confirm);

    await waitFor(() => {
      expect(mockEnginePatch).toHaveBeenCalledWith(
        '/api/tools/vertical-engine-v2/launch-portfolio/items/item-active',
        {
          action: 'release',
          reason: 'Кампания остановлена в Instantly по просьбе клиента',
        },
      );
    });
  });

  it('требует причину для сезонного override и показывает ошибку API как alert', async () => {
    configureApi();
    mockEnginePatch.mockResolvedValue({
      ok: false,
      status: 409,
      data: { error: 'Активный слот уже занят другой отправкой' },
    });
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);
    await openLaunchQueue(user);

    const avoidRow = screen.getByText('Holiday Retail').closest('li');
    expect(avoidRow).not.toBeNull();
    await user.click(
      within(avoidRow as HTMLElement).getByRole('button', {
        name: 'Изменить сезонное решение',
      }),
    );

    await user.click(
      screen.getByRole('radio', { name: 'Активировать при освобождении слота' }),
    );
    const reason = screen.getByRole('textbox', { name: 'Причина ручного решения' });
    const save = screen.getByRole('button', { name: 'Сохранить решение' });
    expect(reason).toBeRequired();
    expect(save).toBeDisabled();

    await user.type(reason, 'Клиент подтвердил доступность ЛПР в текущем окне');
    await user.click(save);

    await waitFor(() => {
      expect(mockEnginePatch).toHaveBeenCalledWith(
        '/api/tools/vertical-engine-v2/launch-portfolio/items/item-avoid',
        {
          action: 'override_seasonality',
          decision: 'activate_next',
          reason: 'Клиент подтвердил доступность ЛПР в текущем окне',
        },
      );
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Активный слот уже занят другой отправкой',
    );
  });

  it('после audited activate_next override показывает QA-gate даже для исходного avoid-окна', async () => {
    const avoided = PORTFOLIO.items.find((item) => item.id === 'item-avoid');
    expect(avoided).toBeDefined();
    configureApi({
      ...PORTFOLIO,
      capacity: {
        ...PORTFOLIO.capacity,
        active_bundles: 0,
        next_estimated_release_at: null,
      },
      items: [{
        ...avoided!,
        priority_override_decision: 'activate_next',
        activation_admissible: true,
        is_activation_head: true,
        activation_head_id: avoided!.id,
      }],
    });
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);
    await openLaunchQueue(user);

    const row = screen.getByText('Holiday Retail').closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Запускать сейчас')).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByRole('checkbox', {
        name: /проверил тексты, получателей и настройки PAUSED-кампаний/i,
      }),
    ).toBeInTheDocument();
  });

  it('не блокирует disjoint mailbox pool из-за активной группы в другом scope', async () => {
    const ready = PORTFOLIO.items.find((item) => item.id === 'item-ready');
    expect(ready).toBeDefined();
    configureApi({
      ...PORTFOLIO,
      items: [{
        ...ready!,
        capacity: {
          max_active_bundles: 1,
          occupied_bundles: 0,
          slot_available: true,
        },
      }],
    });
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);
    await openLaunchQueue(user);

    const row = screen.getByText('Ready Clinics').closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole('checkbox')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole('button', { name: 'Активировать отправку' }))
      .toBeDisabled();
  });

  it('показывает activation QA только authoritative head каждого mailbox-пула', async () => {
    const ready = PORTFOLIO.items.find((item) => item.id === 'item-ready');
    expect(ready).toBeDefined();
    const lower = portfolioItem({
      id: 'item-lower',
      project_id: 'wait-universities',
      project_name: 'Wait Universities',
      seasonalState: 'neutral',
      rank: 2,
      activation_admissible: true,
      is_activation_head: false,
      activation_head_id: 'item-ready',
    });
    const disjoint = portfolioItem({
      id: 'item-disjoint',
      project_id: 'holiday-retail',
      project_name: 'Holiday Retail',
      seasonalState: 'neutral',
      rank: 3,
      activation_admissible: true,
      is_activation_head: true,
      activation_head_id: 'item-disjoint',
    });
    configureApi({
      ...PORTFOLIO,
      capacity: { ...PORTFOLIO.capacity, active_bundles: 0 },
      items: [ready!, lower, disjoint],
    });
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);
    await openLaunchQueue(user);

    const headScope = within(screen.getByText('Ready Clinics').closest('li') as HTMLElement);
    const lowerScope = within(screen.getByText('Wait Universities').closest('li') as HTMLElement);
    const disjointScope = within(screen.getByText('Holiday Retail').closest('li') as HTMLElement);

    expect(headScope.getByRole('checkbox')).toBeInTheDocument();
    expect(disjointScope.getByRole('checkbox')).toBeInTheDocument();
    expect(lowerScope.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(lowerScope.queryByRole('button', { name: 'Активировать отправку' }))
      .not.toBeInTheDocument();
    expect(lowerScope.getByText(/более приоритетная группа в этом mailbox-пуле/i))
      .toBeInTheDocument();
  });

  it('разрешает QA-preflight при stale occupied snapshot, чтобы backend сам сверил Completed holder', async () => {
    const ready = PORTFOLIO.items.find((item) => item.id === 'item-ready');
    expect(ready).toBeDefined();
    configureApi({
      ...PORTFOLIO,
      items: [{
        ...ready!,
        capacity: {
          max_active_bundles: 1,
          occupied_bundles: 1,
          slot_available: false,
          blocking_bundle_ids: ['item-active'],
        },
      }],
    });
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);
    await openLaunchQueue(user);

    const row = screen.getByText('Ready Clinics').closest('li');
    expect(row).not.toBeNull();
    const scope = within(row as HTMLElement);
    expect(scope.getByText(/перед активацией Portal сверит живой статус/i)).toBeInTheDocument();
    const review = scope.getByRole('checkbox');
    const activate = scope.getByRole('button', { name: 'Проверить слот и активировать' });
    expect(activate).toBeDisabled();
    await user.click(review);
    expect(activate).toBeEnabled();
  });

  it('показывает все child campaigns и объём сегмента перед QA-подтверждением', async () => {
    const ready = PORTFOLIO.items.find((item) => item.id === 'item-ready');
    expect(ready).toBeDefined();
    configureApi({
      ...PORTFOLIO,
      capacity: { ...PORTFOLIO.capacity, active_bundles: 0 },
      items: [{
        ...ready!,
        capacity: {
          max_active_bundles: 1,
          occupied_bundles: 0,
          slot_available: true,
        },
      }],
    });
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);
    await openLaunchQueue(user);

    const row = screen.getByText('Ready Clinics').closest('li');
    expect(row).not.toBeNull();
    const scope = within(row as HTMLElement);
    const campaignLink = scope.getByRole('link', {
      name: 'Ready Clinics · Частные клиники Москвы',
    });
    const qaCheckbox = scope.getByRole('checkbox', {
      name: /проверил тексты, получателей и настройки PAUSED-кампаний/i,
    });
    expect(campaignLink).toHaveAttribute(
      'href',
      'https://app.instantly.ai/app/campaign/campaign-ready',
    );
    expect(scope.getByText('Частные клиники Москвы')).toBeInTheDocument();
    expect(scope.getByText('120 лидов')).toBeInTheDocument();
    expect(campaignLink.compareDocumentPosition(qaCheckbox) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('не маскирует activating/uncertain под active и не показывает действия для terminal bundles', async () => {
    configureApi({
      ...PORTFOLIO,
      items: [
        portfolioItem({
          id: 'item-activating',
          project_id: 'active-academy',
          project_name: 'Active Academy',
          seasonalState: 'launch_now',
          status: 'activating',
        }),
        portfolioItem({
          id: 'item-uncertain',
          project_id: 'ready-clinics',
          project_name: 'Ready Clinics',
          seasonalState: 'launch_now',
          status: 'uncertain',
        }),
        portfolioItem({
          id: 'item-released',
          project_id: 'wait-universities',
          project_name: 'Wait Universities',
          seasonalState: 'avoid',
          status: 'released',
        }),
        portfolioItem({
          id: 'item-skipped',
          project_id: 'holiday-retail',
          project_name: 'Holiday Retail',
          seasonalState: 'wait',
          status: 'skipped',
        }),
        portfolioItem({
          id: 'item-cancelled',
          project_id: 'unknown-services',
          project_name: 'Unknown Services',
          seasonalState: 'unknown',
          status: 'cancelled',
        }),
      ],
    });
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);
    await openLaunchQueue(user);

    const activating = screen.getByText('Active Academy').closest('li');
    const uncertain = screen.getByText('Ready Clinics').closest('li');
    const released = screen.getByText('Wait Universities').closest('li');
    const skipped = screen.getByText('Holiday Retail').closest('li');
    const cancelled = screen.getByText('Unknown Services').closest('li');
    expect(activating).not.toBeNull();
    expect(uncertain).not.toBeNull();
    expect(released).not.toBeNull();
    expect(skipped).not.toBeNull();
    expect(cancelled).not.toBeNull();
    expect(within(activating as HTMLElement).getByText('Активация выполняется')).toBeInTheDocument();
    expect(within(uncertain as HTMLElement).getByText('Статус не подтверждён')).toBeInTheDocument();
    expect(within(released as HTMLElement).getByText('Слот освобождён')).toBeInTheDocument();
    expect(within(skipped as HTMLElement).getByText('Запуск пропущен')).toBeInTheDocument();
    expect(within(cancelled as HTMLElement).getByText('Запуск отменён')).toBeInTheDocument();
    expect(within(activating as HTMLElement).queryByRole('button', {
      name: 'Освободить слот вручную',
    })).not.toBeInTheDocument();
    expect(within(uncertain as HTMLElement).getByRole('button', {
      name: 'Освободить слот вручную',
    })).toBeInTheDocument();
    for (const terminalRow of [released, skipped, cancelled]) {
      const terminalScope = within(terminalRow as HTMLElement);
      expect(terminalScope.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(terminalScope.queryByRole('button', { name: 'Активировать отправку' }))
        .not.toBeInTheDocument();
      expect(terminalScope.queryByRole('button', { name: 'Изменить сезонное решение' }))
        .not.toBeInTheDocument();
      expect(terminalScope.queryByRole('button', { name: 'Освободить слот вручную' }))
        .not.toBeInTheDocument();
    }
  });
});
