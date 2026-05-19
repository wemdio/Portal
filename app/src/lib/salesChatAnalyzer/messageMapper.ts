import 'server-only';

import { Api } from 'telegram';

/** Сопоставление Telegram-сообщения со строкой sales_chat_messages (без id/dialog_id). */
export interface MappedMessage {
  tg_message_id: number;
  direction: 'in' | 'out';
  sender_tg_id: number | null;
  text: string | null;
  media_type: string | null;
  sent_at: string;
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

/** Классифицирует вложение сообщения. Файлы НЕ скачиваем — только тип. */
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
    sent_at: new Date(msg.date * 1000).toISOString(),
  };
}
