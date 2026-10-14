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
 * Переменные окружения — по набору на каждый служебный аккаунт:
 *   SENDER_GOOGLE_SA_EMAIL       — почта служебного аккаунта
 *   SENDER_GOOGLE_SA_PRIVATE_KEY — приватный ключ из JSON («\n» вместо переносов)
 *   SENDER_GOOGLE_ADMIN_EMAIL    — супер-админ, от чьего имени читается каталог;
 *                                  несколько Workspace на одном служебном
 *                                  аккаунте — адреса через запятую
 * Следующий служебный аккаунт — те же три имени с окончанием _2, _3 и так далее
 * (SENDER_GOOGLE_SA_EMAIL_2, SENDER_GOOGLE_SA_PRIVATE_KEY_2,
 * SENDER_GOOGLE_ADMIN_EMAIL_2). Номера могут идти с пропусками.
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

interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  /** Админы тех Workspace, что выдали делегирование этому служебному аккаунту. */
  admins: string[];
}

const NOT_CONFIGURED = 'Подключение к Google Workspace не настроено: нужны SENDER_GOOGLE_SA_EMAIL, '
  + 'SENDER_GOOGLE_SA_PRIVATE_KEY и SENDER_GOOGLE_ADMIN_EMAIL в окружении.';

function splitEmails(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Все служебные аккаунты из окружения: без окончания — первый, дальше _2, _3…
 * Набор без ключа или без админа пропускается: читать каталог и входить в ящики
 * ему нечем, а половинчатая настройка не должна ломать остальные аккаунты.
 */
function serviceAccounts(): ServiceAccount[] {
  const suffixes = Object.keys(process.env)
    .flatMap((name) => {
      const match = /^SENDER_GOOGLE_SA_EMAIL(_\d+)?$/.exec(name);
      return match ? [match[1] ?? ''] : [];
    })
    .sort((a, b) => Number(a.slice(1) || 1) - Number(b.slice(1) || 1));

  return suffixes.flatMap((suffix) => {
    const clientEmail = (process.env[`SENDER_GOOGLE_SA_EMAIL${suffix}`] ?? '').trim();
    const rawKey = process.env[`SENDER_GOOGLE_SA_PRIVATE_KEY${suffix}`] ?? '';
    const admins = splitEmails(process.env[`SENDER_GOOGLE_ADMIN_EMAIL${suffix}`]);
    if (!clientEmail || !rawKey || !admins.length) return [];
    // В .env ключ лежит одной строкой с «\n» — иначе переносы ломают формат файла.
    return [{ clientEmail, privateKey: rawKey.replace(/\\n/g, '\n'), admins }];
  });
}

/**
 * Аккаунты Workspace, чьи каталоги зеркалим: по одному супер-админу на каждый,
 * со всех служебных аккаунтов сразу.
 */
export function workspaceAccounts(): string[] {
  return [...new Set(serviceAccounts().flatMap((sa) => sa.admins))];
}

export function isGoogleWorkspaceConfigured(): boolean {
  return serviceAccounts().length > 0;
}

/** Служебный аккаунт, которому этот Workspace выдал делегирование. */
function serviceAccountFor(adminEmail: string): ServiceAccount {
  const all = serviceAccounts();
  if (!all.length) throw new GoogleWorkspaceNotConfigured(NOT_CONFIGURED);
  const own = all.find((sa) => sa.admins.includes(adminEmail.toLowerCase()));
  if (!own) throw new Error(`Нет служебного аккаунта для Workspace ${adminEmail}`);
  return own;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function authorizeMailbox(sa: ServiceAccount, email: string) {
  const jwt = new google.auth.JWT({
    email: sa.clientEmail,
    key: sa.privateKey,
    scopes: [MAIL_SCOPE],
    // Тот самый «от имени ящика»: без subject ключ выдаётся служебному
    // аккаунту, а у него своей почты нет и вход в ящик не проходит.
    subject: email,
  });
  const { access_token: token, expiry_date: expiry } = await jwt.authorize();
  if (!token) throw new Error(`Google не выдал ключ для ${email}`);
  return { token, expiresAt: expiry ?? Date.now() + 60 * 60 * 1000 };
}

/**
 * Ключ на конкретный ящик. Google выдаёт его на час, поэтому держим в памяти
 * процесса: отправка идёт пачками, и просить новый ключ на каждое письмо —
 * лишний round-trip к Google на каждое из сотни писем.
 *
 * `googleAccount` — админ Workspace, из чьего каталога пришёл ящик: ключ
 * берётся у служебного аккаунта этого Workspace.
 */
export async function accessTokenForMailbox(email: string, googleAccount?: string | null): Promise<string> {
  const key = email.toLowerCase();
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - TOKEN_TTL_MARGIN_MS > Date.now()) return hit.token;

  const all = serviceAccounts();
  if (!all.length) throw new GoogleWorkspaceNotConfigured(NOT_CONFIGURED);

  const owner = googleAccount?.toLowerCase();
  const own = owner ? all.find((sa) => sa.admins.includes(owner)) : undefined;
  // Не знаем, чей ящик (каталог ещё не синхронизировался или админа убрали из
  // настроек), — пробуем ключи по очереди: чужой Workspace откажет, свой выдаст.
  const candidates = own ? [own] : all;

  const errors: string[] = [];
  for (const sa of candidates) {
    try {
      const issued = await authorizeMailbox(sa, key);
      tokenCache.set(key, issued);
      return issued.token;
    } catch (e) {
      if (candidates.length === 1) throw e;
      errors.push(`${sa.clientEmail}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(errors.join('; '));
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
  const { clientEmail, privateKey } = serviceAccountFor(adminEmail);
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
