const TG_MAX_MESSAGE_LENGTH = 4096;

function getToken(): string {
  return process.env.TG_AGENT_BOT_TOKEN ?? '';
}

async function tgApi(method: string, body: Record<string, unknown>): Promise<void> {
  const token = getToken();
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function sendChatAction(chatId: number, action: string = 'typing'): Promise<void> {
  await tgApi('sendChatAction', { chat_id: chatId, action });
}

function splitMessage(text: string): string[] {
  if (text.length <= TG_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TG_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', TG_MAX_MESSAGE_LENGTH);
    if (splitAt < TG_MAX_MESSAGE_LENGTH * 0.3) {
      splitAt = remaining.lastIndexOf(' ', TG_MAX_MESSAGE_LENGTH);
    }
    if (splitAt < TG_MAX_MESSAGE_LENGTH * 0.3) {
      splitAt = TG_MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }
}

export { splitMessage as _splitMessage };
