import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { filterAllowedIds } from '@/lib/clientAccess';
import { listAllLeads, listAllCampaigns, getCampaignAnalytics } from '@/lib/instantly/client';
import type { Campaign, CampaignAnalytics } from '@/lib/instantly/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { cached, invalidate } from '@/lib/clientCache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CAMPAIGNS_TTL = 5 * 60 * 1000;
const BATCH_SIZE = 500;

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId, accessRows } = result.auth;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const allowedCampaignIds = filterAllowedIds([], accessRows, 'campaign');
  if (allowedCampaignIds.length === 0) {
    return NextResponse.json({ campaigns: [], synced: 0 });
  }

  try {
    let totalSynced = 0;

    const analytics = await cached<CampaignAnalytics[]>(
      'instantly:analytics:all',
      () => getCampaignAnalytics({}).catch(() => [] as CampaignAnalytics[]),
      CAMPAIGNS_TTL,
    );
    const leadsCountMap = new Map(
      analytics.map((a) => [a.campaign_id, Number(a.leads_count ?? 0)]),
    );

    for (const campaignId of allowedCampaignIds) {
      if ((leadsCountMap.get(campaignId) ?? 0) === 0) {
        await supabaseAdmin
          .from('client_instantly_access')
          .update({ leads_synced_at: new Date().toISOString() })
          .eq('client_user_id', userId)
          .eq('resource_type', 'campaign')
          .eq('resource_id', campaignId);
        continue;
      }

      const leads = await listAllLeads(campaignId, 10_000);

      if (leads.length > 0) {
        const rows = leads.map((l) => ({
          client_user_id: userId,
          campaign_id: campaignId,
          email: l.email,
          first_name: l.first_name ?? null,
          last_name: l.last_name ?? null,
          company_name: l.company_name ?? null,
          website: l.website ?? null,
          linkedin_url: l.linkedin_url ?? null,
          synced_at: new Date().toISOString(),
        }));

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          await supabaseAdmin
            .from('client_campaign_leads')
            .upsert(batch, {
              onConflict: 'client_user_id,campaign_id,email',
              ignoreDuplicates: false,
            });
        }

        totalSynced += leads.length;
      }

      await supabaseAdmin
        .from('client_instantly_access')
        .update({ leads_synced_at: new Date().toISOString() })
        .eq('client_user_id', userId)
        .eq('resource_type', 'campaign')
        .eq('resource_id', campaignId);
    }

    invalidate('instantly:campaigns:all');

    const campaignNames = await cached<Campaign[]>(
      'instantly:campaigns:all',
      () => listAllCampaigns(),
      CAMPAIGNS_TTL,
    );
    const nameMap = new Map(campaignNames.map((c) => [c.id, c.name]));

    const { data: allLeads } = await supabaseAdmin
      .from('client_campaign_leads')
      .select('campaign_id, email, first_name, last_name, company_name, website, linkedin_url')
      .eq('client_user_id', userId)
      .in('campaign_id', allowedCampaignIds);

    const grouped = new Map<string, typeof allLeads>();
    for (const lead of allLeads ?? []) {
      const cid = lead.campaign_id as string;
      let arr = grouped.get(cid);
      if (!arr) {
        arr = [];
        grouped.set(cid, arr);
      }
      arr.push(lead);
    }

    const campaigns = allowedCampaignIds.map((cid) => ({
      id: cid,
      name: nameMap.get(cid) ?? cid,
      leads_count: grouped.get(cid)?.length ?? 0,
      leads_synced_at: new Date().toISOString(),
      leads: (grouped.get(cid) ?? []).map((l) => ({
        email: l.email,
        first_name: l.first_name,
        last_name: l.last_name,
        company_name: l.company_name,
        website: l.website,
        linkedin_url: l.linkedin_url,
      })),
    }));

    return NextResponse.json({ campaigns, needsSync: false, synced: totalSynced });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка синхронизации';
    return jsonError(message, 500);
  }
}
