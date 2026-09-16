import type { FileRow } from './fileParse';

/**
 * Распознавание выгрузки провайдера: строка файла → нормализованный ящик.
 *
 * Названия колонок у провайдеров разные и меняются («Email», «Mailbox»,
 * «SMTP Username», «App Password»…), поэтому колонки сопоставляются по списку
 * синонимов, а не по фиксированному порядку. Чего нет в файле — берём из
 * пресета провайдера. Исключение: IMAP-хост у Maildoso индивидуален для
 * каждого ящика, общего значения по умолчанию для него нет.
 */

export type SenderProvider = 'maildoso' | 'zapmail' | 'google' | 'custom';
export type TlsMode = 'implicit_tls' | 'starttls';

export interface ParsedMailbox {
  email: string;
  username: string;
  displayName: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpTlsMode: TlsMode;
  imapHost: string | null;
  imapPort: number;
  smtpPassword: string;
  imapPassword: string | null;
}

export interface ImportRowError {
  line: number;
  email: string | null;
  message: string;
}

export interface ParsedImport {
  mailboxes: ParsedMailbox[];
  errors: ImportRowError[];
}

interface ProviderPreset {
  smtpHost?: string;
  smtpPort: number;
  smtpTlsMode: TlsMode;
  imapHost?: string;
  imapPort: number;
}

/** Порты и режим TLS по умолчанию. Хост Maildoso известен, IMAP-хост — нет. */
const PRESETS: Record<SenderProvider, ProviderPreset> = {
  maildoso: { smtpHost: 'smtp.maildoso.com', smtpPort: 587, smtpTlsMode: 'starttls', imapPort: 993 },
  zapmail: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpTlsMode: 'implicit_tls', imapHost: 'imap.gmail.com', imapPort: 993 },
  google: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpTlsMode: 'implicit_tls', imapHost: 'imap.gmail.com', imapPort: 993 },
  custom: { smtpPort: 587, smtpTlsMode: 'starttls', imapPort: 993 },
};

const ALIASES = {
  email: ['email', 'emailaddress', 'mailbox', 'mailboxemail', 'account', 'login', 'user', 'address'],
  username: ['username', 'smtpusername', 'imapusername', 'loginname', 'smtplogin'],
  displayName: ['displayname', 'name', 'fullname', 'sendername', 'firstname'],
  smtpHost: ['smtphost', 'smtpserver', 'smtp', 'outgoingserver', 'outgoinghost'],
  smtpPort: ['smtpport', 'outgoingport'],
  imapHost: ['imaphost', 'imapserver', 'imap', 'incomingserver', 'incominghost'],
  imapPort: ['imapport', 'incomingport'],
  password: ['password', 'apppassword', 'smtppassword', 'mailboxpassword', 'pass', 'apppasswords'],
  imapPassword: ['imappassword'],
  encryption: ['encryption', 'smtpencryption', 'security', 'tls', 'ssl'],
} as const;

type FieldName = keyof typeof ALIASES;

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Заголовок файла → наше поле. Первое совпадение выигрывает. */
function buildHeaderMap(headers: string[]): Map<FieldName, string> {
  const map = new Map<FieldName, string>();
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    if (!normalized) continue;
    for (const [field, aliases] of Object.entries(ALIASES) as [FieldName, readonly string[]][]) {
      if (map.has(field)) continue;
      if (aliases.includes(normalized)) {
        map.set(field, header);
        break;
      }
    }
  }
  return map;
}

function value(row: FileRow, map: Map<FieldName, string>, field: FieldName): string {
  const header = map.get(field);
  if (!header) return '';
  return (row[header] ?? '').trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parsePort(raw: string, fallback: number): number {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

/**
 * Режим TLS: явная колонка шифрования важнее порта, порт важнее пресета.
 * 465 — implicit TLS, 587/2525 — STARTTLS.
 */
function resolveTlsMode(encryption: string, port: number, preset: ProviderPreset): TlsMode {
  const text = encryption.toLowerCase();
  if (text.includes('starttls')) return 'starttls';
  if (text.includes('ssl') || text.includes('implicit')) return 'implicit_tls';
  if (port === 465) return 'implicit_tls';
  if (port === 587 || port === 2525) return 'starttls';
  return preset.smtpTlsMode;
}

export function parseMailboxRows(rows: FileRow[], provider: SenderProvider): ParsedImport {
  const preset = PRESETS[provider];
  const map = buildHeaderMap(Object.keys(rows[0] ?? {}));
  const mailboxes: ParsedMailbox[] = [];
  const errors: ImportRowError[] = [];
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    // +2: первая строка файла — заголовки, нумерация с единицы.
    const line = index + 2;
    const email = value(row, map, 'email').toLowerCase();

    if (!email) {
      errors.push({ line, email: null, message: 'Нет адреса ящика' });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      errors.push({ line, email, message: 'Адрес ящика выглядит некорректно' });
      return;
    }
    if (seen.has(email)) {
      errors.push({ line, email, message: 'Этот ящик уже есть выше в файле' });
      return;
    }

    const password = value(row, map, 'password');
    if (!password) {
      errors.push({ line, email, message: 'Нет пароля (пароль приложения или SMTP)' });
      return;
    }

    const smtpHost = value(row, map, 'smtpHost') || preset.smtpHost || '';
    if (!smtpHost) {
      errors.push({ line, email, message: 'Нет SMTP-хоста, и у провайдера нет значения по умолчанию' });
      return;
    }

    const smtpPort = parsePort(value(row, map, 'smtpPort'), preset.smtpPort);
    const imapPort = parsePort(value(row, map, 'imapPort'), preset.imapPort);
    // Хост IMAP у Maildoso свой для каждого ящика: подставлять чужой нельзя,
    // ящик просто останется без чтения ответов, пока хост не укажут.
    const imapHost = value(row, map, 'imapHost') || preset.imapHost || null;
    const imapPassword = value(row, map, 'imapPassword') || null;

    seen.add(email);
    mailboxes.push({
      email,
      username: value(row, map, 'username') || email,
      displayName: value(row, map, 'displayName') || null,
      smtpHost,
      smtpPort,
      smtpTlsMode: resolveTlsMode(value(row, map, 'encryption'), smtpPort, preset),
      imapHost,
      imapPort,
      smtpPassword: password,
      imapPassword,
    });
  });

  return { mailboxes, errors };
}
