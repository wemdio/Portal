import { readHeEngCollectionCheckpoint } from './engCollectionTarget';
import type { HeStageContext } from './stages/shared';

/** Separate namespace: legacy carryover still retires a whole company. */
export const HE_ENG_RESERVE_KEY_PREFIX = 'eng-reserve:v1:';
export const HE_ENG_RESERVE_KEY_PATTERN = `${HE_ENG_RESERVE_KEY_PREFIX}%`;

export type HeEngReserveContactState = 'available' | 'dispatching' | 'accepted' | 'rejected' | 'unknown' | 'filtered';
export type HeEngReserveRow = Record<string, unknown> & {
  _eng_reserve?: { version: 1; state: HeEngReserveContactState; refill_base_id?: string; settled_at?: string; dispatched_at?: string };
};

export function isHeEngReserveKey(value: string): boolean {
  return value.startsWith(HE_ENG_RESERVE_KEY_PREFIX);
}

export function heEngReserveEmail(row: Record<string, unknown>): string {
  return typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
}

export function heEngReserveRowAvailable(row: HeEngReserveRow): boolean {
  return row._eng_reserve?.version === 1 && row._eng_reserve.state === 'available';
}

/** Missing/corrupt markers never become available by default. */
export function heEngReserveAvailableRows(rows: readonly HeEngReserveRow[]): HeEngReserveRow[] {
  return rows.filter(heEngReserveRowAvailable);
}

/** Durable pre-dispatch manifest contains only the slice permitted by the cap. */
export function planHeEngReserveDispatch(input: {
  rows: readonly HeEngReserveRow[]; emails: ReadonlySet<string>; refillBaseId: string; now: string;
}): HeEngReserveRow[] {
  return input.rows.map((row) => heEngReserveRowAvailable(row) && input.emails.has(heEngReserveEmail(row))
    ? { ...row, _eng_reserve: { version: 1, state: 'dispatching', refill_base_id: input.refillBaseId, dispatched_at: input.now } }
    : row);
}

/**
 * Publish only a completed collection's actual reserve, lazily inside an
 * already-authorized refill. Idempotent inserts never reset an existing claim
 * or outcome. A failure aborts before new paid collection instead of buying
 * contacts while the prepared reserve cannot be read.
 */
