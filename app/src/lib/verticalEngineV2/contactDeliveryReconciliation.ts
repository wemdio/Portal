import type { SupabaseClient } from '@supabase/supabase-js';
import { getCampaign, listLeads } from '@/lib/instantly/client';
import { launchMailboxScopesEqual } from './launchPortfolio';

type Claim = { token: string; email: string; campaign_id: string; account_id: string; mailbox_ids: string[] };
const PAGE_SIZE = 100;

function parseClaim(data: unknown): Claim | null {
  if (data === null) return null;
  const row = data as Claim;
  if (!row || ['token', 'email', 'campaign_id', 'account_id'].some((key) =>
    typeof row[key as keyof Claim] !== 'string' || !(row[key as keyof Claim] as string).trim()) ||
    !Array.isArray(row.mailbox_ids) || !row.mailbox_ids.length || row.mailbox_ids.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('Invalid contact reconciliation claim');
  }
  return row;
}

/** Only exact normalized email + campaign can prove presence. Absence needs
 * every page of a valid, bounded response to the explicit contacts filter. */
async function findMembership(claim: Claim, deps: { getCampaign: typeof getCampaign; listLeads: typeof listLeads }): Promise<string | null> {
  const options = { accountId: claim.account_id, timeoutMs: 10_000, timeoutIncludesBody: true, retryRateLimits: false };
  const live = await deps.getCampaign(claim.campaign_id, options);
  if (!live || live.id !== claim.campaign_id || !launchMailboxScopesEqual(live.email_list, claim.mailbox_ids)) {
    throw new Error('Live campaign identity or sender scope changed');
  }
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  const email = claim.email.trim().toLowerCase();
  for (let page = 0; page < 5; page += 1) {
    const result = await deps.listLeads({ campaign_id: claim.campaign_id, contacts: [email], limit: PAGE_SIZE,
      ...(cursor ? { starting_after: cursor } : {}) }, options);
    if (!result || !Array.isArray(result.items) || result.items.length > PAGE_SIZE) throw new Error('Incomplete lead search response');
    let match: string | null = null;
    for (const lead of result.items) {
      if (!lead || typeof lead.id !== 'string' || !lead.id.trim() || typeof lead.email !== 'string' || !lead.email.trim() ||
        (lead.campaign ?? lead.campaign_id) !== claim.campaign_id ||
        (lead.campaign != null && lead.campaign_id != null && lead.campaign !== lead.campaign_id) || ids.has(lead.id)) {
        throw new Error('Unverified lead identity or campaign scope');
      }
      ids.add(lead.id);
      if (lead.email.trim().toLowerCase() === email) match = lead.id;
    }
    // Exact presence needs no inference about the rest of the result set.
    if (match) return match;
    const next = result.next_starting_after;
    if (next == null || next === '') {
      if (result.items.length === PAGE_SIZE) throw new Error('Full lead search page has no cursor');
      return null;
    }
    if (typeof next !== 'string' || !next.trim() || cursors.has(next) || result.items.length === 0) {
      throw new Error('Invalid lead search pagination');
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error('Lead search pagination budget exceeded');
}

/** Read-only provider recovery. DB claims/CAS and separate evidence records
 * survive restarts; only DB may resolve a row or release its existing quota. */
export async function reconcileContactDeliveries(input: {
  portalDb: SupabaseClient;
  veProjectId: string;
  shouldStop?: () => boolean;
  deps?: { getCampaign: typeof getCampaign; listLeads: typeof listLeads };
}): Promise<{ accepted: number; released: number; errors: string[] }> {
  const deps = input.deps ?? { getCampaign, listLeads };
  const result = { accepted: 0, released: 0, errors: [] as string[] };
  const deadline = Date.now() + 60_000;
  for (let count = 0; count < 50 && Date.now() < deadline && !input.shouldStop?.(); count += 1) {
    const { data, error } = await input.portalDb.rpc('ve_claim_contact_delivery_reconciliation', { p_ve_project_id: input.veProjectId });
    if (error) throw new Error(`Contact reconciliation claim failed: ${error.message}`);
    const claim = parseClaim(data);
    if (!claim) break;
    let providerLeadId: string | null = null;
    let absent = false;
    let problem: string | null = null;
    try {
      providerLeadId = await findMembership(claim, deps);
      absent = providerLeadId === null;
    } catch (error) {
      problem = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      result.errors.push(`${claim.campaign_id}: ${problem}`);
    }
    const { data: finished, error: finishError } = await input.portalDb.rpc('ve_finish_contact_delivery_reconciliation', {
      p_token: claim.token, p_provider_lead_id: providerLeadId, p_absent: absent, p_error: problem,
    });
    if (finishError || !finished || !['present', 'released', 'missing', 'inconclusive'].includes(finished.status)) {
      throw new Error(`Contact reconciliation save failed: ${finishError?.message ?? 'invalid result'}`);
    }
    if (finished.replayed !== true && finished.status === 'present') result.accepted += 1;
    if (finished.replayed !== true && finished.status === 'released') result.released += 1;
    // An API outage should not consume the workspace read budget for every row.
    if (problem) break;
  }
  return result;
}
