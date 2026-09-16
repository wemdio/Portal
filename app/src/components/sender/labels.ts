import type { MailboxDto } from './api';

/**
 * Подписи ящика — в одном месте, потому что их читают на трёх экранах: в
 * таблице ящиков, в выборе ящиков для кампании и в карточке кампании. Пока
 * они жили копиями, «Готов» на одном экране легко становился «Проверен» на
 * другом.
 */
export const MAILBOX_STATUS_LABELS: Record<MailboxDto['status'], { text: string; className: string }> = {
  pending: { text: 'Проверяется', className: 'bg-amber-100 text-amber-700' },
  verified: { text: 'Готов', className: 'bg-emerald-100 text-emerald-700' },
  failed: { text: 'Ошибка', className: 'bg-red-100 text-red-700' },
  disabled: { text: 'Выключен', className: 'bg-zinc-100 text-zinc-600' },
};

/**
 * Провайдера портал определяет сам при загрузке (lib/sender/providerDetect),
 * здесь только человеческие названия. «ZapMail» больше не записывается — под
 * ним всегда Google или Outlook, — но остаётся ради ящиков, загруженных до
 * этого.
 */
const PROVIDER_LABELS: Record<string, string> = {
  maildoso: 'Maildoso',
  google: 'Google Workspace',
  outlook: 'Outlook',
  zapmail: 'ZapMail',
  custom: 'Свои настройки',
};

export const providerLabel = (id: string) => PROVIDER_LABELS[id] ?? id;
