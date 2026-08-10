import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamPage from '@/app/team/page';
import type { UserRole } from '@/types';

let mockUserRole: UserRole | null | 'unknown' = 'technician';
let mockIsHr = false;

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
    userEmail: 'team-member@example.com',
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
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it.each<UserRole>(['technician', 'manager', 'sales', 'marketer'])(
    'shows only the load workspace to an internal %s',
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

  it.each<UserRole>(['lead', 'director'])(
    'lets leadership role %s open statistics and reviews',
    async (role) => {
      mockUserRole = role;
      const user = userEvent.setup();

      await renderLoadedTeamPage();

      expect(screen.getByRole('group', { name: 'Разделы команды' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Загрузка' })).toBeInTheDocument();
      const statisticsTab = screen.getByRole('button', { name: 'Статистика' });
      const reviewsTab = screen.getByRole('button', { name: 'Ревью' });
      expect(screen.queryByRole('button', { name: 'Активности' })).not.toBeInTheDocument();

      await user.click(statisticsTab);
      expect(screen.getByText('Statistics panel mounted')).toBeInTheDocument();
      expect(mockStatisticsPanel).toHaveBeenCalled();
      expect(mockReviewsPanel).not.toHaveBeenCalled();

      await user.click(reviewsTab);
      expect(screen.getByText('Reviews panel mounted')).toBeInTheDocument();
      expect(mockReviewsPanel).toHaveBeenCalled();
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

  it('immediately hides a private workspace after a role downgrade', async () => {
    mockUserRole = 'lead';
    const user = userEvent.setup();
    const view = await renderLoadedTeamPage();

    await user.click(screen.getByRole('button', { name: 'Статистика' }));
    expect(screen.getByText('Statistics panel mounted')).toBeInTheDocument();

    mockUserRole = 'technician';
    view.rerender(<TeamPage />);

    expect(screen.queryByRole('button', { name: 'Статистика' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ревью' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Активности' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Разделы команды' })).not.toBeInTheDocument();
    expect(screen.queryByText('Statistics panel mounted')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Лиды' })).toBeInTheDocument();
  });

  it('lets an admin open the activity plan without an explicit HR capability', async () => {
    mockUserRole = 'admin';
    const user = userEvent.setup();

    await renderLoadedTeamPage();

    expect(screen.getByRole('button', { name: 'Статистика' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ревью' })).toBeVisible();
    const activitiesTab = screen.getByRole('button', { name: 'Активности' });
    expect(activitiesTab).toBeVisible();
    await user.click(activitiesTab);

    expect(screen.getByText('Activity plan panel mounted')).toBeInTheDocument();
    expect(mockActivityPlanPanel).toHaveBeenCalledTimes(1);
  });

  it('keeps activity access for an explicitly HR-capable non-admin', async () => {
    mockUserRole = 'technician';
    mockIsHr = true;
    const user = userEvent.setup();

    await renderLoadedTeamPage();

    const activitiesTab = screen.getByRole('button', { name: 'Активности' });
    expect(activitiesTab).toBeVisible();
    await user.click(activitiesTab);

    expect(screen.getByText('Activity plan panel mounted')).toBeInTheDocument();
  });

  it('unmounts the activity plan immediately when a non-admin HR capability is revoked', async () => {
    mockUserRole = 'technician';
    mockIsHr = true;
    const user = userEvent.setup();
    const view = await renderLoadedTeamPage();

    await user.click(screen.getByRole('button', { name: 'Активности' }));
    expect(screen.getByText('Activity plan panel mounted')).toBeInTheDocument();

    mockIsHr = false;
    view.rerender(<TeamPage />);

    expect(screen.queryByRole('button', { name: 'Активности' })).not.toBeInTheDocument();
    expect(screen.queryByText('Activity plan panel mounted')).not.toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: 'Команда' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByRole('group', { name: 'Разделы команды' })).not.toBeInTheDocument();
  });
});
