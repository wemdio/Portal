import 'server-only';

/**
 * Yandex OAuth — подключение Яндекс.Почты «в один клик» (без пароля приложения).
 * В отличие от Google, у Яндекса НЕТ верификации приложения — зарегистрировал,
 * запросил доступы, сразу работает для внешних клиентов.
 *
 * Доступы (scopes): mail:smtp (отправка), mail:imap_full (чтение), login:email (адрес).
 * Токен годен для SMTP/IMAP по XOAUTH2 (smtp.yandex.ru / imap.yandex.ru).
 * Env: YANDEX_OAUTH_CLIENT_ID, YANDEX_OAUTH_CLIENT_SECRET.
 * redirect_uri = <BYO_OAUTH_REDIRECT_BASE или origin>/api/client/mailboxes/oauth/yandex/callback
 *
 * Подпись state переиспользуем из googleOAuth (signOAuthState/verifyOAuthState) — она общая.
 */

const AUTH_ENDPOINT = 'https://oauth.yandex.ru/authorize';
const TOKEN_ENDPOINT = 'https://oauth.yandex.ru/token';
const USERINFO_ENDPOINT = 'https://login.yandex.ru/info?format=json';
const SCOPES = ['mail:smtp', 'mail:imap_full', 'login:email'];

export function getYandexClientCreds(): { clientId: string; clientSecret: string } {
  const clientId = (process.env.YANDEX_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.YANDEX_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('YANDEX_OAUTH_CLIENT_ID / YANDEX_OAUTH_CLIENT_SECRET are not configured');
  }
  return { clientId, clientSecret };
}

export function yandexCallbackRedirectUri(reqOrigin: string): string {
  const base = (process.env.BYO_OAUTH_REDIRECT_BASE || reqOrigin).replace(/\/+$/, '');
  return `${base}/api/client/mailboxes/oauth/yandex/callback`;
}

export function buildYandexAuthUrl(redirectUri: string, state: string): string {
  const { clientId } = getYandexClientCreds();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
    force_confirm: 'yes', // всегда показывать экран согласия → стабильно отдаёт refresh_token
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeYandexCode(
  code: string,
  redirectUri: string,
): Promise<{ refreshToken: string; accessToken: string }> {
  const { clientId, clientSecret } = getYandexClientCreds();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || `token exchange failed (${res.status})`);
  }
  if (!json.refresh_token) {
    throw new Error('Yandex did not return a refresh_token');
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token };
}

export async function getYandexAccessTokenFromRefresh(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = getYandexClientCreds();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) throw new Error(json.error || `yandex token refresh failed (${res.status})`);
  return json.access_token;
}

export async function getYandexUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `OAuth ${accessToken}` } });
  const json = (await res.json().catch(() => ({}))) as { default_email?: string; emails?: string[] };
  const email = json.default_email || json.emails?.[0];
  if (!res.ok || !email) throw new Error('Failed to read Yandex account email');
  return email.trim().toLowerCase();
}
