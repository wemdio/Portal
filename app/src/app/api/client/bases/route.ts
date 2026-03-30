import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { filterAllowedIds } from '@/lib/clientAccess';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { listAllCampaigns } from '@/lib/instantly/client';
import type { Campaign } from '@/lib/instantly/types';
import { cached } from '@/lib/clientCache';

export const dynamic = 'force-dynamic';

const CAMPAIGNS_TTL = 5 * 60 * 1000;

interface StoredLead {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  website: string | null;
  linkedin_url: string | null;
}

interface CampaignGroup {
  id: string;
  name: string;
  leads_count: number;
  leads_synced_at: string | null;
  leads: StoredLead[];
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId, accessRows } = result.auth;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const allowedCampaignIds = filterAllowedIds([], accessRows, 'campaign');
  if (allowedCampaignIds.length === 0) {
    return NextResponse.json({ campaigns: [] });
  }

  const search = req.nextUrl.searchParams.get('search')?.trim().toLowerCase() ?? '';

  try {
    const [campaignNames, leadsResult, syncResult] = await Promise.all([
      cached<Campaign[]>('instantly:campaigns:all', () => listAllCampaigns(), CAMPAIGNS_TTL),
      supabaseAdmin
        .from('client_campaign_leads')
        .select('campaign_id, email, first_name, last_name, company_name, website, linkedin_url')
        .eq('client_user_id', userId)
        .in('campaign_id', allowedCampaignIds),
      supabaseAdmin
        .from('client_instantly_access')
        .select('resource_id, leads_synced_at')
        .eq('client_user_id', userId)
        .eq('resource_type', 'campaign')
        .in('resource_id', allowedCampaignIds),
    ]);

    const nameMap = new Map(campaignNames.map((c) => [c.id, c.name]));
    const syncMap = new Map(
      (syncResult.data ?? []).map((r) => [r.resource_id as string, r.leads_synced_at as string | null]),
    );

    const allLeads = (leadsResult.data ?? []) as (StoredLead & { campaign_id: string })[];

    const grouped = new Map<string, StoredLead[]>();
    for (const lead of allLeads) {
      if (search) {
        const hay = [lead.email, lead.first_name, lead.last_name, lead.company_name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) continue;
      }
      let arr = grouped.get(lead.campaign_id);
      if (!arr) {
        arr = [];
        grouped.set(lead.campaign_id, arr);
      }
      arr.push({
        email: lead.email,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company_name: lead.company_name,
        website: lead.website,
        linkedin_url: lead.linkedin_url,
      });
    }

    const campaigns: CampaignGroup[] = allowedCampaignIds.map((cid) => ({
      id: cid,
      name: nameMap.get(cid) ?? cid,
      leads_count: grouped.get(cid)?.length ?? 0,
      leads_synced_at: syncMap.get(cid) ?? null,
      leads: grouped.get(cid) ?? [],
    }));

    const needsSync = campaigns.some((c) => !c.leads_synced_at);

    return NextResponse.json({ campaigns, needsSync });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка загрузки';
    return jsonError(message, 500);
  }
}
