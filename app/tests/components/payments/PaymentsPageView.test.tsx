import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import PaymentsPageView from '@/app/payments/PaymentsPageView';

const mockAuthFetch = jest.fn();
const mockAuthFetchJson = jest.fn();
const mockDirectSupabaseFrom = jest.fn();
const mockGetSession = jest.fn();
const mockCurrentMoscowDate = jest.fn(() => '2026-08-18');

jest.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
  authFetchJson: (...args: unknown[]) => mockAuthFetchJson(...args),
}));

jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
    from: (...args: unknown[]) => mockDirectSupabaseFrom(...args),
  },
}));

jest.mock('@/lib/calendarDate', () => ({
  currentMoscowDate: () => mockCurrentMoscowDate(),
}));

type ExpenseType = 'one_time' | 'planned' | 'legacy_unclassified';
type Urgency = 'normal' | 'urgent' | 'critical';
type PaymentStatus = 'pending' | 'approved' | 'paid' | 'rejected';

interface PaymentRequestFixture {
  id: string;
  requester: { id: string; name: string };
  department: string;
  description: string;
  amount: number;
  project: { id: string; client: string; name: string } | null;
  comment: string | null;
  expenseType: ExpenseType;
  expectedPaymentOn: string;
  urgency: Urgency;
  documentUrl: string | null;
  status: PaymentStatus;
  approvalReason: 'planned' | 'limit_exceeded' | null;
  decisionComment: string | null;
  paidOn: string | null;
  paidOnSource: 'entered' | 'legacy_created_at' | null;
  createdAt: string;
  updatedAt: string;
}

interface PaymentsSummaryFixture {
  limit: number;
  paidOneTime: number;
  reservedOneTime: number;
  usedOneTime: number;
  remaining: number;
  overage: number;
  usagePct: number;
  level: 'normal' | 'warning' | 'exceeded';
  legacyCount: number;
  legacyAmount: number;
  paidAll: number;
  pendingCount: number;
  approvedCount: number;
}

interface PaymentsResponseFixture {
  period: {
    key: string;
    label: string;
    previous: string;
    next: string;
    asOf: string;
  };
  summary: PaymentsSummaryFixture;
  requests: PaymentRequestFixture[];
  projects: Array<{ id: string; client: string; name: string }>;
  canManage: boolean;
}

const DEFAULT_SUMMARY: PaymentsSummaryFixture = {
  limit: 75_000,
  paidOneTime: 20_000,
  reservedOneTime: 40_000,
  usedOneTime: 60_000,
  remaining: 15_000,
  overage: 0,
  usagePct: 80,
  level: 'warning',
  legacyCount: 0,
  legacyAmount: 0,
  paidAll: 20_000,
  pendingCount: 1,
  approvedCount: 1,
};

const LEGACY_SUMMARY: PaymentsSummaryFixture = {
  limit: 75_000,
  paidOneTime: 114_170,
  reservedOneTime: 0,
  usedOneTime: 114_170,
  remaining: 0,
  overage: 39_170,
  usagePct: 152.2267,
  level: 'exceeded',
  legacyCount: 42,
  legacyAmount: 114_170,
  paidAll: 114_170,
  pendingCount: 0,
  approvedCount: 0,
};

const SINGLE_LEGACY_SUMMARY: PaymentsSummaryFixture = {
  ...LEGACY_SUMMARY,
  legacyCount: 1,
};

const CLASSIFIED_PLANNED_SUMMARY: PaymentsSummaryFixture = {
  limit: 75_000,
  paidOneTime: 0,
  reservedOneTime: 0,
  usedOneTime: 0,
  remaining: 75_000,
  overage: 0,
  usagePct: 0,
  level: 'normal',
  legacyCount: 0,
  legacyAmount: 0,
  paidAll: 114_170,
  pendingCount: 0,
  approvedCount: 0,
};

function payment(overrides: Partial<PaymentRequestFixture> = {}): PaymentRequestFixture {
  return {
    id: 'payment-default',
    requester: { id: 'user-current', name: 'Сергей Лазуткин' },
    department: 'outreach',
    description: 'База для проекта Acme',
    amount: 10_000,
    project: { id: 'project-1', client: 'Acme', name: 'Аутрич' },
    comment: 'Нужна для запуска',
    expenseType: 'one_time',
    expectedPaymentOn: '2026-08-20',
    urgency: 'normal',
    documentUrl: 'https://files.example.com/invoice-acme.pdf',
    status: 'approved',
    approvalReason: null,
    decisionComment: null,
    paidOn: null,
    paidOnSource: null,
    createdAt: '2026-08-12T09:00:00.000Z',
    updatedAt: '2026-08-12T09:00:00.000Z',
    ...overrides,
  };
}

function legacyPayment(overrides: Partial<PaymentRequestFixture> = {}): PaymentRequestFixture {
  return payment({
    id: 'payment-legacy',
    description: 'Старый расход без классификации',
    amount: 114_170,
    project: null,
    comment: null,
    expenseType: 'legacy_unclassified',
    expectedPaymentOn: '2026-08-03',
    urgency: 'normal',
    documentUrl: null,
    status: 'paid',
    paidOn: '2026-08-03',
    paidOnSource: 'legacy_created_at',
    createdAt: '2026-08-03T08:30:00.000Z',
    updatedAt: '2026-08-03T08:30:00.000Z',
    ...overrides,
  });
}

