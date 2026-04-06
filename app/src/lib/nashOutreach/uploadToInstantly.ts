import { createLeads } from '@/lib/instantly/client';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import { createClient } from '@supabase/supabase-js';
import type { NashLead, EmailStep } from './types';

const BATCH_SIZE = 100;

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return createClient(url, key);
}

async function getCampaignId(): Promise<string | null> {
  const sb = getSupabase();
  const { data } = await sb
    .from('nash_outreach_config')
    .select('key, value')
    .eq('key', 'instantly_campaign_id')
    .single();

  return data?.value ?? null;
}

function buildLeadPayload(
  lead: NashLead,
  email: string,
  sequence: EmailStep[],
): LeadCreatePayload {
  return {
    email,
    first_name: '',
    last_name: '',
    company_name: lead.company_name,
    website: lead.website ?? undefined,
    custom_variables: {
      signal_type: lead.signal_type,
      signal_detail: lead.signal_detail,
      priority: lead.priority,
      niche: lead.niche,
      city: lead.city ?? '',
      step1_subject: sequence[0]?.subject ?? '',
      step1_body: sequence[0]?.body ?? '',
      step2_subject: sequence[1]?.subject ?? '',
      step2_body: sequence[1]?.body ?? '',
      step3_subject: sequence[2]?.subject ?? '',
      step3_body: sequence[2]?.body ?? '',
    },
  };
}

export interface UploadResult {
  uploaded: number;
  skipped: number;
  errors: string[];
}

export async function uploadNashToInstantly(leads: NashLead[]): Promise<UploadResult> {
  const result: UploadResult = { uploaded: 0, skipped: 0, errors: [] };

  const eligible = leads.filter(
    (l) => l.emails_validated.length > 0 && l.email_sequence && l.email_sequence.length >= 3,
  );

  if (eligible.length === 0) {
    console.log('[nash-instantly] No eligible leads to upload');
    return result;
  }

  const campaignId = await getCampaignId();
  if (!campaignId) {
    console.warn('[nash-instantly] No campaign ID configured (nash_outreach_config.instantly_campaign_id)');
    result.errors.push('No campaign ID configured');
    return result;
  }

  const sb = getSupabase();
  const payloads: Array<{ leadId: string; payload: LeadCreatePayload }> = [];

  for (const lead of eligible) {
    if (!lead.email_sequence || lead.email_sequence.length < 3) {
      result.skipped++;
      continue;
    }
    for (const email of lead.emails_validated) {
      payloads.push({ leadId: lead.id, payload: buildLeadPayload(lead, email, lead.email_sequence) });
    }
  }

  const markedLeadIds = new Set<string>();

  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    const batch = payloads.slice(i, i + BATCH_SIZE);
    try {
      await createLeads(
        batch.map((b) => b.payload),
        { campaign_id: campaignId, skip_if_in_campaign: true },
      );

      for (const b of batch) {
        if (!markedLeadIds.has(b.leadId)) {
          markedLeadIds.add(b.leadId);
          await sb
            .from('nash_outreach_leads')
            .update({ instantly_uploaded: true })
            .eq('id', b.leadId);
        }
      }

      result.uploaded += batch.length;
      console.log(`[nash-instantly] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} emails`);
    } catch (err) {
      const msg = `Batch upload failed: ${err instanceof Error ? err.message : err}`;
      console.error(`[nash-instantly] ${msg}`);
      result.errors.push(msg);
    }
  }

  console.log(`[nash-instantly] Upload complete: ${result.uploaded} uploaded, ${result.skipped} skipped`);
  return result;
}
