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
      const employee = body.employeeUserId === ANNA_ID ? anna : vera;
      const review: TeamReview = {
        id: 'scheduled-created',
        reviewDate: body.reviewDate,
        employee,
        reviewer,
        status: 'scheduled',
        reason: body.reason || null,
        outcomes: null,
        problems: null,
        recommendations: null,
        createdAt: '2026-08-01T12:00:00.000Z',
        updatedAt: '2026-08-01T12:00:00.000Z',
      };
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
            employee: body.employeeUserId === ANNA_ID ? anna : vera,
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

    expect(within(form).queryByLabelText('Основные итоги')).not.toBeInTheDocument();
    await user.clear(date);
    await user.type(date, '2026-09-01');
    await user.selectOptions(within(form).getByLabelText('Сотрудник'), ANNA_ID);
    await user.type(within(form).getByLabelText(/Причина/), '  План развития  ');
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

  it('searches scheduled reviews by reason', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    const search = await screen.findByRole('searchbox', { name: 'Поиск по ревью' });
    await user.type(search, 'адаптацию');

    expect(screen.getByText('Сверить адаптацию на новом проекте')).toBeVisible();
    expect(screen.queryByText('Обсудить ближайшие приоритеты')).not.toBeInTheDocument();
    expect(screen.queryByText('Свежие итоги ревью')).not.toBeInTheDocument();
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
    const reason = within(plannedRow).getByLabelText(/Причина/);
    await user.clear(reason);
    await user.type(reason, 'Новая повестка');
    await user.click(within(plannedRow).getByRole('button', { name: 'Сохранить изменения' }));

    await waitFor(() => {
      const patchCall = mockTeamApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall?.[0]).toBe('/api/team/reviews/scheduled-early');
      expect(jsonBody(patchCall?.[1])).toEqual({
        reviewDate: '2026-08-05',
        employeeUserId: ANNA_ID,
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

  it('shows the original agenda in completed review details', async () => {
    const user = userEvent.setup();
    render(<TeamReviewsPanel />);

    await screen.findByText('Свежие итоги ревью');
    const completedRow = articleForText('Свежие итоги ревью');
    await user.click(within(completedRow).getByRole('button', { name: /Свежие итоги ревью/ }));

    expect(within(completedRow).getByText('Повестка')).toBeVisible();
    expect(within(completedRow).getByText('Обсудить фокус на следующий квартал')).toBeVisible();
  });

  it('keeps the create form open and disables every close action while saving', async () => {
    const user = userEvent.setup();
    const request = deferred<unknown>();
    render(<TeamReviewsPanel />);

    await user.click(await screen.findByRole('button', { name: 'Запланировать ревью' }));
    const form = screen.getByRole('form', { name: 'Планирование ревью' });
    await user.selectOptions(within(form).getByLabelText('Сотрудник'), ANNA_ID);
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
    const reason = within(plannedRow).getByLabelText(/Причина/);
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
    expect(within(plannedRow).getByLabelText(/Причина/)).toHaveValue('Черновик, который нельзя потерять');

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

    const region = screen.getByRole('region', { name: 'Ревью сотрудников' });
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
    const agenda = screen.getByLabelText(/Причина/);
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
