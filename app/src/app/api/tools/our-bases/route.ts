import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseInstantly as supabaseAdmin } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

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
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const search = req.nextUrl.searchParams.get('search')?.trim().toLowerCase() ?? '';

  try {
    const [accessResult, catalogResult] = await Promise.all([
      supabaseAdmin
        .from('client_instantly_access')
        .select('resource_id, leads_synced_at')
        .eq('resource_type', 'campaign'),
      supabaseAdmin
        .from('instantly_campaign_catalog')
        .select('id, name'),
    ]);

    const allCampaignIds = [
      ...new Set((accessResult.data ?? []).map((r) => r.resource_id as string)),
    ];

    if (allCampaignIds.length === 0) {
      return NextResponse.json({ campaigns: [] });
    }

    const nameMap = new Map(
      (catalogResult.data ?? []).map((c) => [c.id as string, c.name as string]),
    );

    const syncMap = new Map<string, string | null>();
    for (const r of accessResult.data ?? []) {
      const cid = r.resource_id as string;
      const syncAt = r.leads_synced_at as string | null;
      const existing = syncMap.get(cid);
      if (!existing || (syncAt && syncAt > existing)) {
        syncMap.set(cid, syncAt);
      }
    }

    const leadsResult = await supabaseAdmin
      .from('client_campaign_leads')
      .select('campaign_id, email, first_name, last_name, company_name, website, linkedin_url')
      .in('campaign_id', allCampaignIds);

    const allLeads = (leadsResult.data ?? []) as (StoredLead & { campaign_id: string })[];

    const seen = new Map<string, Set<string>>();
    const grouped = new Map<string, StoredLead[]>();

    for (const lead of allLeads) {
      if (search) {
        const hay = [lead.email, lead.first_name, lead.last_name, lead.company_name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) continue;
      }

      let emailSet = seen.get(lead.campaign_id);
      if (!emailSet) {
        emailSet = new Set();
        seen.set(lead.campaign_id, emailSet);
      }
      if (emailSet.has(lead.email)) continue;
      emailSet.add(lead.email);

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

    const campaigns: CampaignGroup[] = allCampaignIds
      .map((cid) => ({
        id: cid,
        name: nameMap.get(cid) ?? cid,
        leads_count: grouped.get(cid)?.length ?? 0,
        leads_synced_at: syncMap.get(cid) ?? null,
        leads: grouped.get(cid) ?? [],
      }))
      .filter((c) => c.leads_count > 0 || !search);

    return NextResponse.json({ campaigns });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка загрузки';
    return jsonError(message, 500);
  }
}
