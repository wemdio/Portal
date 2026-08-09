import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamActivityPlanPanel from '@/components/team/TeamActivityPlanPanel';
import type { TeamActivityPlanItem } from '@/components/team/teamApi';

const mockTeamApiFetch = jest.fn();

jest.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));

jest.mock('@/components/team/teamApi', () => {
  const actual = jest.requireActual('@/components/team/teamApi');
  return {
    ...actual,
    localIsoDate: () => '2026-08-08',
    teamApiFetch: (...args: unknown[]) => mockTeamApiFetch(...args),
  };
});

function activity(overrides: Partial<TeamActivityPlanItem>): TeamActivityPlanItem {
  return {
    id: 'activity-default',
    planMonth: '2026-08',
    periodicity: 'Ежемесячно',
    activity: 'Активность команды',
    format: null,
    plannedDate: null,
    plannedTime: null,
    scheduleNote: null,
    note: null,
    budgetAmount: null,
    budgetNote: null,
    status: 'planned',
    position: 0,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

function initialItems(): TeamActivityPlanItem[] {
  return [
    activity({
      id: 'past-planned',
      periodicity: 'Ситуативно',
      activity: 'Review с Иваном Сивочко',
      format: 'Онлайн-встреча',
      plannedDate: '2026-08-06',
      plannedTime: '14:00',
      note: 'Анализ состояния сотрудника',
      position: 0,
    }),
    activity({
      id: 'recurring',
      periodicity: 'Еженедельно',
      activity: 'Обучающий созвон',
      format: 'Телемост',
      scheduleNote: 'Каждую среду, 14:00',
      note: 'Свободный формат',
      position: 1,
    }),
    activity({
      id: 'past-completed',
      periodicity: 'Ежемесячно',
      activity: 'Развлекательный конкурс',
      format: 'Голосование в общем чате',
      plannedDate: '2026-08-03',
      budgetAmount: 700,
      status: 'completed',
      position: 2,
    }),
    activity({
      id: 'future-cancelled',
      periodicity: 'По календарю',
      activity: 'Поздравление с днём рождения',
      format: 'Пост в общем чате',
      plannedDate: '2026-08-20',
      budgetAmount: 2000,
      budgetNote: 'Подарок',
      status: 'cancelled',
      position: 3,
    }),
  ];
}

function monthParts(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const current = new Date(Date.UTC(year, monthNumber - 1, 1));
  const previous = new Date(Date.UTC(year, monthNumber - 2, 1));
  const next = new Date(Date.UTC(year, monthNumber, 1));
  const key = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthNames = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
  ];
  const label = `${monthNames[current.getUTCMonth()]} ${current.getUTCFullYear()}`;
  return { label, previousMonth: key(previous), nextMonth: key(next) };
}

function planResponse(
  items: TeamActivityPlanItem[],
  month = '2026-08',
  asOf = '2026-08-08',
) {
  const overdue = items.filter((item) => (
    item.status === 'planned'
    && Boolean(item.plannedDate)
    && String(item.plannedDate) < asOf
  )).length;
  return {
    period: { month, ...monthParts(month) },
    items,
    summary: {
      total: items.length,
      planned: items.filter((item) => item.status === 'planned').length,
      completed: items.filter((item) => item.status === 'completed').length,
      cancelled: items.filter((item) => item.status === 'cancelled').length,
      overdue,
      budgetAmount: items.reduce((sum, item) => sum + (item.budgetAmount || 0), 0),
      budgetUnspecified: items.filter((item) => item.budgetAmount === null).length,
    },
    asOf,
    canManage: true,
  };
}

function jsonBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function setupApi(seed = initialItems(), asOf = '2026-08-08') {
  let items = seed;

  mockTeamApiFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';

    if (url.startsWith('/api/team/activity-plan?month=') && method === 'GET') {
      const month = url.split('month=')[1];
      return planResponse(month === '2026-08' ? items : [], month, asOf);
    }

    if (url === '/api/team/activity-plan' && method === 'POST') {
      const body = jsonBody(init);
      const item = activity({
        ...body,
        id: 'activity-created',
        createdAt: '2026-08-08T10:00:00.000Z',
        updatedAt: '2026-08-08T10:00:00.000Z',
      } as Partial<TeamActivityPlanItem>);
      items = [...items, item];
      return { item };
    }

    if (url.startsWith('/api/team/activity-plan/') && method === 'PATCH') {
      const id = url.split('/').pop();
      const body = jsonBody(init);
      items = items.map((item) => item.id === id
        ? activity({
            ...item,
            ...body,
            id: item.id,
            updatedAt: '2026-08-08T11:00:00.000Z',
          } as Partial<TeamActivityPlanItem>)
        : item);
      return { item: items.find((item) => item.id === id) };
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

function rowForActivity(name: string): HTMLTableRowElement {
  const row = screen.getByText(name).closest('tr');
  if (!row) throw new Error(`Activity row not found: ${name}`);
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  setupApi();
});

describe('<TeamActivityPlanPanel />', () => {
  it('loads the current month with a compact summary and an accessible responsive table', async () => {
    render(<TeamActivityPlanPanel />);

    const panel = screen.getByRole('region', { name: 'План активностей' });
    expect(panel).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByText('Август 2026')).toBeVisible();
    expect(mockTeamApiFetch).toHaveBeenCalledWith('/api/team/activity-plan?month=2026-08');
    await waitFor(() => expect(panel).toHaveAttribute('aria-busy', 'false'));

    const summary = within(panel).getByRole('region', { name: 'Итоги месяца' });
    expect(summary).toHaveTextContent(/Всего\s*4/);
    expect(summary).toHaveTextContent(/В плане\s*2/);
    expect(summary).toHaveTextContent(/Выполнено\s*1/);
    expect(summary).toHaveTextContent(/Просрочено\s*1/);
    expect(summary).toHaveTextContent(/2\s?700\s?₽/);

    const tableRegion = within(panel).getByRole('region', { name: 'Таблица активностей' });
    expect(tableRegion).toHaveAttribute('tabindex', '0');
    expect(tableRegion).toHaveClass('max-w-full', 'overflow-x-auto');
    const table = within(tableRegion).getByRole('table', { name: 'Активности за Август 2026' });
    ['Периодичность', 'Активность', 'Формат', 'Дата или расписание', 'Примечание', 'Бюджет', 'Статус']
      .forEach((heading) => expect(within(table).getByRole('columnheader', { name: heading })).toBeVisible());
    expect(panel).toHaveClass('bg-white', 'text-gray-900');
    expect(panel.querySelector('[class*="dark:"]')).toBeNull();
  });

  it('navigates between calendar months and reloads only the selected month', async () => {
    const user = userEvent.setup();
    render(<TeamActivityPlanPanel />);

    await screen.findByText('Август 2026');
    await user.click(screen.getByRole('button', { name: 'Следующий месяц' }));

    expect(await screen.findByText('Сентябрь 2026')).toBeVisible();
    expect(mockTeamApiFetch).toHaveBeenCalledWith('/api/team/activity-plan?month=2026-09');
    await user.click(screen.getByRole('button', { name: 'Предыдущий месяц' }));
    expect(await screen.findByText('Август 2026')).toBeVisible();
    expect(mockTeamApiFetch).toHaveBeenLastCalledWith('/api/team/activity-plan?month=2026-08');
  });

  it('keeps the requested month in the header when that month fails to load', async () => {
    const user = userEvent.setup();
    mockTeamApiFetch.mockReset();
    mockTeamApiFetch
      .mockResolvedValueOnce(planResponse(initialItems()))
      .mockRejectedValueOnce(new Error('network unavailable'));
    render(<TeamActivityPlanPanel />);

    await screen.findByText('Август 2026');
    await user.click(screen.getByRole('button', { name: 'Следующий месяц' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить план активностей');
    expect(screen.getByText('Сентябрь 2026')).toBeVisible();
    expect(mockTeamApiFetch).toHaveBeenLastCalledWith('/api/team/activity-plan?month=2026-09');
  });

  it('announces loading, then shows a useful empty state', async () => {
    const request = deferred<unknown>();
    mockTeamApiFetch.mockReset();
    mockTeamApiFetch.mockImplementationOnce(() => request.promise);
    render(<TeamActivityPlanPanel />);

    const panel = screen.getByRole('region', { name: 'План активностей' });
    expect(panel).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем план активностей');

    await act(async () => {
      request.resolve(planResponse([]));
      await request.promise;
    });

    expect(await screen.findByText(/пока нет активностей/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Добавить активность' })).toBeVisible();
    expect(panel).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows an actionable load error and retries the same month', async () => {
    const user = userEvent.setup();
    mockTeamApiFetch.mockReset();
    mockTeamApiFetch
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(planResponse(initialItems()));
    render(<TeamActivityPlanPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить план активностей');
    await user.click(screen.getByRole('button', { name: 'Попробовать снова' }));

    expect(await screen.findByText('Обучающий созвон')).toBeVisible();
    expect(mockTeamApiFetch).toHaveBeenNthCalledWith(1, '/api/team/activity-plan?month=2026-08');
    expect(mockTeamApiFetch).toHaveBeenNthCalledWith(2, '/api/team/activity-plan?month=2026-08');
  });

  it('creates an exact-date activity inline with time, budget amount and budget note', async () => {
    const user = userEvent.setup();
    render(<TeamActivityPlanPanel />);

    await user.click(await screen.findByRole('button', { name: 'Добавить активность' }));
    const form = screen.getByRole('form', { name: 'Создание активности' });
    expect(within(form).getByRole('radio', { name: 'Точная дата' })).toBeChecked();
    expect(within(form).queryByRole('textbox', { name: 'Расписание' })).not.toBeInTheDocument();

    await user.type(within(form).getByLabelText('Периодичность'), 'Ежемесячно');
    await user.type(within(form).getByLabelText('Активность'), 'Профессиональный конкурс');
    await user.type(within(form).getByLabelText('Формат'), 'Анонс в общем чате');
    await user.type(within(form).getByLabelText('Плановая дата'), '2026-09-01');
    await user.type(within(form).getByLabelText('Время'), '16:30');
    await user.type(within(form).getByLabelText('Примечание'), 'Подвести итоги и наградить победителей');
    await user.type(within(form).getByLabelText('Бюджет, ₽'), '1400.50');
    await user.type(within(form).getByLabelText('Комментарий к бюджету'), 'Две премии по 700 ₽');
    await user.click(within(form).getByRole('button', { name: 'Добавить' }));

    await waitFor(() => {
      const postCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(postCall?.[0]).toBe('/api/team/activity-plan');
      expect(jsonBody(postCall?.[1])).toEqual({
        planMonth: '2026-08',
        periodicity: 'Ежемесячно',
        activity: 'Профессиональный конкурс',
        format: 'Анонс в общем чате',
        plannedDate: '2026-09-01',
        plannedTime: '16:30',
        scheduleNote: null,
        note: 'Подвести итоги и наградить победителей',
        budgetAmount: 1400.5,
        budgetNote: 'Две премии по 700 ₽',
        status: 'planned',
        position: 4,
      });
    });
    expect(await screen.findByText('Профессиональный конкурс')).toBeVisible();
  });

  it('keeps create and edit forms outside the horizontally scrolling table', async () => {
    const user = userEvent.setup();
    render(<TeamActivityPlanPanel />);

    await user.click(await screen.findByRole('button', { name: 'Добавить активность' }));
    const createForm = screen.getByRole('form', { name: 'Создание активности' });
    expect(createForm.closest('table')).toBeNull();
    expect(createForm).toHaveClass('w-full', 'min-w-0');
    await user.click(within(createForm).getByRole('button', { name: 'Отмена' }));

    const row = rowForActivity('Обучающий созвон');
    await user.click(within(row).getByRole('button', { name: 'Редактировать активность Обучающий созвон' }));
    const editForm = screen.getByRole('form', { name: 'Редактирование активности' });
    expect(editForm.closest('table')).toBeNull();
    expect(editForm).toHaveClass('w-full', 'min-w-0');
    expect(screen.getAllByRole('form')).toHaveLength(1);
  });

  it('creates a schedule-based activity without leaking hidden date fields', async () => {
    const user = userEvent.setup();
    render(<TeamActivityPlanPanel />);

    await user.click(await screen.findByRole('button', { name: 'Добавить активность' }));
    const form = screen.getByRole('form', { name: 'Создание активности' });
    await user.click(within(form).getByRole('radio', { name: 'Расписание' }));

    expect(within(form).queryByLabelText('Плановая дата')).not.toBeInTheDocument();
    expect(within(form).queryByLabelText('Время')).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText('Периодичность'), 'Еженедельно');
    await user.type(within(form).getByLabelText('Активность'), 'Разбор полезной тематики');
    await user.type(within(form).getByRole('textbox', { name: 'Расписание' }), '  каждую среду, 14:00  ');
    await user.click(within(form).getByRole('button', { name: 'Добавить' }));

    await waitFor(() => {
      const postCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(jsonBody(postCall?.[1])).toEqual(expect.objectContaining({
        planMonth: '2026-08',
        periodicity: 'Еженедельно',
        activity: 'Разбор полезной тематики',
        plannedDate: null,
        plannedTime: null,
        scheduleNote: 'каждую среду, 14:00',
      }));
    });
    expect(await screen.findByText('каждую среду, 14:00')).toBeVisible();
  });

  it('creates an activity whose exact date will be decided later', async () => {
    const user = userEvent.setup();
    render(<TeamActivityPlanPanel />);

    await user.click(await screen.findByRole('button', { name: 'Добавить активность' }));
    const form = screen.getByRole('form', { name: 'Создание активности' });
    await user.click(within(form).getByRole('radio', { name: 'Без даты' }));

    expect(within(form).queryByLabelText('Плановая дата')).not.toBeInTheDocument();
    expect(within(form).queryByRole('textbox', { name: 'Расписание' })).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText('Периодичность'), 'Раз в полугодие');
    await user.type(within(form).getByLabelText('Активность'), 'Командный квиз');
    await user.click(within(form).getByRole('button', { name: 'Добавить' }));

    await waitFor(() => {
      const postCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(jsonBody(postCall?.[1])).toEqual(expect.objectContaining({
        activity: 'Командный квиз',
        plannedDate: null,
        plannedTime: null,
        scheduleNote: null,
      }));
    });
  });

  it('edits an activity inline and sends the original update token with its new status', async () => {
    const user = userEvent.setup();
    render(<TeamActivityPlanPanel />);

    await screen.findByText('Обучающий созвон');
    const row = rowForActivity('Обучающий созвон');
    await user.click(within(row).getByRole('button', { name: 'Редактировать активность Обучающий созвон' }));
    const form = screen.getByRole('form', { name: 'Редактирование активности' });
    expect(form.closest('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Предыдущий месяц' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Следующий месяц' })).toBeDisabled();
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Статус' }), 'completed');
    const note = within(form).getByLabelText('Примечание');
    await user.clear(note);
    await user.type(note, 'Созвон проведён, материалы отправлены');
    await user.click(within(form).getByRole('button', { name: 'Сохранить изменения' }));

    await waitFor(() => {
      const patchCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall?.[0]).toBe('/api/team/activity-plan/recurring');
      expect(jsonBody(patchCall?.[1])).toEqual(expect.objectContaining({
        planMonth: '2026-08',
        activity: 'Обучающий созвон',
        scheduleNote: 'Каждую среду, 14:00',
        status: 'completed',
        note: 'Созвон проведён, материалы отправлены',
        expectedUpdatedAt: '2026-08-01T09:00:00.000Z',
      }));
    });
    expect(within(rowForActivity('Обучающий созвон')).getByText('Выполнено')).toBeVisible();
  });

  it('derives overdue only for a planned activity with a past exact date', async () => {
    render(<TeamActivityPlanPanel />);

    await screen.findByText('Review с Иваном Сивочко');
    expect(within(rowForActivity('Review с Иваном Сивочко')).getByText('Просрочено')).toBeVisible();

    const recurring = rowForActivity('Обучающий созвон');
    expect(within(recurring).getByText('В плане')).toBeVisible();
    expect(within(recurring).queryByText('Просрочено')).not.toBeInTheDocument();

    const completed = rowForActivity('Развлекательный конкурс');
    expect(within(completed).getByText('Выполнено')).toBeVisible();
    expect(within(completed).queryByText('Просрочено')).not.toBeInTheDocument();
  });

  it('uses the API as-of date instead of the browser date for row overdue state', async () => {
    setupApi([activity({
      id: 'server-today',
      activity: 'Активность на дату среза',
      plannedDate: '2026-08-07',
    })], '2026-08-07');
    render(<TeamActivityPlanPanel />);

    await screen.findByText('Активность на дату среза');
    const row = rowForActivity('Активность на дату среза');
    expect(within(row).getByText('В плане')).toBeVisible();
    expect(within(row).queryByText('Просрочено')).not.toBeInTheDocument();
  });

  it('moves keyboard focus into delete confirmation and restores it on cancel', async () => {
    const user = userEvent.setup();
    render(<TeamActivityPlanPanel />);

    await screen.findByText('Обучающий созвон');
    const row = rowForActivity('Обучающий созвон');
    await user.click(within(row).getByRole('button', { name: 'Редактировать активность Обучающий созвон' }));
    const form = screen.getByRole('form', { name: 'Редактирование активности' });
    await user.click(within(form).getByRole('button', { name: 'Удалить' }));

    const confirm = within(form).getByRole('button', { name: 'Да, удалить' });
    await waitFor(() => expect(confirm).toHaveFocus());
    await user.click(within(form).getByRole('button', { name: 'Не удалять' }));
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Удалить' })).toHaveFocus());
  });
});
