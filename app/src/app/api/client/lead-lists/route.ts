import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { filterAllowedIds } from '@/lib/clientAccess';
import { listLeads, listAllLeadLists } from '@/lib/instantly/client';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

async function discoverLeadListIds(campaignIds: string[]): Promise<string[]> {
  const ids = new Set<string>();
  const pages = await Promise.all(
    campaignIds.map((cid) =>
      listLeads({ campaign_id: cid, limit: 100 }).catch(() => ({ items: [] as { lead_list_id?: string | null }[] })),
    ),
  );
  for (const page of pages) {
    for (const lead of page.items ?? []) {
      if (lead.lead_list_id) ids.add(lead.lead_list_id);
    }
  }
  return [...ids];
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId, accessRows } = result.auth;

  const allowedCampaignIds = filterAllowedIds([], accessRows, 'campaign');
  if (allowedCampaignIds.length === 0) {
    return NextResponse.json({ items: [] });
  }

  try {
    const storedListIds = new Set(
      accessRows
        .filter((r) => r.resource_type === 'lead_list')
        .map((r) => r.resource_id),
    );

    const liveListIds = await discoverLeadListIds(allowedCampaignIds);

    const newIds = liveListIds.filter((id) => !storedListIds.has(id));
    if (newIds.length > 0 && supabaseAdmin) {
      const rows = newIds.map((id) => ({
        client_user_id: userId,
        resource_type: 'lead_list' as const,
        resource_id: id,
        created_by: userId,
      }));
      void supabaseAdmin
        .from('client_instantly_access')
        .upsert(rows, { onConflict: 'client_user_id,resource_type,resource_id', ignoreDuplicates: true });
    }

    const allListIds = new Set([...storedListIds, ...liveListIds]);
    if (allListIds.size === 0) {
      return NextResponse.json({ items: [] });
    }

    const allLists = await listAllLeadLists();
    const items = allLists.filter((l) => allListIds.has(l.id));
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка загрузки';
    return jsonError(message, 500);
  }
}
