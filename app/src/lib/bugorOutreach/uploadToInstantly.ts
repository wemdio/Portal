import {
  createLeads,
} from '@/lib/instantly/client';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import type { BugorLead, EmailStep } from './types';
import { createClient } from '@supabase/supabase-js';

const BATCH_SIZE = 100;

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return createClient(url, key);
}

interface CampaignIds {
  us: string | null;
  eu: string | null;
}

async function getCampaignIds(): Promise<CampaignIds> {
  const sb = getSupabase();
  const { data } = await sb
    .from('bugor_outreach_config')
    .select('key, value')
    .in('key', ['instantly_campaign_id_us', 'instantly_campaign_id_eu']);

  const ids: CampaignIds = { us: null, eu: null };
  for (const row of data ?? []) {
    if (row.key === 'instantly_campaign_id_us' && row.value) ids.us = row.value;
    if (row.key === 'instantly_campaign_id_eu' && row.value) ids.eu = row.value;
  }
  return ids;
}

function buildLeadPayload(
  lead: BugorLead,
  email: string,
  sequence: EmailStep[],
): LeadCreatePayload {
  const firstName = lead.founder_name?.split(' ')[0] ?? '';
  const lastName = lead.founder_name?.split(' ').slice(1).join(' ') ?? '';

  return {
    email,
    first_name: firstName,
    last_name: lastName,
    company_name: lead.company_name,
    website: lead.website ?? undefined,
    custom_variables: {
      signal_type: lead.signal_type,
      signal_detail: lead.signal_detail,
      priority: lead.priority,
      timing: lead.timing,
      niche: lead.niche,
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

async function uploadBatch(
  payloads: Array<{ leadId: string; payload: LeadCreatePayload }>,
  campaignId: string,
  regionLabel: string,
  sb: ReturnType<typeof getSupabase>,
  markedLeadIds: Set<string>,
  result: UploadResult,
) {
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
            .from('bugor_outreach_leads')
            .update({ instantly_uploaded: true })
            .eq('id', b.leadId);
        }
      }

      result.uploaded += batch.length;
      console.log(`[bugor-instantly] ${regionLabel} batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} emails`);
    } catch (err) {
      const msg = `${regionLabel} batch upload failed: ${err instanceof Error ? err.message : err}`;
      console.error(`[bugor-instantly] ${msg}`);
      result.errors.push(msg);
    }
  }
}

export async function uploadToInstantly(
  leads: BugorLead[],
): Promise<UploadResult> {
  const result: UploadResult = { uploaded: 0, skipped: 0, errors: [] };

  const eligible = leads.filter(
    (l) => l.emails_validated.length > 0 && l.email_sequence && l.email_sequence.length >= 3,
  );

  if (eligible.length === 0) {
    console.log('[bugor-instantly] No eligible leads to upload');
    return result;
  }

  const campaigns = await getCampaignIds();
  if (!campaigns.us && !campaigns.eu) {
    console.warn('[bugor-instantly] No campaign IDs configured.');
    result.errors.push('No campaign IDs configured (instantly_campaign_id_us / _eu)');
    return result;
  }

  const usPayloads: Array<{ leadId: string; payload: LeadCreatePayload }> = [];
  const euPayloads: Array<{ leadId: string; payload: LeadCreatePayload }> = [];

  for (const lead of eligible) {
    if (!lead.email_sequence || lead.email_sequence.length < 3) {
      result.skipped++;
      continue;
    }
    const target = lead.region === 'EU' ? euPayloads : usPayloads;
    for (const email of lead.emails_validated) {
      target.push({ leadId: lead.id, payload: buildLeadPayload(lead, email, lead.email_sequence) });
    }
  }

  const sb = getSupabase();
  const markedLeadIds = new Set<string>();

  if (usPayloads.length > 0 && campaigns.us) {
    console.log(`[bugor-instantly] Uploading ${usPayloads.length} US emails...`);
    await uploadBatch(usPayloads, campaigns.us, 'US', sb, markedLeadIds, result);
  } else if (usPayloads.length > 0) {
    console.warn('[bugor-instantly] US leads found but no US campaign configured');
    result.errors.push('US leads found but instantly_campaign_id_us not set');
  }

  if (euPayloads.length > 0 && campaigns.eu) {
    console.log(`[bugor-instantly] Uploading ${euPayloads.length} EU emails...`);
    await uploadBatch(euPayloads, campaigns.eu, 'EU', sb, markedLeadIds, result);
  } else if (euPayloads.length > 0) {
    console.warn('[bugor-instantly] EU leads found but no EU campaign configured');
    result.errors.push('EU leads found but instantly_campaign_id_eu not set');
  }

  console.log(`[bugor-instantly] Done: uploaded=${result.uploaded} emails (US=${usPayloads.length}, EU=${euPayloads.length}) for ${markedLeadIds.size} leads, skipped=${result.skipped}`);
  return result;
}
