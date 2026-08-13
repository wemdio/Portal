import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamReviewRequestForm from '@/components/team/TeamReviewRequestForm';

const mockTeamApiFetch = jest.fn();

jest.mock('@/components/team/teamApi', () => ({
  ...jest.requireActual('@/components/team/teamApi'),
  teamApiFetch: (...args: unknown[]) => mockTeamApiFetch(...args),
}));

const employees = [
  { id: 'employee-1', name: 'Анна Ким', email: 'anna@example.com', avatarUrl: null },
  { id: 'employee-2', name: 'Иван Петров', email: null, avatarUrl: null },
];

const projects = [
  { id: 'project-1', name: 'Acme · Аутрич' },
  { id: 'project-2', name: 'BPMSoft · Перфоманс' },
];

describe('<TeamReviewRequestForm />', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTeamApiFetch.mockResolvedValue({ requestId: 'request-1' });
  });

  it('opens an inline, minimal request form with no editable initiator field', async () => {
    const user = userEvent.setup();
    render(
      <TeamReviewRequestForm
        employees={employees}
        projects={projects}
        requestVisibility="lead_shared"
        onSubmitted={jest.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Запросить ревью' });
    await user.click(trigger);

    const form = screen.getByRole('form', { name: 'Новый запрос на ревью' });
    expect(within(form).getByLabelText('Сотрудник, с которым нужно ревью')).toBeRequired();
    expect(within(form).getByLabelText('Проект, необязательно')).not.toBeRequired();
    expect(within(form).getByLabelText('Проблема или причина')).toBeRequired();
    expect(within(form).getByLabelText('Проблема или причина')).toHaveAttribute('maxlength', '500');
    expect(within(form).getByLabelText('Примеры или обсуждения, необязательно')).not.toBeRequired();
    expect(within(form).getByLabelText('Примеры или обсуждения, необязательно')).toHaveAttribute('maxlength', '5000');
    expect(within(form).getByLabelText('Что нужно выяснить')).toBeRequired();
    expect(within(form).getByLabelText('Что нужно выяснить')).toHaveAttribute('maxlength', '1000');
    expect(within(form).queryByLabelText(/инициатор/i)).not.toBeInTheDocument();
    expect(within(form).getByRole('note')).toHaveTextContent(
      'Запрос увидят другие лиды и директора. Обработать его смогут Алина и Сергей.',
    );
    expect(trigger.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('explains private visibility without exposing a user-controlled visibility switch', async () => {
    const user = userEvent.setup();
    render(
      <TeamReviewRequestForm
        employees={employees}
        projects={projects}
        requestVisibility="private"
        onSubmitted={jest.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Запросить ревью' }));
    const form = screen.getByRole('form', { name: 'Новый запрос на ревью' });

    expect(within(form).getByRole('note')).toHaveTextContent('Запрос увидят только Алина и Сергей.');
    expect(within(form).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(form).queryByLabelText(/видимость|доступ/i)).not.toBeInTheDocument();
  });

  it('submits trimmed business fields without a client-controlled initiator', async () => {
    const onSubmitted = jest.fn();
    const user = userEvent.setup();
    render(
      <TeamReviewRequestForm
        employees={employees}
        projects={projects}
        requestVisibility="lead_shared"
        onSubmitted={onSubmitted}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Запросить ревью' });
    await user.click(trigger);
    const form = screen.getByRole('form', { name: 'Новый запрос на ревью' });

    await user.selectOptions(within(form).getByLabelText('Сотрудник, с которым нужно ревью'), 'employee-1');
    await user.selectOptions(within(form).getByLabelText('Проект, необязательно'), 'project-1');
    await user.type(within(form).getByLabelText('Проблема или причина'), '  Не хватает контекста перед запуском  ');
    await user.type(within(form).getByLabelText('Примеры или обсуждения, необязательно'), '  https://t.me/c/123/456  ');
    await user.type(within(form).getByLabelText('Что нужно выяснить'), '  Зафиксировать следующий шаг  ');
    await user.click(within(form).getByRole('button', { name: 'Отправить запрос' }));

    await waitFor(() => expect(mockTeamApiFetch).toHaveBeenCalledTimes(1));
    const [url, init] = mockTeamApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/team/review-requests');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      employeeUserId: 'employee-1',
      projectId: 'project-1',
      problem: 'Не хватает контекста перед запуском',
      examples: 'https://t.me/c/123/456',
      desiredOutcome: 'Зафиксировать следующий шаг',
    });
    expect(body).not.toHaveProperty('initiator');
    expect(body).not.toHaveProperty('initiatorUserId');
    expect(body).not.toHaveProperty('createdBy');
    expect(body).not.toHaveProperty('visibility');
    expect(body).not.toHaveProperty('requestVisibility');
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('normalizes empty optional fields to null and blocks missing required values', async () => {
    const user = userEvent.setup();
    render(
      <TeamReviewRequestForm
        employees={employees}
        projects={projects}
        requestVisibility="private"
        onSubmitted={jest.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Запросить ревью' }));
    const form = screen.getByRole('form', { name: 'Новый запрос на ревью' });

    await user.click(within(form).getByRole('button', { name: 'Отправить запрос' }));
    expect(mockTeamApiFetch).not.toHaveBeenCalled();

    await user.selectOptions(within(form).getByLabelText('Сотрудник, с которым нужно ревью'), 'employee-2');
    await user.type(within(form).getByLabelText('Проблема или причина'), 'Нужна помощь с приоритетами');
    await user.type(within(form).getByLabelText('Что нужно выяснить'), 'Как перестроить план');
    await user.click(within(form).getByRole('button', { name: 'Отправить запрос' }));

    await waitFor(() => expect(mockTeamApiFetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((mockTeamApiFetch.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({
      employeeUserId: 'employee-2',
      projectId: null,
      problem: 'Нужна помощь с приоритетами',
      examples: null,
      desiredOutcome: 'Как перестроить план',
    });
  });

  it('keeps the inline draft visible when submission fails and returns focus on cancel', async () => {
    mockTeamApiFetch.mockRejectedValueOnce(new Error('Не удалось отправить запрос'));
    const user = userEvent.setup();
    render(
      <TeamReviewRequestForm
        employees={employees}
        projects={projects}
        requestVisibility="private"
        onSubmitted={jest.fn()}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Запросить ревью' });
    await user.click(trigger);
    const form = screen.getByRole('form', { name: 'Новый запрос на ревью' });

    await user.selectOptions(within(form).getByLabelText('Сотрудник, с которым нужно ревью'), 'employee-1');
    await user.type(within(form).getByLabelText('Проблема или причина'), 'Черновик проблемы');
    await user.type(within(form).getByLabelText('Что нужно выяснить'), 'Черновик результата');
    await user.click(within(form).getByRole('button', { name: 'Отправить запрос' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось отправить запрос');
    expect(within(form).getByLabelText('Проблема или причина')).toHaveValue('Черновик проблемы');
    expect(within(form).getByLabelText('Что нужно выяснить')).toHaveValue('Черновик результата');

    await user.click(within(form).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
