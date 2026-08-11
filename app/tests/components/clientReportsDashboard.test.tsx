import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientReportsDashboard, resolveDateRange } from '@/components/client-reports/ClientReportsDashboard';
import { clientApiFetch } from '@/lib/clientFetcher';

const mockReplace = jest.fn();
let mockSearch = '';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

jest.mock('@/lib/clientFetcher', () => ({
  clientApiFetch: jest.fn(),
}));

const mockClientApiFetch = clientApiFetch as jest.MockedFunction<typeof clientApiFetch>;

const analyticsFixture = {
  campaigns: [
    { id: 'campaign-a', name: 'Высокий скор', scoreCode: 'A' },
    { id: 'campaign-c', name: 'Средний скор', scoreCode: 'C' },
  ],
  filters: {
    from: '2026-07-08',
    to: '2026-08-06',
    score: 'all',
    campaign: 'all',
  },
  funnel: {
    scoredCompanies: 5_112_878,
    workingScoreCompanies: 61_350,
    emailFoundCompanies: 34_500,
    validatedEmails: 31_980,
    submittedContacts: 30_200,
    confirmedContacts: 30_194,
    byCampaign: [
      {
        campaignId: 'campaign-a',
        campaignName: 'Высокий скор',
        scoreCode: 'A',
        submitted: 12_100,
        confirmed: 12_094,
      },
      {
        campaignId: 'campaign-c',
        campaignName: 'Средний скор',
        scoreCode: 'C',
        submitted: 18_100,
        confirmed: 18_100,
      },
    ],
  },
  freshness: {
    pipelineAt: '2026-08-06T06:45:00.000Z',
  },
  legacyNotice: null,
  qualityNotices: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ClientReportsDashboard', () => {
  beforeEach(() => {
    mockSearch = '';
    mockReplace.mockReset();
    mockClientApiFetch.mockReset();
    mockClientApiFetch.mockResolvedValue(analyticsFixture);
  });

  it('resolves inclusive preset ranges in the business timezone calendar', () => {
    expect(resolveDateRange('7d', '2026-08-06')).toEqual({
      from: '2026-07-31',
      to: '2026-08-06',
    });
    expect(resolveDateRange('30d', '2026-08-06')).toEqual({
      from: '2026-07-08',
      to: '2026-08-06',
    });
    expect(resolveDateRange('current', '2026-08-06')).toEqual({
      from: '2026-08-01',
      to: '2026-08-06',
    });
    expect(resolveDateRange('previous', '2026-08-06')).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('loads the default 30-day slice and renders the base funnel without outreach metrics', async () => {
    render(<ClientReportsDashboard />);

    expect(await screen.findByRole('heading', { name: 'Воронка базы' })).toBeInTheDocument();
    await waitFor(() => expect(mockClientApiFetch).toHaveBeenCalledTimes(1));

    const [path, init] = mockClientApiFetch.mock.calls[0];
    const requestUrl = new URL(String(path), 'http://localhost');
    expect(requestUrl.pathname).toBe('/reports/analytics');
    expect(requestUrl.searchParams.get('preset')).toBe('last_30_days');
    expect(requestUrl.searchParams.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(requestUrl.searchParams.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(requestUrl.searchParams.get('score')).toBe('all');
    expect(requestUrl.searchParams.has('campaign')).toBe(false);
    expect(init).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByRole('button', { name: '30 дней' })).toHaveAttribute('aria-pressed', 'true');

    expect(screen.queryByRole('region', { name: 'Общая статистика' })).not.toBeInTheDocument();
    expect(screen.queryByText('Добавлено в рассылку')).not.toBeInTheDocument();
    expect(screen.queryByText('Писем отправлено')).not.toBeInTheDocument();
    expect(screen.queryByText('Живых ответов')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Кампании/ })).toHaveAttribute('href', '/client');

    const funnel = screen.getByRole('region', { name: 'Воронка компаний, отскоренных в период' });
    const scoredRow = within(funnel).getByRole('row', { name: /Отскорено компаний/ });
    expect(within(scoredRow).getByText('5 112 878')).toBeInTheDocument();
    expect(within(scoredRow).getByText('компаний')).toBeInTheDocument();
    const validatedRow = within(funnel).getByRole('row', { name: /Почта прошла валидацию/ });
    const submittedRow = within(funnel).getByRole('row', { name: /Передано из этой когорты/ });
    expect(within(funnel).getByRole('row', { name: /Принято из этой когорты/ })).toBeInTheDocument();
    expect(within(validatedRow).getByText('—')).toBeInTheDocument();
    expect(within(submittedRow).getByText('—')).toBeInTheDocument();

    const breakdown = screen.getByRole('region', { name: 'По кампаниям и скору' });
    expect(within(breakdown).getByRole('row', { name: /Высокий скор A 12.100 12.094/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Выгрузки баз' })).toBeInTheDocument();
  });

  it('writes period, score, campaign and custom date changes to the URL', async () => {
    const user = userEvent.setup();
    render(<ClientReportsDashboard />);
    await screen.findByText('30 194');

    await user.click(screen.getByRole('button', { name: '7 дней' }));
    expect(mockReplace).toHaveBeenLastCalledWith(expect.stringMatching(/period=7d.*score=all.*campaign=all/));

    await user.click(screen.getByRole('button', { name: 'A' }));
    expect(mockReplace).toHaveBeenLastCalledWith(expect.stringMatching(/score=A/));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Кампания после передачи' }), 'campaign-c');
    expect(mockReplace).toHaveBeenLastCalledWith(expect.stringMatching(/campaign=campaign-c/));
    expect(screen.getByText(/Фильтр кампании действует с этапа передачи контактов/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('С'), { target: { value: '2026-08-02' } });
    fireEvent.change(screen.getByLabelText('По'), { target: { value: '2026-08-05' } });
    expect(mockReplace).toHaveBeenLastCalledWith(expect.stringMatching(/period=custom.*from=2026-08-02.*to=2026-08-05/));
  });

  it('does not let a stale analytics response overwrite the latest filter result', async () => {
    const first = deferred<typeof analyticsFixture>();
    const second = deferred<typeof analyticsFixture>();
    mockClientApiFetch
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const view = render(<ClientReportsDashboard />);
    await waitFor(() => expect(mockClientApiFetch).toHaveBeenCalledTimes(1));

    mockSearch = 'period=7d&from=2026-07-31&to=2026-08-06&score=A&campaign=all';
    view.rerender(<ClientReportsDashboard />);
    await waitFor(() => expect(mockClientApiFetch).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({
        ...analyticsFixture,
        funnel: { ...analyticsFixture.funnel, confirmedContacts: 33 },
      });
    });
    expect(await screen.findByText('33')).toBeInTheDocument();

    await act(async () => {
      first.resolve(analyticsFixture);
    });
    expect(screen.getByText('33')).toBeInTheDocument();
    expect(screen.queryByText('30 194')).not.toBeInTheDocument();
  });

  it('shows an error with retry and a clear empty state', async () => {
    const user = userEvent.setup();
    mockClientApiFetch
      .mockRejectedValueOnce(new Error('Сервис статистики временно недоступен'))
      .mockResolvedValueOnce({
        ...analyticsFixture,
        campaigns: [],
        funnel: {
          ...analyticsFixture.funnel,
          scoredCompanies: 0,
          workingScoreCompanies: 0,
          emailFoundCompanies: 0,
          validatedEmails: 0,
          submittedContacts: 0,
          confirmedContacts: 0,
          byCampaign: [],
        },
      });

    render(<ClientReportsDashboard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Сервис статистики временно недоступен');
    expect(screen.getByRole('region', { name: 'Выгрузки баз' })).toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('За выбранный период данных нет')).toBeInTheDocument();
    expect(mockClientApiFetch).toHaveBeenCalledTimes(2);
  });

  it('shows data-quality notices without restoring the removed outreach metrics', async () => {
    mockClientApiFetch.mockResolvedValueOnce({
      ...analyticsFixture,
      qualityNotices: [
        'Фильтр кампании применяется с этапа передачи контактов.',
        '3 ответа ещё не классифицированы.',
      ],
    });

    render(<ClientReportsDashboard />);

    const notice = await screen.findByRole('region', { name: 'Ограничения данных' });
    expect(notice).toHaveTextContent('Фильтр кампании применяется с этапа передачи контактов.');
    expect(notice).toHaveTextContent('3 ответа ещё не классифицированы.');
    expect(screen.queryByText('известные автоответы исключены')).not.toBeInTheDocument();
  });

  it('keeps exports available and working when analytics fails', async () => {
    const user = userEvent.setup();
    mockClientApiFetch.mockImplementation((path, init) => {
      if (path === '/reports/exports' && init?.method === 'POST') {
        return Promise.resolve({ job: { id: 'export-without-analytics', status: 'cancelled' } });
      }
      return Promise.reject(new Error('Аналитика недоступна'));
    });

    render(<ClientReportsDashboard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Аналитика недоступна');

    const exportsRegion = screen.getByRole('region', { name: 'Выгрузки баз' });
    await user.click(within(exportsRegion).getByRole('button', { name: 'Выгрузить рабочий скор' }));

    await waitFor(() => {
      expect(mockClientApiFetch).toHaveBeenCalledWith(
        '/reports/exports',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await within(exportsRegion).findByText(/Выгрузка отменена/)).toBeInTheDocument();
  });

  it('explains that rejected export ignores score and campaign filters', async () => {
    render(<ClientReportsDashboard />);

    expect(await screen.findByText(
      'Выгрузка всегда включает все компании, которые не попали в A, B или C за выбранный период. Фильтры скора и кампании к ней не применяются.',
    )).toBeInTheDocument();
  });

  it('creates an export job, polls it and starts the returned download', async () => {
    const user = userEvent.setup();
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mockClientApiFetch.mockImplementation((path, init) => {
      if (path === '/reports/exports' && init?.method === 'POST') {
        return Promise.resolve({ job: { id: 'export-1', status: 'running' } });
      }
      if (path === '/reports/exports/export-1') {
        return Promise.resolve({
          job: {
            id: 'export-1',
            status: 'completed',
            downloadUrl: '/api/client/reports/exports/export-1/download',
          },
        });
      }
      return Promise.resolve(analyticsFixture);
    });

    render(<ClientReportsDashboard />);
    await screen.findByText('30 194');
    await user.click(screen.getByRole('button', { name: 'Выгрузить неподходящие' }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    const postCall = mockClientApiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(postCall?.[0]).toBe('/reports/exports');
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      kind: 'rejected',
      filters: expect.objectContaining({ preset: 'last_30_days', score: 'all' }),
    });
    expect(JSON.parse(String(postCall?.[1]?.body)).filters).not.toHaveProperty('campaign');
    expect(mockClientApiFetch).toHaveBeenCalledWith(
      '/reports/exports/export-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    clickSpy.mockRestore();
  });

  it('stops polling and makes retry available when an export is cancelled', async () => {
    const user = userEvent.setup();
    mockClientApiFetch.mockImplementation((path, init) => {
      if (path === '/reports/exports' && init?.method === 'POST') {
        return Promise.resolve({ job: { id: 'export-cancelled', status: 'cancelled' } });
      }
      return Promise.resolve(analyticsFixture);
    });

    render(<ClientReportsDashboard />);
    await screen.findByText('30 194');
    const button = screen.getByRole('button', { name: 'Выгрузить неподходящие' });
    await user.click(button);

    expect(await screen.findByText('Выгрузка отменена. Запустите её повторно.')).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(mockClientApiFetch).not.toHaveBeenCalledWith(
      '/reports/exports/export-cancelled',
      expect.anything(),
    );
  });
});
