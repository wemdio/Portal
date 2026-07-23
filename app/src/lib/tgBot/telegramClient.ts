const API_BASE = 'https://api.telegram.org';

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
    chat: { id: number };
    text?: string;
  };
};

export type SendMessageOptions = {
  chatId: number;
  text: string;
  parseMode?: 'MarkdownV2' | 'HTML';
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
): Promise<TelegramUpdate[]> {
  return callApi<TelegramUpdate[]>(token, 'getUpdates', {
    offset,
    timeout: 25,
    allowed_updates: ['message'],
  });
}

export async function sendMessage(
  token: string,
  options: SendMessageOptions,
): Promise<void> {
  await callApi(token, 'sendMessage', {
    chat_id: options.chatId,
    text: options.text,
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
  });
}