function paymentsResponse({
  period,
  summary,
  requests,
  projects,
  canManage = false,
}: {
  period?: Partial<PaymentsResponseFixture['period']>;
  summary?: Partial<PaymentsSummaryFixture>;
  requests?: PaymentRequestFixture[];
  projects?: PaymentsResponseFixture['projects'];
  canManage?: boolean;
} = {}): PaymentsResponseFixture {
  return {
    period: {
      key: '2026-08',
      label: 'Август 2026',
      previous: '2026-07',
      next: '2026-09',
      asOf: '2026-08-18',
      ...period,
    },
    summary: { ...DEFAULT_SUMMARY, ...summary },
    requests: requests ?? [payment()],
    projects: projects ?? [
      { id: 'project-1', client: 'Acme', name: 'Аутрич' },
      { id: 'project-2', client: 'BPMSoft', name: 'Перфоманс' },
    ],
    canManage,
  };
}

type PostResult = {
  request: PaymentRequestFixture;
  summary: PaymentsSummaryFixture;
  outcome: 'auto_approved' | 'approval_required';
};

type PatchResult = {
  request: PaymentRequestFixture;
  summaries: Array<{ month: string; summary: PaymentsSummaryFixture }>;
  outcome: 'approved' | 'rejected' | 'paid' | 'legacy_classified';
};

interface ApiOptions {
  getResult?: Promise<PaymentsResponseFixture>;
  getResultAfterRetry?: PaymentsResponseFixture;
  getErrorOnce?: string;
  postResult?: PostResult | Promise<PostResult>;
  patchResult?: PatchResult | Promise<PatchResult>;
  postError?: string;
  patchError?: {
    status: number;
    error: string;
    code?: string;
  };
  patchErrorOnce?: {
    status: number;
    error: string;
    code?: string;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String((input as { url?: unknown })?.url ?? input);
}

function setupApi(seed = paymentsResponse(), options: ApiOptions = {}) {
  let getAttempts = 0;
  let patchAttempts = 0;
  const dispatch = async (input: unknown, init: RequestInit = {}) => {
    const url = requestUrl(input);
    const method = (init.method || 'GET').toUpperCase();

    if (/^\/api\/payments\?month=\d{4}-\d{2}$/.test(url) && method === 'GET') {
      getAttempts += 1;
      if (options.getErrorOnce && getAttempts === 1) {
        return { status: 500, body: { error: options.getErrorOnce } };
      }
      if (getAttempts > 1 && options.getResultAfterRetry) {
        return { status: 200, body: options.getResultAfterRetry };
      }
      return { status: 200, body: options.getResult ? await options.getResult : seed };
    }
    if (url === '/api/payments' && method === 'POST') {
      if (options.postError) return { status: 500, body: { error: options.postError } };
      return {
        status: 200,
        body: options.postResult ? await options.postResult : {
          request: payment({ id: 'payment-created' }),
          summary: seed.summary,
          outcome: 'auto_approved' as const,
        },
      };
    }
    if (/^\/api\/payments\/[^/]+$/.test(url) && method === 'PATCH') {
      patchAttempts += 1;
      if (options.patchErrorOnce && patchAttempts === 1) {
        return {
          status: options.patchErrorOnce.status,
          body: { error: options.patchErrorOnce.error, code: options.patchErrorOnce.code },
        };
      }
      if (options.patchError) {
        return {
          status: options.patchError.status,
          body: { error: options.patchError.error, code: options.patchError.code },
        };
      }
      return {
        status: 200,
        body: options.patchResult ? await options.patchResult : {
          request: payment({ id: url.split('/').pop() }),
          summaries: [{ month: seed.period.key, summary: seed.summary }],
          outcome: 'approved' as const,
        },
      };
    }
    return { status: 500, body: { error: `Unexpected request: ${method} ${url}` } };
  };

  mockAuthFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const result = await dispatch(input, init);
    return jsonResponse(result.body, result.status);
  });
  mockAuthFetchJson.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const result = await dispatch(input, init);
    if (result.status < 200 || result.status >= 300) {
      const body = result.body as { error?: string };
      throw new Error(body.error || `Ошибка ${result.status}`);
    }
    return result.body;
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function emptySupabaseQuery() {
  const result = Promise.resolve({ data: [], error: null });
  const query: Record<string, unknown> & PromiseLike<{ data: unknown[]; error: null }> = {
    select: () => query,
    order: () => result,
    eq: () => query,
    then: result.then.bind(result),
  };
  return query;
}

function apiCalls(): Array<[unknown, RequestInit | undefined]> {
  return [
    ...mockAuthFetch.mock.calls,
    ...mockAuthFetchJson.mock.calls,
  ] as Array<[unknown, RequestInit | undefined]>;
}

function findApiCall(method: string, url: string | RegExp) {
  return apiCalls().find(([input, init]) => {
    const actualUrl = requestUrl(input);
    const expectedMethod = (init?.method || 'GET').toUpperCase();
    const urlMatches = typeof url === 'string' ? actualUrl === url : url.test(actualUrl);
    return expectedMethod === method && urlMatches;
  });
}

function bodyOf(call: [unknown, RequestInit | undefined] | undefined): Record<string, unknown> {
  if (!call) throw new Error('API call not found');
  return JSON.parse(String(call[1]?.body || '{}')) as Record<string, unknown>;
}

function rowFor(description: string): HTMLElement {
  const row = screen.getByText(description).closest('[data-payment-row]');
  if (!row) throw new Error(`Payment row not found: ${description}`);
  return row as HTMLElement;
}

async function openNewExpenseForm(user = userEvent.setup()): Promise<HTMLElement> {
  const toggle = await screen.findByRole('button', { name: 'Новый расход' });
  if (!screen.queryByRole('form', { name: 'Новый расход' })) {
    await user.click(toggle);
  }
  return screen.getByRole('form', { name: 'Новый расход' });
}

beforeEach(() => {
  jest.clearAllMocks();
  document.documentElement.removeAttribute('data-portal-theme');
  mockGetSession.mockResolvedValue({
    data: {
      session: {
        access_token: 'test-token',
        user: { id: 'user-current', email: 'vaver1954@mail.ru' },
      },
    },
  });
  mockDirectSupabaseFrom.mockImplementation(() => emptySupabaseQuery());
  setupApi();
});

