import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamTalentReservePanel from '@/components/team/TeamTalentReservePanel';
import { TeamApiError } from '@/components/team/teamApi';

const mockTeamApiFetch = jest.fn();

jest.mock('@/components/team/teamApi', () => ({
  ...jest.requireActual('@/components/team/teamApi'),
  teamApiFetch: (...args: unknown[]) => mockTeamApiFetch(...args),
}));

type TalentEntry = {
  id: string;
  contact: string;
  candidateName: string;
  vacancyDirection: string;
  testAssignment: string | null;
  testResult: string | null;
  testSentOn: string | null;
  interviewOn: string | null;
  comment: string | null;
  revisitOn: string | null;
  revisitNote: string | null;
  stage: 'new' | 'test' | 'interview' | 'reserve' | 'return_later' | 'hired' | 'rejected' | 'archived';
  createdAt: string;
  updatedAt: string;
};

const revisitDue: TalentEntry = {
  id: 'talent-return',
  contact: '@maria_sokolova',
  candidateName: 'Мария Соколова',
  vacancyDirection: 'Аккаунт-менеджер',
  testAssignment: 'https://docs.example.com/test',
  testResult: 'Сильная структура ответа',
  testSentOn: '2026-08-01',
  interviewOn: null,
  comment: 'Есть опыт в агентстве',
  revisitOn: '2026-08-10',
  revisitNote: 'Вернуться после отпуска',
  stage: 'return_later',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
};

const interviewToday: TalentEntry = {
  ...revisitDue,
  id: 'talent-interview',
  contact: 'ivan@example.com',
  candidateName: 'Иван Смирнов',
  vacancyDirection: 'Специалист по аутричу',
  stage: 'interview',
  interviewOn: '2026-08-11',
  revisitOn: null,
  revisitNote: null,
};

const activeCandidate: TalentEntry = {
  ...revisitDue,
  id: 'talent-test',
  contact: '+7 900 000-00-00',
  candidateName: 'Ольга Белова',
  vacancyDirection: 'Лидогенерация',
  stage: 'test',
  // Dates from another stage must not pull a test-stage candidate into attention.
  interviewOn: '2026-08-01',
  revisitOn: '2026-08-01',
  revisitNote: null,
};

const historicalCandidate: TalentEntry = {
  ...revisitDue,
  id: 'talent-history',
  contact: 'https://t.me/archive_candidate',
  candidateName: 'Пётр Архивный',
  vacancyDirection: 'Продажи',
  stage: 'rejected',
  interviewOn: null,
  revisitOn: null,
  revisitNote: null,
};

let response: {
  entries: TalentEntry[];
  summary: { total: number; attentionCount: number; activeCount: number; historyCount: number };
  asOf: string;
  canManage: boolean;
};

function defaultResponse(overrides: Partial<typeof response> = {}) {
  return {
    entries: [revisitDue, interviewToday, activeCandidate, historicalCandidate],
    summary: { total: 4, attentionCount: 2, activeCount: 3, historyCount: 1 },
    asOf: '2026-08-11',
    canManage: true,
    ...overrides,
  };
}

function sectionForHeading(name: string) {
  const heading = screen.getByRole('heading', { name });
  const section = heading.closest('section');
  if (!section) throw new Error(`Section for ${name} not found`);
  return section;
}

