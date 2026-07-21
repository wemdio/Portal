import { render, screen } from '@testing-library/react';
import { ClientMobileDrawer } from '@/components/client/ClientMobileDrawer';

jest.mock('@/components/client/ClientNavList', () => ({
  ClientNavList: () => <nav data-testid="client-nav-list" />,
}));

describe('ClientMobileDrawer', () => {
  it('mounts its navigation only while the drawer is open', () => {
    const { rerender } = render(
      <ClientMobileDrawer
        open={false}
        onClose={jest.fn()}
        activeId="dashboard"
        locale="ru"
        mode="manual"
      />,
    );

    expect(screen.queryByTestId('client-nav-list')).not.toBeInTheDocument();

    rerender(
      <ClientMobileDrawer
        open
        onClose={jest.fn()}
        activeId="dashboard"
        locale="ru"
        mode="manual"
      />,
    );

    expect(screen.getByTestId('client-nav-list')).toBeInTheDocument();
  });
});
