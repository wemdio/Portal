/**
 * Optional DaData enrichment — only used when INN is found on the company website.
 * NOT part of the main pipeline flow.
 */
import { findByInn, hasDadataKey } from '@/lib/enrich/dadataClient';
import { fetchInnFromWebsite } from '@/lib/enrich/websiteParser';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function tryEnrichWithDadata(
  leadId: string,
  website: string | null,
): Promise<void> {
  if (!website || !hasDadataKey() || !supabaseAdmin) return;

  try {
    const inn = await fetchInnFromWebsite(website);
    if (!inn) return;

    const result = await findByInn(inn);
    if (!result) return;

    await supabaseAdmin
      .from('nash_outreach_leads')
      .update({ inn, raw_data: { dadata: result } })
      .eq('id', leadId);

    console.log(`[nash-dadata] Enriched ${leadId} with INN ${inn}`);
  } catch {
    // non-critical
  }
}
