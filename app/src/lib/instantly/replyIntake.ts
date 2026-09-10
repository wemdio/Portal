import type { SupabaseClient } from '@supabase/supabase-js';
import { listEmails } from './client';
import type { Email } from './types';

type IntakeDb = Pick<SupabaseClient, 'rpc'>;
type RpcResult = Record<string, unknown>;
const FAILURE = 'Instantly durable reply intake unavailable';
const PAGE_SIZE = 100;

export interface ReplyIntakeClaim {
  accountId: string;
  emailId: string;
  leaseToken: string;
  email: Email;
  attempts: number;
}

async function call(db: IntakeDb, name: string, args: Record<string, unknown>): Promise<RpcResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = db.rpc(name, args).abortSignal(controller.signal);
    const { data, error } = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('intake RPC deadline')); }, 10_000);
      }),
    ]);
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid RPC result');
    return data as RpcResult;
  } catch {
    // No credential, provider body or contact details in operational failures.
    throw new Error(`${FAILURE}: ${name}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Source age and pagination age are deliberately different: Instantly sorts and
 * filters by creation date, which may be much later than timestamp_email after
 * an import. The initial 48h source floor never advances or deletes known work.
 * Existing older qualifications remain owned by their existing recovery queue.
 */
export async function discoverReplyIntake(
  db: IntakeDb,
  options: { accountId: string; campaignIds: ReadonlySet<string>; maxPages?: number },
): Promise<{ staged: number; pages: number; sweepComplete: boolean; busy: boolean }> {
  const stats = { staged: 0, pages: 0, sweepComplete: false, busy: false };
  if (!options.accountId.trim()) throw new Error(`${FAILURE}: missing account`);
  if (!options.campaignIds.size) return stats;
  // A one-page budget alternates durable head/sweep lanes across invocations.
  const maxPages = Math.max(1, Math.min(5, Math.trunc(options.maxPages ?? 5) || 5));
  const lease = await call(db, 'claim_instantly_reply_discovery', { p_account_id: options.accountId });
  if (lease.state === 'busy') return { ...stats, busy: true };
  if (lease.state !== 'claimed' || typeof lease.lease_token !== 'string' ||
    !timestamp(lease.bootstrap_since) || !timestamp(lease.sweep_since) || !timestamp(lease.sweep_until)) {
    throw new Error(`${FAILURE}: invalid discovery lease`);
  }
  const token = lease.lease_token;
  const bootstrapSince = timestamp(lease.bootstrap_since)!;
  const sweepSince = timestamp(lease.sweep_since)!;
  const sweepUntil = timestamp(lease.sweep_until)!;
  let cursor = typeof lease.sweep_cursor === 'string' ? lease.sweep_cursor : null;
  const cursors = new Set<string>();
  if (cursor) cursors.add(cursor);
  let failed = false;
  try {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const head = maxPages === 1 ? lease.single_page_head !== false : pageNumber === 0;
      const page = await listEmails({
        email_type: 'received', mode: 'emode_all', limit: PAGE_SIZE,
        sort_order: 'desc', latest_of_thread: false, preview_only: false,
        min_timestamp_created: head ? bootstrapSince : sweepSince,
        max_timestamp_created: head ? undefined : sweepUntil,
        starting_after: head ? undefined : cursor ?? undefined,
      }, {
        // Both lanes discover newly received work. Do not spend the separate
        // recovery allowance needed by already-persisted ownership retries.
        accountId: options.accountId, requestPriority: 'fresh',
        timeoutMs: 20_000, timeoutIncludesBody: true, retryRateLimits: false,
      });
      if (!Array.isArray(page.items) || page.items.length > PAGE_SIZE) throw new Error(`${FAILURE}: invalid email page`);
      const items = page.items.filter(email =>
        (email.ue_type ?? 2) === 2 && email.campaign_id && options.campaignIds.has(email.campaign_id),
      ).flatMap(email => {
        if (typeof email.id !== 'string' || !email.id.trim()) throw new Error(`${FAILURE}: inbound missing id`);
        const replyTimestamp = timestamp(email.timestamp_email) ?? timestamp(email.timestamp_created);
        if (replyTimestamp && replyTimestamp < bootstrapSince) return [];
        return [{ email_id: email.id, campaign_id: email.campaign_id,
          lead_email: (email.from_address_email || email.lead || '').trim().toLowerCase() || null,
          reply_timestamp: replyTimestamp, email_payload: email }];
      });
      const next = page.next_starting_after ?? null;
      if (next !== null && (typeof next !== 'string' || !next.trim())) throw new Error(`${FAILURE}: invalid cursor`);
      // Do not declare EOF based on a short/old page: only the provider cursor.
      // A cyclic response is saved, but cannot advance the durable sweep cursor.
      const cycle = !head && next !== null && cursors.has(next);
      const result = await call(db, 'stage_instantly_reply_page', {
        p_account_id: options.accountId, p_lease_token: token, p_items: items,
        p_is_head: head, p_expected_cursor: head ? null : cursor,
        p_next_cursor: cycle ? cursor : next, p_sweep_complete: !head && next === null,
      });
      if (result.state !== 'saved') throw new Error(`${FAILURE}: discovery lease lost`);
      stats.pages += 1;
      stats.staged += Number(result.staged) || 0;
      if (cycle) throw new Error(`${FAILURE}: cyclic provider cursor`);
      if (!head) {
        cursor = next;
        if (cursor) cursors.add(cursor);
        else { stats.sweepComplete = true; break; }
      }
    }
    return stats;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A crash instead of this release is safe: page+cursor are atomic and the
    // discovery lease expires. Never advance progress from a failed fetch.
    try {
      const released = await call(db, 'release_instantly_reply_discovery', {
        p_account_id: options.accountId, p_lease_token: token, p_failed: failed,
      });
      if (released.state !== 'released' && !failed) throw new Error(`${FAILURE}: discovery release lost`);
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

export async function claimReplyIntake(
  db: IntakeDb, options: { accountIds: string[]; limit: number },
): Promise<ReplyIntakeClaim[]> {
  if (!options.accountIds.length) return [];
  const result = await call(db, 'claim_instantly_reply_intake', {
    p_account_ids: options.accountIds, p_limit: Math.max(1, Math.min(20, Math.trunc(options.limit) || 1)),
  });
  if (result.state !== 'claimed' || !Array.isArray(result.items)) throw new Error(`${FAILURE}: invalid intake claim`);
  return result.items.map((item: RpcResult) => {
    if (typeof item.account_id !== 'string' || !options.accountIds.includes(item.account_id) ||
      typeof item.email_id !== 'string' || typeof item.lease_token !== 'string' ||
      !item.email_payload || typeof item.email_payload !== 'object' ||
      (item.email_payload as Email).id !== item.email_id) throw new Error(`${FAILURE}: invalid claimed reply`);
    return { accountId: item.account_id, emailId: item.email_id, leaseToken: item.lease_token,
      email: item.email_payload as Email, attempts: Number(item.attempts) || 0 };
  });
}

/** ACK means durably handed to qualification/recovery, NOT a final lead verdict. */
export async function completeReplyIntake(db: IntakeDb, claim: ReplyIntakeClaim): Promise<boolean> {
  const result = await call(db, 'finish_instantly_reply_intake', {
    p_account_id: claim.accountId, p_email_id: claim.emailId, p_lease_token: claim.leaseToken,
    p_complete: true,
  });
  if (result.state === 'accepted') return true;
  if (result.state === 'missing_qualification') return false;
  throw new Error(`${FAILURE}: completion lease lost`);
}

export async function deferReplyIntake(db: IntakeDb, claim: ReplyIntakeClaim, error: string): Promise<void> {
  // Persist a bounded class, never the provider's raw error/body/contact text.
  const message = error.toLowerCase();
  const errorCode = /429|rate.?limit|quota|budget/.test(message) ? 'provider_budget'
    : /timeout|timed out|deadline|abort/.test(message) ? 'timeout'
      : /ownership|owner/.test(message) ? 'ownership_unresolved'
        : /intake unavailable|database|storage|pgrst/.test(message) ? 'storage_unavailable'
          : 'qualification_not_durably_saved';
  const result = await call(db, 'finish_instantly_reply_intake', {
    p_account_id: claim.accountId, p_email_id: claim.emailId, p_lease_token: claim.leaseToken,
    p_complete: false, p_error_code: errorCode,
  });
  if (result.state !== 'deferred') throw new Error(`${FAILURE}: retry lease lost`);
}
