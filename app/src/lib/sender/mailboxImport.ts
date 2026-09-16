import type { FileRow } from './fileParse';
import {
  FALLBACK_PROVIDER,
  PRESETS,
  lookupProviderByMx,
  lookupProviders,
  providerFromEmailDomain,
  providerFromHeaders,
  providerFromHost,
  type DomainLookup,
  type ProviderPreset,
  type SenderProvider,
  type TlsMode,
} from './providerDetect';

/**
 * Распознавание выгрузки провайдера: строка файла → нормализованный ящик.
 *
 * Названия колонок у провайдеров разные и меняются («Email», «Mailbox»,
 * «SMTP Username», «App Password»…), поэтому колонки сопоставляются по списку
 * синонимов, а не по фиксированному порядку. Чего нет в файле — берём из
 * пресета провайдера, а самого провайдера определяем по файлу и домену
 * (providerDetect), а не спрашиваем у человека. Исключение: IMAP-хост у
 * Maildoso индивидуален для каждого ящика, общего значения по умолчанию для
 * него нет.
 */

export type { SenderProvider, TlsMode } from './providerDetect';

export interface ParsedMailbox {
  provider: SenderProvider;
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

/** Строка файла, прошедшая проверку: провайдер известен либо ждёт ответа DNS. */
interface Draft {
  line: number;
  email: string;
  domain: string;
  provider: SenderProvider | null;
  row: FileRow;
}

/**
 * Провайдер по тому, что уже есть в файле. Лесенка, до первого попадания:
 *
 * 1. SMTP-хост в колонке — сильнее всего: хост у нас на руках в любом случае,
 *    и незнакомый хост честно означает «свои настройки».
 * 2. IMAP-хост в колонке — так узнаётся выгрузка Maildoso (у неё IMAP-хост свой
 *    на каждый ящик). Незнакомый IMAP-хост провайдера НЕ определяет: SMTP-хоста
 *    он не даёт, и объявить такую строку «своими настройками» значило бы
 *    отвергнуть её из-за отсутствия SMTP-хоста.
 * 3. Шапка файла — выгрузка пользователей Google Workspace.
 * 4. Домен адреса, если он публичный (@gmail.com и подобные).
 *
 * Не хватило — спрашиваем DNS домена (шаг 5 в parseMailboxRows).
 */
function detectFromFile(
  row: FileRow,
  map: Map<FieldName, string>,
  headerProvider: SenderProvider | null,
  domain: string,
): SenderProvider | null {
  const smtpHost = value(row, map, 'smtpHost');
  if (smtpHost) return providerFromHost(smtpHost) ?? 'custom';

  const imapHost = value(row, map, 'imapHost');
  if (imapHost) {
    const byImap = providerFromHost(imapHost);
    if (byImap) return byImap;
  }

  return headerProvider ?? providerFromEmailDomain(domain);
}

export async function parseMailboxRows(
  rows: FileRow[],
  lookup: DomainLookup = lookupProviderByMx,
): Promise<ParsedImport> {
  const headers = Object.keys(rows[0] ?? {});
  const map = buildHeaderMap(headers);
  const headerProvider = providerFromHeaders(headers.map((h) => normalizeHeader(stripAnnotations(h))));
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

  const drafts: Draft[] = [];

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
    if (!value(row, map, 'password')) {
      errors.push({ line, email, message: 'Нет пароля (пароль приложения или SMTP)' });
      return;
    }

    seen.add(email);
    const domain = email.slice(email.indexOf('@') + 1);
    drafts.push({ line, email, domain, provider: detectFromFile(row, map, headerProvider, domain), row });
  });

  // Шаг 5 лесенки — DNS, и только для доменов, по которым файл промолчал.
  // Спрашиваем раз на домен, а не на ящик: у выгрузки на две сотни ящиков
  // доменов единицы.
  const unresolved = [...new Set(drafts.filter((d) => !d.provider).map((d) => d.domain))];
  const byDomain = unresolved.length ? await lookupProviders(unresolved, lookup) : new Map<string, SenderProvider>();

  for (const draft of drafts) {
    const { row, line, email } = draft;
    const provider = draft.provider ?? byDomain.get(draft.domain) ?? FALLBACK_PROVIDER;
    const preset = PRESETS[provider];

    const smtpHost = value(row, map, 'smtpHost') || preset.smtpHost || '';
    if (!smtpHost) {
      errors.push({ line, email, message: 'Не поняли, какой у ящика SMTP-сервер — добавьте в файл колонку SMTP Host' });
      continue;
    }

    const smtpPort = parsePort(value(row, map, 'smtpPort'), preset.smtpPort);
    const imapPort = parsePort(value(row, map, 'imapPort'), preset.imapPort);
    // Хост IMAP у Maildoso свой для каждого ящика: подставлять чужой нельзя,
    // ящик просто останется без чтения ответов, пока хост не укажут.
    const imapHost = value(row, map, 'imapHost') || preset.imapHost || null;

    mailboxes.push({
      provider,
      email,
      username: value(row, map, 'username') || email,
      displayName: value(row, map, 'displayName') || null,
      smtpHost,
      smtpPort,
      smtpTlsMode: resolveTlsMode(value(row, map, 'encryption'), smtpPort, preset),
      imapHost,
      imapPort,
      smtpPassword: value(row, map, 'password'),
      imapPassword: value(row, map, 'imapPassword') || null,
    });
  }

  // Ошибки строк набираются в два прохода (проверка строки и подстановка
  // настроек), а на экране они должны идти по порядку файла — иначе первые
  // десять в списке окажутся не первыми в выгрузке.
  errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  return { mailboxes, errors };
}
