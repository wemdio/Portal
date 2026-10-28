import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { listInstantlyAccounts } from '@/lib/instantly/accounts';
import { listAccounts } from '@/lib/instantly/client';

type Log = (level: 'info' | 'warn' | 'error', message: string, extra?: unknown) => void;
type Mailbox = { id: string; email: string; display_name: string | null };
type Name = { value: string | null; invalid: boolean; conflict: boolean };

export interface InstantlyNameSyncResult {
  configured: boolean;
  matched: number;
  updated: number;
  unchanged: number;
  unmatched: number;
  conflicts: number;
  failed: number;
}

const DB_PAGE_SIZE = 500;
const ACCOUNT_PAGE_SIZE = 100;
const MAX_ACCOUNT_PAGES = 200;
const MANUAL_PASS_TIMEOUT_MS = 90_000;
const BACKGROUND_PASS_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const DB_TIMEOUT_MS = 5_000;
const WRITE_CONCURRENCY = 5;

const emailKey = (email: string): string => email.trim().toLowerCase();

/** listAccounts' HTTP timeout starts after rate-limit admission; bound both. */
async function withinPass<T>(read: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Истекло время синхронизации имён Instantly')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Missing fields are not an instruction to clear a name; two empty strings are. */
function accountName(account: { first_name?: unknown; last_name?: unknown }): string | null | undefined {
  if (typeof account.first_name !== 'string' || typeof account.last_name !== 'string') return undefined;
  // The same 120-character limit as the name editor. No control characters may
  // reach a From header, even if an upstream account contains malformed text.
  const name = `${account.first_name} ${account.last_name}`
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return name || null;
}

/**
 * Instantly is the source of the sender name for mailboxes present there.
 * This only copies names into existing Sender rows: no mailbox/account creation,
 * provider writes, changes to limits, statuses, credentials or Google Directory.
 *
 * Read every configured workspace before writing: the same address can exist in
 * several workspaces. Different names are ambiguous; a failed workspace could
 * conceal such a conflict, so an incomplete snapshot never changes any names.
 */
export async function syncInstantlyMailboxNames(opts: {
  db: SupabaseClient;
  /** Omit for the background fleet pass; [] deliberately means no mailboxes. */
  mailboxIds?: string[];
  log?: Log;
}): Promise<InstantlyNameSyncResult> {
  const { db, log = () => {} } = opts;
  const accounts = listInstantlyAccounts();
  const result: InstantlyNameSyncResult = {
    configured: accounts.length > 0,
    matched: 0, updated: 0, unchanged: 0, unmatched: 0, conflicts: 0, failed: 0,
  };
  if (!accounts.length || opts.mailboxIds?.length === 0) return result;

  const passTimeout = opts.mailboxIds ? MANUAL_PASS_TIMEOUT_MS : BACKGROUND_PASS_TIMEOUT_MS;
  const deadline = Date.now() + passTimeout;
  const remaining = (max: number): number => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('Истекло время синхронизации имён Instantly');
    return Math.min(ms, max);
  };
  const mailboxes: Mailbox[] = [];
  // API callers are bounded to one visible page. Background scans must page
  // explicitly so the PostgREST row limit cannot silently cut off the fleet.
  const ids = opts.mailboxIds ? [...new Set(opts.mailboxIds)] : undefined;
  if (ids && ids.length > 100) throw new Error('Можно обновить имена не более 100 ящиков за запрос');
  for (let offset = 0; ; offset += DB_PAGE_SIZE) {
    let query = db.from('sender_mailboxes').select('id, email, display_name').order('id');
    if (ids) query = query.in('id', ids);
    const { data, error } = await query.range(offset, offset + DB_PAGE_SIZE - 1)
      .abortSignal(AbortSignal.timeout(remaining(DB_TIMEOUT_MS)));
    if (error) throw new Error(`Не удалось прочитать ящики Sender: ${error.message}`);
    mailboxes.push(...((data ?? []) as Mailbox[]));
    if ((data?.length ?? 0) < DB_PAGE_SIZE) break;
  }
  if (!mailboxes.length) return result;

  const wanted = new Set(mailboxes.map((mailbox) => emailKey(mailbox.email)));
  const names = new Map<string, Name>();
  let pagesRead = 0;
  try {
    for (const workspace of accounts) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      while (true) {
        if (++pagesRead > MAX_ACCOUNT_PAGES) throw new Error('Превышен лимит страниц каталога Instantly');
        // The shared limiter can queue a read before its HTTP timeout starts.
        // If the pass expires there, ignore that eventual GET result: writes
        // only happen after this complete snapshot has returned successfully.
        const page = await withinPass(() => listAccounts(
          { limit: ACCOUNT_PAGE_SIZE, starting_after: cursor },
          {
            accountId: workspace.id,
            consumer: 'sender_mailbox_names',
            timeoutMs: remaining(REQUEST_TIMEOUT_MS),
            timeoutIncludesBody: true,
            retryRateLimits: false,
          },
        ), remaining(passTimeout));
        // Runtime validation matters: an incomplete/malformed API response
        // must never look like an empty workspace or a cleared display name.
        if (!page || !Array.isArray(page.items)) throw new Error('Instantly вернул неполный каталог ящиков');
        for (const account of page.items) {
          if (!account || typeof account.email !== 'string' || !account.email.trim()) {
            throw new Error('Instantly вернул ящик без адреса');
          }
          const email = emailKey(account.email);
          if (!wanted.has(email)) continue;
          const value = accountName(account);
          const previous = names.get(email);
          if (!previous) {
            names.set(email, { value: value ?? null, invalid: value === undefined, conflict: false });
          } else {
            previous.invalid ||= value === undefined;
            previous.conflict ||= value !== undefined && value !== previous.value;
          }
        }
        const next = page.next_starting_after;
        if (next === undefined || next === null || next === '') break;
        if (typeof next !== 'string' || cursors.has(next) || !page.items.length) {
          throw new Error('Instantly вернул некорректную пагинацию каталога');
        }
        cursors.add(next);
        cursor = next;
      }
    }
    remaining(DB_TIMEOUT_MS);
  } catch (error) {
    result.failed = mailboxes.length;
    log('warn', 'Имена Sender сохранены: каталог Instantly не удалось прочитать полностью', error);
    return result;
  }

  const changes: { mailbox: Mailbox; name: string | null }[] = [];
  for (const mailbox of mailboxes) {
    const name = names.get(emailKey(mailbox.email));
    if (!name) { result.unmatched += 1; continue; }
    result.matched += 1;
    if (name.invalid) { result.failed += 1; continue; }
    if (name.conflict) { result.conflicts += 1; continue; }
    if (mailbox.display_name === name.value) { result.unchanged += 1; continue; }
    changes.push({ mailbox, name: name.value });
  }

  let nextChange = 0;
  const updateNext = async (): Promise<void> => {
    while (nextChange < changes.length) {
      if (Date.now() >= deadline) {
        result.failed += changes.length - nextChange;
        nextChange = changes.length;
        log('warn', 'Оставшиеся имена Sender сохранены: истекло время синхронизации');
        return;
      }
      const { mailbox, name } = changes[nextChange++];
      try {
        let query = db.from('sender_mailboxes')
          .update({ display_name: name, updated_at: new Date().toISOString() })
          .eq('id', mailbox.id);
        // A manual edit or another sync may have completed during API reads.
        // Compare with the original name so this older snapshot cannot erase it.
        query = mailbox.display_name === null
          ? query.is('display_name', null)
          : query.eq('display_name', mailbox.display_name);
        const { data, error } = await query.select('id')
          .abortSignal(AbortSignal.timeout(remaining(DB_TIMEOUT_MS)));
        if (error) throw error;
        if (data?.length) result.updated += 1;
        else result.conflicts += 1;
      } catch (error) {
        result.failed += 1;
        log('warn', `Не удалось обновить имя Sender (${mailbox.id})`, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, changes.length) }, updateNext));
  return result;
}
