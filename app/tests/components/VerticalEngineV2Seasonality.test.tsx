import { render, screen, waitFor, within } from '@testing-library/react';
import { Step2Verticals } from '@/components/vertical-engine-v2/engine/steps/Step2Verticals';
import { Step4Base } from '@/components/vertical-engine-v2/engine/steps/Step4Base';
import { Step5Template } from '@/components/vertical-engine-v2/engine/steps/Step5Template';
import type { VeBaseSummary } from '@/components/vertical-engine-v2/engine/api';
import type {
  VeBaseAnalysis,
  VeHypothesis,
  VeTemplate,
  VeVertical,
} from '@/lib/verticalEngineV2/types';

const mockEngineCall = jest.fn();
const mockEnginePost = jest.fn();
const mockEnginePatch = jest.fn();

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEngineCall: (...args: unknown[]) => mockEngineCall(...args),
  veEnginePost: (...args: unknown[]) => mockEnginePost(...args),
  veEnginePatch: (...args: unknown[]) => mockEnginePatch(...args),
}));

const BASE_ID = 'base-seasonal';
const TEMPLATE_ID = 'template-seasonal';
const PREVIEW_URL = `/api/tools/vertical-engine-v2/bases/${BASE_ID}/template`;
const PORTFOLIO_URL = '/api/tools/vertical-engine-v2/launch-portfolio?market=ru';

const SEASONALITY = {
  version: 1 as const,
  classification: 'seasonal' as const,
  rationale: 'Закупки на осенний набор уже начались — писать стоит сейчас.',
  confidence: 'high' as const,
  windows: [
    {
      kind: 'peak' as const,
      label: 'Подготовка и набор групп к началу учебного года',
      start_mm_dd: '08-15',
      end_mm_dd: '09-20',
      lead_days: 21,
      evidence: [{
        claim: 'Минпросвещения: основной набор проходит к началу учебного года',
        source_url: 'https://research.example/education-calendar',
        quote: 'Образовательные центры формируют осенний набор за 3–5 недель до сентября.',
      }],
    },
    {
      kind: 'avoid' as const,
      label: 'Каникулы и недоступность ЛПР',
      start_mm_dd: '12-25',
      end_mm_dd: '01-10',
      evidence: [{
        claim: 'Производственный календарь: каникулы снижают доступность ЛПР',
        source_url: 'https://research.example/production-calendar',
        quote: 'Каникулы и недоступность ЛПР снижают шанс ответа.',
      }],
    },
  ],
  evidence: [
    {
      claim: 'Минпросвещения: основной набор проходит к началу учебного года',
      source_url: 'https://research.example/education-calendar',
      quote: 'Образовательные центры формируют осенний набор за 3–5 недель до сентября.',
    },
    {
      claim: 'Производственный календарь: каникулы снижают доступность ЛПР',
      source_url: 'https://research.example/production-calendar',
      quote: 'Каникулы и недоступность ЛПР снижают шанс ответа.',
    },
  ],
};

const PREPARE_SEASONALITY = {
  ...SEASONALITY,
  rationale: 'Кампанию можно подготовить сейчас, но активировать лучше перед осенним набором.',
  confidence: 'medium' as const,
  windows: [
    {
      kind: 'peak' as const,
      label: 'Осенний набор',
      start_mm_dd: '10-02',
      end_mm_dd: '10-31',
      lead_days: 21,
      evidence: [SEASONALITY.evidence[0]],
    },
  ],
};

const VERTICAL = {
  id: 'vertical-education',
  project_id: 'project-education',
  name: 'Частное образование',
  summary: 'Школы, учебные центры и курсы с выраженным осенним набором.',
  synonyms: ['частные школы', 'образовательные центры'],
  potential_pct: 72,
  rank: 1,
  created_at: '2026-08-20T08:00:00.000Z',
  updated_at: '2026-08-28T08:00:00.000Z',
} as unknown as VeVertical;

const HYPOTHESIS = {
  id: 'hypothesis-education',
  project_id: VERTICAL.project_id,
  vertical_id: VERTICAL.id,
  tier: 1,
  title: 'Частные школы с осенним набором',
  description: 'Школы, которым нужен поток заявок к новому учебному году.',
  fit_rationale: 'Продукт помогает школе заполнить группы до начала занятий.',
  evidence: [],
  potential_pct: 68,
  status: 'accepted',
  seasonality: PREPARE_SEASONALITY,
  created_at: '2026-08-20T08:00:00.000Z',
  updated_at: '2026-08-28T08:00:00.000Z',
} as unknown as VeHypothesis;

