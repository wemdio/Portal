import 'server-only';

import { Api } from 'telegram';

/** Сопоставление Telegram-сообщения со строкой sales_chat_messages (без id/dialog_id). */
export interface MappedMessage {
  tg_message_id: number;
  direction: 'in' | 'out';
  sender_tg_id: number | null;
  text: string | null;
  media_type: string | null;
  attachment: MappedAttachment | null;
  sent_at: string;
}

export interface MappedAttachment {
  media_type: string;
  file_name: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
}

/** Безопасно приводит big-integer (GramJS) к обычному number. */
export function bigToNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const maybe = value as { toJSNumber?: () => number };
  if (typeof maybe.toJSNumber === 'function') {
    const n = maybe.toJSNumber();
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value as never);
  return Number.isFinite(n) ? n : null;
}

/** Классифицирует вложение сообщения. */
function classifyMedia(media: Api.TypeMessageMedia | undefined): string | null {
  if (!media) return null;
  if (media instanceof Api.MessageMediaPhoto) return 'photo';
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document;
    if (doc instanceof Api.Document) {
      for (const attr of doc.attributes) {
        if (attr instanceof Api.DocumentAttributeAudio) return attr.voice ? 'voice' : 'audio';
        if (attr instanceof Api.DocumentAttributeVideo) return attr.roundMessage ? 'video_note' : 'video';
        if (attr instanceof Api.DocumentAttributeSticker) return 'sticker';
      }
    }
    return 'document';
  }
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive) return 'geo';
  if (media instanceof Api.MessageMediaContact) return 'contact';
  if (media instanceof Api.MessageMediaWebPage) return null; // просто превью ссылки
  return 'media';
}

function extensionForMime(mimeType: string | null): string {
  switch ((mimeType ?? '').toLowerCase()) {
    case 'application/pdf':
      return 'pdf';
    case 'application/msword':
      return 'doc';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'application/vnd.ms-excel':
      return 'xls';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx';
    case 'application/vnd.ms-powerpoint':
      return 'ppt';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx';
    case 'text/plain':
      return 'txt';
    default:
      return 'bin';
  }
}

function extractFilename(doc: Api.Document): string | null {
  for (const attr of doc.attributes) {
    if (attr instanceof Api.DocumentAttributeFilename) {
      const name = attr.fileName?.trim();
      if (name) return name;
    }
  }
  return null;
}

function extractAttachment(msg: Api.Message, mediaType: string | null): MappedAttachment | null {
  if (mediaType !== 'document') return null;
  if (!(msg.media instanceof Api.MessageMediaDocument)) return null;
  const doc = msg.media.document;
  if (!(doc instanceof Api.Document)) return null;

  const mimeType = doc.mimeType?.trim() || null;
  const fileSize = bigToNum(doc.size);
  const explicitName = extractFilename(doc);
  return {
    media_type: 'document',
    file_name: explicitName ?? `telegram-document-${msg.id}.${extensionForMime(mimeType)}`,
    mime_type: mimeType,
    file_size_bytes: fileSize,
  };
}

/**
 * Превращает Api.Message в MappedMessage. Возвращает null для служебных
 * сообщений и всего, что не является обычным Api.Message.
 */
export function mapMessage(msg: unknown): MappedMessage | null {
  if (!(msg instanceof Api.Message)) return null;

  const text = (msg.message ?? '').trim();
  const mediaType = classifyMedia(msg.media);
  // Пустое сообщение без вложения — пропускаем.
  if (!text && !mediaType) return null;

  return {
    tg_message_id: msg.id,
    direction: msg.out ? 'out' : 'in',
    sender_tg_id: bigToNum(msg.senderId),
    text: text || null,
    media_type: mediaType,
    attachment: extractAttachment(msg, mediaType),
    sent_at: new Date(msg.date * 1000).toISOString(),
  };
}
