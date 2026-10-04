import type { CampaignDto, MailboxDto } from './api';

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
 * Статус кампании — его показывают и список кампаний, и колонка кампаний на
 * вкладке «Письма»: одна подпись на оба места.
 */
export const CAMPAIGN_STATUS_LABELS: Record<CampaignDto['status'], { text: string; className: string }> = {
  draft: { text: 'Черновик', className: 'bg-zinc-100 text-zinc-600' },
  running: { text: 'Идёт', className: 'bg-emerald-100 text-emerald-700' },
  paused: { text: 'Пауза', className: 'bg-amber-100 text-amber-700' },
  done: { text: 'Завершена', className: 'bg-zinc-100 text-zinc-600' },
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

/** Что про ящик думает сам Google — это не то же, что «прошёл ли он проверку». */
/**
 * Проблемные состояния ящика в каталоге Google — показываются в «Статусе»
 * вместо статуса входа. «Активен» отдельно не показываем: он у всех.
 */
export const GOOGLE_STATE_LABELS: Record<string, { text: string; className: string }> = {
  suspended: { text: 'Заблокирован в Google', className: 'bg-red-100 text-red-700' },
  missing: { text: 'Пропал из Google', className: 'bg-amber-100 text-amber-700' },
};
