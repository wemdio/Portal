import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamReviewRequestsPanel from '@/components/team/TeamReviewRequestsPanel';
import { TeamApiError } from '@/components/team/teamApi';

const mockTeamApiFetch = jest.fn();

jest.mock('@/components/team/teamApi', () => ({
  ...jest.requireActual('@/components/team/teamApi'),
  teamApiFetch: (...args: unknown[]) => mockTeamApiFetch(...args),
}));

type PersonOption = {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
};

type ProjectOption = {
  id: string;
  name: string;
};

type ReviewRequestItem = {
  id: string;
  state: 'new' | 'in_progress' | 'converted' | 'declined';
  employee: PersonOption;
  initiator: PersonOption;
  project: ProjectOption | null;
  problem: string;
  examples: string | null;
  desiredOutcome: string;
  claimedBy: { id: string; name: string } | null;
  linkedReviewId: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
};

const employee: PersonOption = {
  id: 'employee-1',
  name: 'Анна Ким',
  email: 'anna@example.com',
  avatarUrl: null,
};

const initiator: PersonOption = {
  id: 'lead-1',
  name: 'Иван Руководитель',
  email: 'lead@example.com',
  avatarUrl: null,
};

const project: ProjectOption = {
  id: 'project-1',
  name: 'Acme · Аутрич',
};

const newRequest: ReviewRequestItem = {
  id: 'request-new',
  state: 'new',
  employee,
  initiator,
  project,
  problem: 'Специалисту не хватает контекста перед запуском',
  examples: 'Обсуждение: https://t.me/c/123/456',
  desiredOutcome: 'Зафиксировать следующий шаг и владельца',
  claimedBy: null,
  linkedReviewId: null,
  decisionNote: null,
  createdAt: '2026-08-11T08:00:00.000Z',
  updatedAt: '2026-08-11T08:00:00.000Z',
};

const inProgressRequest: ReviewRequestItem = {
  ...newRequest,
  id: 'request-progress',
  state: 'in_progress',
  problem: 'Нужно разобрать приоритеты по проектам',
  claimedBy: { id: 'hr-1', name: 'Алина' },
  updatedAt: '2026-08-11T09:00:00.000Z',
};

const convertedRequest: ReviewRequestItem = {
  ...newRequest,
  id: 'request-converted',
  state: 'converted',
  problem: 'Ревью уже запланировано',
  linkedReviewId: 'review-1',
  updatedAt: '2026-08-11T10:00:00.000Z',
};

const declinedRequest: ReviewRequestItem = {
  ...newRequest,
  id: 'request-declined',
  state: 'declined',
  problem: 'Отдельное ревью не требуется',
  decisionNote: 'Сначала обсудить внутри команды',
  updatedAt: '2026-08-11T11:00:00.000Z',
};

let response: {
  groups: Array<{
    state: ReviewRequestItem['state'];
    requests: ReviewRequestItem[];
  }>;
  summary: {
    total: number;
    newCount: number;
    inProgressCount: number;
    convertedCount: number;
    declinedCount: number;
  };
  employees: PersonOption[];
  projects: ProjectOption[];
  canManage: boolean;
};

function defaultResponse(overrides: Partial<typeof response> = {}): typeof response {
  return {
    groups: [
      { state: 'new', requests: [newRequest] },
      { state: 'in_progress', requests: [inProgressRequest] },
      { state: 'converted', requests: [convertedRequest] },
      { state: 'declined', requests: [declinedRequest] },
    ],
    summary: {
      total: 4,
      newCount: 1,
      inProgressCount: 1,
      convertedCount: 1,
      declinedCount: 1,
    },
    employees: [employee],
    projects: [project],
    canManage: true,
    ...overrides,
  };
}

function responseWithOnly(request: ReviewRequestItem): typeof response {
  return defaultResponse({
    groups: (['new', 'in_progress', 'converted', 'declined'] as const).map((state) => ({
      state,
      requests: request.state === state ? [request] : [],
    })),
    summary: {
      total: 1,
      newCount: request.state === 'new' ? 1 : 0,
      inProgressCount: request.state === 'in_progress' ? 1 : 0,
      convertedCount: request.state === 'converted' ? 1 : 0,
      declinedCount: request.state === 'declined' ? 1 : 0,
    },
  });
}

