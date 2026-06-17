import 'server-only';

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { unsealMailboxSecret } from './credentials';
import { getAccessTokenFromRefresh } from './googleOAuth';
import { getYandexAccessTokenFromRefresh } from './yandexOAuth';

/**
 * Чтение новых писем (ответов) по IMAP с подключённого ящика клиента.
 * Поддерживает app-password (user+pass) и Gmail OAuth (user+accessToken по refresh-токену).
 * Историю не тянем: при первой проверке (last_uid=0) просто запоминаем текущий UID,
 * дальше забираем только письма с UID больше курсора.
 */

export interface ReplyMailboxRow {
  id: string;
  client_user_id: string;
  email: string;
  username: string | null;
  secret_encrypted: string;
  auth_type: string;
  imap_host: string | null;
  imap_port: number | null;
  imap_last_uid: number | null;
  imap_uidvalidity: string | number | null;
}

export interface FetchedReply {
  uid: number;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  body: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  receivedAt: string | null;
}

export interface FetchResult {
  replies: FetchedReply[];
  newLastUid: number;
  uidValidity: string | null;
}

function imapTarget(mb: ReplyMailboxRow): { host: string; port: number } | null {
  if (mb.auth_type === 'oauth_google') return { host: 'imap.gmail.com', port: 993 };
  if (mb.auth_type === 'oauth_yandex') return { host: 'imap.yandex.ru', port: 993 };
  if (mb.imap_host) return { host: mb.imap_host, port: mb.imap_port || 993 };
  return null;
}

export async function fetchNewReplies(mb: ReplyMailboxRow): Promise<FetchResult | null> {
  const target = imapTarget(mb);
  if (!target) return null;

  const secret = unsealMailboxSecret(mb.secret_encrypted);
  let auth: { user: string; pass?: string; accessToken?: string };
  if (mb.auth_type === 'oauth_google') {
    if (!secret.oauthRefreshToken) return null;
    const accessToken = await getAccessTokenFromRefresh(secret.oauthRefreshToken);
    auth = { user: mb.email, accessToken };
  } else if (mb.auth_type === 'oauth_yandex') {
    if (!secret.oauthRefreshToken) return null;
    const accessToken = await getYandexAccessTokenFromRefresh(secret.oauthRefreshToken);
    auth = { user: mb.email, accessToken };
  } else {
    const pass = secret.imapPassword || secret.smtpPassword;
    if (!pass) return null;
    auth = { user: mb.username || mb.email, pass };
  }

  const client = new ImapFlow({
    host: target.host,
    port: target.port,
    secure: true,
    auth,
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 12_000,
    socketTimeout: 60_000,
  });

  await client.connect();
  try {
    const box = await client.mailboxOpen('INBOX');
    const uidNext = Number(box.uidNext);
    const uidValidity = box.uidValidity != null ? String(box.uidValidity) : null;

    const cursorValid = mb.imap_uidvalidity != null && String(mb.imap_uidvalidity) === uidValidity;
    const lastUid = cursorValid ? mb.imap_last_uid ?? 0 : 0;

    // Первичная инициализация / смена uidvalidity → стартуем с текущего, историю не читаем.
    if (lastUid === 0) {
      return { replies: [], newLastUid: Math.max(0, uidNext - 1), uidValidity };
    }
    if (lastUid + 1 >= uidNext) {
      return { replies: [], newLastUid: lastUid, uidValidity };
    }

    const replies: FetchedReply[] = [];
    let maxUid = lastUid;

    for await (const msg of client.fetch(
      `${lastUid + 1}:*`,
      { uid: true, envelope: true, source: true },
      { uid: true },
    )) {
      const uid = Number(msg.uid);
      if (uid > maxUid) maxUid = uid;

      let body: string | null = null;
      try {
        if (msg.source) {
          const parsed = await simpleParser(msg.source as Buffer);
          body = (parsed.text || '').slice(0, 20_000) || null;
        }
      } catch {
        /* битый MIME — оставляем body=null */
      }

      const env = msg.envelope;
      const fromAddr = env?.from?.[0];
      replies.push({
        uid,
        fromEmail: fromAddr?.address ?? null,
        fromName: fromAddr?.name ?? null,
        subject: env?.subject ?? null,
        body,
        messageId: env?.messageId ?? null,
        inReplyTo: env?.inReplyTo ?? null,
        receivedAt: env?.date ? new Date(env.date).toISOString() : null,
      });
    }

    return { replies, newLastUid: Math.max(maxUid, uidNext - 1), uidValidity };
  } finally {
    await client.logout().catch(() => {});
  }
}