describe('<PaymentsPageView /> — server contract and monthly limit', () => {
  it('derives the initial month from the Moscow calendar date, not the browser timezone', async () => {
    mockCurrentMoscowDate.mockReturnValueOnce('2026-09-01');
    render(<PaymentsPageView />);

    await waitFor(() => {
      expect(findApiCall('GET', '/api/payments?month=2026-09')).toBeDefined();
    });
  });

  it('announces the initial load with aria-busy until the server read model arrives', async () => {
    const pending = deferred<PaymentsResponseFixture>();
    setupApi(paymentsResponse(), { getResult: pending.promise });
    render(<PaymentsPageView />);

    const page = await screen.findByRole('region', { name: 'Оплаты' });
    expect(page).toHaveAttribute('aria-busy', 'true');
    expect(within(page).getByRole('status', { name: 'Загрузка расходов' })).toBeVisible();

    pending.resolve(paymentsResponse());
    await waitFor(() => expect(page).toHaveAttribute('aria-busy', 'false'));
  });

  it('focuses a load error and retries the same month without a page reload', async () => {
    setupApi(paymentsResponse(), { getErrorOnce: 'Не удалось загрузить расходы' });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Не удалось загрузить расходы');
    expect(error).toHaveFocus();
    await user.click(within(error).getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByRole('region', { name: 'Лимит разовых расходов' })).toBeVisible();
    const getCalls = apiCalls().filter(([input, init]) => (
      (init?.method || 'GET').toUpperCase() === 'GET'
      && /^\/api\/payments\?month=\d{4}-\d{2}$/.test(requestUrl(input))
    ));
    expect(getCalls).toHaveLength(2);
  });

  it('separates total paid spend from the one-time expense limit', async () => {
    render(<PaymentsPageView />);

    expect(await screen.findByRole('heading', { name: 'Оплаты' })).toBeVisible();
    await waitFor(() => {
      expect(findApiCall('GET', /^\/api\/payments\?month=\d{4}-\d{2}$/)).toBeDefined();
    });
    expect(mockDirectSupabaseFrom).not.toHaveBeenCalled();

    const overview = screen.getByRole('region', { name: 'Сводка расходов' });
    expect(overview).toHaveTextContent(/Всего оплачено\s*20\s?000\s?₽/);
    expect(overview).toHaveTextContent(/Плановые\s*0\s?₽/);
    const summary = screen.getByRole('region', { name: 'Лимит разовых расходов' });
    expect(summary).toHaveTextContent(/Лимит\s*75\s?000\s?₽/);
    expect(summary).toHaveTextContent(/Оплачено разовых\s*20\s?000\s?₽/);
    expect(summary).toHaveTextContent(/В резерве\s*40\s?000\s?₽/);
    expect(summary).toHaveTextContent(/Доступно\s*15\s?000\s?₽/);
    expect(summary).toHaveTextContent('Лимит общий для компании. Плановые расходы в него не входят.');
    expect(summary).toHaveTextContent(/Осталось 20% месячного лимита/);
  });

  it.each([
    ['2026-01', 'Январь 2026'],
    ['2026-05', 'Май 2026'],
    ['2026-12', 'Декабрь 2026'],
  ])('shows the 40,000 ₽ exceptional limit for %s', async (key, label) => {
    setupApi(paymentsResponse({
      period: { key, label },
      summary: {
        limit: 40_000,
        paidOneTime: 5_000,
        reservedOneTime: 0,
        usedOneTime: 5_000,
        remaining: 35_000,
        usagePct: 12.5,
        level: 'normal',
      },
    }));

    render(<PaymentsPageView />);

    expect(await screen.findByText(label)).toBeVisible();
    expect(screen.getByRole('region', { name: 'Лимит разовых расходов' }))
      .toHaveTextContent(/Лимит\s*40\s?000\s?₽/);
  });

  it('shows legacy rows as incomplete data and includes them conservatively in the limit', async () => {
    setupApi(paymentsResponse({
      requests: [legacyPayment()],
      summary: LEGACY_SUMMARY,
    }));

    render(<PaymentsPageView />);

    const note = await screen.findByRole('note', { name: 'Неполные данные' });
    expect(note).toHaveTextContent(/42 старые записи/);
    expect(note).toHaveTextContent(/114\s?170\s?₽/);
    expect(note).toHaveTextContent(/учтены как разовые и оплаченные по дате создания/i);
    const summary = screen.getByRole('region', { name: 'Лимит разовых расходов' });
    expect(summary).toHaveTextContent(/Доступно\s*0\s?₽/);
    expect(summary).toHaveTextContent(/Лимит превышен на 39\s?170\s?₽/);
    expect(screen.queryByRole('button', { name: 'Уточнить тип и дату оплаты' })).not.toBeInTheDocument();
  });
});

