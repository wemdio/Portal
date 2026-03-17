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