const LAUNCH_NOW_HYPOTHESIS = {
  ...HYPOTHESIS,
  seasonality: SEASONALITY,
} as unknown as VeHypothesis;

const ANALYSIS = {
  geo_distribution: [{ value: 'Москва', share_pct: 62 }],
  industry_distribution: [{ value: 'Частное образование', share_pct: 78 }],
  company_type_distribution: [{ value: 'Учебный центр', share_pct: 54 }],
  title_distribution: [{ value: 'Директор', share_pct: 48 }],
  notable_segments: ['Частные школы готовят осенний набор'],
  data_quality_notes: '',
  recommended_angles: ['Предложить подготовить лидогенерацию до начала учебного года'],
} as unknown as VeBaseAnalysis;

const BASE = {
  id: BASE_ID,
  vertical_id: VERTICAL.id,
  hypothesis_id: HYPOTHESIS.id,
  filename: 'education.csv',
  row_count: 1200,
  columns: ['company', 'industry', 'city', 'email'],
  sample_rows: [],
  analysis: ANALYSIS,
  status: 'analyzed',
  source: 'auto',
  created_at: '2026-08-28T07:00:00.000Z',
} as VeBaseSummary;

const EMBEDDED_PRIORITY = {
  version: 1 as const,
  state: 'wait' as const,
  priority: 500,
  automatic_activation_eligible: false,
  evaluated_on: '2026-08-28',
  planned_activation_date: '2026-10-15',
  seasonal_deadline_date: '2026-11-01',
  confidence: 'medium' as const,
};

const TEMPLATE = {
  id: TEMPLATE_ID,
  base_id: BASE_ID,
  vertical_id: VERTICAL.id,
  fixed_block: 'Общая основа',
  personalization_plan: {
    letters: [],
    additions: [],
    operator_mapping: [],
  },
  letters: [
    {
      subject: 'Осенний набор для {{companyName}}',
      body: 'Предлагаем подготовить поток обращений к началу учебного года.',
      wait_days: 0,
    },
  ],
  status: 'ready',
  tokens_used: 0,
  cost_usd: 0,
  created_at: '2026-08-28T08:00:00.000Z',
  updated_at: '2026-08-28T08:00:00.000Z',
  launch_info: {
    campaign_id: 'campaign-paused',
    campaign_name: 'Education — September',
    campaign_url: 'https://app.instantly.ai/app/campaign/campaign-paused',
    leads_count: 1180,
    preset_id: 'preset-education',
    created_at: '2026-08-28T08:30:00.000Z',
    portfolio_item_id: 'portfolio-education',
    campaigns: [
      {
        campaign_id: 'campaign-paused',
        campaign_name: 'Education — September',
        campaign_url: 'https://app.instantly.ai/app/campaign/campaign-paused',
        segment: null,
        leads_count: 1180,
        status: 'paused',
      },
    ],
  },
  launch_portfolio: {
    item_id: 'portfolio-education',
    status: 'queued',
    mode: 'enforced',
    priority_snapshot: EMBEDDED_PRIORITY,
    capacity: { max_active_bundles: 1, active_bundles: 0 },
  },
} as unknown as VeTemplate;

