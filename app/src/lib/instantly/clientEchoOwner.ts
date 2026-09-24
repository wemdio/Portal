import type { SupabaseClient } from '@supabase/supabase-js';
import type { Email } from './types';
import type { ReplyOwnershipResolution } from './replyOwnershipResolver';
import { getBodyText } from './leadQualifier';
import { recipientMailboxIdentities } from '@/lib/clientCampaignReplies/participants';
import { resolveCampaignProjectOwner } from './campaignProjectOwnerResolver';

const normalizeText = (text: string) => text.split('\n').map(line => line.replace(/^\s*>+\s?/, ''))
  .join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
const subjectKey = (text: string) => text.replace(/^(?:(?:re|fw|fwd|ответ):\s*)+/iu, '').trim().toLowerCase();

/** Local proof for CLIENT-authored post-handoff replies only. Provider thread
 * ids can be reused across recipients, so never use them as identity. Failure
 * or incomplete evidence falls back to the normal ownership resolver. */
export async function resolveSentHandoffClientEcho(
  db: SupabaseClient, reply: Email,
): Promise<Extract<ReplyOwnershipResolution, { status: 'resolved' }> | null> {
  const sender = reply.from_address_email?.trim().toLowerCase();
  const mailbox = reply.eaccount?.trim().toLowerCase();
  const at = Date.parse(reply.timestamp_email ?? reply.timestamp_created ?? '');
  if (!sender || !mailbox || sender === mailbox || !Number.isFinite(at) || !reply.subject?.trim()) return null;
  const recipients = recipientMailboxIdentities(reply);
  if (!recipients.has(mailbox)) return null;
  const body = normalizeText(getBodyText(reply.body));
  const { data: handoffs, error } = await db.from('instantly_pending_handoffs')
    .select('qualification_id, campaign_id, client_email, draft_text, sent_at')
    .eq('eaccount', mailbox).eq('status', 'sent')
    .lte('sent_at', new Date(at).toISOString())
    .gte('sent_at', new Date(at - 30 * 24 * 60 * 60_000).toISOString())
    .order('sent_at', { ascending: false }).limit(51);
  if (error || !handoffs?.length || handoffs.length > 50) return null;
  const candidates = handoffs.filter(handoff => {
    const draft = normalizeText(handoff.draft_text ?? '');
    return handoff.campaign_id && draft.length >= 40 && body.includes(draft) &&
      String(handoff.client_email ?? '').split(/[,;\n]/u).some(email => email.trim().toLowerCase() === sender);
  });
  if (!candidates.length) return null;
  const { data: qualifications, error: lookupError } = await db.from('instantly_lead_qualifications')
    .select('id, campaign_id, qualified_project_id, qualified_project_owner_proven, lead_email, reply_subject')
    .in('id', candidates.map(handoff => handoff.qualification_id));
  if (lookupError) return null;
  const matches = (qualifications ?? []).filter(row => row.qualified_project_owner_proven === true &&
    row.qualified_project_id && row.lead_email?.toLowerCase() !== sender &&
    recipients.has(row.lead_email?.toLowerCase()) && subjectKey(row.reply_subject ?? '') === subjectKey(reply.subject!) &&
    candidates.some(handoff => handoff.qualification_id === row.id && handoff.campaign_id === row.campaign_id));
  const owners = new Set(matches.map(row => `${row.campaign_id}:${row.qualified_project_id}`));
  if (owners.size !== 1) return null;
  const match = matches[0];
  // Do not reuse historical proof after the campaign moved to another project.
  let live;
  try {
    live = await resolveCampaignProjectOwner(db, match.campaign_id);
  } catch {
    // The normal resolver owns the durable dependency-failure disposition.
    return null;
  }
  if (live.status !== 'resolved' || live.projectId !== match.qualified_project_id) return null;
  return { status: 'resolved', providerCampaignId: reply.campaign_id!,
    effectiveCampaignId: match.campaign_id, effectiveProjectId: match.qualified_project_id,
    corrected: match.campaign_id !== reply.campaign_id, context: null,
    mailboxVerified: false, conversationVerified: true,
    reason: 'exact client sender, recipient and quoted sent handoff proved client-side continuation' };
}
