import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientNavList } from '@/components/client/ClientNavList';

jest.mock('next/link', () => {
  const MockLink = ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  );
  MockLink.displayName = 'MockLink';
  return { __esModule: true, default: MockLink };
});

// ClientNavList polls two endpoints on mount: /mailboxes/enabled (BYO pilot
// flag) and /support/unread (the badge count). We stub both.
const clientApiFetchMock = jest.fn();
jest.mock('@/lib/clientFetcher', () => ({
  clientApiFetch: (path: string) => clientApiFetchMock(path),
}));

function stubEndpoints(unread: number) {
  clientApiFetchMock.mockImplementation((path: string) => {
    if (path === '/mailboxes/enabled') return Promise.resolve({ enabled: false });
    if (path === '/support/unread') return Promise.resolve({ unread });
    return Promise.resolve({});
  });
}

describe('ClientNavList — support unread badge', () => {
  beforeEach(() => {
    clientApiFetchMock.mockReset();
  });

  it('shows the unread count next to «Поддержка» when there are unread messages', async () => {
    stubEndpoints(3);
    render(<ClientNavList activeId="dashboard" locale="ru" mode="manual" />);

    const badge = await screen.findByLabelText('3 новых сообщений');
    expect(badge).toHaveTextContent('3');
  });

  it('collapses counts above nine to «9+» so the row never widens', async () => {
    stubEndpoints(25);
    render(<ClientNavList activeId="dashboard" locale="ru" mode="manual" />);

    const badge = await screen.findByLabelText('25 новых сообщений');
    expect(badge).toHaveTextContent('9+');
  });

  it('renders no badge when the unread count is zero', async () => {
    stubEndpoints(0);
    render(<ClientNavList activeId="dashboard" locale="ru" mode="manual" />);

    await waitFor(() =>
      expect(clientApiFetchMock).toHaveBeenCalledWith('/support/unread'),
    );
    expect(screen.queryByLabelText(/новых сообщений/)).not.toBeInTheDocument();
  });

  it('suppresses the badge while the client is on the support page', async () => {
    // Endpoint still reports unread, but an open thread is read by definition —
    // the active support page must hide the badge regardless of the count.
    stubEndpoints(3);
    render(<ClientNavList activeId="support" locale="ru" mode="manual" />);

    await waitFor(() =>
      expect(clientApiFetchMock).toHaveBeenCalledWith('/support/unread'),
    );
    expect(screen.queryByLabelText(/новых сообщений/)).not.toBeInTheDocument();
  });
});
