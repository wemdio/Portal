import type { Email } from '@/lib/instantly/types';
import type { ClientReply } from './types';

/** Hard cap on body text we return to the browser. */
const MAX_BODY_TEXT_CHARS = 20_000;
const MAX_PREVIEW_CHARS = 200;

/** Lightweight HTML → plain-text. Intentionally minimal: replies are usually short. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<\/?(div|p|li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBodyText(body: Email['body']): string | null {
  if (!body) return null;
  if (typeof body === 'string') {
    // Could be html or plain — be safe and convert.
    return htmlToText(body);
  }
  if (typeof body === 'object') {
    if (typeof body.text === 'string' && body.text.trim().length > 0) {
      return body.text;
    }
    if (typeof body.html === 'string' && body.html.trim().length > 0) {
      return htmlToText(body.html);
    }
  }
  return null;
}

function clamp(text: string | null, max: number): string | null {
  if (text == null) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function extractFromName(email: Email): string | null {
  const arr = email.from_address_json;
  if (Array.isArray(arr) && arr.length > 0) {
    const name = arr[0]?.name;
    if (typeof name === 'string' && name.trim().length > 0) {
      return name.trim();
    }
  }
  return null;
}

/**
 * Convert a raw Instantly Email to a public-safe ClientReply.
 * Strips: eaccount, i_status, is_focused, from/to_address_json, raw body object.
 */
export function mapInstantlyEmailToReply(email: Email): ClientReply {
  const bodyText = clamp(extractBodyText(email.body), MAX_BODY_TEXT_CHARS);
  const preview = clamp(email.content_preview ?? null, MAX_PREVIEW_CHARS);
  const isUnread = typeof email.is_unread === 'number' && email.is_unread > 0;
  const aiInterest =
    typeof email.ai_interest_value === 'number' && Number.isFinite(email.ai_interest_value)
      ? email.ai_interest_value
      : null;

  return {
    id: email.id,
    timestamp: email.timestamp_email ?? email.timestamp_created ?? null,
    subject: email.subject ?? null,
    from_email: email.from_address_email ?? null,
    from_name: extractFromName(email),
    lead_id: email.lead ?? null,
    thread_id: email.thread_id ?? null,
    is_unread: isUnread,
    ai_interest_value: aiInterest,
    content_preview: preview,
    body_text: bodyText,
  };
}
