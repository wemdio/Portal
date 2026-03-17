const TG_MAX_MESSAGE_LENGTH = 4096;
const MAX_VOICE_SIZE = 20 * 1024 * 1024; // 20 MB

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

async function tgApiJson<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const json = await res.json() as { ok: boolean; result?: T };
  return json.ok ? (json.result ?? null) : null;
}

export async function downloadVoiceFile(fileId: string): Promise<Buffer | null> {
  const token = getToken();
  if (!token) return null;

  const file = await tgApiJson<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
  if (!file?.file_path) return null;
  if (file.file_size && file.file_size > MAX_VOICE_SIZE) return null;

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  return Buffer.from(await res.arrayBuffer());
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

export type InlineButton = { text: string; callback_data: string };

export async function sendMessage(chatId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (isLast && buttons) {
      body.reply_markup = { inline_keyboard: buttons };
    }
    await tgApi('sendMessage', body);
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await tgApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text ?? '',
  });
}

export async function editMessageReplyMarkup(chatId: number, messageId: number): Promise<void> {
  await tgApi('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

export async function sendDocument(chatId: number, filename: string, buffer: Buffer, caption?: string): Promise<void> {
  const token = getToken();
  if (!token) return;

  const blob = new Blob([buffer], { type: 'text/csv' });
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', blob, filename);
  if (caption) form.append('caption', caption);

  await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
}

export { splitMessage as _splitMessage };