export async function ensureHeEngRefillReserve(
  ctx: HeStageContext,
  input: {
    projectId: string;
    verticalId: string;
    oldestPreparedAt: string;
    keyOf: (columns: readonly string[]) => (row: Record<string, unknown>) => string;
    expiry: (rows: HeEngReserveRow[], preparedAtMs: number) => { expiresAtMs: number; release: string | null };
  },
): Promise<boolean> {
  let after: string | null = null;
  let hasPreparedReserve = false;
  for (let page = 0; page < 100; page += 1) {
    ctx.signal?.throwIfAborted();
    let query = ctx.supabase.from('he_bases')
      .select('id, columns, created_at, eng_collection_target:collect_info->eng_collection_target, eng_collection_pool:collect_info->eng_collection_pool')
      .eq('project_id', input.projectId).eq('vertical_id', input.verticalId)
      .gte('created_at', input.oldestPreparedAt)
      .eq('status', 'analyzed').not('collect_info->eng_collection_target', 'is', null);
    if (after) query = query.gt('id', after);
    const { data, error } = await query.order('id', { ascending: true }).limit(25);
    if (error) throw new Error(`ENG reserve could not be read: ${error.message}`);
    const bases = (data ?? []) as Array<Record<string, unknown>>;
    if (bases.length === 0) return hasPreparedReserve;
    for (const base of bases) {
      if (typeof base.id !== 'string' || !Array.isArray(base.columns)) throw new Error('ENG reserve: invalid source base');
      const checkpoint = readHeEngCollectionCheckpoint(base.eng_collection_target, base.eng_collection_pool);
      if (checkpoint.target.phase !== 'complete' && checkpoint.target.phase !== 'stopped') continue;
      if (checkpoint.reserveRows.length === 0) continue;
      hasPreparedReserve = true;
      const preparedAtMs = typeof base.created_at === 'string' ? Date.parse(base.created_at) : NaN;
      if (!Number.isFinite(preparedAtMs)) throw new Error('ENG reserve: missing preparation time');
      const columns = base.columns.filter((column): column is string => typeof column === 'string');
      const keyOf = input.keyOf(columns);
      const groups = new Map<string, HeEngReserveRow[]>();
      for (const row of checkpoint.reserveRows) {
        const key = keyOf(row);
        if (!key || !heEngReserveEmail(row)) throw new Error('ENG reserve: missing company or contact identity');
        const rows = groups.get(key) ?? [];
        rows.push({ ...row, _eng_reserve: { version: 1, state: 'available' } });
        groups.set(key, rows);
      }
      const now = new Date().toISOString();
      const records = [...groups].map(([key, rows]) => {
        const expiry = input.expiry(rows, preparedAtMs);
        const expired = expiry.release ?? (expiry.expiresAtMs <= Date.now() ? 'expired' : null);
        return {
          project_id: input.projectId, vertical_id: input.verticalId, source_base_id: base.id,
          company_key: `${HE_ENG_RESERVE_KEY_PREFIX}${key}`, lead_rows: rows, lead_columns: columns,
          prepared_at: new Date(preparedAtMs).toISOString(), expires_at: new Date(expiry.expiresAtMs).toISOString(),
          status: expired ? 'released' : 'pending', settled_at: expired ? now : null,
          settle_reason: expired, updated_at: now,
        };
      });
      for (let offset = 0; offset < records.length; offset += 100) {
        ctx.signal?.throwIfAborted();
        const { error: writeError } = await ctx.supabase.from('he_refill_carryover')
          .upsert(records.slice(offset, offset + 100), { onConflict: 'source_base_id,company_key', ignoreDuplicates: true });
        if (writeError) throw new Error(`ENG reserve could not be published: ${writeError.message}`);
      }
    }
    const last = bases[bases.length - 1].id;
    if (typeof last !== 'string' || (after !== null && last <= after)) throw new Error('ENG reserve: source cursor did not advance');
    after = last;
  }
  throw new Error('ENG reserve: source scan limit exceeded');
}

export interface HeEngReserveSettlement {
  rows: HeEngReserveRow[];
  status: 'pending' | 'sent' | 'dropped';
  reason: string | null;
  available: number;
}

/**
 * A different refill may release untouched stock only after every job for
 * the old owner is conclusively terminal. The version/owner CAS races safely
 * with its pre-dispatch manifest: whichever writes first fences the other.
 */
export async function recoverHeEngTerminalReserveClaims(
  ctx: HeStageContext,
  input: { projectId: string; verticalId: string; currentBaseId: string },
): Promise<void> {
  let after: string | null = null;
  const terminalOwners = new Map<string, boolean>();
  for (let page = 0; page < 100; page += 1) {
    let query = ctx.supabase.from('he_refill_carryover')
      .select('id, company_key, claimed_base_id, lead_rows, updated_at')
      .eq('project_id', input.projectId).eq('vertical_id', input.verticalId).eq('status', 'claimed')
      .neq('claimed_base_id', input.currentBaseId).like('company_key', HE_ENG_RESERVE_KEY_PATTERN);
    if (after) query = query.gt('id', after);
    const { data, error } = await query.order('id', { ascending: true }).limit(100);
    if (error) throw new Error(`ENG reserve recovery read failed: ${error.message}`);
    const claims = (data ?? []) as Array<Record<string, unknown>>;
    if (claims.length === 0) return;
    for (const claim of claims) {
      const owner = claim.claimed_base_id;
      if (typeof claim.id !== 'string' || typeof owner !== 'string' ||
          typeof claim.updated_at !== 'string' || !Number.isFinite(Date.parse(claim.updated_at)) || !Array.isArray(claim.lead_rows)) continue;
      if (!terminalOwners.has(owner)) {
        const { data: jobs, error: jobError } = await ctx.supabase.from('he_jobs')
          .select('status').eq('project_id', input.projectId).eq('stage', 'base_collect')
          .eq('payload->>base_id', owner).limit(100);
        // Missing, truncated, failed reads and unknown states prove nothing.
        terminalOwners.set(owner, !jobError && !!jobs?.length && jobs.length < 100 &&
          jobs.every((job) => ['done', 'failed', 'cancelled'].includes(String(job.status))));
      }
      if (!terminalOwners.get(owner)) continue;
      const rows = claim.lead_rows.filter((row): row is HeEngReserveRow => !!row && typeof row === 'object' && !Array.isArray(row));
      if (rows.length !== claim.lead_rows.length) continue;
      const now = new Date(Math.max(Date.now(), Date.parse(claim.updated_at) + 1)).toISOString();
      const outcome = planHeEngReserveSettlement({
        rows, refillBaseId: owner, now, reachedEmails: new Set(), acceptedEmails: new Set(), rejectedEmails: new Set(),
        keptEmails: null, heldEmails: new Set(), previousOutcomeUnknown: true, heldReason: 'letters_unfilled',
      });
      const { error: writeError } = await ctx.supabase.from('he_refill_carryover')
        .update({ lead_rows: outcome.rows, status: outcome.status, settle_reason: outcome.reason,
          claimed_base_id: outcome.status === 'pending' ? null : owner,
          claimed_at: null, settled_at: outcome.status === 'pending' ? null : now, updated_at: now })
        .eq('id', claim.id).eq('status', 'claimed').eq('claimed_base_id', owner).eq('updated_at', claim.updated_at);
      if (writeError) throw new Error(`ENG reserve recovery checkpoint failed: ${writeError.message}`);
    }
    const last = claims[claims.length - 1].id;
    if (typeof last !== 'string' || (after !== null && last <= after)) throw new Error('ENG reserve recovery cursor did not advance');
    after = last;
  }
  throw new Error('ENG reserve recovery scan limit exceeded');
}

