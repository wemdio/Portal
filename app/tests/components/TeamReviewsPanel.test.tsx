import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import TeamReviewsPanel from '@/components/team/TeamReviewsPanel';
import * as teamApiModule from '@/components/team/teamApi';
import type { TeamReview } from '@/components/team/teamApi';

const mockTeamApiFetch = jest.fn();

jest.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));

jest.mock('@/components/team/teamApi', () => {
  const actual = jest.requireActual('@/components/team/teamApi');
  return {
    ...actual,
    teamApiFetch: (...args: unknown[]) => mockTeamApiFetch(...args),
  };
});

const ANNA_ID = '00000000-0000-4000-8000-000000000002';
const VERA_ID = '00000000-0000-4000-8000-000000000003';
const REVIEWER_ID = '00000000-0000-4000-8000-000000000001';

const anna = {
  id: ANNA_ID,
  name: 'Анна Ким',
  email: 'anna@example.com',
  role: 'technician',
  avatarUrl: null,
};

const vera = {
  id: VERA_ID,
  name: 'Вера Орлова',
  email: 'vera@example.com',
  role: 'manager',
  avatarUrl: null,
};

const formerEmployee = {
  id: '00000000-0000-4000-8000-000000000099',
  name: 'Ольга Смирнова',
  email: 'olga@example.com',
  role: 'client',
  avatarUrl: null,
};

const reviewer = {
  id: REVIEWER_ID,
  name: 'Лид Команды',
  email: 'lead@example.com',
  role: 'lead',
  avatarUrl: null,
};

function initialReviews(): TeamReview[] {
  return [
    {
      id: 'scheduled-late',
      reviewDate: '2026-08-20',
      employee: vera,
      candidateName: null,
      reviewer,
      status: 'scheduled',
      reason: 'Сверить адаптацию на новом проекте',
      outcomes: null,
      problems: null,
      recommendations: null,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    },
    {
      id: 'completed-old',
      reviewDate: '2026-06-10',
      employee: vera,
      candidateName: null,
      reviewer,
      status: 'completed',
      reason: null,
      outcomes: 'Старые итоги ревью',
      problems: null,
      recommendations: null,
      createdAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:00:00.000Z',
    },
    {
      id: 'scheduled-early',
      reviewDate: '2026-08-05',
      employee: anna,
      candidateName: null,
      reviewer,
      status: 'scheduled',
      reason: 'Обсудить ближайшие приоритеты',
      outcomes: null,
      problems: null,
      recommendations: null,
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T09:00:00.000Z',
    },
    {
      id: 'completed-new',
      reviewDate: '2026-07-28',
      employee: anna,
      candidateName: null,
      reviewer,
      status: 'completed',
      reason: 'Обсудить фокус на следующий квартал',
      outcomes: 'Свежие итоги ревью',
      problems: 'Не хватает фокуса',
      recommendations: 'Фиксировать три приоритета',
      createdAt: '2026-07-28T10:00:00.000Z',
      updatedAt: '2026-07-28T10:00:00.000Z',
    },
  ];
}

function candidateReview(overrides: Partial<TeamReview> = {}): TeamReview {
  return {
    id: 'candidate-scheduled',
    reviewDate: '2026-08-18',
    employee: null,
    candidateName: 'Мария Соколова',
    reviewer,
    status: 'scheduled',
    reason: 'Вакансия: аккаунт-менеджер, этап: финальное интервью',
    outcomes: null,
    problems: null,
    recommendations: null,
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
    ...overrides,
  } as TeamReview;
}

