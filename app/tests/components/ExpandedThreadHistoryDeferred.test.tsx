/**
 * Карточка переписки при отложенной истории (жалоба сейлза «не находит треды»).
 *
 * Сервер отдал только последнее письмо и history_deferred.retry_after_ms —
 * общий бюджет чтения был занят. Карточка должна: показать письмо сразу,
 * спокойно сказать, что остальное догружается, и сама повторить запрос; после
 * исчерпания повторов — предложить «Повторить» вручную.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

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
    image_links: [],
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

  it('показывает ссылку на скриншот и загружает превью только по нажатию', async () => {
    clientApiFetch.mockResolvedValue({
      ...FULL,
      messages: [{
        ...message('m-image', 'Посмотрите скриншот.'),
        image_links: [{ url: 'https://files.example.test/attachments/image.png', name: 'image.png' }],
      }],
    });

    await renderThread();

    expect(screen.getByText('image.png')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /изображение из письма/i })).not.toBeInTheDocument();
    const original = screen.getByRole('link', { name: /открыть отдельно/i });
    expect(original).toHaveAttribute('href', 'https://files.example.test/attachments/image.png');
    expect(original).toHaveAttribute('rel', 'noopener noreferrer');

    fireEvent.click(screen.getByRole('button', { name: 'Показать изображение' }));
    expect(screen.getByRole('img', { name: /изображение из письма/i })).toHaveAttribute(
      'src', 'https://files.example.test/attachments/image.png',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть' }));
    expect(screen.queryByRole('img', { name: /изображение из письма/i })).not.toBeInTheDocument();
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

  it('если сам повтор упал обычной ошибкой — заметка «догрузится» уходит, остаётся ошибка с «Повторить»', async () => {
    clientApiFetch
      .mockResolvedValueOnce(PARTIAL)
      .mockRejectedValueOnce(new Error('Сервис писем недоступен'));

    await renderThread();
    expect(screen.getByText(/остальная переписка догрузится/)).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(5_500);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Сервис писем недоступен')).toBeInTheDocument();
    expect(screen.queryByText(/остальная переписка догрузится/)).not.toBeInTheDocument();
    // Письмо, которое уже было на экране, не пропало.
    expect(screen.getByText('Последний ответ лида')).toBeInTheDocument();
    // И больше никаких автоматических запросов.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(clientApiFetch).toHaveBeenCalledTimes(2);
  });

  it('отложенное обновление после «Ответить» не затирает уже показанную полную переписку', async () => {
    clientApiFetch
      .mockResolvedValueOnce(FULL) // первая загрузка — полная переписка
      .mockResolvedValueOnce({ ok: true }) // POST ответа
      .mockResolvedValueOnce(PARTIAL) // обновление после отправки — бюджет занят
      .mockResolvedValueOnce(FULL); // автоповтор

    await renderThread();
    expect(screen.getByText('Наше первое письмо')).toBeInTheDocument();

    await sendReply('Спасибо, созвонимся завтра');

    // История осталась на экране, заметка честно говорит «обновляем».
    expect(clientApiFetch).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Наше первое письмо')).toBeInTheDocument();
    expect(screen.getByText(/Обновляем переписку/)).toBeInTheDocument();
    expect(screen.queryByText(/Показываем последнее письмо/)).not.toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(5_500);
    });
    await flush();

    expect(clientApiFetch).toHaveBeenCalledTimes(4);
    expect(screen.queryByText(/Обновляем переписку/)).not.toBeInTheDocument();
  });

  it('запланированный повтор отменяется, если переписка уже загрузилась другим путём', async () => {
    clientApiFetch
      .mockResolvedValueOnce(PARTIAL) // первая загрузка — одно письмо, повтор через 5,5 с
      .mockResolvedValueOnce({ ok: true }) // менеджер сразу ответил
      .mockResolvedValueOnce(FULL); // обновление после отправки — уже полная

    await renderThread();
    await sendReply('Добрый день!');

    expect(clientApiFetch).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Наше первое письмо')).toBeInTheDocument();

    // Старый таймер не должен выстрелить лишним запросом.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(clientApiFetch).toHaveBeenCalledTimes(3);
  });
  it('пересёкшиеся загрузки: запоздавший ответ старой загрузки не ставит лишний повтор', async () => {
    let resolveStale: (v: ClientReplyThread) => void = () => {};
    clientApiFetch
      .mockResolvedValueOnce(PARTIAL) // 1) первая загрузка — повтор через 5,5 с
      .mockImplementationOnce(() => new Promise<ClientReplyThread>((r) => { resolveStale = r; })) // 2) автоповтор висит
      .mockResolvedValueOnce({ ok: true }) // 3) POST ответа
      .mockResolvedValueOnce(FULL); // 4) обновление после ответа — полная

    await renderThread();
    await act(async () => {
      jest.advanceTimersByTime(5_500); // запускаем автоповтор, он повисает
    });
    await sendReply('Ответ, пока идёт автоповтор');
    expect(screen.getByText('Наше первое письмо')).toBeInTheDocument();

    // Автоповтор наконец ответил «история отложена» — это устаревший ответ.
    await act(async () => {
      resolveStale(PARTIAL);
    });
    await flush();

    expect(screen.getByText('Наше первое письмо')).toBeInTheDocument();
    expect(screen.queryByText(/Обновляем переписку|догрузится/)).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    // 3 GET + 1 POST, ни одного лишнего чтения.
    expect(clientApiFetch).toHaveBeenCalledTimes(4);
  });
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function sendReply(text: string) {
  fireEvent.click(screen.getByRole('button', { name: /Ответить/ }));
  fireEvent.change(screen.getByPlaceholderText('Текст ответа…'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /Отправить/ }));
  await flush();
}

describe('ExpandedThread — смена письма посреди загрузки', () => {
  beforeEach(() => {
    clientApiFetch.mockReset();
  });

  it('ответ по предыдущему письму не ложится поверх нового', async () => {
    let resolveOld: (v: ClientReplyThread) => void = () => {};
    clientApiFetch
      .mockImplementationOnce(() => new Promise<ClientReplyThread>((r) => { resolveOld = r; }))
      .mockResolvedValueOnce({ ...FULL, messages: [message('m-new', 'Письмо нового лида')] });

    const { ExpandedThread } = await import('@/components/client-replies/ExpandedThread');
    const { rerender } = render(<ExpandedThread campaignId="cmp-1" emailId="email-old" />);
    rerender(<ExpandedThread campaignId="cmp-1" emailId="email-new" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Письмо нового лида')).toBeInTheDocument();

    await act(async () => {
      resolveOld({ ...FULL, messages: [message('m-old', 'Письмо старого лида')] });
    });
    expect(screen.getByText('Письмо нового лида')).toBeInTheDocument();
    expect(screen.queryByText('Письмо старого лида')).not.toBeInTheDocument();
  });
});