/**
 * Per-address outcome, computed only after the provider result. Unknown
 * attempted addresses remain in the durable record but never return to the
 * available set. A cap or explicit temporary refusal leaves untouched stock.
 */
export function planHeEngReserveSettlement(input: {
  rows: readonly HeEngReserveRow[];
  refillBaseId: string;
  now: string;
  reachedEmails: ReadonlySet<string>;
  acceptedEmails: ReadonlySet<string>;
  rejectedEmails: ReadonlySet<string>;
  keptEmails: ReadonlySet<string> | null;
  heldEmails: ReadonlySet<string>;
  /** Only this attempt's durable manifest; older dispatching rows are uncertain. */
  currentDispatchEmails?: ReadonlySet<string>;
  previousOutcomeUnknown: boolean;
  heldReason: string;
}): HeEngReserveSettlement {
  let available = 0;
  let unheldAvailable = 0;
  const rows = input.rows.map((row): HeEngReserveRow => {
    const dispatching = row._eng_reserve?.version === 1 && row._eng_reserve.state === 'dispatching';
    if (!heEngReserveRowAvailable(row) && !dispatching) return row;
    const email = heEngReserveEmail(row);
    let state: HeEngReserveContactState = 'available';
    if (dispatching && (input.previousOutcomeUnknown || !input.currentDispatchEmails?.has(email))) state = 'unknown';
    // The previous attempt could not send rows absent from its manifest.
    // Do not discard them just because its daily reservation is still held.
    else if (input.previousOutcomeUnknown) state = 'available';
    else if (input.reachedEmails.has(email)) {
      state = input.acceptedEmails.has(email) ? 'accepted' : input.rejectedEmails.has(email) ? 'rejected' : 'unknown';
    } else if (input.keptEmails !== null && !input.keptEmails.has(email) && !input.heldEmails.has(email)) state = 'filtered';
    if (state === 'available') {
      available += 1;
      if (input.keptEmails === null || !input.heldEmails.has(email)) unheldAvailable += 1;
      return dispatching ? { ...row, _eng_reserve: { version: 1, state: 'available' } } : row;
    }
    return { ...row, _eng_reserve: { version: 1, state, refill_base_id: input.refillBaseId, settled_at: input.now } };
  });
  const attempted = rows.some((row) => row._eng_reserve?.state === 'accepted' || row._eng_reserve?.state === 'unknown');
  return {
    rows, available,
    status: available > 0 ? 'pending' : attempted ? 'sent' : 'dropped',
    reason: available > 0 ? unheldAvailable > 0 ? null : input.heldReason : attempted ? null : 'no_sendable_address',
  };
}
