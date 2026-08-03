import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamPage from '@/app/team/page';
import type { UserRole } from '@/types';

let mockUserRole: UserRole | null | 'unknown' = 'technician';

const mockSupabaseFrom = jest.fn((table: string) => ({
  select: jest.fn().mockResolvedValue({
    data: table === 'projects' ? [] : [],
    error: null,
  }),
}));
const mockStatisticsPanel = jest.fn(() => <div>Statistics panel mounted</div>);
const mockReviewsPanel = jest.fn(() => <div>Reviews panel mounted</div>);

jest.mock('@/lib/UserProvider', () => ({
  useUser: () => ({
    userRole: mockUserRole,
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

async function renderLoadedTeamPage() {
  const view = render(<TeamPage />);
  expect(await screen.findByRole('heading', { name: 'Лиды' })).toBeInTheDocument();
  return view;
}

describe('<TeamPage /> access', () => {
  beforeEach(() => {
    mockUserRole = 'technician';
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
      expect(mockStatisticsPanel).not.toHaveBeenCalled();
      expect(mockReviewsPanel).not.toHaveBeenCalled();
    },
  );

  it.each<UserRole>(['lead', 'director', 'admin'])(
    'lets leadership role %s open statistics and reviews',
    async (role) => {
      mockUserRole = role;
      const user = userEvent.setup();

      await renderLoadedTeamPage();

      expect(screen.getByRole('group', { name: 'Разделы команды' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Загрузка' })).toBeInTheDocument();
      const statisticsTab = screen.getByRole('button', { name: 'Статистика' });
      const reviewsTab = screen.getByRole('button', { name: 'Ревью' });

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
      expect(mockStatisticsPanel).not.toHaveBeenCalled();
      expect(mockReviewsPanel).not.toHaveBeenCalled();
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
    expect(screen.queryByRole('group', { name: 'Разделы команды' })).not.toBeInTheDocument();
    expect(screen.queryByText('Statistics panel mounted')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Лиды' })).toBeInTheDocument();
  });
});