function requestToggle(requestId: string): HTMLButtonElement {
  const toggle = screen.getAllByRole('button').find((button) => (
    button.getAttribute('aria-controls') === `review-request-details-${requestId}`
  ));
  if (!(toggle instanceof HTMLButtonElement)) throw new Error(`Toggle for ${requestId} not found`);
  return toggle;
}

function sectionForHeading(name: string) {
  const section = screen.getByRole('heading', { name }).closest('section');
  if (!section) throw new Error(`Section for ${name} not found`);
  return section;
}

function apiBody(method: string, url: string) {
  const call = mockTeamApiFetch.mock.calls.find(([calledUrl, init]) => (
    calledUrl === url && ((init as RequestInit | undefined)?.method || 'GET') === method
  ));
  if (!call) throw new Error(`${method} ${url} was not called`);
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe('<TeamReviewRequestsPanel />', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-08-11T09:00:00.000Z') });
    response = defaultResponse();
    mockTeamApiFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      if (url === '/api/team/review-requests' && method === 'GET') return response;
      if (url.startsWith('/api/team/review-requests/') && method === 'PATCH') return { request: inProgressRequest };
      if (url.endsWith('/convert') && method === 'POST') {
        return {
          request: convertedRequest,
          review: { id: 'review-1', reviewDate: '2026-08-15', status: 'scheduled' },
        };
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders stable new, in-progress, converted and declined groups as an expandable responsive inbox', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={jest.fn()} />);

    const region = screen.getByRole('region', { name: 'Запросы на ревью' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(region).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(region).toHaveClass('min-w-0', 'overflow-hidden');

    expect(sectionForHeading('Новые')).toHaveTextContent(newRequest.problem);
    expect(sectionForHeading('В работе')).toHaveTextContent(inProgressRequest.problem);
    expect(sectionForHeading('Ревью запланировано')).toHaveTextContent(convertedRequest.problem);
    expect(sectionForHeading('Не требуется')).toHaveTextContent(declinedRequest.problem);
    expect(sectionForHeading('Новые')).toHaveAttribute('aria-labelledby', 'review-request-group-new');
    expect(within(sectionForHeading('Новые')).getAllByRole('listitem')).toHaveLength(1);

    const row = screen.getByRole('button', { name: /Анна Ким.*Acme.*Новый/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveClass('min-h-11');
    await user.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('region', { name: 'Детали запроса Анна Ким' });
    expect(details).toHaveTextContent('Иван Руководитель');
    expect(details).toHaveTextContent('Acme · Аутрич');
    expect(details).toHaveTextContent('Проблема / причина');
    expect(details).toHaveTextContent(newRequest.problem);
    expect(details).toHaveTextContent(newRequest.desiredOutcome);
    const discussion = within(details).getByRole('link', { name: /обсуждение/i });
    expect(discussion).toHaveAttribute('href', 'https://t.me/c/123/456');
    expect(discussion).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('uses only the new group for the visible queue count and never marks a row processed on expand', async () => {
    const onChanged = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={onChanged} />);
    await screen.findByText(newRequest.problem);

    expect(screen.getByText('1 новый')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Анна Ким.*Acme.*Новый/ }));

    expect(mockTeamApiFetch).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByText('1 новый')).toBeInTheDocument();
  });

  it('claims a new request with its CAS token and refreshes the shared badge after success', async () => {
    const onChanged = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={onChanged} />);
    await screen.findByText(newRequest.problem);
    await user.click(screen.getByRole('button', { name: /Анна Ким.*Acme.*Новый/ }));
    await user.click(screen.getByRole('button', { name: 'Взять в работу' }));

    await waitFor(() => expect(apiBody(
      'PATCH',
      '/api/team/review-requests/request-new',
    )).toEqual({
      action: 'claim',
      expectedUpdatedAt: newRequest.updatedAt,
    }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'claim',
      initial: newRequest,
      transitioned: {
        ...newRequest,
        state: 'in_progress' as const,
        claimedBy: { id: 'hr-1', name: 'Алина' },
        updatedAt: '2026-08-11T12:00:00.000Z',
      },
      openAction: 'Взять в работу',
      confirmAction: null,
      method: 'PATCH',
      endpoint: '/api/team/review-requests/request-new',
      success: 'Запрос взят в работу',
    },
    {
      label: 'decline',
      initial: newRequest,
      transitioned: {
        ...newRequest,
        state: 'declined' as const,
        decisionNote: 'Ревью не требуется',
        updatedAt: '2026-08-11T12:00:00.000Z',
      },
      openAction: 'Закрыть без ревью',
      confirmAction: 'Подтвердить: ревью не требуется',
      method: 'PATCH',
      endpoint: '/api/team/review-requests/request-new',
      success: 'Запрос закрыт без ревью',
    },
    {
      label: 'convert',
      initial: inProgressRequest,
      transitioned: {
        ...inProgressRequest,
        state: 'converted' as const,
        linkedReviewId: 'review-1',
        updatedAt: '2026-08-11T12:00:00.000Z',
      },
      openAction: 'Запланировать ревью',
      confirmAction: 'Создать ревью',
      method: 'POST',
      endpoint: '/api/team/review-requests/request-progress/convert',
      success: 'Ревью запланировано',
    },
  ])('announces $label success and focuses the updated row after it changes group', async ({
    initial,
    transitioned,
    openAction,
    confirmAction,
    method,
    endpoint,
    success,
  }) => {
    response = responseWithOnly(initial);
    mockTeamApiFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const requestMethod = init.method || 'GET';
      if (url === '/api/team/review-requests' && requestMethod === 'GET') return response;
      if (url === endpoint && requestMethod === method) {
        response = responseWithOnly(transitioned);
        return method === 'POST'
          ? { request: transitioned, review: { id: 'review-1', reviewDate: '2026-08-11', status: 'scheduled' } }
          : { request: transitioned };
      }
      throw new Error(`Unexpected request: ${requestMethod} ${url}`);
    });
    const onChanged = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={onChanged} />);
    await screen.findByText(initial.problem);

    await user.click(requestToggle(initial.id));
    await user.click(screen.getByRole('button', { name: openAction }));
    if (confirmAction) await user.click(screen.getByRole('button', { name: confirmAction }));

    const status = await screen.findByRole('status', { name: 'Действие с запросом выполнено' });
    expect(status).toHaveTextContent(success);
    expect(status).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(requestToggle(initial.id)).toHaveFocus());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('declines a request explicitly with CAS instead of treating opening as processing', async () => {
    const onChanged = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={onChanged} />);
    await screen.findByText(newRequest.problem);
    await user.click(screen.getByRole('button', { name: /Анна Ким.*Acme.*Новый/ }));
    await user.click(screen.getByRole('button', { name: 'Закрыть без ревью' }));
    const confirm = screen.getByRole('button', { name: 'Подтвердить: ревью не требуется' });
    expect(confirm).toHaveFocus();
    const decisionNote = screen.getByLabelText('Комментарий к решению, необязательно');
    expect(decisionNote).toHaveAttribute('maxlength', '1000');
    await user.type(decisionNote, '  Сначала обсудить внутри команды  ');
    await user.click(confirm);

    await waitFor(() => expect(apiBody(
      'PATCH',
      '/api/team/review-requests/request-new',
    )).toEqual({
      action: 'decline',
      decisionNote: 'Сначала обсудить внутри команды',
      expectedUpdatedAt: newRequest.updatedAt,
    }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('moves focus into action forms and restores it to each originating button on cancel', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={jest.fn()} />);
    await screen.findByText(newRequest.problem);

    await user.click(screen.getByRole('button', { name: /Анна Ким.*Acme.*Новый/ }));
    const declineTrigger = screen.getByRole('button', { name: 'Закрыть без ревью' });
    await user.click(declineTrigger);
    const declineForm = screen.getByRole('form', { name: 'Закрытие запроса без ревью' });
    expect(within(declineForm).getByRole('button', { name: 'Подтвердить: ревью не требуется' })).toHaveFocus();
    await user.click(within(declineForm).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Закрыть без ревью' })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: /Анна Ким.*Acme.*В работе/ }));
    const conversionTrigger = screen.getByRole('button', { name: 'Запланировать ревью' });
    await user.click(conversionTrigger);
    const conversionForm = screen.getByRole('form', { name: 'Запланировать ревью по запросу' });
    expect(within(conversionForm).getByLabelText('Дата ревью')).toHaveFocus();
    await user.click(within(conversionForm).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Запланировать ревью' })).toHaveFocus());
  });

  it('locks other queue actions while a decline or conversion draft is open', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={jest.fn()} />);
    await screen.findByText(newRequest.problem);

    const newRow = screen.getByRole('button', { name: /Анна Ким.*Acme.*Новый/ });
    const progressRow = screen.getByRole('button', { name: /Анна Ким.*Acme.*В работе/ });
    await user.click(newRow);
    await user.click(progressRow);
    const newDetails = newRow.closest('article');
    const progressDetails = progressRow.closest('article');
    if (!newDetails || !progressDetails) throw new Error('Review request rows not found');

    await user.click(within(progressDetails).getByRole('button', { name: 'Запланировать ревью' }));
    const conversionForm = within(progressDetails).getByRole('form', { name: 'Запланировать ревью по запросу' });
    const reason = within(conversionForm).getByLabelText('Причина и контекст ревью');
    await user.clear(reason);
    await user.type(reason, 'Черновик конвертации нельзя заменить');
    const newClaim = within(newDetails).getByRole('button', { name: 'Взять в работу' });
    const newDecline = within(newDetails).getByRole('button', { name: 'Закрыть без ревью' });

    expect(newClaim).toBeDisabled();
    expect(newDecline).toBeDisabled();
    await user.click(newDecline);
    expect(reason).toHaveValue('Черновик конвертации нельзя заменить');
    expect(within(newDetails).queryByRole('form', { name: 'Закрытие запроса без ревью' })).not.toBeInTheDocument();

    await user.click(within(conversionForm).getByRole('button', { name: 'Отмена' }));
    await user.click(within(newDetails).getByRole('button', { name: 'Закрыть без ревью' }));
    const declineForm = within(newDetails).getByRole('form', { name: 'Закрытие запроса без ревью' });
    const note = within(declineForm).getByLabelText('Комментарий к решению, необязательно');
    await user.type(note, 'Черновик решения нельзя заменить');
    const progressConvert = within(progressDetails).getByRole('button', { name: 'Запланировать ревью' });

    expect(progressConvert).toBeDisabled();
    await user.click(progressConvert);
    expect(note).toHaveValue('Черновик решения нельзя заменить');
    expect(within(progressDetails).queryByRole('form', { name: 'Запланировать ревью по запросу' })).not.toBeInTheDocument();
  });

  it('converts a request with prefilled review date and reason, then links the created review', async () => {
    const onChanged = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={onChanged} />);
    await screen.findByText(inProgressRequest.problem);
    await user.click(screen.getByRole('button', { name: /Анна Ким.*Acme.*В работе/ }));
    await user.click(screen.getByRole('button', { name: 'Запланировать ревью' }));

    const form = screen.getByRole('form', { name: 'Запланировать ревью по запросу' });
    expect(within(form).getByLabelText('Дата ревью')).toHaveValue('2026-08-11');
    const reason = within(form).getByLabelText('Причина и контекст ревью');
    expect(reason).toHaveAttribute('maxlength', '500');
    expect((reason as HTMLTextAreaElement).value).toContain(inProgressRequest.problem);
    expect((reason as HTMLTextAreaElement).value).toContain(project.name);

    await user.click(within(form).getByRole('button', { name: 'Создать ревью' }));
    const body = apiBody(
      'POST',
      '/api/team/review-requests/request-progress/convert',
    );
    expect(body).toEqual({
      reviewDate: '2026-08-11',
      reviewReason: expect.stringContaining(inProgressRequest.problem),
      expectedUpdatedAt: inProgressRequest.updatedAt,
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    response = defaultResponse({
      groups: [
        { state: 'new', requests: [] },
        { state: 'in_progress', requests: [] },
        { state: 'converted', requests: [convertedRequest] },
        { state: 'declined', requests: [declinedRequest] },
      ],
    });
    await user.click(screen.getByRole('button', { name: /Анна Ким.*Ревью запланировано/ }));
    expect(screen.getByText('Связано с ревью')).toBeInTheDocument();
  });

  it('reloads a conflicting request, keeps the draft and retries with the refreshed CAS token', async () => {
    const refreshedRequest = {
      ...inProgressRequest,
      claimedBy: { id: 'hr-2', name: 'Сергей' },
      updatedAt: '2026-08-11T10:30:00.000Z',
    };
    let conversionAttempts = 0;
    mockTeamApiFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      if (url === '/api/team/review-requests' && method === 'GET') {
        if (conversionAttempts === 0) return response;
        return defaultResponse({
          groups: [
            { state: 'new', requests: [newRequest] },
            { state: 'in_progress', requests: [refreshedRequest] },
            { state: 'converted', requests: [convertedRequest] },
            { state: 'declined', requests: [declinedRequest] },
          ],
        });
      }
      if (url === '/api/team/review-requests/request-progress/convert' && method === 'POST') {
        conversionAttempts += 1;
        if (conversionAttempts === 1) {
          throw new TeamApiError('Запрос уже изменился', 409, { code: 'review_request_conflict' });
        }
        return {
          request: convertedRequest,
          review: { id: 'review-1', reviewDate: '2026-08-20', status: 'scheduled' },
        };
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={jest.fn()} />);
    await screen.findByText(inProgressRequest.problem);
    await user.click(screen.getByRole('button', { name: /Анна Ким.*Acme.*В работе/ }));
    await user.click(screen.getByRole('button', { name: 'Запланировать ревью' }));
    const form = screen.getByRole('form', { name: 'Запланировать ревью по запросу' });
    const reason = within(form).getByLabelText('Причина и контекст ревью');
    await user.clear(reason);
    await user.type(reason, 'Мой уточнённый черновик');
    const reviewDate = within(form).getByLabelText('Дата ревью');
    await user.clear(reviewDate);
    await user.type(reviewDate, '2026-08-20');
    await user.click(within(form).getByRole('button', { name: 'Создать ревью' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/уже изменил|уже изменился/i);
    expect(reason).toHaveValue('Мой уточнённый черновик');
    expect(within(form).getByLabelText('Дата ревью')).toHaveValue('2026-08-20');

    await user.click(screen.getByRole('button', { name: 'Обновить данные запроса' }));
    const refreshedStatus = await screen.findByRole('status', { name: 'Запрос обновлён' });
    expect(refreshedStatus).toHaveTextContent(/черновик сохранён/i);
    expect(refreshedStatus).toHaveFocus();
    expect(reason).toHaveValue('Мой уточнённый черновик');
    expect(within(form).getByLabelText('Дата ревью')).toHaveValue('2026-08-20');

    await user.click(within(form).getByRole('button', { name: 'Создать ревью' }));
    const conversionCalls = mockTeamApiFetch.mock.calls.filter(([url, init]) => (
      url === '/api/team/review-requests/request-progress/convert'
      && (init as RequestInit | undefined)?.method === 'POST'
    ));
    expect(JSON.parse(String((conversionCalls.at(-1)?.[1] as RequestInit).body))).toEqual({
      reviewDate: '2026-08-20',
      reviewReason: 'Мой уточнённый черновик',
      expectedUpdatedAt: refreshedRequest.updatedAt,
    });
  });

  it('keeps conflict recovery and the draft visible when refreshing current data fails', async () => {
    let getAttempts = 0;
    mockTeamApiFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      if (url === '/api/team/review-requests' && method === 'GET') {
        getAttempts += 1;
        if (getAttempts === 1) return response;
        throw new Error('Сеть недоступна');
      }
      if (url === '/api/team/review-requests/request-progress/convert' && method === 'POST') {
        throw new TeamApiError('Запрос уже изменился', 409, { code: 'review_request_conflict' });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={jest.fn()} />);
    await screen.findByText(inProgressRequest.problem);
    await user.click(screen.getByRole('button', { name: /Анна Ким.*Acme.*В работе/ }));
    await user.click(screen.getByRole('button', { name: 'Запланировать ревью' }));
    const form = screen.getByRole('form', { name: 'Запланировать ревью по запросу' });
    const reason = within(form).getByLabelText('Причина и контекст ревью');
    await user.clear(reason);
    await user.type(reason, 'Черновик, который нельзя потерять');
    await user.click(within(form).getByRole('button', { name: 'Создать ревью' }));

    const refresh = await screen.findByRole('button', { name: 'Обновить данные запроса' });
    await user.click(refresh);

    expect(await screen.findByRole('alert', { name: 'Ошибка обновления списка' })).toHaveTextContent('Сеть недоступна');
    expect(screen.getByRole('button', { name: 'Обновить данные запроса' })).toBeInTheDocument();
    expect(reason).toHaveValue('Черновик, который нельзя потерять');
    expect(screen.getByRole('button', { name: 'Обновить данные запроса' })).toHaveFocus();
  });

  it('bounds a long conversion prefill to the review limit and uses the Moscow calendar date', async () => {
    jest.setSystemTime(new Date('2026-08-10T21:30:00.000Z'));
    const longRequest = {
      ...inProgressRequest,
      project: { id: 'long-project', name: `Проект ${'П'.repeat(190)}` },
      problem: `Проблема ${'А'.repeat(492)}`,
      desiredOutcome: `Результат ${'Б'.repeat(991)}`,
    };
    response = defaultResponse({
      groups: [
        { state: 'new', requests: [] },
        { state: 'in_progress', requests: [longRequest] },
        { state: 'converted', requests: [] },
        { state: 'declined', requests: [] },
      ],
    });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={jest.fn()} />);
    await screen.findByText(longRequest.problem);
    await user.click(screen.getByRole('button', { name: /Анна Ким.*Проект.*В работе/ }));
    await user.click(screen.getByRole('button', { name: 'Запланировать ревью' }));

    const form = screen.getByRole('form', { name: 'Запланировать ревью по запросу' });
    expect(within(form).getByLabelText('Дата ревью')).toHaveValue('2026-08-11');
    const prefill = (within(form).getByLabelText('Причина и контекст ревью') as HTMLTextAreaElement).value;
    expect(prefill.length).toBeLessThanOrEqual(500);
    expect(prefill).toContain('Проект:');
    expect(prefill).toContain('Проблема:');
  });

  it('renders every safe http(s) example link and never turns other schemes into links', async () => {
    const multiLinkRequest = {
      ...newRequest,
      examples: 'Чат https://t.me/c/123/456 и документ https://docs.example.com/case, javascript:alert(1)',
    };
    response = defaultResponse({
      groups: [
        { state: 'new', requests: [multiLinkRequest] },
        { state: 'in_progress', requests: [] },
        { state: 'converted', requests: [] },
        { state: 'declined', requests: [] },
      ],
    });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={jest.fn()} />);
    await screen.findByText(multiLinkRequest.problem);
    await user.click(screen.getByRole('button', { name: /Анна Ким.*Acme.*Новый/ }));

    const links = screen.getAllByRole('link', { name: /открыть обсуждение/i });
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://t.me/c/123/456',
      'https://docs.example.com/case',
    ]);
    expect(screen.queryByRole('link', { name: /javascript/i })).not.toBeInTheDocument();
  });

  it('shows linked reviews in history while read-only mode hides queue actions', async () => {
    response = defaultResponse({ canManage: false });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TeamReviewRequestsPanel onChanged={jest.fn()} />);
    await screen.findByText(convertedRequest.problem);

    expect(screen.queryByRole('button', { name: 'Взять в работу' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Запланировать ревью' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Анна Ким.*Ревью запланировано/ }));
    expect(screen.getByText('Связано с ревью')).toBeInTheDocument();
  });

  it('uses shared dark-theme tokens, reduced-motion loading and wrapped list rows', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/components/team/TeamReviewRequestsPanel.tsx'),
      'utf8',
    );
    expect(source).not.toContain('dark:');
    expect(source).not.toMatch(/<table\b/i);
    expect(source).toContain('motion-reduce:animate-none');
    expect(source).toMatch(/break-(?:words|all)/);
  });
});
