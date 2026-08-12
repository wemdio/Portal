/**
 * Render-smoke для <EngDashboard /> (Command Center): компонент монтируется
 * на реалистичном пэйлоаде GET /api/client/eng/dashboard и показывает ключевые
 * блоки (01 → Today счётчики, карточки вертикалей с картой пайплайна и строкой
 * «next: …», ссылку в Instantly, ленту событий, карточку «Right now», countdown
 * авто-добора), плюс пустое состояние без вертикалей. Сеть замокана на уровне
 * api-client.
 */

import { render, screen, within } from '@testing-library/react';
import { EngDashboard } from '@/components/client-eng/EngDashboard';
import { fetchEngDashboard, type EngDashboardResponse } from '@/components/client-eng/api-client';

jest.mock('@/components/client-eng/api-client', () => ({
  fetchEngDashboard: jest.fn(),
}));

const mockFetch = fetchEngDashboard as jest.MockedFunction<typeof fetchEngDashboard>;

function payload(overrides: Partial<EngDashboardResponse> = {}): EngDashboardResponse {
  return {
    projects: [{ id: 'p1', name: 'Acme outbound', status: 'researched' }],
    verticals: [
      {
        id: 'v1',
        project_id: 'p1',
        name: 'Banks',
        stage: 'launched',
        stageDetail: 'live: Banks US · Aug 6',
        dots: [true, true, true, true, true],
        stats: { companies: 300, emails_found: 250, valid_count: 210, appended_today: 38, leads_launched: 210 },
        launch: {
          campaign_url: 'https://app.instantly.ai/app/campaign/cmp-9',
          campaign_name: 'Banks US · Aug 6',
        },
        forecast: { pct: 42 },
        actual: { reply_pct: 3.1, sent: 1200, measured_at: '2026-08-06T01:00:00.000Z' },
      },
      {
        id: 'v2',
        project_id: 'p1',
        name: 'Fintech',
        stage: 'construct',
        stageDetail: 'constructor: 87/147 valid',
        dots: [true, true, false, false, false],
        stats: { companies: 0, emails_found: 147, valid_count: 87, appended_today: 0, leads_launched: 0 },
        launch: null,
        forecast: null,
        actual: null,
      },
    ],
    today: { appended: 38, valid: 40, collected: 50 },
    autoRefill: { enabled: true, next_run_at: '2099-01-01T03:20:00.000Z', daily_cap: 50 },
    events: [
      { type: 'refill_appended', text: 'refill: +38 leads · Banks', at: '2026-08-06T00:40:00.000Z' },
    ],
    activeJobs: [
      {
        id: 'j1',
        project_id: 'p1',
        stage: 'base_collect',
        status: 'running',
        vertical_id: 'v2',
        progress: { done: 1, total: 2, label: 'harvest' },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('<EngDashboard />', () => {
  it('renders the aggregate: today counters, vertical cards, events, active jobs', async () => {
    mockFetch.mockResolvedValue(payload());
    render(<EngDashboard />);

    // Ждём именно дата-зависимый блок: шапка статична и не маркирует загрузку.
    expect(await screen.findByText('Appended today')).toBeInTheDocument();
    expect(screen.getByText('Command Center')).toBeInTheDocument();
    expect(screen.getByText('Valid today')).toBeInTheDocument();
    expect(screen.getByText('Collected today')).toBeInTheDocument();
    // Секции подписаны editorial eyebrows.
    expect(screen.getByText('01 → Today')).toBeInTheDocument();
    expect(screen.getByText('02 → Verticals')).toBeInTheDocument();
    expect(screen.getByText('03 → Recent activity')).toBeInTheDocument();
    // Авто-добор включён: расписание и в тайле, и в строке next live-вертикали.
    expect(screen.getAllByText(/03:20 UTC/).length).toBeGreaterThan(0);
    // Карточки вертикалей: статус-теги dot+mono вместо пилюль.
    expect(screen.getByText('Banks')).toBeInTheDocument();
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(screen.getByText('Fintech')).toBeInTheDocument();
    expect(screen.getByText('enrichment')).toBeInTheDocument();
    // Ссылка на кампанию Instantly у launched-вертикали.
    const instantly = screen.getByRole('link', { name: /open in instantly/i });
    expect(instantly).toHaveAttribute('href', 'https://app.instantly.ai/app/campaign/cmp-9');
    // Кнопка перехода в мастер на нужный шаг.
    const view = screen.getAllByRole('link', { name: /view|continue/i })[0];
    expect(view).toHaveAttribute('href', expect.stringContaining('/client/eng/projects/p1?step='));
    // Лента событий и карточка «Right now» (джоба — строкой с вертикалью).
    expect(screen.getByText('refill: +38 leads · Banks')).toBeInTheDocument();
    expect(screen.getByText('Right now')).toBeInTheDocument();
    expect(screen.getByText('collecting the base · Fintech')).toBeInTheDocument();
    expect(screen.getByText('1/2 · harvest')).toBeInTheDocument();
  });

  it('pipeline map: current stage with numeric evidence and a next line', async () => {
    mockFetch.mockResolvedValue(payload());
    render(<EngDashboard />);

    const cards = await screen.findAllByTestId('vertical-card');
    expect(cards).toHaveLength(2);
    const [banks, fintech] = cards;

    // Live-вертикаль: весь пайплайн пройден, Daily refill — отдельная строка.
    expect(within(banks).getByText('Launch')).toBeInTheDocument();
    expect(within(banks).getByText(/210 leads/)).toBeInTheDocument();
    expect(within(banks).getByRole('link', { name: /Banks US · Aug 6/ })).toHaveAttribute(
      'href',
      'https://app.instantly.ai/app/campaign/cmp-9',
    );
    expect(within(banks).getByText('template ready')).toBeInTheDocument();
    expect(within(banks).getByText('Daily refill')).toBeInTheDocument();
    expect(within(banks).getByText('+38 today · next 03:20 UTC')).toBeInTheDocument();
    expect(within(banks).getByText('next: daily refill 03:20 UTC')).toBeInTheDocument();

    // Вертикаль в работе: текущая стадия Email enrichment с доказательством
    // из stats (valid/emails), прошлые стадии с цифрами, будущие — без.
    expect(within(fintech).getByText('Email enrichment')).toBeInTheDocument();
    expect(within(fintech).getByText('87 / 147 valid')).toBeInTheDocument();
    expect(within(fintech).getByText('Lead base')).toBeInTheDocument();
    expect(within(fintech).getByText('Analysis')).toBeInTheDocument();
    expect(within(fintech).getByText('next: analysis (after enrichment)')).toBeInTheDocument();
  });

  it('shows the empty state when there are no verticals', async () => {
    mockFetch.mockResolvedValue(
      payload({ verticals: [], events: [], activeJobs: [], autoRefill: { enabled: false, next_run_at: '2099-01-01T03:20:00.000Z', daily_cap: 0 } }),
    );
    render(<EngDashboard />);

    expect(await screen.findByText('No verticals yet — create a project')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /create a project/i })).toBeInTheDocument();
    expect(screen.getByText('off')).toBeInTheDocument();
  });

  it('renders the load error when the aggregate fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    render(<EngDashboard />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
