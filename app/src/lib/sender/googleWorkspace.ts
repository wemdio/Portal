import 'server-only';

import { google } from 'googleapis';

/**
 * Ящики Google Workspace без паролей: служебный аккаунт с делегированием.
 *
 * Пароль приложения Google создаёт только сам владелец ящика, зайдя в свой
 * аккаунт, — на двух сотнях аутрич-ящиков это двести заходов руками. Вместо
 * этого админ Workspace один раз разрешает нашему служебному аккаунту работать
 * от имени пользователей домена, и дальше портал:
 *   - читает список ящиков из каталога Workspace (импорт одной кнопкой);
 *   - перед каждым входом в ящик берёт у Google ключ на час именно на этот
 *     адрес и подключается по SMTP/IMAP через XOAUTH2.
 * Пароли не существуют в природе, новые ящики домена подхватываются сами.
 *
 * Что должно быть настроено на стороне Google (делается один раз):
 *   1. В Google Cloud включены Admin SDK API и Gmail API, создан служебный
 *      аккаунт и скачан JSON-ключ.
 *   2. В админке Workspace (Безопасность → Управление делегированием на уровне
 *      домена) добавлен Client ID этого аккаунта с двумя разрешениями:
 *        https://www.googleapis.com/auth/admin.directory.user.readonly
 *        https://mail.google.com/
 *      Урезанный gmail.send для SMTP не годится: Google его не принимает —
 *      та же история, что и с клиентским OAuth (см. byoMailbox/googleOAuth).
 *
 * Переменные окружения:
 *   SENDER_GOOGLE_SA_EMAIL       — почта служебного аккаунта
 *   SENDER_GOOGLE_SA_PRIVATE_KEY — приватный ключ из JSON («\n» вместо переносов)
 *   SENDER_GOOGLE_ADMIN_EMAIL    — супер-админ, от чьего имени читается каталог;
 *                                  несколько Workspace — адреса через запятую
 *                                  (в каждом нужно выдать делегирование тому же
 *                                  Client ID)
 */

/** SMTP-отправка у Google требует полный доступ к почте; gmail.send не подходит. */
const MAIL_SCOPE = 'https://mail.google.com/';
const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

/** Ключ живёт час; обновляем заранее, чтобы он не протух посреди отправки. */
const TOKEN_TTL_MARGIN_MS = 5 * 60 * 1000;

export interface WorkspaceUser {
  email: string;
  fullName: string | null;
  suspended: boolean;
  archived: boolean;
}

export class GoogleWorkspaceNotConfigured extends Error {}

interface Credentials {
  clientEmail: string;
  privateKey: string;
}

/**
 * Аккаунты Workspace, чьи каталоги зеркалим: по одному супер-админу на каждый.
 * Ящик входит по ключу на свой адрес, поэтому для отправки неважно, из какого
 * Workspace он пришёл, — список нужен только для чтения каталогов.
 */
export function workspaceAccounts(): string[] {
  return (process.env.SENDER_GOOGLE_ADMIN_EMAIL ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function credentials(): Credentials {
  const clientEmail = process.env.SENDER_GOOGLE_SA_EMAIL ?? '';
  const rawKey = process.env.SENDER_GOOGLE_SA_PRIVATE_KEY ?? '';

  if (!clientEmail || !rawKey || !workspaceAccounts().length) {
    throw new GoogleWorkspaceNotConfigured(
      'Подключение к Google Workspace не настроено: нужны SENDER_GOOGLE_SA_EMAIL, '
      + 'SENDER_GOOGLE_SA_PRIVATE_KEY и SENDER_GOOGLE_ADMIN_EMAIL в окружении.',
    );
  }

  // В .env ключ лежит одной строкой с «\n» — иначе переносы ломают формат файла.
  return { clientEmail, privateKey: rawKey.replace(/\\n/g, '\n') };
}

export function isGoogleWorkspaceConfigured(): boolean {
  return Boolean(
    process.env.SENDER_GOOGLE_SA_EMAIL
    && process.env.SENDER_GOOGLE_SA_PRIVATE_KEY
    && workspaceAccounts().length,
  );
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Ключ на конкретный ящик. Google выдаёт его на час, поэтому держим в памяти
 * процесса: отправка идёт пачками, и просить новый ключ на каждое письмо —
 * лишний round-trip к Google на каждое из сотни писем.
 */
export async function accessTokenForMailbox(email: string): Promise<string> {
  const key = email.toLowerCase();
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - TOKEN_TTL_MARGIN_MS > Date.now()) return hit.token;

  const { clientEmail, privateKey } = credentials();
  const jwt = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [MAIL_SCOPE],
    // Тот самый «от имени ящика»: без subject ключ выдаётся служебному
    // аккаунту, а у него своей почты нет и вход в ящик не проходит.
    subject: email,
  });

  const { access_token: token, expiry_date: expiry } = await jwt.authorize();
  if (!token) throw new Error(`Google не выдал ключ для ${email}`);

  tokenCache.set(key, { token, expiresAt: expiry ?? Date.now() + 60 * 60 * 1000 });
  return token;
}

/** Забыть ключ: вызывается, когда Google отказал во входе — вдруг ключ протух. */
export function forgetMailboxToken(email: string): void {
  tokenCache.delete(email.toLowerCase());
}

/**
 * Список ящиков из каталога одного Workspace.
 *
 * Читается от имени его супер-админа: у служебного аккаунта самого по себе
 * доступа к каталогу нет, делегирование выдаётся на конкретного пользователя.
 */
export async function listWorkspaceMailboxes(adminEmail: string): Promise<WorkspaceUser[]> {
  const { clientEmail, privateKey } = credentials();
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [DIRECTORY_SCOPE],
    subject: adminEmail,
  });

  const directory = google.admin({ version: 'directory_v1', auth });
  const users: WorkspaceUser[] = [];
  let pageToken: string | undefined;

  do {
    const res = await directory.users.list({
      // my_customer — «домен того админа, от чьего имени работаем»: так не надо
      // ни знать customerId, ни перечислять все 58 доменов руками.
      customer: 'my_customer',
      maxResults: 500,
      orderBy: 'email',
      pageToken,
    });

    for (const user of res.data.users ?? []) {
      const email = String(user.primaryEmail ?? '').toLowerCase();
      if (!email) continue;
      users.push({
        email,
        fullName: user.name?.fullName ?? null,
        suspended: Boolean(user.suspended),
        archived: Boolean(user.archived),
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return users;
}