describe('<PaymentsPageView /> — new expense form', () => {
  it('keeps the long form out of the reading flow until the user asks for it', async () => {
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    const toggle = await screen.findByRole('button', { name: 'Новый расход' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('form', { name: 'Новый расход' })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByRole('form', { name: 'Новый расход' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Закрыть форму' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('defaults to one-time, exposes all requested fields, and explains the resulting workflow', async () => {
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    const form = await openNewExpenseForm(user);
    const type = within(form).getByRole('radiogroup', { name: 'Тип расхода' });
    expect(within(type).getByRole('radio', { name: /Разовый/ })).toBeChecked();
    expect(within(type).getByRole('radio', { name: /Плановый/ })).not.toBeChecked();
    expect(within(form).getByLabelText('Предполагаемая дата оплаты')).toBeRequired();
    expect(within(form).getByLabelText('Срочность')).toHaveValue('normal');
    expect(within(form).getByRole('option', { name: 'Обычная' })).toHaveValue('normal');
    expect(within(form).getByRole('option', { name: 'Высокая' })).toHaveValue('urgent');
    expect(within(form).getByRole('option', { name: 'Критическая' })).toHaveValue('critical');
    expect(within(form).getByLabelText('Проект, необязательно')).not.toBeRequired();
    expect(within(form).getByLabelText('Ссылка на счёт или документ, необязательно'))
      .toHaveAttribute('type', 'url');
    expect(within(form).getByLabelText('Комментарий, необязательно')).not.toBeRequired();

    await user.type(within(form).getByLabelText('На что расход'), 'Новая база');
    await user.type(within(form).getByLabelText('Сумма, ₽'), '5000');
    await user.type(within(form).getByLabelText('Предполагаемая дата оплаты'), '2026-08-25');
    expect(within(form).getByText(/будет одобрен автоматически/i)).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Добавить расход' })).toBeEnabled();

    await user.click(within(type).getByRole('radio', { name: /Плановый/ }));
    expect(within(form).getByText(/Плановый расход не уменьшает лимит разовых/i)).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Отправить Ане' })).toBeEnabled();
  });

  it('uses the shared project label rules for duplicate and blank project names', async () => {
    setupApi(paymentsResponse({
      requests: [payment({ project: { id: 'same-project', client: 'Acme', name: 'acme' } })],
      projects: [
        { id: 'same-project', client: ' Acme ', name: 'acme' },
        { id: 'service-only', client: '   ', name: 'Поддержка' },
        { id: 'blank-project', client: '   ', name: '   ' },
      ],
    }));
    render(<PaymentsPageView />);

    const form = await openNewExpenseForm();
    expect(within(form).getByRole('option', { name: 'Acme' })).toBeVisible();
    expect(within(form).getByRole('option', { name: 'Поддержка' })).toBeVisible();
    expect(within(form).getByRole('option', { name: 'Проект' })).toBeVisible();
    expect(rowFor('База для проекта Acme')).toHaveTextContent('Аутрич · Acme');
    expect(rowFor('База для проекта Acme')).not.toHaveTextContent('Acme — acme');
  });

  it('keeps an unfinished expense draft when switching to statistics and back', async () => {
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    const form = await openNewExpenseForm(user);
    await user.type(within(form).getByLabelText('На что расход'), 'Не потерять черновик');
    await user.type(within(form).getByLabelText('Сумма, ₽'), '4321');
    await user.type(within(form).getByLabelText('Предполагаемая дата оплаты'), '2026-08-28');
    await user.click(screen.getByRole('tab', { name: 'Статистика' }));

    expect(form).not.toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Расходы' }));
    const restoredForm = screen.getByRole('form', { name: 'Новый расход' });
    expect(within(restoredForm).getByLabelText('На что расход')).toHaveValue('Не потерять черновик');
    expect(within(restoredForm).getByLabelText('Сумма, ₽')).toHaveValue(4321);
    expect(within(restoredForm).getByLabelText('Предполагаемая дата оплаты')).toHaveValue('2026-08-28');
  });

  it('blocks period and tab navigation while a new expense is being submitted', async () => {
    const pending = deferred<PostResult>();
    setupApi(paymentsResponse(), { postResult: pending.promise });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    const form = await openNewExpenseForm(user);
    await user.type(within(form).getByLabelText('На что расход'), 'Долгая отправка');
    await user.type(within(form).getByLabelText('Сумма, ₽'), '5000');
    await user.type(within(form).getByLabelText('Предполагаемая дата оплаты'), '2026-08-28');
    await user.click(within(form).getByRole('button', { name: 'Добавить расход' }));
    await waitFor(() => expect(findApiCall('POST', '/api/payments')).toBeDefined());

    expect(screen.getByRole('tab', { name: 'Статистика' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Предыдущий месяц' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Следующий месяц' })).toBeDisabled();

    pending.resolve({
      request: payment({ id: 'payment-created', description: 'Долгая отправка', amount: 5_000 }),
      summary: DEFAULT_SUMMARY,
      outcome: 'auto_approved',
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Статистика' })).toBeEnabled());
  });

  it('routes a one-time expense over the available remainder to Anya', async () => {
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    const form = await openNewExpenseForm(user);
    await user.type(within(form).getByLabelText('На что расход'), 'Срочный сервис');
    await user.type(within(form).getByLabelText('Сумма, ₽'), '20000');
    await user.type(within(form).getByLabelText('Предполагаемая дата оплаты'), '2026-08-25');

    expect(within(form).getByText(/Превышает доступный остаток на 5\s?000\s?₽/i)).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Отправить Ане' })).toBeEnabled();
  });

  it('does not apply the open month remainder to another month and loads the submitted target period', async () => {
    setupApi(paymentsResponse(), {
      postResult: {
        request: payment({
          id: 'payment-next-month',
          amount: 90_000,
          expectedPaymentOn: '2026-09-05',
          status: 'pending',
          approvalReason: 'limit_exceeded',
        }),
        summary: { ...DEFAULT_SUMMARY, remaining: 0, overage: 15_000, level: 'exceeded' },
        outcome: 'approval_required',
      },
    });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    const form = await openNewExpenseForm(user);
    await user.type(within(form).getByLabelText('На что расход'), 'Сервис на сентябрь');
    await user.type(within(form).getByLabelText('Сумма, ₽'), '90000');
    await user.type(within(form).getByLabelText('Предполагаемая дата оплаты'), '2026-09-05');

    expect(within(form).getByText(/лимит выбранного месяца проверит сервер/i)).toBeVisible();
    expect(within(form).queryByText(/Превышает доступный остаток/i)).not.toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Добавить расход' }));

    await waitFor(() => expect(findApiCall('GET', '/api/payments?month=2026-09')).toBeDefined());
    expect(await screen.findByRole('status')).toHaveTextContent('Расход отправлен Ане');
  });

  it('submits only editable business fields and trusts the server outcome', async () => {
    const created = payment({
      id: 'payment-created',
      department: 'sales',
      description: 'Сервис поиска контактов',
      amount: 9_500,
      project: null,
      comment: 'Нужен до запуска',
      expectedPaymentOn: '2026-08-26',
      urgency: 'urgent',
      documentUrl: 'https://files.example.com/bill-95.pdf',
    });
    setupApi(paymentsResponse(), {
      postResult: {
        request: created,
        summary: { ...DEFAULT_SUMMARY, reservedOneTime: 49_500, usedOneTime: 69_500, remaining: 5_500 },
        outcome: 'auto_approved',
      },
    });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    const form = await openNewExpenseForm(user);
    await user.selectOptions(within(form).getByLabelText('Отдел'), 'sales');
    await user.type(within(form).getByLabelText('На что расход'), '  Сервис поиска контактов  ');
    await user.type(within(form).getByLabelText('Сумма, ₽'), '9500');
    await user.type(within(form).getByLabelText('Предполагаемая дата оплаты'), '2026-08-26');
    await user.selectOptions(within(form).getByLabelText('Срочность'), 'urgent');
    await user.type(
      within(form).getByLabelText('Ссылка на счёт или документ, необязательно'),
      'https://files.example.com/bill-95.pdf',
    );
    await user.type(within(form).getByLabelText('Комментарий, необязательно'), '  Нужен до запуска  ');
    await user.click(within(form).getByRole('button', { name: 'Добавить расход' }));

    await waitFor(() => expect(findApiCall('POST', '/api/payments')).toBeDefined());
    const body = bodyOf(findApiCall('POST', '/api/payments'));
    expect(body).toEqual({
      department: 'sales',
      description: 'Сервис поиска контактов',
      amount: 9500,
      projectId: null,
      comment: 'Нужен до запуска',
      expenseType: 'one_time',
      expectedPaymentOn: '2026-08-26',
      urgency: 'urgent',
      documentUrl: 'https://files.example.com/bill-95.pdf',
    });
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('canManage');
    expect(await screen.findByText(/Расход одобрен автоматически/i)).toBeVisible();
  });

  it('keeps the complete draft visible when submission fails', async () => {
    setupApi(paymentsResponse(), { postError: 'Не удалось отправить расход' });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    const form = await openNewExpenseForm(user);
    await user.type(within(form).getByLabelText('На что расход'), 'Черновик расхода');
    await user.type(within(form).getByLabelText('Сумма, ₽'), '7000');
    await user.type(within(form).getByLabelText('Предполагаемая дата оплаты'), '2026-08-29');
    await user.selectOptions(within(form).getByLabelText('Срочность'), 'critical');
    await user.type(within(form).getByLabelText('Комментарий, необязательно'), 'Не потерять этот текст');
    await user.click(within(form).getByRole('button', { name: 'Добавить расход' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось отправить расход');
    expect(within(form).getByLabelText('На что расход')).toHaveValue('Черновик расхода');
    expect(within(form).getByLabelText('Сумма, ₽')).toHaveValue(7000);
    expect(within(form).getByLabelText('Предполагаемая дата оплаты')).toHaveValue('2026-08-29');
    expect(within(form).getByLabelText('Срочность')).toHaveValue('critical');
    expect(within(form).getByLabelText('Комментарий, необязательно')).toHaveValue('Не потерять этот текст');
  });
});

describe('<PaymentsPageView /> — Anya-only actions', () => {
  const actionRows = [
    payment({
      id: 'payment-pending',
      description: 'Расход сверх лимита',
      amount: 20_000,
      status: 'pending',
      approvalReason: 'limit_exceeded',
    }),
    payment({ id: 'payment-approved', description: 'Одобренный расход', status: 'approved' }),
    legacyPayment(),
  ];

  it('never exposes decision, payment, or legacy classification controls to a regular user', async () => {
    setupApi(paymentsResponse({ requests: actionRows, canManage: false }));
    render(<PaymentsPageView />);

    expect(await screen.findByText('Расход сверх лимита')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Одобрить' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отклонить' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отметить оплаченным' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Уточнить тип и дату оплаты' })).not.toBeInTheDocument();
  });

  it('shows 44px manager controls, allows releasing an approved reserve, and pairs every status color with text and a dot', async () => {
    setupApi(paymentsResponse({ requests: actionRows, canManage: true }));
    render(<PaymentsPageView />);

    await screen.findByText('Расход сверх лимита');
    const pendingRow = rowFor('Расход сверх лимита');
    const approvedRow = rowFor('Одобренный расход');
    expect(within(pendingRow).getByRole('button', { name: 'Одобрить' })).toHaveClass('min-h-11');
    expect(within(approvedRow).getByRole('button', { name: 'Отклонить' })).toHaveClass('min-h-11');
    expect(within(approvedRow).getByRole('button', { name: 'Отметить оплаченным' })).toHaveClass('min-h-11');
    const approvedStatus = within(approvedRow).getByText('Одобрено');
    expect(approvedStatus.querySelector('[aria-hidden="true"]')).toHaveClass('rounded-full');
    expect(within(rowFor('Старый расход без классификации')).getByText('Тип не определён')).toBeVisible();
  });

  it('returns focus to the originating action after cancelling a draft', async () => {
    setupApi(paymentsResponse({ requests: actionRows, canManage: true }));
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await screen.findByText('Расход сверх лимита');
    const row = rowFor('Расход сверх лимита');
    const trigger = within(row).getByRole('button', { name: 'Отклонить' });
    await user.click(trigger);
    const form = screen.getByRole('form', { name: 'Отклонить расход' });
    await user.click(within(form).getByRole('button', { name: 'Отмена' }));

    expect(within(rowFor('Расход сверх лимита')).getByRole('button', { name: 'Отклонить' })).toHaveFocus();
  });

  it('disables other rows while one manager action draft is open', async () => {
    setupApi(paymentsResponse({ requests: actionRows, canManage: true }));
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await screen.findByText('Расход сверх лимита');
    await user.click(within(rowFor('Расход сверх лимита')).getByRole('button', { name: 'Отклонить' }));

    expect(within(rowFor('Одобренный расход')).getByRole('button', { name: 'Отметить оплаченным' })).toBeDisabled();
  });

  it('blocks tab and month navigation while a manager action draft is open', async () => {
    setupApi(paymentsResponse({ requests: actionRows, canManage: true }));
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await screen.findByText('Расход сверх лимита');
    await user.click(within(rowFor('Расход сверх лимита')).getByRole('button', { name: 'Отклонить' }));

    expect(screen.getByRole('tab', { name: 'Статистика' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Предыдущий месяц' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Следующий месяц' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.getByRole('tab', { name: 'Статистика' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Предыдущий месяц' })).toBeEnabled();
  });

  it('uses canManage from the API to expose actions and approves with an optimistic-lock token', async () => {
    setupApi(paymentsResponse({ requests: actionRows, canManage: true }));
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await screen.findByText('Расход сверх лимита');
    const row = rowFor('Расход сверх лимита');
    await user.click(within(row).getByRole('button', { name: 'Одобрить' }));

    await waitFor(() => expect(findApiCall('PATCH', '/api/payments/payment-pending')).toBeDefined());
    expect(bodyOf(findApiCall('PATCH', '/api/payments/payment-pending'))).toEqual({
      action: 'approve',
      expectedUpdatedAt: '2026-08-12T09:00:00.000Z',
    });
  });

  it('locks navigation and other rows while an immediate approval is saving', async () => {
    const pending = deferred<PatchResult>();
    setupApi(paymentsResponse({ requests: actionRows, canManage: true }), {
      patchResult: pending.promise,
    });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await screen.findByText('Расход сверх лимита');
    await user.click(within(rowFor('Расход сверх лимита')).getByRole('button', { name: 'Одобрить' }));
    await waitFor(() => expect(findApiCall('PATCH', '/api/payments/payment-pending')).toBeDefined());

    expect(screen.getByRole('tab', { name: 'Статистика' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Предыдущий месяц' })).toBeDisabled();
    expect(within(rowFor('Одобренный расход')).getByRole('button', { name: 'Отметить оплаченным' })).toBeDisabled();

    pending.resolve({
      request: payment({
        id: 'payment-pending',
        description: 'Расход сверх лимита',
        status: 'approved',
        approvalReason: 'limit_exceeded',
        updatedAt: '2026-08-18T12:00:00.000Z',
      }),
      summaries: [{ month: '2026-08', summary: DEFAULT_SUMMARY }],
      outcome: 'approved',
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Статистика' })).toBeEnabled());
  });

  it('announces a successful action and moves focus to the updated row', async () => {
    const pending = payment({
      id: 'payment-focus',
      description: 'Расход для проверки фокуса',
      status: 'pending',
      approvalReason: 'limit_exceeded',
    });
    setupApi(paymentsResponse({ requests: [pending], canManage: true }), {
      patchResult: {
        request: { ...pending, status: 'approved', updatedAt: '2026-08-18T12:00:00.000Z' },
        summaries: [{ month: '2026-08', summary: DEFAULT_SUMMARY }],
        outcome: 'approved',
      },
    });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await screen.findByText('Расход для проверки фокуса');
    await user.click(within(rowFor('Расход для проверки фокуса')).getByRole('button', { name: 'Одобрить' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Расход одобрен');
    await waitFor(() => expect(rowFor('Расход для проверки фокуса')).toHaveFocus());
  });

  it('requires Anya to explain a rejection and sends only the decision plus CAS token', async () => {
    setupApi(paymentsResponse({ requests: actionRows, canManage: true }), {
      patchResult: {
        request: payment({
          id: 'payment-pending',
          description: 'Расход сверх лимита',
          status: 'rejected',
          approvalReason: 'limit_exceeded',
          decisionComment: 'Нет бизнес-обоснования',
        }),
        summaries: [{ month: '2026-08', summary: DEFAULT_SUMMARY }],
        outcome: 'rejected',
      },
    });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await screen.findByText('Расход сверх лимита');
    await user.click(within(rowFor('Расход сверх лимита')).getByRole('button', { name: 'Отклонить' }));
    const form = screen.getByRole('form', { name: 'Отклонить расход' });
    const reason = within(form).getByLabelText('Причина отклонения');
    expect(reason).toBeRequired();
    expect(reason).toHaveFocus();
    await user.type(reason, 'Нет бизнес-обоснования');
    await user.click(within(form).getByRole('button', { name: 'Подтвердить отклонение' }));

    await waitFor(() => expect(findApiCall('PATCH', '/api/payments/payment-pending')).toBeDefined());
    expect(bodyOf(findApiCall('PATCH', '/api/payments/payment-pending'))).toEqual({
      action: 'reject',
      decisionComment: 'Нет бизнес-обоснования',
      expectedUpdatedAt: '2026-08-12T09:00:00.000Z',
    });
  });

  it('refreshes a conflicted row without losing the action draft and retries with the fresh CAS token', async () => {
    const refreshedRows = actionRows.map((request) => request.id === 'payment-pending'
      ? { ...request, updatedAt: '2026-08-18T13:00:00.000Z' }
      : request);
    setupApi(paymentsResponse({ requests: actionRows, canManage: true }), {
      getResultAfterRetry: paymentsResponse({ requests: refreshedRows, canManage: true }),
      patchErrorOnce: {
        status: 409,
        code: 'payment_request_conflict',
        error: 'Заявка уже изменилась. Обновите данные и повторите.',
      },
      patchResult: {
        request: { ...refreshedRows[0], status: 'rejected', decisionComment: 'Сохранить это обоснование' },
        summaries: [{ month: '2026-08', summary: DEFAULT_SUMMARY }],
        outcome: 'rejected',
      },
    });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await screen.findByText('Расход сверх лимита');
    await user.click(within(rowFor('Расход сверх лимита')).getByRole('button', { name: 'Отклонить' }));
    const form = screen.getByRole('form', { name: 'Отклонить расход' });
    const reason = within(form).getByLabelText('Причина отклонения');
    await user.type(reason, 'Сохранить это обоснование');
    await user.click(within(form).getByRole('button', { name: 'Подтвердить отклонение' }));

    const conflict = await within(form).findByRole('alert');
    expect(conflict).toHaveTextContent('Заявка уже изменилась');
    expect(conflict).toHaveFocus();
    expect(reason).toHaveValue('Сохранить это обоснование');
    await user.click(within(conflict).getByRole('button', { name: 'Обновить данные' }));

    const refreshedForm = await screen.findByRole('form', { name: 'Отклонить расход' });
    expect(within(refreshedForm).getByLabelText('Причина отклонения')).toHaveValue('Сохранить это обоснование');
    await user.click(within(refreshedForm).getByRole('button', { name: 'Подтвердить отклонение' }));

    await waitFor(() => {
      const patches = apiCalls().filter(([input, init]) => (
        (init?.method || 'GET').toUpperCase() === 'PATCH'
        && requestUrl(input) === '/api/payments/payment-pending'
      ));
      expect(patches).toHaveLength(2);
      expect(bodyOf(patches[1])).toEqual({
        action: 'reject',
        decisionComment: 'Сохранить это обоснование',
        expectedUpdatedAt: '2026-08-18T13:00:00.000Z',
      });
    });
  });

  it('requires a real payment date before Anya can mark an approved expense paid', async () => {
    setupApi(paymentsResponse({ requests: actionRows, canManage: true }), {
      patchResult: {
        request: payment({
          id: 'payment-approved',
          description: 'Одобренный расход',
          status: 'paid',
          paidOn: '2026-08-18',
          paidOnSource: 'entered',
        }),
        summaries: [{ month: '2026-08', summary: DEFAULT_SUMMARY }],
        outcome: 'paid',
      },
    });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await screen.findByText('Одобренный расход');
    const row = rowFor('Одобренный расход');
    await user.click(within(row).getByRole('button', { name: 'Отметить оплаченным' }));
    const form = screen.getByRole('form', { name: 'Отметить расход оплаченным' });
    const paidOn = within(form).getByLabelText('Фактическая дата оплаты');
    expect(paidOn).toBeRequired();
    expect(paidOn).toHaveAttribute('max', '2026-08-18');
    await user.type(paidOn, '2026-08-19');
    expect(paidOn).toBeInvalid();
    await user.click(within(form).getByRole('button', { name: 'Подтвердить оплату' }));
    expect(findApiCall('PATCH', '/api/payments/payment-approved')).toBeUndefined();
    await user.clear(paidOn);
    await user.type(paidOn, '2026-08-18');
    await user.click(within(form).getByRole('button', { name: 'Подтвердить оплату' }));

    await waitFor(() => expect(findApiCall('PATCH', '/api/payments/payment-approved')).toBeDefined());
    expect(bodyOf(findApiCall('PATCH', '/api/payments/payment-approved'))).toEqual({
      action: 'mark_paid',
      paidOn: '2026-08-18',
      expectedUpdatedAt: '2026-08-12T09:00:00.000Z',
    });
  });

  it('requires Anya to confirm both a type and the real paid date, then refreshes every affected month', async () => {
    setupApi(paymentsResponse({
      requests: [legacyPayment()],
      summary: SINGLE_LEGACY_SUMMARY,
      canManage: true,
    }), {
      patchResult: {
        request: legacyPayment({
          expenseType: 'planned',
          expectedPaymentOn: '2026-07-31',
          paidOn: '2026-07-31',
          paidOnSource: 'entered',
          updatedAt: '2026-08-18T11:00:00.000Z',
        }),
        summaries: [
          { month: '2026-07', summary: CLASSIFIED_PLANNED_SUMMARY },
          { month: '2026-08', summary: CLASSIFIED_PLANNED_SUMMARY },
        ],
        outcome: 'legacy_classified',
      },
    });
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    expect(await screen.findByRole('note', { name: 'Неполные данные' })).toBeVisible();
    await screen.findByText('Старый расход без классификации');
    const row = rowFor('Старый расход без классификации');
    await user.click(within(row).getByRole('button', { name: 'Уточнить тип и дату оплаты' }));
    const form = screen.getByRole('form', { name: 'Уточнение старого расхода' });
    const paidOn = within(form).getByLabelText('Фактическая дата оплаты');
    expect(within(form).getByRole('radiogroup', { name: 'Тип расхода' })).toBeVisible();
    expect(paidOn).toBeRequired();
    expect(paidOn).toHaveAttribute('max', '2026-08-18');
    expect(paidOn).toHaveValue('');
    expect(paidOn).toHaveFocus();
    expect(within(form).getByText(/3 августа.*дате создания/i)).toBeVisible();
    await user.click(within(form).getByRole('radio', { name: /Плановый/ }));
    await user.type(paidOn, '2026-07-31');
    await user.click(within(form).getByRole('button', { name: 'Сохранить уточнение' }));

    await waitFor(() => expect(findApiCall('PATCH', '/api/payments/payment-legacy')).toBeDefined());
    expect(bodyOf(findApiCall('PATCH', '/api/payments/payment-legacy'))).toEqual({
      action: 'classify_legacy',
      expenseType: 'planned',
      paidOn: '2026-07-31',
      expectedUpdatedAt: '2026-08-03T08:30:00.000Z',
    });
    await waitFor(() => {
      expect(screen.queryByRole('note', { name: 'Неполные данные' })).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Старый расход без классификации')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Расходы за период' })).toHaveFocus());
    expect(screen.getByRole('region', { name: 'Лимит разовых расходов' }))
      .toHaveTextContent(/Доступно\s*75\s?000\s?₽/);
  });

  it('preserves the legacy classification draft and focuses the error when the PATCH fails', async () => {
    setupApi(
      paymentsResponse({ requests: [legacyPayment()], canManage: true }),
      {
        patchError: {
          status: 500,
          error: 'Не удалось сохранить уточнение',
        },
      },
    );
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await screen.findByText('Старый расход без классификации');
    await user.click(within(rowFor('Старый расход без классификации')).getByRole('button', {
      name: 'Уточнить тип и дату оплаты',
    }));
    const form = screen.getByRole('form', { name: 'Уточнение старого расхода' });
    const paidOn = within(form).getByLabelText('Фактическая дата оплаты');
    await user.click(within(form).getByRole('radio', { name: /Плановый/ }));
    await user.type(paidOn, '2026-07-31');
    await user.click(within(form).getByRole('button', { name: 'Сохранить уточнение' }));

    const error = await within(form).findByRole('alert');
    expect(error).toHaveTextContent('Не удалось сохранить уточнение');
    expect(error).toHaveFocus();
    expect(within(form).getByRole('radio', { name: /Плановый/ })).toBeChecked();
    expect(paidOn).toHaveValue('2026-07-31');
  });
});

describe('<PaymentsPageView /> — list, accessibility, responsive and theme contract', () => {
  it('counts paid fact in statistics only by the actual paid month', async () => {
    setupApi(paymentsResponse({
      requests: [
        payment({
          id: 'paid-in-july',
          description: 'Ожидался в августе, оплачен в июле',
          amount: 10_000,
          expectedPaymentOn: '2026-08-05',
          paidOn: '2026-07-31',
          paidOnSource: 'entered',
          status: 'paid',
          department: 'outreach',
        }),
        payment({
          id: 'paid-in-august',
          description: 'Оплачен в августе',
          amount: 20_000,
          expectedPaymentOn: '2026-07-28',
          paidOn: '2026-08-02',
          paidOnSource: 'entered',
          status: 'paid',
          department: 'sales',
        }),
      ],
    }));
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    await user.click(await screen.findByRole('tab', { name: 'Статистика' }));
    const table = screen.getByRole('table', { name: 'Оплаченные расходы по отделам за Август 2026' });
    expect(within(table).getByText('Продажи')).toBeVisible();
    expect(within(table).getByText(/20\s?000\s?₽/)).toBeVisible();
    expect(within(table).queryByText('Аутрич')).not.toBeInTheDocument();
  });

  it('renders a responsive searchable list, keeps every status textual, and exposes only returned document URLs', async () => {
    const rows = [
      payment({ id: 'pending', description: 'Ожидает решения', status: 'pending', approvalReason: 'planned', expenseType: 'planned', documentUrl: null }),
      payment({ id: 'approved', description: 'Зарезервирован', status: 'approved', documentUrl: null }),
      payment({ id: 'paid', description: 'Уже оплачен', status: 'paid', paidOn: '2026-08-17', paidOnSource: 'entered', documentUrl: null }),
      payment({ id: 'rejected', description: 'Отклонён', status: 'rejected', decisionComment: 'Не нужен', documentUrl: null }),
      payment({ id: 'visible-document', description: 'Документ доступен' }),
      payment({
        id: 'private-document',
        requester: { id: 'user-other', name: 'Другой сотрудник' },
        description: 'Документ скрыт сервером',
        documentUrl: null,
      }),
    ];
    setupApi(paymentsResponse({ requests: rows }));
    const user = userEvent.setup();
    render(<PaymentsPageView />);

    const list = await screen.findByRole('region', { name: 'Список расходов' });
    expect(within(list).getByRole('list', { name: 'Расходы за Август 2026' })).toBeVisible();
    ['На согласовании', 'Одобрено', 'Оплачено', 'Отклонено']
      .forEach((status) => expect(within(list).getAllByText(status).length).toBeGreaterThan(0));

    const documentLink = within(list).getByRole('link', { name: 'Открыть документ для Документ доступен' });
    expect(documentLink).toHaveAttribute('href', 'https://files.example.com/invoice-acme.pdf');
    expect(documentLink).toHaveAttribute('target', '_blank');
    expect(documentLink.getAttribute('rel')).toEqual(expect.stringContaining('noopener'));
    expect(documentLink.getAttribute('rel')).toEqual(expect.stringContaining('noreferrer'));
    expect(within(rowFor('Документ скрыт сервером')).queryByRole('link')).not.toBeInTheDocument();

    await user.type(within(list).getByRole('searchbox', { name: 'Поиск расходов' }), 'Документ доступен');
    expect(within(list).getByText('Документ доступен')).toBeVisible();
    expect(within(list).queryByText('Ожидает решения')).not.toBeInTheDocument();
  });

  it('uses the portal theme bridge and accessible tab semantics instead of component-local dark variants', async () => {
    document.documentElement.dataset.portalTheme = 'dark';
    render(<PaymentsPageView />);

    const page = await screen.findByRole('region', { name: 'Оплаты' });
    expect(page).toHaveClass('bg-gray-50', 'text-gray-900');
    expect(page.querySelector('[class*="dark:"]')).toBeNull();
    const tabs = await within(page).findByRole('tablist', { name: 'Разделы оплат' });
    expect(within(tabs).getByRole('tab', { name: 'Расходы' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).getByRole('tab', { name: 'Статистика' })).toHaveAttribute('aria-selected', 'false');
  });
});
