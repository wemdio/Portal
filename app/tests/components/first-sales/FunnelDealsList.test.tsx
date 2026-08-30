import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FunnelDealsList from '@/components/first-sales/FunnelDealsList';
import type { FiltersState } from '@/components/first-sales/FiltersBar';

const mockAuthFetch = jest.fn();

jest.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

jest.mock('@/lib/loggerClient', () => ({ logError: jest.fn() }));

const filters: FiltersState = {
  from: '2026-08-01',
  to: '2026-08-30',
  groupBy: 'day',
  sources: [],
};

function deal(over: Record<string, unknown> = {}) {
  return {
    amo_id: 1,
    name: 'Заявка с сайта',
    company_name: 'ООО Ромашка',
    responsible_name: 'Егор',
    created_at: '2026-08-10T09:00:00.000Z',
    history_complete: true,
    in_period: { lead: true, qualified: false, meetings: 0, contract: false, money: 0 },
    amo_url: 'https://amo.example/leads/detail/1',
    ...over,
  };
}

function respondWith(groups: unknown) {
  mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({ groups }) });
}

beforeEach(() => {
  mockAuthFetch.mockReset();
});

describe('FunnelDealsList', () => {
  it('показывает группы с их собственным размером', async () => {
    respondWith([
      { stage: 'contract', label: 'Договоры', deals: [deal({ amo_id: 2, company_name: 'Договорная' })] },
      { stage: 'lead', label: 'Лиды', deals: [deal({ amo_id: 3 }), deal({ amo_id: 4 })] },
    ]);

    render(<FunnelDealsList filters={filters} focusStage={null} funnelCounts={{ lead: 290 }} />);

    // Заголовок называет размер ГРУППЫ (2), а не цифру ступени воронки (290):
    // на воронке в «Лидах» лежат и те, кто прошёл дальше.
    expect(await screen.findByText('Лиды — 2')).toBeInTheDocument();
    expect(screen.getByText('Договоры — 1')).toBeInTheDocument();
  });

  it('пустой ответ не рисует ни одной группы', async () => {
    respondWith([]);
    render(<FunnelDealsList filters={filters} focusStage={null} funnelCounts={{}} />);
    expect(await screen.findByText(/Сделок за выбранный период нет/)).toBeInTheDocument();
  });

  it('фильтр источников уходит в запрос', async () => {
    respondWith([]);
    render(
      <FunnelDealsList
        filters={{ ...filters, sources: ['none', '42'] }}
        focusStage={null}
        funnelCounts={{}}
      />,
    );
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    const url = String(mockAuthFetch.mock.calls[0][0]);
    expect(url).toContain('source=none');
    expect(url).toContain('source=42');
  });

  it('клик по сделке открывает карточку, Esc закрывает', async () => {
    respondWith([{ stage: 'lead', label: 'Лиды', deals: [deal()] }]);
    render(<FunnelDealsList filters={filters} focusStage={null} funnelCounts={{}} />);

    const row = await screen.findByRole('button', { name: /ООО Ромашка/ });

    // Второй ответ — уже для модалки: она грузит сделку отдельной ручкой.
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        amo_id: 1, name: 'Заявка с сайта', company_name: 'ООО Ромашка',
        company_website: null, responsible_name: 'Егор', status_name: 'Первичный контакт',
        pipeline_name: 'Воронка - новые лиды', amount: 0,
        contact: { email: null, phone: null, telegram: null },
        stages: null, fields: [], notes: [], tasks: [], amo_url: null,
      }),
    });

    fireEvent.click(row);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('ошибка загрузки видна, а не прячется за пустым списком', async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'всё плохо' }) });
    render(<FunnelDealsList filters={filters} focusStage={null} funnelCounts={{}} />);
    expect(await screen.findByText(/Ошибка загрузки/)).toBeInTheDocument();
  });
});
