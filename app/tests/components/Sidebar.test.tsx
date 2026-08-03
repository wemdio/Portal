import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/Sidebar';
import { INTERNAL_ROLES } from '@/lib/roles';
import type { UserRole } from '@/types';

let mockUserRole: UserRole = 'technician';

jest.mock('next/link', () => {
  const MockLink = ({ children, href }: { children: ReactNode; href: string }) => {
    return <a href={href}>{children}</a>;
  };
  MockLink.displayName = 'MockLink';

  return {
    __esModule: true,
    default: MockLink,
  };
});

jest.mock('@/lib/UserProvider', () => ({
  useUser: () => ({
    userRole: mockUserRole,
    userEmail: 'test@example.com',
    userFullName: 'Test User',
    userAvatarUrl: null,
    navTabVisibility: {},
    visibleTools: null,
    badges: {},
    handleAvatarError: jest.fn(),
    handleSignOut: jest.fn(),
  }),
}));

describe('Sidebar Component', () => {
  beforeEach(() => {
    mockUserRole = 'technician';
  });

  it('should render navigation items available to a technician', () => {
    render(<Sidebar />);

    expect(screen.getByText('Проекты')).toBeInTheDocument();
    expect(screen.getByText('Регламент')).toBeInTheDocument();
  });

  it.each<UserRole>(INTERNAL_ROLES)(
    'should render the team link for internal role %s',
    (role) => {
      mockUserRole = role;
      const { container } = render(<Sidebar />);

      expect(container.querySelector('a[href="/team"]')).toBeInTheDocument();
    },
  );

  it('should not render admin link for non-admin users', () => {
    render(<Sidebar />);

    expect(screen.queryByText('Админ')).not.toBeInTheDocument();
  });
});
