import type { FC, ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/Sidebar';

jest.mock('next/link', () => {
  const MockLink: FC<{ children: ReactNode; href: string }> = ({ children, href }) => {
    return <a href={href}>{children}</a>;
  };
  MockLink.displayName = 'MockLink';

  return {
    __esModule: true,
    default: MockLink,
  };
});

jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { role: 'technician' } }),
    }),
  },
}));

describe('Sidebar Component', () => {
  it('should render navigation items', () => {
    render(<Sidebar />);

    expect(screen.getByText('Проекты')).toBeInTheDocument();
    expect(screen.getByText('Команда')).toBeInTheDocument();
    expect(screen.getByText('Регламент')).toBeInTheDocument();
  });

  it('should not render admin link for non-admin users', () => {
    render(<Sidebar />);

    expect(screen.queryByText('Админ')).not.toBeInTheDocument();
  });
});
