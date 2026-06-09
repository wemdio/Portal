import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { ClientNavList } from '@/components/client/ClientNavList';
import { ClientPortalProvider } from '@/lib/clientPortalContext';

jest.mock('next/link', () => {
  const MockLink = ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  );
  MockLink.displayName = 'MockLink';
  return { __esModule: true, default: MockLink };
});

// The support-unread count and the BYO-mailboxes flag are now polled/fetched
// ONCE in the client layout and handed to the nav via ClientPortalProvider
// (instead of the nav self-fetching them twice — once per sidebar/drawer mount).
// So the badge behavior is driven purely by the context value.
function renderNav(
  activeId: string,
  ctx: { supportUnread?: number; mailboxesEnabled?: boolean } = {},
) {
  return render(
    <ClientPortalProvider
      value={{
        portalMode: 'manual',
        supportUnread: ctx.supportUnread ?? 0,
        mailboxesEnabled: ctx.mailboxesEnabled ?? false,
      }}
    >
      <ClientNavList activeId={activeId} locale="ru" mode="manual" />
    </ClientPortalProvider>,
  );
}

describe('ClientNavList — support unread badge', () => {
  it('shows the unread count next to «Поддержка» when there are unread messages', () => {
    renderNav('dashboard', { supportUnread: 3 });
    expect(screen.getByLabelText('3 новых сообщений')).toHaveTextContent('3');
  });

  it('collapses counts above nine to «9+» so the row never widens', () => {
    renderNav('dashboard', { supportUnread: 25 });
    expect(screen.getByLabelText('25 новых сообщений')).toHaveTextContent('9+');
  });

  it('renders no badge when the unread count is zero', () => {
    renderNav('dashboard', { supportUnread: 0 });
    expect(screen.queryByLabelText(/новых сообщений/)).not.toBeInTheDocument();
  });

  it('suppresses the badge while the client is on the support page', () => {
    // Context still reports unread, but an open thread is read by definition —
    // the active support page must hide the badge regardless of the count.
    renderNav('support', { supportUnread: 3 });
    expect(screen.queryByLabelText(/новых сообщений/)).not.toBeInTheDocument();
  });
});
