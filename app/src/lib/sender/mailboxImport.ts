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
  /** null — сломан файл целиком, а не отдельная строка: номер строки тут врал бы. */
  line: number | null;
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

/**
 * Пометки провайдера в скобках: выгрузка пользователей Google Workspace
 * называет колонки «Email Address [Required]», «Status [READ ONLY]»,
 * «Password [Required for new users]». Без снятия пометки заголовок
 * нормализуется в `emailaddressrequired` и не совпадает ни с одним синонимом,
 * из-за чего весь файл отвергался построчно с «Нет адреса ящика».
 */
function stripAnnotations(header: string): string {
  return header.replace(/[[({][^\])}]*[\])}]/g, ' ');
}

/**
 * Заголовок файла → наше поле. Первое совпадение выигрывает.
 *
 * Два прохода, и порядок принципиален: сначала точные заголовки, и только
 * то, что не нашлось, сопоставляется без пометок в скобках. Иначе «Password
 * (IMAP)» превратился бы в `password` и занял бы место SMTP-пароля, хотя в
 * файле рядом есть настоящая колонка пароля.
 */
function buildHeaderMap(headers: string[]): Map<FieldName, string> {
  const map = new Map<FieldName, string>();
  const used = new Set<string>();
  const pass = (prepare: (header: string) => string) => {
    for (const header of headers) {
      if (used.has(header)) continue;
      const normalized = normalizeHeader(prepare(header));
      if (!normalized) continue;
      for (const [field, aliases] of Object.entries(ALIASES) as [FieldName, readonly string[]][]) {
        if (map.has(field)) continue;
        if (aliases.includes(normalized)) {
          map.set(field, header);
          used.add(header);
          break;
        }
      }
    }
  };
  pass((header) => header);
  pass(stripAnnotations);
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
  const headers = Object.keys(rows[0] ?? {});
  const map = buildHeaderMap(headers);
  const mailboxes: ParsedMailbox[] = [];
  const errors: ImportRowError[] = [];
  const seen = new Set<string>();

  // Не нашлась целая колонка — это одна проблема файла, а не двести одинаковых
  // проблем строк. Пока об этом сообщалось построчно, экран показывал «Нет
  // адреса ящика» двести раз подряд: причина (нераспознанный заголовок) из
  // такого списка не читалась вовсе, а номера строк уводили искать в данные.
  // Поэтому сообщение одно, и в нём перечислены заголовки, которые мы увидели:
  // по ним сразу видно и лишнюю пометку провайдера, и неверный разделитель
  // (тогда весь заголовок приезжает одной колонкой).
  if (rows.length) {
    const shown = headers.slice(0, 10).join(', ') || '—';
    const found = headers.length > 10 ? `${shown}… (всего колонок: ${headers.length})` : shown;
    if (!map.has('email')) {
      return { mailboxes: [], errors: [{ line: null, email: null, message:
        `Не нашли колонку с адресом ящика. Заголовки файла: ${found}. `
        + 'Нужны две колонки: адрес (Email, Email Address, Mailbox) и пароль '
        + '(Password, App Password, SMTP Password). Пометки вида [Required] не мешают.' }] };
    }
    if (!map.has('password')) {
      return { mailboxes: [], errors: [{ line: null, email: null, message:
        `Адрес читается из колонки «${map.get('email')}», а колонку с паролем не нашли. `
        + 'Добавьте колонку Password (подойдёт App Password или SMTP Password): без пароля '
        + `портал не сможет войти в ящик. Заголовки файла: ${found}.` }] };
    }
  }

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
