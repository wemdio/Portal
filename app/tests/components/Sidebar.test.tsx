import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/Sidebar';
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
    const { container } = render(<Sidebar />);

    expect(screen.getByText('Проекты')).toBeInTheDocument();
    expect(screen.getByText('Регламент')).toBeInTheDocument();
    expect(container.querySelector('a[href="/team"]')).not.toBeInTheDocument();
  });

  it.each<UserRole>(['lead', 'director', 'admin'])(
    'should render the team link for leadership role %s',
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
