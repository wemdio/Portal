/**
 * Пресеты SMTP/IMAP для популярных провайдеров (BYO mailbox).
 * Используется и на сервере (валидация/верификация), и на клиенте (автозаполнение формы),
 * поэтому БЕЗ 'server-only'.
 *
 * Важно: для холодного аутрича подходят только ящики на ОТДЕЛЬНОМ домене у бизнес-провайдера
 * с прогревом. Личные @yandex.ru / @mail.ru / @gmail.com технически подключатся, но сгорят —
 * предупреждаем об этом в UI, не блокируем (решение за клиентом/менеджером).
 */

export type MailboxProvider = 'yandex' | 'mailru' | 'gmail' | 'custom';

export interface ProviderPreset {
  id: Exclude<MailboxProvider, 'custom'>;
  label: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  /** Подсказка про обязательный «пароль приложения». */
  hint: string;
}

export const PROVIDER_PRESETS: Record<Exclude<MailboxProvider, 'custom'>, ProviderPreset> = {
  yandex: {
    id: 'yandex',
    label: 'Яндекс / Яндекс 360',
    smtpHost: 'smtp.yandex.ru',
    smtpPort: 465,
    smtpSecure: true,
    imapHost: 'imap.yandex.ru',
    imapPort: 993,
    hint: 'Включите доступ по IMAP и создайте «пароль приложения» в Яндекс ID — обычный пароль от почты не подойдёт.',
  },
  mailru: {
    id: 'mailru',
    label: 'Mail.ru / VK WorkMail',
    smtpHost: 'smtp.mail.ru',
    smtpPort: 465,
    smtpSecure: true,
    imapHost: 'imap.mail.ru',
    imapPort: 993,
    hint: 'Создайте «пароль для внешнего приложения» в настройках безопасности Mail.ru.',
  },
  gmail: {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: true,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    hint: 'Нужен app-password (доступен при включённой 2FA). Личный Gmail для холодной рассылки не годится — только Workspace на отдельном домене.',
  },
};

export function presetFor(provider: MailboxProvider): ProviderPreset | null {
  if (provider === 'custom') return null;
  return PROVIDER_PRESETS[provider] ?? null;
}

/** Бесплатные домены — технически работают, но для холодного аутрича опасны. */
const FREE_DOMAINS = new Set([
  'yandex.ru', 'ya.ru', 'yandex.com',
  'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'internet.ru',
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com',
]);

export function isFreeDomain(email: string): boolean {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  return domain ? FREE_DOMAINS.has(domain) : false;
}
