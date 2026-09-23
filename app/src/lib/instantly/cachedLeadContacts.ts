import type { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { Lead } from './types';

/** No cross-campaign/email fallback: a mailbox can be reused by other projects. */
export async function loadCachedLeadContacts(
  db: NonNullable<typeof supabaseInstantly>, campaignId: string, email: string,
): Promise<Lead[]> {
  const escapedEmail = email.trim().replace(/[\\%_]/g, '\\$&');
  const { data, error } = await db.from('client_campaign_leads')
    .select('id, email, campaign_id, first_name, last_name, company_name, phone, website')
    .eq('campaign_id', campaignId)
    .ilike('email', escapedEmail)
    .order('synced_at', { ascending: false })
    .limit(10);
  // App and DB can be deployed separately. Keep qualification working until
  // the phone-cache migration has been applied to the Instantly DB.
  if (error && /phone/i.test(error.message ?? '') &&
    (error.code === '42703' || error.code === 'PGRST204')) {
    const fallback = await db.from('client_campaign_leads')
      .select('id, email, campaign_id, first_name, last_name, company_name, website')
      .eq('campaign_id', campaignId)
      .ilike('email', escapedEmail)
      .order('synced_at', { ascending: false })
      .limit(10);
    if (fallback.error) throw new Error(fallback.error.message);
    return (fallback.data ?? []) as Lead[];
  }
  if (error) throw new Error(error.message);
  return (data ?? []) as Lead[];
}