function expectTextStatusWithDot(label: 'Запускать сейчас' | 'Готовить сейчас' | 'Ждать') {
  const node = screen.getByText(label);
  expect(node.closest('span')?.querySelector('[aria-hidden="true"]')).not.toBeNull();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-28T09:00:00.000Z'));
  mockEngineCall.mockReset();
  mockEnginePost.mockReset();
  mockEnginePatch.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Vertical Engine v2 — сезонность в мастере', () => {
  it('показывает предварительную сезонную оценку до выбора вертикали, отдельно от потенциала', () => {
    render(
      <Step2Verticals
        verticals={[VERTICAL]}
        hypotheses={[HYPOTHESIS]}
        selectedVerticalId={null}
        onPatchHypothesis={jest.fn()}
        onSelectVertical={jest.fn()}
        jobs={[]}
        dossiers={[]}
        chains={[]}
        vocabs={[]}
        bases={[]}
        templates={[]}
      />,
    );

    const hypothesis = screen.getByText(HYPOTHESIS.title).closest('li');
    expect(hypothesis).not.toBeNull();
    expect(within(hypothesis as HTMLElement).getByText('68%')).toBeInTheDocument();
    expect(
      within(hypothesis as HTMLElement).getByText('Предварительная сезонная оценка'),
    ).toBeInTheDocument();
    expect(within(hypothesis as HTMLElement).getByText('Готовить сейчас')).toBeInTheDocument();
    expect(
      within(hypothesis as HTMLElement).getByText(/Активировать с 11 сентября/i),
    ).toBeInTheDocument();
    expect(within(hypothesis as HTMLElement).getByText(/Средняя уверенность/i)).toBeInTheDocument();
    expect(
      within(hypothesis as HTMLElement).getByText(
        /Кампанию можно подготовить сейчас, но активировать лучше/i,
      ),
    ).toBeInTheDocument();
    expectTextStatusWithDot('Готовить сейчас');
  });

  it('на шаге базы показывает структурированные позитивные и негативные окна, confidence и источники', () => {
    render(
      <Step4Base
        projectId="project-education"
        vertical={VERTICAL}
        hypotheses={[LAUNCH_NOW_HYPOTHESIS]}
        bases={[BASE]}
        jobs={[]}
        onUploaded={jest.fn()}
        onTemplateStarted={jest.fn()}
        onGoToTemplate={jest.fn()}
      />,
    );

    const timing = screen.getByRole('region', { name: 'Сезонность и время запуска' });
    expect(within(timing).getByText('Запускать сейчас')).toBeInTheDocument();
    expect(within(timing).getByText(/Можно запускать/i)).toBeInTheDocument();
    expect(within(timing).getByText(/Высокая уверенность/i)).toBeInTheDocument();
    expect(within(timing).getByRole('heading', { name: 'Благоприятные окна' })).toBeInTheDocument();
    expect(within(timing).getByRole('heading', { name: 'Нежелательные окна' })).toBeInTheDocument();
    expect(within(timing).getByText(/15 августа.*20 сентября/i)).toBeInTheDocument();
    expect(within(timing).getByText(/25 декабря.*10 января/i)).toBeInTheDocument();
    expect(
      within(timing).getByRole('link', {
        name: 'Минпросвещения: основной набор проходит к началу учебного года',
      }),
    ).toHaveAttribute('href', 'https://research.example/education-calendar');
    expect(
      within(timing).getByRole('link', {
        name: 'Производственный календарь: каникулы снижают доступность ЛПР',
      }),
    ).toHaveAttribute('href', 'https://research.example/production-calendar');
    expect(
      within(timing).getByText(/Каникулы и недоступность ЛПР снижают шанс ответа/i),
    ).toBeInTheDocument();
    expectTextStatusWithDot('Запускать сейчас');
  });

  it('после создания PAUSED-кампаний отделяет подготовку от sending activation и требует review для будущего окна', async () => {
    mockEngineCall.mockImplementation(async (url: string) => {
      if (url === PREVIEW_URL) {
        return {
          ok: true,
          status: 200,
          data: {
            template: TEMPLATE,
            columns: [],
            sample_rows: [],
            sample_segments: [],
          },
        };
      }
      if (url === PORTFOLIO_URL) {
        return {
          ok: true,
          status: 200,
          data: {
            market: 'ru',
            as_of: '2026-08-28T09:00:00.000Z',
            timezone: 'Europe/Moscow',
            mode: 'enforced',
            plan_version: 4,
            capacity: { max_active_bundles: 1, occupied_bundles: 0, active_bundles: 0 },
            items: [{
              id: 'portfolio-education',
              template_id: TEMPLATE_ID,
              status: 'queued',
              priority_snapshot: EMBEDDED_PRIORITY,
            }],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    render(
      <Step5Template
        template={TEMPLATE}
        base={BASE}
        jobs={[]}
        onBuildTemplate={jest.fn()}
      />,
    );

    await waitFor(() => expect(mockEngineCall).toHaveBeenCalledWith(PORTFOLIO_URL));

    const preparation = screen.getByRole('region', { name: 'Подготовка PAUSED-кампаний' });
    expect(within(preparation).getByText(/PAUSED-кампании подготовлены/i)).toBeInTheDocument();
    expect(within(preparation).getByText(/Sending slot не занят/i)).toBeInTheDocument();

    const activation = screen.getByRole('region', { name: 'Активация отправки' });
    expect(within(activation).getByText('Ждать')).toBeInTheDocument();
    expect(within(activation).getByText(/Требуется проверка сезонного решения/i)).toBeInTheDocument();
    expect(within(activation).getByRole('button', { name: 'Активировать отправку' })).toBeDisabled();
    expect(
      within(activation).getByRole('button', { name: 'Пересмотреть сезонное решение' }),
    ).toBeInTheDocument();
    expectTextStatusWithDot('Ждать');
  });

  it('поверх embedded snapshot всегда накладывает авторитетный обновлённый портфель', async () => {
    mockEngineCall.mockImplementation(async (url: string) => {
      if (url === PREVIEW_URL) {
        return {
          ok: true,
          status: 200,
          data: { template: TEMPLATE, columns: [], sample_rows: [], sample_segments: [] },
        };
      }
      if (url === PORTFOLIO_URL) {
        return {
          ok: true,
          status: 200,
          data: {
            market: 'ru',
            as_of: '2026-08-29T09:00:00.000Z',
            timezone: 'Europe/Moscow',
            mode: 'enforced',
            plan_version: 5,
            capacity: { max_active_bundles: 1, occupied_bundles: 0, active_bundles: 0 },
            items: [{
              id: 'portfolio-education',
              template_id: TEMPLATE_ID,
              status: 'queued',
              activation_admissible: true,
              is_activation_head: true,
              activation_head_id: 'portfolio-education',
              capacity: {
                max_active_bundles: 1,
                occupied_bundles: 0,
                slot_available: true,
              },
              priority_snapshot: {
                ...EMBEDDED_PRIORITY,
                state: 'launch_now',
                priority: 100,
                automatic_activation_eligible: true,
                evaluated_on: '2026-08-29',
              },
            }],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    render(
      <Step5Template
        template={TEMPLATE}
        base={BASE}
        jobs={[]}
        onBuildTemplate={jest.fn()}
      />,
    );

    await waitFor(() => expect(mockEngineCall).toHaveBeenCalledWith(PORTFOLIO_URL));
    const activation = screen.getByRole('region', { name: 'Активация отправки' });
    await waitFor(() => {
      expect(within(activation).getByText('Запускать сейчас')).toBeInTheDocument();
    });
    expect(within(activation).queryByText(/Требуется проверка сезонного решения/i))
      .not.toBeInTheDocument();
  });

  it('в advisory mode показывает сезонный wait как рекомендацию, но не блокирует review', async () => {
    const advisoryTemplate = {
      ...TEMPLATE,
      launch_portfolio: {
        item_id: 'portfolio-education',
        status: 'queued',
        mode: 'advisory',
        plan_version: 6,
        priority_snapshot: EMBEDDED_PRIORITY,
        capacity: { max_active_bundles: 1, active_bundles: 0 },
      },
    } as unknown as VeTemplate;
    const advisoryUrl = '/api/tools/vertical-engine-v2/launch-portfolio?market=us';
    mockEngineCall.mockImplementation(async (url: string) => {
      if (url === PREVIEW_URL) {
        return {
          ok: true,
          status: 200,
          data: { template: advisoryTemplate, columns: [], sample_rows: [], sample_segments: [] },
        };
      }
      if (url === advisoryUrl) {
        return {
          ok: true,
          status: 200,
          data: {
            market: 'us',
            as_of: '2026-08-28T09:00:00.000Z',
            timezone: 'UTC',
            mode: 'advisory',
            plan_version: 6,
            capacity: { max_active_bundles: 1, occupied_bundles: 0, active_bundles: 0 },
            items: [{
              id: 'portfolio-education',
              template_id: TEMPLATE_ID,
              status: 'queued',
              priority_snapshot: EMBEDDED_PRIORITY,
            }],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    render(
      <Step5Template
        template={advisoryTemplate}
        base={BASE}
        jobs={[]}
        onBuildTemplate={jest.fn()}
      />,
    );

    await waitFor(() => expect(mockEngineCall).toHaveBeenCalledWith(advisoryUrl));
    const activation = screen.getByRole('region', { name: 'Активация отправки' });
    expect(within(activation).getByText('Ждать')).toBeInTheDocument();
    expect(within(activation).queryByText(/Требуется проверка сезонного решения/i))
      .not.toBeInTheDocument();
    expect(within(activation).getByRole('checkbox')).toBeEnabled();
  });
});
