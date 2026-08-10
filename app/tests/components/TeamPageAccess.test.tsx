import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamPage from '@/app/team/page';
import type { UserRole } from '@/types';

let mockUserRole: UserRole | null | 'unknown' = 'technician';
let mockIsHr = false;
let mockCanAccessTeamPrivate = false;
let mockUserEmail = 'team-member@example.com';

const mockSupabaseFrom = jest.fn((table: string) => ({
  select: jest.fn().mockResolvedValue({
    data: table === 'projects' ? [] : [],
    error: null,
  }),
}));
const mockStatisticsPanel = jest.fn(() => <div>Statistics panel mounted</div>);
const mockReviewsPanel = jest.fn(() => <div>Reviews panel mounted</div>);
const mockActivityPlanPanel = jest.fn(() => <div>Activity plan panel mounted</div>);

jest.mock('@/lib/UserProvider', () => ({
  useUser: () => ({
    userRole: mockUserRole,
    isHr: mockIsHr,
    canAccessTeamPrivate: mockCanAccessTeamPrivate,
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
    mockUserEmail = 'team-member@example.com';
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
      expect(mockStatisticsPanel).not.toHaveBeenCalled();
      expect(mockReviewsPanel).not.toHaveBeenCalled();
      expect(mockActivityPlanPanel).not.toHaveBeenCalled();
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
      expect(mockStatisticsPanel).not.toHaveBeenCalled();
      expect(mockReviewsPanel).not.toHaveBeenCalled();
      expect(mockActivityPlanPanel).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Алина', 'technician' as UserRole, 'alina@example.com'],
    ['Сергей', 'admin' as UserRole, 'vaver1954@mail.ru'],
  ])('lets %s use all private workspaces when the authoritative capability is true', async (_name, role, email) => {
    mockUserRole = role;
    mockUserEmail = email;
    mockCanAccessTeamPrivate = true;
    const user = userEvent.setup();

    await renderLoadedTeamPage();

    expect(screen.getByRole('button', { name: 'Загрузка' })).toHaveAttribute('aria-pressed', 'true');
    const statisticsTab = screen.getByRole('button', { name: 'Статистика' });
    const reviewsTab = screen.getByRole('button', { name: 'Ревью' });
    const activitiesTab = screen.getByRole('button', { name: 'Активности' });

    await user.click(statisticsTab);
    expect(screen.getByText('Statistics panel mounted')).toBeInTheDocument();

    await user.click(reviewsTab);
    expect(screen.getByText('Reviews panel mounted')).toBeInTheDocument();

    await user.click(activitiesTab);
    expect(screen.getByText('Activity plan panel mounted')).toBeInTheDocument();
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
  });

  it.each([
    ['Статистика', 'Statistics panel mounted'],
    ['Ревью', 'Reviews panel mounted'],
    ['Активности', 'Activity plan panel mounted'],
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
});
