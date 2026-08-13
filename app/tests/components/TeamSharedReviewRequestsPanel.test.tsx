import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamSharedReviewRequestsPanel from '@/components/team/TeamSharedReviewRequestsPanel';

const mockTeamApiFetch = jest.fn();

jest.mock('@/components/team/teamApi', () => ({
  ...jest.requireActual('@/components/team/teamApi'),
  teamApiFetch: (...args: unknown[]) => mockTeamApiFetch(...args),
}));

const sharedRequest = {
  id: 'shared-request-1',
  state: 'new' as const,
  employee: { id: 'employee-1', name: 'Анна Ким', avatarUrl: null },
  initiator: { id: 'lead-1', name: 'Иван Руководитель', avatarUrl: null },
  project: { id: 'project-1', name: 'Acme · Аутрич' },
  problem: 'Снизилась инициативность и скорость выполнения задач',
  examples: 'Обсуждение https://t.me/c/123/456',
  desiredOutcome: 'Понять причину и договориться о следующем шаге',
  createdAt: '2026-08-13T08:00:00.000Z',
  updatedAt: '2026-08-13T08:00:00.000Z',
};

const response = {
  requests: [sharedRequest],
  summary: {
    total: 1,
    newCount: 1,
    inProgressCount: 0,
    convertedCount: 0,
    declinedCount: 0,
  },
  canManage: false,
};

function detailsToggle(requestId: string): HTMLButtonElement {
  const button = screen.getAllByRole('button').find((candidate) => (
    candidate.getAttribute('aria-controls') === `shared-review-request-details-${requestId}`
  ));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Toggle for ${requestId} not found`);
  return button;
}

describe('<TeamSharedReviewRequestsPanel />', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTeamApiFetch.mockResolvedValue(response);
  });

  it('loads the server-redacted shared endpoint as an accessible read-only inbox', async () => {
    const user = userEvent.setup();
    render(<TeamSharedReviewRequestsPanel />);

    const region = screen.getByRole('region', { name: 'Общие запросы на ревью' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(region).toHaveAttribute('aria-busy', 'false'));
    expect(mockTeamApiFetch).toHaveBeenCalledWith('/api/team/review-requests/shared');
    expect(screen.getByRole('heading', { name: 'Запросы на ревью' })).toBeInTheDocument();
    expect(screen.getByText(/запросы, созданные лидами и директорами/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(within(region).getAllByRole('listitem')).toHaveLength(1);

    const toggle = detailsToggle(sharedRequest.id);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Анна Ким');
    expect(toggle).toHaveTextContent('Иван Руководитель');
    expect(toggle).toHaveTextContent('Acme · Аутрич');
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('region', { name: `Детали запроса ${sharedRequest.employee.name}` });
    expect(details).toHaveTextContent(sharedRequest.problem);
    expect(details).toHaveTextContent(sharedRequest.desiredOutcome);
    expect(within(details).getByRole('link', { name: /открыть обсуждение/i })).toHaveAttribute(
      'href',
      'https://t.me/c/123/456',
    );
    expect(screen.queryByRole('button', { name: 'Взять в работу' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Запланировать ревью' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /закрыть без ревью/i })).not.toBeInTheDocument();
  });

  it('never renders private workflow fields or management actions even if a malformed response includes them', async () => {
    mockTeamApiFetch.mockResolvedValue({
      ...response,
      canManage: true,
      requests: [{
        ...sharedRequest,
        state: 'in_progress',
        claimedBy: { id: 'hr-1', name: 'СЕКРЕТНЫЙ HR' },
        claimedAt: '2026-08-13T09:00:00.000Z',
        resolvedBy: { id: 'hr-2', name: 'СЕКРЕТНЫЙ РЕШАЮЩИЙ' },
        resolvedAt: '2026-08-13T10:00:00.000Z',
        decisionNote: 'СЕКРЕТНОЕ РЕШЕНИЕ',
        linkedReviewId: 'СЕКРЕТНОЕ РЕВЬЮ',
        updatedBy: { id: 'hr-3', name: 'СЕКРЕТНЫЙ РЕДАКТОР' },
      }],
    });
    const user = userEvent.setup();
    render(<TeamSharedReviewRequestsPanel />);

    await waitFor(() => expect(screen.getByRole('region', { name: 'Общие запросы на ревью' })).toHaveAttribute('aria-busy', 'false'));
    await user.click(detailsToggle(sharedRequest.id));

    expect(screen.queryByText(/СЕКРЕТН/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Взять в работу' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Запланировать ревью' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /решение|комментарий/i })).not.toBeInTheDocument();
  });

  it('shows an accessible retry state without exposing stale content', async () => {
    mockTeamApiFetch
      .mockRejectedValueOnce(new Error('Не удалось загрузить запросы'))
      .mockResolvedValueOnce(response);
    const user = userEvent.setup();
    render(<TeamSharedReviewRequestsPanel />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось загрузить запросы');
    expect(screen.queryByText(sharedRequest.problem)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    await screen.findByText(sharedRequest.problem);
    expect(mockTeamApiFetch).toHaveBeenCalledTimes(2);
  });

  it('uses responsive shared theme tokens, reduced motion and safe wrapping for long content', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/components/team/TeamSharedReviewRequestsPanel.tsx'),
      'utf8',
    );

    expect(source).not.toContain('dark:');
    expect(source).not.toMatch(/<table\b/i);
    expect(source).toContain('min-w-0');
    expect(source).toContain('overflow-hidden');
    expect(source).toContain('motion-reduce:animate-none');
    expect(source).toMatch(/break-(?:words|all)/);
  });
});
