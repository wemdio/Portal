/**
 * Архив аккаунтов TG-аутрича: причины и разбор запроса.
 *
 * Причину выбирают из списка, а не пишут словами: через месяц по архиву нужно
 * ответить «сколько номеров партии умерло от чего», и свободный текст на это
 * не отвечает. Для всего, что в список не влезло, — «Другое» с обязательным
 * комментарием.
 */

export const ARCHIVE_REASONS = [
  { id: 'session_dead', label: 'Сессия мертва' },
  { id: 'long_cooldown', label: 'Долгий кулдаун' },
  { id: 'resolve_fails', label: 'Не резолвит юзернеймы' },
  { id: 'spamblock', label: 'Спамблок' },
  { id: 'frozen', label: 'Заморожен' },
  { id: 'banned', label: 'Забанен' },
  { id: 'other', label: 'Другое' },
] as const;

export type ArchiveReason = (typeof ARCHIVE_REASONS)[number]['id'];

export function archiveReasonLabel(reason: string | null | undefined): string {
  return ARCHIVE_REASONS.find((r) => r.id === reason)?.label ?? 'Причина не указана';
}

const NOTE_MAX = 500;

export type ArchiveRequest =
  | { ok: true; campaignId: string; ids: string[]; reason: ArchiveReason; note: string | null }
  | { ok: false; error: string };

/** Разбор тела «убрать в архив»: кампания, аккаунты, причина и комментарий. */
export function parseArchiveBody(body: unknown): ArchiveRequest {
  const b = (body ?? {}) as { campaign_id?: unknown; ids?: unknown; reason?: unknown; note?: unknown };
  const campaignId = typeof b.campaign_id === 'string' ? b.campaign_id : '';
  if (!campaignId) return { ok: false, error: 'campaign_id обязателен' };
  const ids = Array.isArray(b.ids) ? b.ids.filter((v): v is string => typeof v === 'string') : [];
  if (!ids.length) return { ok: false, error: 'Выберите аккаунты' };
  const reason = ARCHIVE_REASONS.find((r) => r.id === b.reason)?.id;
  if (!reason) return { ok: false, error: 'Укажите причину архива' };
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, NOTE_MAX) : '';
  if (reason === 'other' && !note) return { ok: false, error: 'Для «Другое» напишите, что случилось' };
  return { ok: true, campaignId, ids, reason, note: note || null };
}
