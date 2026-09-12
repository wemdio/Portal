import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Email } from './types';

// Keep headroom below the operational RPC's 1MiB/item and 16MiB/page guards.
// The expanded limit is defensive, not permission to truncate a larger reply.
const MAX_STORED_PAYLOAD_BYTES = 768 * 1024;
const MAX_EXPANDED_PAYLOAD_BYTES = 64 * 1024 * 1024;
const ENVELOPE_KEY = '_portal_reply_intake_gzip_v1';

export class ReplyIntakePayloadError extends Error {
  constructor(readonly reason: 'payload_too_large' | 'payload_decode_failed') {
    super(`Instantly durable reply intake unavailable: ${reason}`);
  }
}

/** PostgreSQL jsonb::text inserts separator whitespace. Pretty JSON is a
 * conservative size estimate for normal Email metadata and Unicode text.
 * Scientific JSON numbers may expand in PostgreSQL; reserve their worst-case
 * finite-double decimal expansion too, without changing their actual values. */
export function replyIntakeJsonBytes(value: unknown): number {
  const json = JSON.stringify(value, null, 1);
  const scientificNumbers = json.match(/(?:[:,]|\[)\s*-?\d+(?:\.\d+)?[eE][+-]?\d+/g)?.length ?? 0;
  return Buffer.byteLength(json, 'utf8') + scientificNumbers * 1_100;
}

function compactHtmlImages(html: string): string {
  // Remove only binary rendering data in image attributes. Keep alt/title,
  // normal URLs, linked documents, SVG/text data URIs and all authored/quoted
  // text. In particular, never run this over body.text or arbitrary headers.
  const binaryImage = /data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\r\n]+/gi;
  const replaceImage = (value: string) => value.replace(binaryImage, 'about:blank#inline-image-omitted');
  const compactCss = (value: string) => value.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, replaceImage);
  const tags = html.replace(/<[a-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
    const isImage = /^<(?:img|source)\b/i.test(tag);
    return tag.replace(/([^\s=/>]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
      (attribute, name: string, equals: string, double: string | undefined,
        single: string | undefined, unquoted: string | undefined) => {
        const value = double ?? single ?? unquoted ?? '';
        const updated = name.toLowerCase() === 'style' ? compactCss(value)
          : isImage && /^(?:src|srcset)$/i.test(name) ? replaceImage(value) : value;
        if (updated === value) return attribute;
        const quote = double !== undefined ? '"' : single !== undefined ? "'" : '';
        return `${name}${equals}${quote}${updated}${quote}`;
      });
  });
  return tags.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (_match, open: string, css: string, close: string) => open + compactCss(css) + close);
}

/** Compact non-text image bytes; otherwise preserve the entire provider Email.
 * If still large, store a lossless envelope and decode it BEFORE qualification.
 * Uncompressible overflow is explicit/fail-closed, never a clipped business reply. */
export function encodeReplyIntakeEmail(email: Email): Email {
  let compacted = email;
  if (typeof email.body === 'object' && email.body && typeof email.body.html === 'string') {
    const html = compactHtmlImages(email.body.html);
    if (html !== email.body.html) compacted = { ...email, body: { ...email.body, html } };
  }
  if (!Object.hasOwn(compacted, ENVELOPE_KEY) && replyIntakeJsonBytes(compacted) <= MAX_STORED_PAYLOAD_BYTES) {
    return compacted;
  }
  const json = JSON.stringify(compacted);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_EXPANDED_PAYLOAD_BYTES) throw new ReplyIntakePayloadError('payload_too_large');
  const compressed = gzipSync(json).toString('base64');
  const envelope: Email = {
    id: email.id, campaign_id: email.campaign_id, from_address_email: email.from_address_email,
    eaccount: email.eaccount, thread_id: email.thread_id, ue_type: email.ue_type,
    timestamp_email: email.timestamp_email, timestamp_created: email.timestamp_created,
    [ENVELOPE_KEY]: { codec: 'gzip', bytes, sha256: createHash('sha256').update(json).digest('hex'), data: compressed },
  };
  if (replyIntakeJsonBytes(envelope) > MAX_STORED_PAYLOAD_BYTES) throw new ReplyIntakePayloadError('payload_too_large');
  return envelope;
}

export function decodeReplyIntakeEmail(stored: Email): Email {
  if (!Object.hasOwn(stored, ENVELOPE_KEY)) return stored; // pre-deployment raw rows
  try {
    const envelope = stored[ENVELOPE_KEY] as Record<string, unknown> | null;
    if (!envelope || envelope.codec !== 'gzip' || typeof envelope.data !== 'string' ||
      typeof envelope.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sha256) ||
      !Number.isInteger(envelope.bytes) || (envelope.bytes as number) < 1 ||
      (envelope.bytes as number) > MAX_EXPANDED_PAYLOAD_BYTES ||
      envelope.data.length > MAX_STORED_PAYLOAD_BYTES || !/^[a-z0-9+/]+={0,2}$/i.test(envelope.data)) {
      throw new Error('invalid envelope');
    }
    const buffer = gunzipSync(Buffer.from(envelope.data, 'base64'), {
      maxOutputLength: Math.min(envelope.bytes as number, MAX_EXPANDED_PAYLOAD_BYTES),
    });
    if (buffer.length !== envelope.bytes || createHash('sha256').update(buffer).digest('hex') !== envelope.sha256) {
      throw new Error('invalid payload digest');
    }
    const email = JSON.parse(buffer.toString('utf8')) as Email;
    if (!email || Array.isArray(email) || email.id !== stored.id || email.campaign_id !== stored.campaign_id ||
      email.from_address_email !== stored.from_address_email || email.eaccount !== stored.eaccount ||
      email.thread_id !== stored.thread_id || email.ue_type !== stored.ue_type ||
      email.timestamp_email !== stored.timestamp_email || email.timestamp_created !== stored.timestamp_created) {
      throw new Error('invalid decoded reply scope');
    }
    return email;
  } catch {
    throw new ReplyIntakePayloadError('payload_decode_failed');
  }
}
