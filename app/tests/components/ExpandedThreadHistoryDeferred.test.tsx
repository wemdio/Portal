/**
 * Карточка переписки при отложенной истории (жалоба сейлза «не находит треды»).
 *
 * Сервер отдал только последнее письмо и history_deferred.retry_after_ms —
 * общий бюджет чтения был занят. Карточка должна: показать письмо сразу,
 * спокойно сказать, что остальное догружается, и сама повторить запрос; после
 * исчерпания повторов — предложить «Повторить» вручную.
 */

import { act, render, screen } from '@testing-library/react';

import type { ClientReplyThread, ThreadMessage } from '@/lib/clientCampaignReplies/types';

const clientApiFetch = jest.fn();

jest.mock('@/lib/clientFetcher', () => ({
  clientApiFetch: (...args: unknown[]) => clientApiFetch(...args),
}));

jest.mock('@/lib/authFetch', () => ({
  isAuthExpiredError: () => false,
}));

function message(id: string, body: string): ThreadMessage {
  return {
    id,
    direction: 'inbound',
    timestamp: '2026-09-22T10:00:00.000Z',
    subject: 'Re: предложение',
    from_email: 'lead@example.com',
    from_name: 'Лид',
    body_text: body,
    to_recipients: [],
    cc_recipients: [],
  };
}

const PARTIAL: ClientReplyThread = {
  thread_id: 't-1',
  messages: [message('m-last', 'Последний ответ лида')],
  reply_to: { email: 'lead@example.com', name: 'Лид' },
  reply_all_cc: [],
  history_deferred: { retry_after_ms: 5_000 },
};

const FULL: ClientReplyThread = {
  thread_id: 't-1',
  messages: [message('m-last', 'Последний ответ лида'), message('m-first', 'Наше первое письмо')],
  reply_to: { email: 'lead@example.com', name: 'Лид' },
  reply_all_cc: [],
};

async function renderThread() {
  const { ExpandedThread } = await import('@/components/client-replies/ExpandedThread');
  render(<ExpandedThread campaignId="cmp-1" emailId="email-1" />);
  // Дожидаемся первого ответа /thread.
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ExpandedThread — отложенная история', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clientApiFetch.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('показывает письмо сразу и сам догружает переписку', async () => {
    clientApiFetch.mockResolvedValueOnce(PARTIAL).mockResolvedValueOnce(FULL);

    await renderThread();

    expect(screen.getByText('Последний ответ лида')).toBeInTheDocument();
    expect(screen.getByText(/остальная переписка догрузится/)).toBeInTheDocument();
    expect(screen.queryByText('Наше первое письмо')).not.toBeInTheDocument();
    expect(clientApiFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(5_500);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(clientApiFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Наше первое письмо')).toBeInTheDocument();
    expect(screen.queryByText(/остальная переписка догрузится/)).not.toBeInTheDocument();
  });

  it('после исчерпания повторов предлагает повторить вручную', async () => {
    clientApiFetch.mockResolvedValue(PARTIAL);

    await renderThread();
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        jest.advanceTimersByTime(5_500);
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    // 1 первичный запрос + 3 автоповтора, дальше — тишина.
    expect(clientApiFetch).toHaveBeenCalledTimes(4);
    expect(screen.getByText(/повторите через минуту/)).toBeInTheDocument();
    expect(screen.getByText('Последний ответ лида')).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(clientApiFetch).toHaveBeenCalledTimes(4);
  });
});
