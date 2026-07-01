import type { Email } from '@/lib/instantly/types';
import type { Recipient } from './types';

/** Lowercase + trim for case-insensitive address comparison/dedup. */
function normEmail(s: string): string {
  return s.trim().toLowerCase();
}

/** Parse Instantly's `[{address, name}]` recipient arrays into Recipients. */
function fromJsonList(json: unknown): Recipient[] {
  if (!Array.isArray(json)) return [];
  const out: Recipient[] = [];
  for (const item of json) {
    const addr = item && typeof item === 'object' ? (item as { address?: unknown }).address : undefined;
    if (typeof addr === 'string' && addr.includes('@')) {
      const rawName = item && typeof (item as { name?: unknown }).name === 'string' ? (item as { name: string }).name.trim() : '';
      out.push({ email: addr.trim(), name: rawName || null });
    }
  }
  return out;
}

/** Parse Instantly's `"a@b.com, c@d.com"` recipient strings into Recipients. */
function fromEmailListString(s: unknown): Recipient[] {
  if (typeof s !== 'string' || !s.trim()) return [];
  return s
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.includes('@'))
    .map((email) => ({ email, name: null }));
}

function dedupe(list: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of list) {
    const k = normEmail(r.email);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * To/CC recipients of an email. Prefers the `*_json` form (carries display
 * names), falling back to the `*_email_list` comma-string. Deduped.
 */
export function getEmailRecipients(email: Email): { to: Recipient[]; cc: Recipient[] } {
  const to = dedupe([...fromJsonList(email.to_address_json), ...fromEmailListString(email.to_address_email_list)]);
  const cc = dedupe([...fromJsonList(email.cc_address_json), ...fromEmailListString(email.cc_address_email_list)]);
  return { to, cc };
}

/**
 * Reply-all CC addresses to keep when replying to `email`: every To+CC
 * participant EXCEPT our own sending mailbox (`eaccount`) and the lead we're
 * replying to (the lead becomes the To via Instantly's `reply_to_uuid`, so
 * CC'ing them would duplicate). This is what stops us silently dropping a
 * person the lead looped into the thread (a colleague / decision-maker).
 */
export function computeReplyAllRecipients(
  email: Email,
  opts: { eaccount?: string | null; leadEmail?: string | null },
): Recipient[] {
  const { to, cc } = getEmailRecipients(email);
  const exclude = new Set(
    [opts.eaccount, opts.leadEmail, email.from_address_email]
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .map(normEmail),
  );
  const out: Recipient[] = [];
  const seen = new Set<string>();
  for (const r of [...to, ...cc]) {
    const k = normEmail(r.email);
    if (exclude.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** Reply-all CC addresses (email-only) — see computeReplyAllRecipients. */
export function computeReplyAllCc(
  email: Email,
  opts: { eaccount?: string | null; leadEmail?: string | null },
): string[] {
  return computeReplyAllRecipients(email, opts).map((r) => r.email);
}

/** Case-insensitive merge of address lists, preserving the first spelling seen. */
export function mergeCcLists(...lists: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const addr of lists.flat()) {
    const trimmed = addr.trim();
    const k = normEmail(trimmed);
    if (!k || !trimmed.includes('@') || seen.has(k)) continue;
    seen.add(k);
    out.push(trimmed);
  }
  return out;
}
