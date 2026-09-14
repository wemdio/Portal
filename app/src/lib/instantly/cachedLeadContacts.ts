import type { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { Lead } from './types';

/** No cross-campaign/email fallback: a mailbox can be reused by other projects. */
export async function loadCachedLeadContacts(
  db: NonNullable<typeof supabaseInstantly>, campaignId: string, email: string,
): Promise<Lead[]> {
  const escapedEmail = email.trim().replace(/[\\%_]/g, '\\$&');
  const { data, error } = await db.from('client_campaign_leads')
    .select('id, email, campaign_id, first_name, last_name, company_name, website')
    .eq('campaign_id', campaignId)
    .ilike('email', escapedEmail)
    .order('synced_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  return (data ?? []) as Lead[];
}
