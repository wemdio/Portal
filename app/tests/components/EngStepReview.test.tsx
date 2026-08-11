/**
 * Render-smoke для <EngStepReview /> (шаг 5 «Review & Launch»): пустое
 * состояние (автопилот ещё работает → ссылка в Command Center) и наполненное —
 * карточка вертикали с письмами цепочки, ленивым превью базы (GET rows по
 * кнопке), статусом шаблона и панелью «Launch all (paused)» (пресеты +
 * последовательный запуск с прогрессом). Сеть замокана на уровне api-client.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { EngStepReview } from '@/components/client-eng/EngStepReview';
import type { EngDetail } from '@/components/client-eng/EngProjectWizard';
import {
  fetchEngBaseRows,
  fetchEngLaunchPresets,
  launchEngTemplate,
} from '@/components/client-eng/api-client';
import type { HeTemplate, HeVertical } from '@/lib/hypothesisEngine/types';

jest.mock('@/components/client-eng/api-client', () => ({
  fetchEngBaseRows: jest.fn(),
  fetchEngLaunchPresets: jest.fn(),
  launchEngTemplate: jest.fn(),
  // ChainEditor (EngStepLetters) тянет эти две — сохранение/генерация в тесте
  // не вызываются, но символы обязаны существовать.
  patchEngChain: jest.fn(),
  generateEngChain: jest.fn(),
}));

const mockRows = fetchEngBaseRows as jest.MockedFunction<typeof fetchEngBaseRows>;
const mockPresets = fetchEngLaunchPresets as jest.MockedFunction<typeof fetchEngLaunchPresets>;
const mockLaunch = launchEngTemplate as jest.MockedFunction<typeof launchEngTemplate>;

function detail(overrides: Partial<EngDetail> = {}): EngDetail {
  return {
    project: {
      id: 'p1',
      name: 'Acme outbound',
      status: 'researched',
      market: 'us',
      website_url: 'https://acme.example/',
    } as EngDetail['project'],
    verticals: [],
    hypotheses: [],
    chains: [],
    bases: [],
    templates: [],
    jobs: [],
    ...overrides,
  } as EngDetail;
}

const READY_TEMPLATE = {
  id: 't1',
  vertical_id: 'v1',
  base_id: 'b1',
  status: 'ready',
  letters: [],
  fixed_block: '',
  personalization_plan: { letters: [], additions: [] },
  launch_info: null,
  tokens_used: 0,
  cost_usd: 0,
  created_at: '2026-08-10T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z',
} as unknown as HeTemplate;

beforeEach(() => {
  mockRows.mockReset();
  mockPresets.mockReset();
  mockLaunch.mockReset();
});

describe('<EngStepReview />', () => {
  it('shows the empty state with a Command Center link when nothing is ready', () => {
    render(
      <EngStepReview
        detail={detail({
          verticals: [
            { id: 'v1', project_id: 'p1', name: 'Banks' } as HeVertical,
          ],
        })}
        onChanged={() => {}}
      />,
    );

    expect(screen.getByText(/Autopilot is still working/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /command center/i });
    expect(link).toHaveAttribute('href', '/client/eng/dashboard');
  });

  it('renders letters, lazy base preview, template status and launches all', async () => {
    mockRows.mockResolvedValue({
      columns: ['company', 'website', 'email'],
      rows: [
        { company: 'Acme Corp', website: 'acme.com', email: 'hi@acme.com', _email_status: 'ok' },
      ],
      total: 350,
      status: 'analyzed',
      row_count: 350,
    });
    mockPresets.mockResolvedValue([{ id: 'pr1', name: 'sender@x.com' }]);
    mockLaunch.mockResolvedValue({ ok: true });

    const onChanged = jest.fn();
    render(
      <EngStepReview
        detail={detail({
          verticals: [
            { id: 'v1', project_id: 'p1', name: 'Banks' } as HeVertical,
          ],
          chains: [
            {
              id: 'c1',
              vertical_id: 'v1',
              status: 'ready',
              language: 'en',
              letters: [{ subject: 'Hi there', body: 'Body text', wait_days: 0 }],
              tokens_used: 0,
              cost_usd: 0,
              created_at: '2026-08-10T00:00:00Z',
              updated_at: '2026-08-10T00:00:00Z',
            },
          ],
          bases: [
            {
              id: 'b1',
              vertical_id: 'v1',
              filename: 'auto: Banks',
              status: 'analyzed',
              row_count: 350,
              columns: ['company', 'website', 'email'],
              sample_rows: [],
              analysis: null,
              source: 'auto',
              created_at: '2026-08-10T00:00:00Z',
            },
          ],
          templates: [READY_TEMPLATE],
        })}
        onChanged={onChanged}
      />,
    );

    // Письма цепочки на месте (инлайн-редактор шага Letters).
    expect(screen.getByText('Banks')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Hi there')).toBeInTheDocument();
    // Статус шаблона и пресеты подъехали по первому ready-шаблону.
    expect(screen.getByText(/template: ready/i)).toBeInTheDocument();
    expect(await screen.findByText('sender@x.com')).toBeInTheDocument();
    expect(mockPresets).toHaveBeenCalledWith('t1');

    // Ленивое превью базы — только по кнопке.
    expect(mockRows).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /preview base/i }));
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(mockRows).toHaveBeenCalledWith('b1', expect.objectContaining({ limit: 100 }));
    expect(screen.getByText('ok')).toBeInTheDocument();

    // «Launch all (paused)» — последовательный запуск с прогрессом.
    fireEvent.click(screen.getByRole('button', { name: /launch all \(paused\)/i }));
    expect(await screen.findByText(/Launched 1\/1/)).toBeInTheDocument();
    expect(mockLaunch).toHaveBeenCalledWith('t1', { preset_id: 'pr1' });
    expect(onChanged).toHaveBeenCalled();
  });
});
