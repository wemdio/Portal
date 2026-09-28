/**
 * Файлы к первому сообщению (28.09.2026).
 *
 * К базе загружаются картинки и документы. Контакт получает файл, имя которого
 * стоит у него в колонке «картинка»/«файл» таблицы; колонка пустая — файл
 * «для всех» базы, если он отмечен; иначе сообщение уходит текстом, как раньше.
 * Файл и текст — одно сообщение: текст идёт подписью под файлом.
 */

export const ATTACHMENTS_BUCKET = 'tg-outreach-attachments';

/** Предел Telegram на фото — 10 МБ; документ ограничиваем сами, чтобы отправка не тянулась минутами через прокси. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_BASE = 20;

export type AttachmentKind = 'photo' | 'document';

const TYPES: Record<string, { kind: AttachmentKind; mime: string }> = {
  jpg: { kind: 'photo', mime: 'image/jpeg' },
  jpeg: { kind: 'photo', mime: 'image/jpeg' },
  // webp не берём: gramJS считает картинками только jpg и png, webp ушёл бы документом.
  png: { kind: 'photo', mime: 'image/png' },
  pdf: { kind: 'document', mime: 'application/pdf' },
  doc: { kind: 'document', mime: 'application/msword' },
  docx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xls: { kind: 'document', mime: 'application/vnd.ms-excel' },
  xlsx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ppt: { kind: 'document', mime: 'application/vnd.ms-powerpoint' },
  pptx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};

export const ACCEPTED_EXTENSIONS = Object.keys(TYPES).map((e) => `.${e}`);

/** Тип файла по расширению; неподдерживаемый — null. */
export function attachmentTypeFor(fileName: string): { kind: AttachmentKind; mime: string } | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return TYPES[ext] ?? null;
}

export function maxBytesFor(kind: AttachmentKind): number {
  return kind === 'photo' ? MAX_PHOTO_BYTES : MAX_DOCUMENT_BYTES;
}

/** Имя файла, как его пишут в таблице: без пути и лишних пробелов. Сверяем без учёта регистра. */
export function normalizeAttachmentName(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop()!.replace(/\s+/g, ' ').trim();
}

export function attachmentKey(name: string): string {
  return normalizeAttachmentName(name).toLowerCase();
}

/**
 * Заголовок колонки с файлом в таблице базы. Колонку ищем по заголовку, а не
 * по номеру: в старых базах третья колонка — данные скрапера.
 */
export function isAttachmentHeader(header: string): boolean {
  return /^(картинк|изображени|фото|файл|вложени|image|picture|photo|file|attachment)/i.test(header.trim());
}

export interface BaseAttachment {
  id: string;
  base_id: string;
  file_name: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  kind: AttachmentKind;
  is_default: boolean;
}

export type ContactAttachment =
  | { kind: 'none' }
  | { kind: 'file'; attachment: BaseAttachment }
  /** В таблице указан файл, которого среди загруженных к базе нет. */
  | { kind: 'missing'; name: string };

/** Какой файл получит контакт: свой из колонки, иначе «для всех» базы, иначе без файла. */
export function resolveContactAttachment(attachmentName: string | null | undefined, baseAttachments: BaseAttachment[]): ContactAttachment {
  const name = attachmentName ? normalizeAttachmentName(attachmentName) : '';
  if (name) {
    const hit = baseAttachments.find((a) => attachmentKey(a.file_name) === name.toLowerCase());
    return hit ? { kind: 'file', attachment: hit } : { kind: 'missing', name };
  }
  const fallback = baseAttachments.find((a) => a.is_default);
  return fallback ? { kind: 'file', attachment: fallback } : { kind: 'none' };
}
