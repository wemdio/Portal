import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/Sidebar';

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

jest.mock('@/lib/supabaseClient', () => {
  const mockSelect = jest.fn().mockReturnThis();
  const mockEq = jest.fn().mockReturnThis();
  const mockSingle = jest.fn().mockResolvedValue({ data: { role: 'technician' } });
  const subscription = { unsubscribe: jest.fn() };

  return {
    supabase: {
      auth: {
        getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
        onAuthStateChange: jest.fn().mockReturnValue({ data: { subscription } }),
      },
      from: jest.fn(() => ({
        select: mockSelect,
        eq: mockEq,
        single: mockSingle,
      })),
    },
  };
});

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
