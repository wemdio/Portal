import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamPage from '@/app/team/page';
import type { UserRole } from '@/types';

let mockUserRole: UserRole | null | 'unknown' = 'technician';
let mockIsHr = false;
let mockCanAccessTeamPrivate = false;
let mockCanSubmitTeamReviewRequest = false;
let mockCanViewTeamReviewRequestsShared = false;
let mockUserEmail = 'team-member@example.com';
let mockNewReviewRequestCount = 0;
let mockProjectsData: Array<Record<string, unknown>> = [];
let mockProfilesData: Array<Record<string, unknown>> = [];

const mockSupabaseFrom = jest.fn((table: string) => ({
  select: jest.fn().mockResolvedValue({
    data: table === 'projects' ? mockProjectsData : mockProfilesData,
    error: null,
  }),
}));
const mockStatisticsPanel = jest.fn(() => <div>Statistics panel mounted</div>);
const mockReviewsPanel = jest.fn(() => <div>Reviews panel mounted</div>);
const mockActivityPlanPanel = jest.fn(() => <div>Activity plan panel mounted</div>);
const mockSharedReviewRequestsPanel = jest.fn(() => <div>Shared review requests panel mounted</div>);
const mockRefreshReviewRequestSummary = jest.fn();
const mockUseTeamReviewRequestSummary = jest.fn((_enabled: boolean) => ({
  newCount: mockNewReviewRequestCount,
  refresh: mockRefreshReviewRequestSummary,
}));
const mockHrPanel = jest.fn(({
  newRequestCount,
  onReviewRequestsChanged,
}: {
  newRequestCount: number;
  onReviewRequestsChanged: () => void;
}) => (
  <div>
    <span>HR panel mounted</span>
    <span>Nested requests count: {newRequestCount}</span>
    <button type="button" onClick={onReviewRequestsChanged}>Mock request mutation</button>
  </div>
));

jest.mock('@/lib/UserProvider', () => ({
  useUser: () => ({
    userRole: mockUserRole,
    isHr: mockIsHr,
    canAccessTeamPrivate: mockCanAccessTeamPrivate,
    canSubmitTeamReviewRequest: mockCanSubmitTeamReviewRequest,
    canViewTeamReviewRequestsShared: mockCanViewTeamReviewRequestsShared,
    userEmail: mockUserEmail,
    userFullName: 'Team Member',
    userAvatarUrl: null,
    navTabVisibility: {},
    visibleTools: null,
    badges: {},
    handleAvatarError: jest.fn(),
    handleSignOut: jest.fn(),
  }),
}));

jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => mockSupabaseFrom(table),
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

jest.mock('@/lib/useIsTma', () => ({
  useIsTma: () => false,
}));

jest.mock('@/components/team/TeamStatisticsPanel', () => ({
  __esModule: true,
  default: () => mockStatisticsPanel(),
}));

jest.mock('@/components/team/TeamReviewsPanel', () => ({
  __esModule: true,
  default: () => mockReviewsPanel(),
}));

jest.mock('@/components/team/TeamActivityPlanPanel', () => ({
  __esModule: true,
  default: () => mockActivityPlanPanel(),
}), { virtual: true });

jest.mock('../../src/components/team/TeamSharedReviewRequestsPanel', () => ({
  __esModule: true,
  default: () => mockSharedReviewRequestsPanel(),
}), { virtual: true });

jest.mock('../../src/components/team/TeamHrPanel', () => ({
  __esModule: true,
  default: (props: {
    newRequestCount: number;
    onReviewRequestsChanged: () => void;
  }) => mockHrPanel(props),
}), { virtual: true });

jest.mock('../../src/components/team/useTeamReviewRequestSummary', () => ({
  useTeamReviewRequestSummary: (enabled: boolean) => mockUseTeamReviewRequestSummary(enabled),
}), { virtual: true });

async function renderLoadedTeamPage() {
  const view = render(<TeamPage />);
  expect(await screen.findByRole('heading', { name: 'Лиды' })).toBeInTheDocument();
  return view;
}

