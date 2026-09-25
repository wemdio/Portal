const API_BASE = 'https://api.telegram.org';

export type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
  chat: { id: number };
  text?: string;
  caption?: string;
  date?: number;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export type SendMessageOptions = {
  chatId: number;
  text: string;
  parseMode?: 'MarkdownV2' | 'HTML';
  messageThreadId?: number;
  replyToMessageId?: number;
  disableWebPagePreview?: boolean;
};

export function escapeMarkdownV2(input: string): string {
  return input.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function callApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  if (!token) throw new Error('Telegram bot token is empty');

  const response = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // getUpdates ждёт до 25 с — таймаут с запасом, чтобы зависший запрос не
    // останавливал воркер навсегда.
    signal: AbortSignal.timeout(40_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    description?: string;
  } | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(
      `Telegram API ${method} failed: ` +
        (payload?.description ?? `HTTP ${response.status}`),
    );
  }
  return payload.result as T;
}

export async function getUpdates(
  token: string,
  offset: number,
  allowedUpdates: string[] = ['message'],
): Promise<TelegramUpdate[]> {
  return callApi<TelegramUpdate[]>(token, 'getUpdates', {
    offset,
    timeout: 25,
    allowed_updates: allowedUpdates,
  });
}

export async function sendMessage(
  token: string,
  options: SendMessageOptions,
): Promise<{ message_id: number }> {
  return callApi<{ message_id: number }>(token, 'sendMessage', {
    chat_id: options.chatId,
    text: options.text,
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
    ...(options.messageThreadId != null ? { message_thread_id: options.messageThreadId } : {}),
    ...(options.disableWebPagePreview ? { disable_web_page_preview: true } : {}),
    ...(options.replyToMessageId != null
      ? {
          reply_parameters: {
            message_id: options.replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
  });
}

export async function getWebhookInfo(token: string): Promise<{ url: string }> {
  return callApi<{ url: string }>(token, 'getWebhookInfo', {});
}

export async function getMe(
  token: string,
): Promise<{ id: number; username?: string; can_read_all_group_messages?: boolean }> {
  return callApi(token, 'getMe', {});
}

export async function getChatMember(
  token: string,
  chatId: number,
  userId: number,
): Promise<{ status: string }> {
  return callApi<{ status: string }>(token, 'getChatMember', { chat_id: chatId, user_id: userId });
}
