import { render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/Sidebar';

// Mock Next.js Link component
jest.mock('next/link', () => {
  return ({ children, href }: { children: React.ReactNode; href: string }) => {
    return <a href={href}>{children}</a>;
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
    // Mock supabase to return non-admin user
    const { supabase } = require('@/lib/supabaseClient');
    supabase.from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { role: 'technician' } }),
    });

    render(<Sidebar />);
    
    // Admin link should not be visible for non-admin
    expect(screen.queryByText('Админ')).not.toBeInTheDocument();
  });
});