describe('<TeamPage /> access', () => {
  beforeEach(() => {
    mockUserRole = 'technician';
    mockIsHr = false;
    mockCanAccessTeamPrivate = false;
    mockCanSubmitTeamReviewRequest = false;
    mockCanViewTeamReviewRequestsShared = false;
    mockUserEmail = 'team-member@example.com';
    mockNewReviewRequestCount = 0;
    mockProjectsData = [];
    mockProfilesData = [];
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it.each<UserRole>(['technician', 'manager', 'sales', 'marketer', 'lead', 'director', 'admin'])(
    'shows only the load workspace to an internal %s without the private-team capability',
    async (role) => {
      mockUserRole = role;

      await renderLoadedTeamPage();

      expect(screen.queryByRole('group', { name: 'Разделы команды' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Статистика' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Ревью' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Активности' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^HR(?:,|$)/ })).not.toBeInTheDocument();
      expect(mockStatisticsPanel).not.toHaveBeenCalled();
      expect(mockReviewsPanel).not.toHaveBeenCalled();
      expect(mockActivityPlanPanel).not.toHaveBeenCalled();
      expect(mockHrPanel).not.toHaveBeenCalled();
    },
  );

  it.each([null, 'unknown'] as const)(
    'fails closed to the load workspace when the role is %s',
    async (role) => {
      mockUserRole = role;

      await renderLoadedTeamPage();

      expect(screen.queryByRole('group', { name: 'Разделы команды' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Статистика' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Ревью' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Активности' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^HR(?:,|$)/ })).not.toBeInTheDocument();
      expect(mockStatisticsPanel).not.toHaveBeenCalled();
      expect(mockReviewsPanel).not.toHaveBeenCalled();
      expect(mockActivityPlanPanel).not.toHaveBeenCalled();
      expect(mockHrPanel).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Алина', 'technician' as UserRole, 'alina@example.com'],
    ['Сергей', 'admin' as UserRole, 'vaver1954@mail.ru'],
  ])('lets %s use all private workspaces when the authoritative capability is true', async (_name, role, email) => {
    mockUserRole = role;
    mockUserEmail = email;
    mockCanAccessTeamPrivate = true;
    mockCanSubmitTeamReviewRequest = true;
    const user = userEvent.setup();

    await renderLoadedTeamPage();

    expect(screen.getByRole('button', { name: 'Загрузка' })).toHaveAttribute('aria-pressed', 'true');
    const statisticsTab = screen.getByRole('button', { name: 'Статистика' });
    const reviewsTab = screen.getByRole('button', { name: 'Ревью' });
    const activitiesTab = screen.getByRole('button', { name: 'Активности' });
    const hrTab = screen.getByRole('button', { name: 'HR' });
    expect(screen.queryByRole('button', { name: 'Запросы' })).not.toBeInTheDocument();

    await user.click(statisticsTab);
    expect(screen.getByText('Statistics panel mounted')).toBeInTheDocument();

    await user.click(reviewsTab);
    expect(screen.getByText('Reviews panel mounted')).toBeInTheDocument();

    await user.click(activitiesTab);
    expect(screen.getByText('Activity plan panel mounted')).toBeInTheDocument();

    await user.click(hrTab);
    expect(screen.getByText('HR panel mounted')).toBeInTheDocument();
    expect(screen.getByText('Nested requests count: 0')).toBeInTheDocument();
  });

  it.each([
    ['an admin role', 'admin' as UserRole, false, 'other-admin@example.com'],
    ['a lead role', 'lead' as UserRole, false, 'lead@example.com'],
    ['a director role', 'director' as UserRole, false, 'director@example.com'],
    ['the legacy HR flag', 'technician' as UserRole, true, 'alina@example.com'],
    ['the approved email', 'technician' as UserRole, false, 'vaver1954@mail.ru'],
  ])('does not grant private access from %s alone', async (_case, role, isHr, email) => {
    mockUserRole = role;
    mockIsHr = isHr;
    mockUserEmail = email;
    mockCanAccessTeamPrivate = false;

    await renderLoadedTeamPage();

    expect(screen.queryByRole('group', { name: 'Разделы команды' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Статистика' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ревью' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Активности' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^HR(?:,|$)/ })).not.toBeInTheDocument();
  });

  it.each([
    ['Статистика', 'Statistics panel mounted'],
    ['Ревью', 'Reviews panel mounted'],
    ['Активности', 'Activity plan panel mounted'],
    ['HR', 'HR panel mounted'],
  ])('immediately leaves %s when the private-team capability is revoked', async (tabName, panelText) => {
    mockUserRole = 'technician';
    mockCanAccessTeamPrivate = true;
    const user = userEvent.setup();
    const view = await renderLoadedTeamPage();

    await user.click(screen.getByRole('button', { name: tabName }));
    expect(screen.getByText(panelText)).toBeInTheDocument();

    mockCanAccessTeamPrivate = false;
    view.rerender(<TeamPage />);

    expect(screen.queryByText(panelText)).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Разделы команды' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Лиды' })).toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: 'Команда' });
    await waitFor(() => expect(heading).toHaveFocus());

    mockCanAccessTeamPrivate = true;
    view.rerender(<TeamPage />);

    expect(screen.getByRole('button', { name: 'Загрузка' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(panelText)).not.toBeInTheDocument();
  });

  it.each([
    ['lead', true],
    ['director', true],
    ['admin', false],
    ['manager', false],
    ['technician', false],
    ['sales', false],
    ['marketer', false],
  ] as const)('uses the authoritative submit capability for a %s profile: %s', async (role, allowed) => {
    mockUserRole = role;
    mockCanSubmitTeamReviewRequest = allowed;

    await renderLoadedTeamPage();

    const trigger = screen.queryByRole('button', { name: 'Запросить ревью' });
    if (allowed) expect(trigger).toBeInTheDocument();
    else expect(trigger).not.toBeInTheDocument();
    expect(screen.queryByText('HR panel mounted')).not.toBeInTheDocument();
  });

  it.each(['lead', 'director'] as const)(
    'does not infer submit or shared-read access from the %s role when both server capabilities deny it',
    async (role) => {
      mockUserRole = role;
      mockCanSubmitTeamReviewRequest = false;
      mockCanViewTeamReviewRequestsShared = false;

      await renderLoadedTeamPage();

      expect(screen.queryByRole('button', { name: 'Запросить ревью' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Запросы' })).not.toBeInTheDocument();
    },
  );

  it.each([
    ['Grid4ina.an@gmail.com', 'admin' as UserRole],
    ['sorichev@polzaagency.ru', 'admin' as UserRole],
  ])('lets the approved executive %s submit a private request without exposing the shared queue', async (email, role) => {
    mockUserRole = role;
    mockUserEmail = email;
    mockCanSubmitTeamReviewRequest = true;
    mockCanViewTeamReviewRequestsShared = false;
    const user = userEvent.setup();

    await renderLoadedTeamPage();

    expect(screen.getByRole('button', { name: 'Запросить ревью' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Запросы' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^HR(?:,|$)/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Запросить ревью' }));
    expect(screen.getByRole('note')).toHaveTextContent('Запрос увидят только Алина и Сергей.');
  });

  it('does not hardcode executive email or role when the server denies submit access', async () => {
    mockUserRole = 'admin';
    mockUserEmail = 'Grid4ina.an@gmail.com';
    mockCanSubmitTeamReviewRequest = false;

    await renderLoadedTeamPage();

    expect(screen.queryByRole('button', { name: 'Запросить ревью' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Запросы' })).not.toBeInTheDocument();
  });

  it.each(['lead', 'director'] as const)(
    'shows %s a top-level read-only shared requests workspace without private HR tools',
    async (role) => {
      mockUserRole = role;
      mockCanSubmitTeamReviewRequest = true;
      mockCanViewTeamReviewRequestsShared = true;
      const user = userEvent.setup();

      await renderLoadedTeamPage();

      const navigation = screen.getByRole('group', { name: 'Разделы команды' });
      expect(within(navigation).getByRole('button', { name: 'Загрузка' })).toHaveAttribute('aria-pressed', 'true');
      const requestsTab = within(navigation).getByRole('button', { name: 'Запросы' });
      expect(screen.queryByRole('button', { name: 'Статистика' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Ревью' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Активности' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^HR(?:,|$)/ })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Запросить ревью' }));
      expect(screen.getByRole('note')).toHaveTextContent(
        'Запрос увидят другие лиды и директора. Обработать его смогут Алина и Сергей.',
      );
      await user.click(screen.getByRole('button', { name: 'Закрыть форму' }));

      await user.click(requestsTab);

      expect(requestsTab).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('Shared review requests panel mounted')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Запросить ревью' })).not.toBeInTheDocument();
      expect(mockHrPanel).not.toHaveBeenCalled();
    },
  );

  it('immediately leaves shared requests when its capability is revoked', async () => {
    mockUserRole = 'lead';
    mockCanSubmitTeamReviewRequest = true;
    mockCanViewTeamReviewRequestsShared = true;
    const user = userEvent.setup();
    const view = await renderLoadedTeamPage();

    await user.click(screen.getByRole('button', { name: 'Запросы' }));
    expect(screen.getByText('Shared review requests panel mounted')).toBeInTheDocument();

    mockCanViewTeamReviewRequestsShared = false;
    view.rerender(<TeamPage />);

    expect(screen.queryByText('Shared review requests panel mounted')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Запросы' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Лиды' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Команда' })).toHaveFocus());
  });

  it('offers only real internal employees and composes clean project labels in the lead request form', async () => {
    mockUserRole = 'lead';
    mockCanSubmitTeamReviewRequest = true;
    mockProfilesData = [
      { id: 'real-specialist', email: 'real@example.com', full_name: 'Анна Ким', role: 'technician', avatar_url: null, is_demo: false },
      { id: 'demo-specialist', email: 'demo@example.com', full_name: 'Демо Специалист', role: 'technician', avatar_url: null, is_demo: true },
      { id: 'client', email: 'client@example.com', full_name: 'Клиент', role: 'client', avatar_url: null, is_demo: false },
    ];
    mockProjectsData = [
      { id: 'named', client: ' Acme ', name: ' Аутрич ', status: 'В работе', manager: null, specialist: null, kpi_plan: null, kpi_fact: null },
      { id: 'client-only', client: ' Solo ', name: '   ', status: 'Подготовка', manager: null, specialist: null, kpi_plan: null, kpi_fact: null },
      { id: 'equal', client: ' Polza ', name: 'polZa', status: 'В работе', manager: null, specialist: null, kpi_plan: null, kpi_fact: null },
      { id: 'blank', client: '   ', name: '   ', status: 'В работе', manager: null, specialist: null, kpi_plan: null, kpi_fact: null },
    ];
    const user = userEvent.setup();

    await renderLoadedTeamPage();
    await user.click(screen.getByRole('button', { name: 'Запросить ревью' }));

    const employeeSelect = screen.getByLabelText('Сотрудник, с которым нужно ревью');
    expect(employeeSelect).toHaveTextContent('Анна Ким · real@example.com');
    expect(employeeSelect).not.toHaveTextContent('Демо Специалист');
    expect(employeeSelect).not.toHaveTextContent('Клиент');
    const projectSelect = screen.getByLabelText('Проект, необязательно');
    expect(projectSelect).toHaveTextContent('Acme · Аутрич');
    expect(projectSelect).toHaveTextContent('Solo');
    expect(projectSelect).not.toHaveTextContent('Solo ·');
    expect(within(projectSelect).getByRole('option', { name: 'Polza' })).toBeInTheDocument();
    expect(projectSelect).not.toHaveTextContent('Polza · polZa');
    expect(within(projectSelect).getByRole('option', { name: 'Проект' })).toBeInTheDocument();
  });

  it('shows a private new-request badge on HR, caps its visual value and refreshes after a queue mutation', async () => {
    mockCanAccessTeamPrivate = true;
    mockNewReviewRequestCount = 128;
    const user = userEvent.setup();

    await renderLoadedTeamPage();

    const hrTab = screen.getByRole('button', {
      name: 'HR, 128 новых запросов на ревью',
    });
    expect(hrTab).toHaveTextContent('99+');
    expect(mockUseTeamReviewRequestSummary).toHaveBeenCalledWith(true);

    await user.click(hrTab);
    expect(screen.getByText('Nested requests count: 128')).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'HR, 128 новых запросов на ревью',
    })).toHaveTextContent('99+');

    await user.click(screen.getByRole('button', { name: 'Mock request mutation' }));
    expect(mockRefreshReviewRequestSummary).toHaveBeenCalledTimes(1);
  });

  it('hides a zero badge and does not mark requests processed merely by opening HR', async () => {
    mockCanAccessTeamPrivate = true;
    mockNewReviewRequestCount = 0;
    const user = userEvent.setup();

    await renderLoadedTeamPage();

    const hrTab = screen.getByRole('button', { name: 'HR' });
    expect(hrTab).not.toHaveTextContent('0');
    await user.click(hrTab);

    expect(mockRefreshReviewRequestSummary).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'HR' })).not.toHaveTextContent('0');
  });
});