function apiBody(method: string, urlPart: string) {
  const call = mockTeamApiFetch.mock.calls.find(([url, init]) => (
    String(url).includes(urlPart) && ((init as RequestInit | undefined)?.method || 'GET') === method
  ));
  if (!call) throw new Error(`${method} ${urlPart} was not called`);
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe('<TeamTalentReservePanel />', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    response = defaultResponse();
    mockTeamApiFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      if (url === '/api/team/talent-reserve' && method === 'GET') return response;
      if (url === '/api/team/talent-reserve' && method === 'POST') return { entry: activeCandidate };
      if (url.startsWith('/api/team/talent-reserve/') && method === 'PATCH') return { entry: activeCandidate };
      if (url.startsWith('/api/team/talent-reserve/') && method === 'DELETE') return { ok: true };
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
  });

  it('renders an expandable responsive list grouped by attention, active work and history', async () => {
    const user = userEvent.setup();
    render(<TeamTalentReservePanel />);

    const region = screen.getByRole('region', { name: 'Кадровый резерв' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(region).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(region).toHaveClass('min-w-0', 'overflow-hidden');

    const attention = sectionForHeading('Требуют внимания');
    expect(attention).toHaveAttribute('aria-labelledby', 'talent-group-attention');
    expect(attention).toHaveTextContent('Мария Соколова');
    expect(attention).toHaveTextContent('Иван Смирнов');
    expect(sectionForHeading('В работе')).toHaveTextContent('Ольга Белова');
    expect(sectionForHeading('История')).toHaveTextContent('Пётр Архивный');
    expect(within(attention).getAllByRole('listitem')).toHaveLength(2);

    const mariaToggle = within(attention).getByRole('button', { name: /^Мария Соколова/ });
    expect(mariaToggle).toHaveAttribute('aria-expanded', 'false');
    expect(mariaToggle).toHaveClass('min-h-11');
    await user.click(mariaToggle);
    expect(mariaToggle).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('region', { name: 'Детали кандидата Мария Соколова' });
    expect(details).toHaveTextContent('Тестовое задание');
    expect(details).toHaveTextContent('Сильная структура ответа');
    expect(details).toHaveTextContent('10.08.2026');
    expect(details).toHaveTextContent('Вернуться после отпуска');
  });

  it('searches the useful fields and filters by stage without duplicating a spreadsheet', async () => {
    const user = userEvent.setup();
    render(<TeamTalentReservePanel />);
    await screen.findByText('Мария Соколова');

    const search = screen.getByRole('searchbox', { name: 'Поиск по кадровому резерву' });
    await user.type(search, 'ivan@example.com');
    expect(screen.getByText('Иван Смирнов')).toBeInTheDocument();
    expect(screen.queryByText('Мария Соколова')).not.toBeInTheDocument();

    await user.clear(search);
    await user.selectOptions(screen.getByLabelText('Фильтр по этапу'), 'return_later');
    expect(screen.getByText('Мария Соколова')).toBeInTheDocument();
    expect(screen.queryByText('Иван Смирнов')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Фильтр по этапу'), 'all');
    await user.type(search, 'лидогенерация');
    expect(screen.getByText('Ольга Белова')).toBeInTheDocument();
  });

  it('creates all approved fields inline and reveals return fields only for return_later', async () => {
    const user = userEvent.setup();
    render(<TeamTalentReservePanel />);
    await screen.findByText('Мария Соколова');
    const trigger = screen.getByRole('button', { name: 'Добавить кандидата' });
    await user.click(trigger);

    const form = screen.getByRole('form', { name: 'Новая запись кадрового резерва' });
    expect(within(form).getByLabelText('Контакт')).toHaveAttribute('maxlength', '500');
    expect(within(form).getByLabelText('Имя')).toHaveAttribute('maxlength', '200');
    expect(within(form).getByLabelText('Вакансия или направление')).toHaveAttribute('maxlength', '500');
    expect(within(form).getByLabelText('Тестовое задание')).toHaveAttribute('maxlength', '5000');
    expect(within(form).getByLabelText('Результат тестового')).toHaveAttribute('maxlength', '500');
    expect(within(form).getByLabelText('Комментарий')).toHaveAttribute('maxlength', '5000');
    expect(within(form).queryByLabelText('Когда вернуться')).not.toBeInTheDocument();
    expect(within(form).queryByLabelText('Заметка к возврату')).not.toBeInTheDocument();

    await user.type(within(form).getByLabelText('Контакт'), '  @new_candidate  ');
    await user.type(within(form).getByLabelText('Имя'), '  Елена Новая  ');
    await user.type(within(form).getByLabelText('Вакансия или направление'), '  Аккаунтинг  ');
    await user.type(within(form).getByLabelText('Тестовое задание'), '  https://docs.example.com/new  ');
    await user.type(within(form).getByLabelText('Результат тестового'), '  Хорошо  ');
    await user.type(within(form).getByLabelText('Дата отправки тестового'), '2026-08-02');
    await user.type(within(form).getByLabelText('Дата собеседования'), '2026-08-09');
    await user.type(within(form).getByLabelText('Комментарий'), '  Сильный кандидат  ');
    await user.selectOptions(within(form).getByLabelText('Этап'), 'return_later');
    expect(within(form).getByText('Укажите дату или заметку, чтобы не потерять кандидата.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Когда вернуться'), '2026-09-01');
    await user.type(within(form).getByLabelText('Заметка к возврату'), '  После завершения проекта  ');
    await user.click(within(form).getByRole('button', { name: 'Сохранить кандидата' }));

    await waitFor(() => expect(mockTeamApiFetch).toHaveBeenCalledWith(
      '/api/team/talent-reserve',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(apiBody('POST', '/api/team/talent-reserve')).toEqual({
      contact: '@new_candidate',
      candidateName: 'Елена Новая',
      vacancyDirection: 'Аккаунтинг',
      testAssignment: 'https://docs.example.com/new',
      testResult: 'Хорошо',
      testSentOn: '2026-08-02',
      interviewOn: '2026-08-09',
      comment: 'Сильный кандидат',
      revisitOn: '2026-09-01',
      revisitNote: 'После завершения проекта',
      stage: 'return_later',
    });
    await waitFor(() => expect(trigger).toHaveFocus());
  }, 10_000);

  it('explains and focuses the missing return reminder instead of silently ignoring save', async () => {
    const user = userEvent.setup();
    render(<TeamTalentReservePanel />);
    await screen.findByText('Мария Соколова');
    await user.click(screen.getByRole('button', { name: 'Добавить кандидата' }));
    const form = screen.getByRole('form', { name: 'Новая запись кадрового резерва' });

    await user.type(within(form).getByLabelText('Контакт'), '@candidate');
    await user.type(within(form).getByLabelText('Имя'), 'Кандидат');
    await user.type(within(form).getByLabelText('Вакансия или направление'), 'Аутрич');
    await user.selectOptions(within(form).getByLabelText('Этап'), 'return_later');
    await user.click(within(form).getByRole('button', { name: 'Сохранить кандидата' }));

    expect(within(form).getByRole('alert')).toHaveTextContent('Укажите дату или заметку, чтобы сохранить кандидата');
    const revisitDate = within(form).getByLabelText('Когда вернуться');
    expect(revisitDate).toHaveAttribute('aria-invalid', 'true');
    expect(revisitDate).toHaveFocus();
    expect(mockTeamApiFetch).toHaveBeenCalledTimes(1);

    await user.type(within(form).getByLabelText('Заметка к возврату'), 'После отпуска');
    expect(within(form).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('locks other edit actions while a draft is open or saving so the draft cannot be replaced', async () => {
    let resolvePatch!: (value: { entry: TalentEntry }) => void;
    const pendingPatch = new Promise<{ entry: TalentEntry }>((resolve) => {
      resolvePatch = resolve;
    });
    mockTeamApiFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      if (url === '/api/team/talent-reserve' && method === 'GET') return response;
      if (url === '/api/team/talent-reserve/talent-return' && method === 'PATCH') return pendingPatch;
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const user = userEvent.setup();
    render(<TeamTalentReservePanel />);
    await screen.findByText('Мария Соколова');

    await user.click(screen.getByRole('button', { name: /Редактировать.*Мария Соколова/ }));
    const form = screen.getByRole('form', { name: /Редактирование.*Мария Соколова/ });
    const comment = within(form).getByLabelText('Комментарий');
    await user.clear(comment);
    await user.type(comment, 'Черновик Марии нельзя заменить');
    const otherEdit = screen.getByRole('button', { name: /Редактировать.*Иван Смирнов/ });

    expect(otherEdit).toBeDisabled();
    await user.click(otherEdit);
    expect(screen.getByRole('form', { name: /Редактирование.*Мария Соколова/ })).toBeInTheDocument();
    expect(comment).toHaveValue('Черновик Марии нельзя заменить');

    await user.click(within(form).getByRole('button', { name: 'Сохранить изменения' }));
    await waitFor(() => expect(mockTeamApiFetch).toHaveBeenCalledWith(
      '/api/team/talent-reserve/talent-return',
      expect.objectContaining({ method: 'PATCH' }),
    ));
    expect(otherEdit).toBeDisabled();
    await user.click(otherEdit);
    expect(comment).toHaveValue('Черновик Марии нельзя заменить');

    resolvePatch({ entry: activeCandidate });
    await waitFor(() => expect(screen.queryByRole('form', { name: /Редактирование/ })).not.toBeInTheDocument());
    expect(otherEdit).not.toBeDisabled();
  });

  it('sends the original CAS token on edit and keeps a conflicting draft visible', async () => {
    const user = userEvent.setup();
    mockTeamApiFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      if (url === '/api/team/talent-reserve' && method === 'GET') return response;
      if (url === '/api/team/talent-reserve/talent-return' && method === 'PATCH') {
        throw new TeamApiError('Запись уже изменилась', 409, { code: 'talent_reserve_conflict' });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    render(<TeamTalentReservePanel />);
    await screen.findByText('Мария Соколова');
    await user.click(screen.getByRole('button', { name: /Редактировать.*Мария Соколова/ }));
    const form = screen.getByRole('form', { name: /Редактирование.*Мария Соколова/ });
    const comment = within(form).getByLabelText('Комментарий');
    await user.clear(comment);
    await user.type(comment, 'Мой несохранённый комментарий');
    await user.click(within(form).getByRole('button', { name: 'Сохранить изменения' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/изменил|изменилась/i);
    expect(comment).toHaveValue('Мой несохранённый комментарий');
    expect(apiBody('PATCH', '/api/team/talent-reserve/talent-return')).toEqual(expect.objectContaining({
      comment: 'Мой несохранённый комментарий',
      expectedUpdatedAt: revisitDue.updatedAt,
    }));
  });

  it('archives with CAS and confirms destructive deletion without losing keyboard focus', async () => {
    const user = userEvent.setup();
    render(<TeamTalentReservePanel />);
    await screen.findByText('Мария Соколова');
    await user.click(screen.getByRole('button', { name: /Редактировать.*Мария Соколова/ }));
    let form = screen.getByRole('form', { name: /Редактирование.*Мария Соколова/ });

    await user.click(within(form).getByRole('button', { name: 'В архив' }));
    await waitFor(() => expect(apiBody('PATCH', '/api/team/talent-reserve/talent-return')).toEqual({
      stage: 'archived',
      expectedUpdatedAt: revisitDue.updatedAt,
    }));

    await user.click(screen.getByRole('button', { name: /Редактировать.*Мария Соколова/ }));
    form = screen.getByRole('form', { name: /Редактирование.*Мария Соколова/ });
    const deleteButton = within(form).getByRole('button', { name: 'Удалить запись' });
    await user.click(deleteButton);
    const confirm = within(form).getByRole('button', { name: 'Удалить без возможности восстановления' });
    expect(confirm).toHaveFocus();
    await user.click(within(form).getByRole('button', { name: 'Отмена удаления' }));
    const restoredDeleteButton = within(form).getByRole('button', { name: 'Удалить запись' });
    expect(restoredDeleteButton).toHaveFocus();

    await user.click(restoredDeleteButton);
    await user.click(within(form).getByRole('button', { name: 'Удалить без возможности восстановления' }));
    await waitFor(() => expect(apiBody('DELETE', '/api/team/talent-reserve/talent-return')).toEqual({
      expectedUpdatedAt: revisitDue.updatedAt,
    }));
  });

  it('keeps read-only data expandable while hiding every mutation control', async () => {
    response = defaultResponse({ canManage: false });
    const user = userEvent.setup();
    render(<TeamTalentReservePanel />);
    await screen.findByText('Мария Соколова');

    expect(screen.queryByRole('button', { name: 'Добавить кандидата' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Редактировать/ })).not.toBeInTheDocument();
    const row = screen.getByRole('button', { name: /Мария Соколова/ });
    await user.click(row);
    expect(screen.getByRole('region', { name: 'Детали кандидата Мария Соколова' })).toBeInTheDocument();
  });

  it('uses the shared dark-theme vocabulary, reduced-motion skeletons and wrapping instead of a wide table', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/components/team/TeamTalentReservePanel.tsx'),
      'utf8',
    );
    expect(source).not.toContain('dark:');
    expect(source).not.toMatch(/<table\b/i);
    expect(source).toContain('motion-reduce:animate-none');
    expect(source).toMatch(/break-(?:words|all)/);
    expect(source).not.toMatch(/min-w-\[(?:8|9|1\d)\d\dpx\]/);
  });
});
