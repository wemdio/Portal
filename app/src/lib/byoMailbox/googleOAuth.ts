import 'server-only';

import { createHmac } from 'crypto';

/**
 * OAuth2 для подключения Gmail/Google Workspace (BYO-почты) — «в один клик»,
 * без app-password. Реализовано на чистом fetch (без тяжёлого googleapis).
 *
 * ВАЖНО: для отправки через SMTP (XOAUTH2, наш движок на nodemailer) Google
 * требует ПОЛНЫЙ scope `https://mail.google.com/` — `gmail.send` для SMTP не
 * подходит. Этот scope «restricted» → для внешних клиентов нужна верификация
 * OAuth-приложения в Google; для своего Workspace можно internal-приложение.
 *
 * Требует env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET.
 * redirect_uri = <origin или BYO_OAUTH_REDIRECT_BASE>/api/client/mailboxes/oauth/google/callback
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';
const SCOPES = ['https://mail.google.com/', 'https://www.googleapis.com/auth/userinfo.email'];
const STATE_TTL_MS = 10 * 60 * 1000;

export function getGoogleClientCreds(): { clientId: string; clientSecret: string } {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not configured');
  }
  return { clientId, clientSecret };
}

export function callbackRedirectUri(reqOrigin: string): string {
  const base = (process.env.BYO_OAUTH_REDIRECT_BASE || reqOrigin).replace(/\/+$/, '');
  return `${base}/api/client/mailboxes/oauth/google/callback`;
}

// --- signed state (HMAC) so the unauthenticated callback can trust the user id ---

function stateSecret(): string {
  const s = (process.env.GUEST_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!s) throw new Error('No secret available to sign OAuth state');
  return s;
}

function hmac(data: string): string {
  return createHmac('sha256', stateSecret()).update(data).digest('base64url');
}

export function signOAuthState(userId: string, issuedAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, t: issuedAtMs }), 'utf8').toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

export function verifyOAuthState(state: string, nowMs: number): string | null {
  const [payload, sig] = (state ?? '').split('.');
  if (!payload || !sig) return null;
  if (hmac(payload) !== sig) return null;
  try {
    const { u, t } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u: string; t: number };
    if (!u || !t || nowMs - t > STATE_TTL_MS) return null;
    return u;
  } catch {
    return null;
  }
}

// --- OAuth flow ---

export function buildGoogleAuthUrl(redirectUri: string, state: string): string {
  const { clientId } = getGoogleClientCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // force refresh_token even on repeat consent
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<{ refreshToken: string; accessToken: string }> {
  const { clientId, clientSecret } = getGoogleClientCreds();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || `token exchange failed (${res.status})`);
  }
  if (!json.refresh_token) {
    throw new Error('Google did not return a refresh_token (revoke prior access for this app and retry).');
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token };
}

export async function getGoogleUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = (await res.json().catch(() => ({}))) as { email?: string };
  if (!res.ok || !json.email) throw new Error('Failed to read Google account email');
  return json.email.trim().toLowerCase();
}

/** Свежий access-token из refresh-токена (для IMAP XOAUTH2 при чтении ответов Gmail). */
export async function getAccessTokenFromRefresh(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = getGoogleClientCreds();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) throw new Error(json.error || `token refresh failed (${res.status})`);
  return json.access_token;
}