function jsonBody(init?: RequestInit): Record<string, string> {
  return JSON.parse(String(init?.body || '{}')) as Record<string, string>;
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

function reviewsResponse(reviews = initialReviews()) {
  return {
    reviews,
    employees: [anna, vera],
    canManage: true,
    currentUserId: REVIEWER_ID,
  };
}

function reviewConflictError() {
  const payload = {
    error: 'Review changed; reload and try again',
    code: 'review_conflict',
    currentUpdatedAt: '2026-08-02T10:15:00.000Z',
  };
  return new teamApiModule.TeamApiError(payload.error, 409, payload);
}

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid hex color: ${hex}`);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function portalGlobalsCss(): string {
  const appGlobals = resolve(process.cwd(), 'src/app/globals.css');
  const globalsPath = existsSync(appGlobals)
    ? appGlobals
    : resolve(process.cwd(), 'app/src/app/globals.css');
  return readFileSync(globalsPath, 'utf8');
}

function darkThemeHexToken(css: string, token: string): string {
  const value = css.match(new RegExp(`${token}:\\s*(#[a-f\\d]{6})`, 'i'))?.[1];
  if (!value) throw new Error(`Dark-theme token not found: ${token}`);
  return value;
}

function setupApi() {
  let reviews = initialReviews();

  mockTeamApiFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';

    if (url === '/api/team/reviews' && method === 'GET') {
      return reviewsResponse(reviews);
    }

    if (url === '/api/team/reviews' && method === 'POST') {
      const body = jsonBody(init);
      const employee = body.employeeUserId
        ? body.employeeUserId === ANNA_ID ? anna : vera
        : null;
      const review: TeamReview = {
        id: 'scheduled-created',
        reviewDate: body.reviewDate,
        employee,
        candidateName: body.candidateName || null,
        reviewer,
        status: 'scheduled',
        reason: body.reason || null,
        outcomes: null,
        problems: null,
        recommendations: null,
        createdAt: '2026-08-01T12:00:00.000Z',
        updatedAt: '2026-08-01T12:00:00.000Z',
      } as TeamReview;
      reviews = [...reviews, review];
      return { review };
    }

    if (url.startsWith('/api/team/reviews/') && method === 'PATCH') {
      const id = url.split('/').pop();
      const body = jsonBody(init);
      reviews = reviews.map((review) => review.id === id
        ? {
            ...review,
            reviewDate: body.reviewDate,
            employee: body.employeeUserId
              ? body.employeeUserId === ANNA_ID ? anna : vera
              : null,
            candidateName: body.candidateName || null,
            status: body.status === 'completed' ? 'completed' : review.status,
            reason: body.reason || null,
            outcomes: body.outcomes || null,
            problems: body.problems || null,
            recommendations: body.recommendations || null,
            updatedAt: '2026-08-01T13:00:00.000Z',
          }
        : review);
      return { review: reviews.find((review) => review.id === id) };
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

function sectionForHeading(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const section = heading.closest('section');
  if (!section) throw new Error(`Section not found for heading: ${name}`);
  return section;
}

function articleForText(text: string): HTMLElement {
  const article = screen.getByText(text).closest('article');
  if (!article) throw new Error(`Review row not found for text: ${text}`);
  return article;
}

beforeEach(() => {
  jest.clearAllMocks();
  setupApi();
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => (
    window.setTimeout(() => callback(0), 0)
  ));
});

describe('<TeamReviewsPanel />', () => {
  it('shows planned reviews first by nearest date and history by newest date', async () => {
    render(<TeamReviewsPanel />);

    await screen.findByRole('heading', { name: 'Запланировано' });
    const plannedText = sectionForHeading('Запланировано').textContent || '';
    const historyText = sectionForHeading('История').textContent || '';

    expect(plannedText.indexOf('Обсудить ближайшие приоритеты')).toBeLessThan(
      plannedText.indexOf('Сверить адаптацию на новом проекте'),
    );
    expect(historyText.indexOf('Свежие итоги ревью')).toBeLessThan(
      historyText.indexOf('Старые итоги ревью'),
    );
  });

  it('opens a minimal planning form and posts only date, employee and optional reason', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    await user.click(await screen.findByRole('button', { name: 'Запланировать ревью' }));
    const date = screen.getByLabelText('Дата ревью');
    const form = date.closest('form');
    if (!form) throw new Error('Planning form not found');

    expect(within(form).getByRole('radio', { name: 'Сотрудник' })).toBeChecked();
    expect(within(form).getByRole('radio', { name: 'Кандидат' })).not.toBeChecked();
    expect(within(form).queryByLabelText('Основные итоги')).not.toBeInTheDocument();
    await user.clear(date);
    await user.type(date, '2026-09-01');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Сотрудник' }), ANNA_ID);
    await user.type(within(form).getByLabelText(/Комментарий/), '  План развития  ');
    await user.click(within(form).getByRole('button', { name: 'Запланировать' }));

    await waitFor(() => {
      const postCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(jsonBody(postCall?.[1])).toEqual({
        reviewDate: '2026-09-01',
        employeeUserId: ANNA_ID,
        reason: 'План развития',
      });
    });
  });

  it('plans a candidate review with a manual name and one free-form comment', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    await user.click(await screen.findByRole('button', { name: 'Запланировать ревью' }));
    const form = screen.getByRole('form', { name: 'Планирование ревью' });
    const candidateRadio = within(form).getByRole('radio', { name: 'Кандидат' });
    await user.click(candidateRadio);

    expect(within(form).queryByRole('combobox', { name: 'Сотрудник' })).not.toBeInTheDocument();
    const candidateName = within(form).getByLabelText('Имя кандидата');
    const comment = within(form).getByLabelText(/Комментарий/);
    expect(comment).toHaveAttribute(
      'placeholder',
      'Вакансия, этап, ссылка на резюме или другой контекст',
    );

    const date = within(form).getByLabelText('Дата ревью');
    await user.clear(date);
    await user.type(date, '2026-09-02');
    await user.type(candidateName, '  Мария Соколова  ');
    await user.type(comment, '  Вакансия: аккаунт-менеджер, этап: финал  ');
    await user.click(within(form).getByRole('button', { name: 'Запланировать' }));

    await waitFor(() => {
      const postCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(jsonBody(postCall?.[1])).toEqual({
        reviewDate: '2026-09-02',
        candidateName: 'Мария Соколова',
        reason: 'Вакансия: аккаунт-менеджер, этап: финал',
      });
    });
  });

  it('requires a candidate name instead of allowing an anonymous review', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    await user.click(await screen.findByRole('button', { name: 'Запланировать ревью' }));
    const form = screen.getByRole('form', { name: 'Планирование ревью' });
    await user.click(within(form).getByRole('radio', { name: 'Кандидат' }));
    expect(within(form).getByLabelText('Имя кандидата')).toBeRequired();
    await user.click(within(form).getByRole('button', { name: 'Запланировать' }));

    expect(mockTeamApiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('searches scheduled reviews by reason', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    const search = await screen.findByRole('searchbox', { name: 'Поиск по ревью' });
    await user.type(search, 'адаптацию');

    expect(screen.getByText('Сверить адаптацию на новом проекте')).toBeVisible();
    expect(screen.queryByText('Обсудить ближайшие приоритеты')).not.toBeInTheDocument();
    expect(screen.queryByText('Свежие итоги ревью')).not.toBeInTheDocument();
  });

  it('renders, searches and filters candidate reviews separately from employees', async () => {
    const user = userEvent.setup();
    mockTeamApiFetch.mockResolvedValueOnce(reviewsResponse([
      ...initialReviews(),
      candidateReview(),
    ]));
    render(<TeamReviewsPanel />);

    const candidateName = await screen.findByText('Мария Соколова');
    const candidateRow = candidateName.closest('article');
    if (!candidateRow) throw new Error('Candidate review row not found');
    expect(within(candidateRow).getByText('Кандидат')).toBeVisible();
    expect(within(candidateRow).getByText(/Вакансия: аккаунт-менеджер/)).toBeVisible();

    const search = screen.getByRole('searchbox', { name: 'Поиск по ревью' });
    await user.type(search, 'финальное интервью');
    expect(screen.getByText('Мария Соколова')).toBeVisible();
    expect(screen.queryByText('Обсудить ближайшие приоритеты')).not.toBeInTheDocument();

    await user.clear(search);
    const participantFilter = screen.getByRole('combobox', { name: 'Фильтр по участнику' });
    expect(within(participantFilter).getByRole('option', { name: 'Все ревью' })).toBeInTheDocument();
    expect(within(participantFilter).getByRole('option', { name: 'Все сотрудники' })).toBeInTheDocument();
    expect(within(participantFilter).getByRole('option', { name: 'Кандидаты' })).toBeInTheDocument();

    await user.selectOptions(participantFilter, 'candidates');
    expect(screen.getByText('Мария Соколова')).toBeVisible();
    expect(screen.queryByText('Обсудить ближайшие приоритеты')).not.toBeInTheDocument();

    await user.selectOptions(participantFilter, 'employees');
    expect(screen.queryByText('Мария Соколова')).not.toBeInTheDocument();
    expect(screen.getByText('Обсудить ближайшие приоритеты')).toBeVisible();
  });

  it('keeps a historical review linked to an employee who is no longer selectable', async () => {
    const user = userEvent.setup();
    const historicalReview: TeamReview = {
      ...candidateReview(),
      id: 'former-employee-review',
      employee: formerEmployee,
      candidateName: null,
      reason: 'Исторический комментарий',
    };
    mockTeamApiFetch.mockResolvedValueOnce(reviewsResponse([historicalReview]));
    render(<TeamReviewsPanel />);

    const employeeName = await screen.findByText('Ольга Смирнова');
    const reviewRow = employeeName.closest('article');
    if (!reviewRow) throw new Error('Historical employee review row not found');
    expect(within(reviewRow).getByText('Сотрудник')).toBeVisible();
    expect(within(reviewRow).queryByText('Кандидат')).not.toBeInTheDocument();

    await user.click(within(reviewRow).getByRole('button', {
      name: 'Редактировать запланированное ревью Ольга Смирнова',
    }));
    const form = within(reviewRow).getByRole('form', {
      name: 'Редактирование запланированного ревью',
    });
    expect(within(form).getByRole('radio', { name: 'Сотрудник' })).toBeChecked();
    expect(within(form).getByRole('combobox', { name: 'Сотрудник' }))
      .toHaveValue(formerEmployee.id);
  });

  it('completes a planned review and moves it to history after reload', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    await screen.findByText('Обсудить ближайшие приоритеты');
    const plannedRow = articleForText('Обсудить ближайшие приоритеты');
    await user.click(within(plannedRow).getByRole('button', { name: 'Заполнить итоги' }));

    const outcomes = screen.getByLabelText('Основные итоги');
    expect(outcomes).toHaveFocus();
    const form = outcomes.closest('form');
    if (!form) throw new Error('Completion form not found');
    await user.type(outcomes, 'Сотрудник уверенно ведёт проекты');
    await user.type(within(form).getByLabelText('Зоны внимания'), 'Нужно точнее определять приоритеты');
    await user.type(within(form).getByLabelText('Рекомендации'), 'Разбирать кейсы раз в неделю');
    await user.click(within(form).getByRole('button', { name: 'Сохранить итоги' }));

    await waitFor(() => {
      const patchCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall?.[0]).toBe('/api/team/reviews/scheduled-early');
      expect(jsonBody(patchCall?.[1])).toEqual({
        reviewDate: '2026-08-05',
        employeeUserId: ANNA_ID,
        candidateName: null,
        expectedUpdatedAt: '2026-08-01T09:00:00.000Z',
        status: 'completed',
        reason: 'Обсудить ближайшие приоритеты',
        outcomes: 'Сотрудник уверенно ведёт проекты',
        problems: 'Нужно точнее определять приоритеты',
        recommendations: 'Разбирать кейсы раз в неделю',
      });
    });

    await waitFor(() => {
      expect(within(sectionForHeading('Запланировано')).queryByText('Обсудить ближайшие приоритеты')).not.toBeInTheDocument();
      expect(within(sectionForHeading('История')).getByText('Сотрудник уверенно ведёт проекты')).toBeVisible();
    });
  });

  it('keeps edit actions visible for both planned and completed reviews', async () => {
    render(<TeamReviewsPanel />);

    await screen.findByText('Обсудить ближайшие приоритеты');
    const plannedRow = articleForText('Обсудить ближайшие приоритеты');
    const completedRow = articleForText('Свежие итоги ревью');

    expect(within(plannedRow).getByRole('button', { name: /Редактировать/ })).toBeVisible();
    expect(within(completedRow).getByRole('button', { name: /Редактировать/ })).toBeVisible();
  });

  it('returns focus to the actual edit action after cancel and save', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    await screen.findByText('Обсудить ближайшие приоритеты');
    const plannedRow = articleForText('Обсудить ближайшие приоритеты');
    const edit = within(plannedRow).getByRole('button', {
      name: 'Редактировать запланированное ревью Анна Ким',
    });

    await user.click(edit);
    await user.click(within(plannedRow).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(edit).toHaveFocus());

    await user.click(edit);
    const reason = within(plannedRow).getByLabelText(/Комментарий/);
    await user.clear(reason);
    await user.type(reason, 'Новая повестка');
    await user.click(within(plannedRow).getByRole('button', { name: 'Сохранить изменения' }));

    await waitFor(() => {
      const patchCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall?.[0]).toBe('/api/team/reviews/scheduled-early');
      expect(jsonBody(patchCall?.[1])).toEqual({
        reviewDate: '2026-08-05',
        employeeUserId: ANNA_ID,
        candidateName: null,
        expectedUpdatedAt: '2026-08-01T09:00:00.000Z',
        reason: 'Новая повестка',
      });
    });

    await waitFor(() => {
      expect(within(articleForText('Новая повестка')).getByRole('button', {
        name: 'Редактировать запланированное ревью Анна Ким',
      })).toHaveFocus();
    });
  });

  it('edits a candidate review with both XOR fields and the original CAS token', async () => {
    const user = userEvent.setup();
    const candidate = candidateReview();
    mockTeamApiFetch.mockResolvedValueOnce(reviewsResponse([candidate]));
    render(<TeamReviewsPanel />);

    const candidateName = await screen.findByText('Мария Соколова');
    const candidateRow = candidateName.closest('article');
    if (!candidateRow) throw new Error('Candidate review row not found');
    await user.click(within(candidateRow).getByRole('button', {
      name: 'Редактировать запланированное ревью Мария Соколова',
    }));

    const form = within(candidateRow).getByRole('form', {
      name: 'Редактирование запланированного ревью',
    });
    expect(within(form).getByRole('radio', { name: 'Кандидат' })).toBeChecked();
    expect(within(form).queryByRole('combobox', { name: 'Сотрудник' })).not.toBeInTheDocument();
    const nameInput = within(form).getByLabelText('Имя кандидата');
    const comment = within(form).getByLabelText(/Комментарий/);
    await user.clear(nameInput);
    await user.type(nameInput, 'Мария Соколова-Петрова');
    await user.clear(comment);
    await user.type(comment, 'Вакансия: руководитель проектов, этап: оффер');
    await user.click(within(form).getByRole('button', { name: 'Сохранить изменения' }));

    await waitFor(() => {
      const patchCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall?.[0]).toBe('/api/team/reviews/candidate-scheduled');
      expect(jsonBody(patchCall?.[1])).toEqual({
        reviewDate: '2026-08-18',
        employeeUserId: null,
        candidateName: 'Мария Соколова-Петрова',
        expectedUpdatedAt: '2026-08-02T10:00:00.000Z',
        reason: 'Вакансия: руководитель проектов, этап: оффер',
      });
    });
  });

  it('completes a candidate review without requiring an employee profile', async () => {
    const user = userEvent.setup();
    const candidate = candidateReview();
    mockTeamApiFetch.mockResolvedValueOnce(reviewsResponse([candidate]));
    render(<TeamReviewsPanel />);

    const candidateName = await screen.findByText('Мария Соколова');
    const candidateRow = candidateName.closest('article');
    if (!candidateRow) throw new Error('Candidate review row not found');
    await user.click(within(candidateRow).getByRole('button', { name: 'Заполнить итоги' }));

    const form = within(candidateRow).getByRole('form', {
      name: 'Редактирование итогов ревью',
    });
    await user.type(within(form).getByLabelText('Основные итоги'), 'Подходит для оффера');
    await user.click(within(form).getByRole('button', { name: 'Сохранить итоги' }));

    await waitFor(() => {
      const patchCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall?.[0]).toBe('/api/team/reviews/candidate-scheduled');
      expect(jsonBody(patchCall?.[1])).toEqual({
        reviewDate: '2026-08-18',
        employeeUserId: null,
        candidateName: 'Мария Соколова',
        expectedUpdatedAt: '2026-08-02T10:00:00.000Z',
        status: 'completed',
        reason: 'Вакансия: аккаунт-менеджер, этап: финальное интервью',
        outcomes: 'Подходит для оффера',
        problems: null,
        recommendations: null,
      });
    });
  });

  it('shows the original agenda in completed review details', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    await screen.findByText('Свежие итоги ревью');
    const completedRow = articleForText('Свежие итоги ревью');
    await user.click(within(completedRow).getByRole('button', { name: /Свежие итоги ревью/ }));

    expect(within(completedRow).getByText('Комментарий')).toBeVisible();
    expect(within(completedRow).getByText('Обсудить фокус на следующий квартал')).toBeVisible();
  });

  it('keeps the create form open and disables every close action while saving', async () => {
    const user = userEvent.setup();
    const request = deferred<unknown>();
    render(<TeamReviewsPanel />);

    await user.click(await screen.findByRole('button', { name: 'Запланировать ревью' }));
    const form = screen.getByRole('form', { name: 'Планирование ревью' });
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Сотрудник' }), ANNA_ID);
    mockTeamApiFetch.mockImplementationOnce(() => request.promise);
    await user.click(within(form).getByRole('button', { name: 'Запланировать' }));

    const closeButton = screen.getByRole('button', { name: 'Закрыть форму' });
    const cancelButton = within(form).getByRole('button', { name: 'Отмена' });
    const closeWasDisabled = closeButton.hasAttribute('disabled');
    const cancelWasDisabled = cancelButton.hasAttribute('disabled');
    const formStayedMounted = form.isConnected;
    await act(async () => {
      request.resolve({});
      await request.promise;
    });

    expect(closeWasDisabled).toBe(true);
    expect(cancelWasDisabled).toBe(true);
    expect(formStayedMounted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Планирование ревью' })).not.toBeInTheDocument());
  });

  it('keeps a conflicting edit and its draft visible with an actionable explanation', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    await screen.findByText('Обсудить ближайшие приоритеты');
    const plannedRow = articleForText('Обсудить ближайшие приоритеты');
    await user.click(within(plannedRow).getByRole('button', {
      name: 'Редактировать запланированное ревью Анна Ким',
    }));
    const reason = within(plannedRow).getByLabelText(/Комментарий/);
    await user.clear(reason);
    await user.type(reason, 'Черновик, который нельзя потерять');
    mockTeamApiFetch.mockRejectedValueOnce(reviewConflictError());

    await user.click(within(plannedRow).getByRole('button', { name: 'Сохранить изменения' }));

    expect(await within(plannedRow).findByRole('alert')).toHaveTextContent(
      'Ревью уже изменил другой руководитель. Ваш черновик пока остался в форме. Скопируйте нужные изменения, затем нажмите «Отмена»: мы загрузим актуальную версию.',
    );
    expect(within(plannedRow).getByRole('form', {
      name: 'Редактирование запланированного ревью',
    })).toBeVisible();
    expect(within(plannedRow).getByLabelText(/Комментарий/)).toHaveValue('Черновик, который нельзя потерять');

    const refreshedReviews = initialReviews().map((review) => review.id === 'scheduled-early'
      ? {
          ...review,
          reason: 'Актуальная повестка другого руководителя',
          updatedAt: '2026-08-02T10:15:00.000Z',
        }
      : review);
    mockTeamApiFetch.mockResolvedValueOnce(reviewsResponse(refreshedReviews));
    await user.click(within(plannedRow).getByRole('button', { name: 'Отмена' }));

    expect(await screen.findByText('Актуальная повестка другого руководителя')).toBeVisible();
    expect(mockTeamApiFetch).toHaveBeenLastCalledWith('/api/team/reviews');
  });

  it('announces initial loading and marks the reviews region as busy', async () => {
    const request = deferred<unknown>();
    mockTeamApiFetch.mockImplementationOnce(() => request.promise);
    render(<TeamReviewsPanel />);

    const region = screen.getByRole('region', { name: 'Ревью' });
    const busyWhileLoading = region.getAttribute('aria-busy');
    const loadingStatus = screen.queryByRole('status');
    await act(async () => {
      request.resolve(reviewsResponse());
      await request.promise;
    });

    expect(busyWhileLoading).toBe('true');
    expect(loadingStatus).toHaveTextContent('Загружаем ревью');
    await screen.findByText('Обсудить ближайшие приоритеты');
    expect(region).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('uses readable semantic text for placeholders and missing review values', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    const search = await screen.findByRole('searchbox', { name: 'Поиск по ревью' });
    expect(search).toHaveClass('placeholder:text-gray-500');
    expect(search).not.toHaveClass('placeholder:text-gray-400');

    await user.click(await screen.findByRole('button', { name: 'Запланировать ревью' }));
    const agenda = screen.getByLabelText(/Комментарий/);
    expect(agenda).toHaveAttribute('placeholder', 'Что важно обсудить на встрече');
    expect(agenda).toHaveClass('placeholder:text-gray-500');
    expect(agenda).not.toHaveClass('placeholder:text-gray-400');
    await user.click(screen.getByRole('button', { name: 'Закрыть форму' }));

    const plannedRow = articleForText('Обсудить ближайшие приоритеты');
    await user.click(within(plannedRow).getByRole('button', { name: 'Заполнить итоги' }));
    within(plannedRow).getAllByRole('textbox').forEach((textarea) => {
      expect(textarea).toHaveClass('placeholder:text-gray-500');
      expect(textarea).not.toHaveClass('placeholder:text-gray-400');
    });
    await user.click(within(plannedRow).getByRole('button', { name: 'Отмена' }));

    const completedRow = articleForText('Старые итоги ревью');
    await user.click(within(completedRow).getByRole('button', { name: /Старые итоги ревью/ }));
    within(completedRow).getAllByText('Не указано').forEach((fallback) => {
      expect(fallback).toHaveClass('text-gray-500');
      expect(fallback).not.toHaveClass('text-gray-400');
    });
  });

  it('keeps dark-theme placeholder text at WCAG AA contrast', () => {
    const css = portalGlobalsCss();
    const faintText = darkThemeHexToken(css, '--pd-text-faint');
    const inputSurface = darkThemeHexToken(css, '--pd-surface-elev');

    expect(contrastRatio(faintText, inputSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('wraps long unbroken review content inside its responsive grid cell', async () => {
    const user = userEvent.setup();
    const longOutcomes = 'A'.repeat(200);
    mockTeamApiFetch.mockResolvedValueOnce(reviewsResponse(
      initialReviews().map((review) => review.id === 'completed-new'
        ? { ...review, outcomes: longOutcomes }
        : review),
    ));
    render(<TeamReviewsPanel />);

    await screen.findByText(longOutcomes);
    const completedRow = articleForText(longOutcomes);
    await user.click(within(completedRow).getByRole('button', { name: new RegExp(longOutcomes) }));
    const outcomes = within(completedRow)
      .getAllByText(longOutcomes)
      .find((element) => element.tagName === 'P');

    expect(outcomes).toBeDefined();
    expect(outcomes?.closest('section')).toHaveClass('min-w-0');
    expect(outcomes).toHaveClass('[overflow-wrap:anywhere]');
  });

  it('keeps the dark-theme primary hover visibly distinct from its resting state', () => {
    const css = portalGlobalsCss();
    const primaryButtonBlocks = css.match(/[^{}]*button\.bg-gray-900[^{}]*\{[^{}]*\}/g) || [];

    expect(primaryButtonBlocks.some((block) => (
      block.includes(':hover')
      && block.includes(':not(:disabled)')
      && /background-color:\s*var\(--pd-text-mute\)\s*!important/.test(block)
    ))).toBe(true);
  });
});
