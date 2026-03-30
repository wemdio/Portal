import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { filterAllowedIds } from '@/lib/clientAccess';
import { listLeads, listAllLeadLists } from '@/lib/instantly/client';
import type { LeadList } from '@/lib/instantly/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { cached } from '@/lib/clientCache';

export const dynamic = 'force-dynamic';

const LEAD_LISTS_TTL = 10 * 60 * 1000;
const MAX_LEADS_PER_CAMPAIGN = 500;
const MAX_PAGES_PER_CAMPAIGN = 5;

async function discoverLeadListIds(campaignIds: string[]): Promise<string[]> {
  const ids = new Set<string>();

  await Promise.all(
    campaignIds.map(async (cid) => {
      try {
        let after: string | undefined;
        for (let page = 0; page < MAX_PAGES_PER_CAMPAIGN; page++) {
          const res = await listLeads({
            campaign_id: cid,
            limit: 100,
            starting_after: after,
          });
          for (const lead of res.items ?? []) {
            if (lead.lead_list_id) ids.add(lead.lead_list_id);
          }
          after = res.next_starting_after || undefined;
          if (!after) break;
          if (ids.size > 0 && page >= 1) break;
          const itemsCount = (res.items?.length ?? 0);
          if (itemsCount === 0) break;
          const total = page * 100 + itemsCount;
          if (total >= MAX_LEADS_PER_CAMPAIGN) break;
        }
      } catch {
        // skip campaigns that fail
      }
    }),
  );

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

    const cacheKey = `instantly:lead-lists:discover:${allowedCampaignIds.sort().join(',')}`;
    const liveListIds = await cached(
      cacheKey,
      () => discoverLeadListIds(allowedCampaignIds),
      LEAD_LISTS_TTL,
    );

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

    const allLists = await cached<LeadList[]>(
      'instantly:lead-lists:all',
      () => listAllLeadLists(),
      LEAD_LISTS_TTL,
    );
    const items = allLists.filter((l) => allListIds.has(l.id));
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка загрузки';
    return jsonError(message, 500);
  }
}
