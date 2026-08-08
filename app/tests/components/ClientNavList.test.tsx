import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { ClientNavList } from '@/components/client/ClientNavList';
import { ClientPortalProvider } from '@/lib/clientPortalContext';

jest.mock('next/link', () => {
  const MockLink = ({
    children,
    href,
    prefetch,
  }: {
    children: ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a href={href} data-prefetch={String(prefetch)}>{children}</a>
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
  ctx: { supportUnread?: number; mailboxesEnabled?: boolean; market?: 'ru' | 'eng' } = {},
) {
  return render(
    <ClientPortalProvider
      value={{
        portalMode: 'manual',
        supportUnread: ctx.supportUnread ?? 0,
        mailboxesEnabled: ctx.mailboxesEnabled ?? false,
        gisSignalsEnabled: false,
        ...(ctx.market ? { market: ctx.market } : {}),
      }}
    >
      <ClientNavList activeId={activeId} locale="ru" mode="manual" />
    </ClientPortalProvider>,
  );
}

describe('ClientNavList — support unread badge', () => {
  it('disables automatic RSC prefetch for every sidebar link', () => {
    renderNav('dashboard');
    expect(screen.getAllByRole('link')).not.toHaveLength(0);
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('data-prefetch', 'false');
    }
  });

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

describe('ClientNavList — видимость ENG-пункта по market', () => {
  it('ru-market: ENG-пункт скрыт, RU-группы на месте', () => {
    renderNav('dashboard', { market: 'ru' });
    expect(screen.queryByRole('link', { name: 'Outreach' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Бриф' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Кампании' })).toBeInTheDocument();
  });

  it('market не задан (старый провайдер/демо) — ENG скрыт, рендер как у ru', () => {
    renderNav('dashboard');
    expect(screen.queryByRole('link', { name: 'Outreach' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Бриф' })).toBeInTheDocument();
  });

  it('eng-market: виден ТОЛЬКО ENG-пункт (middleware всё равно уводит с RU-путей)', () => {
    renderNav('eng', { market: 'eng' });
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/client/eng');
    expect(links[0]).toHaveTextContent('Outreach');
  });
});
