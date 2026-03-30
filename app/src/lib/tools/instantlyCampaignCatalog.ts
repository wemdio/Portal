import 'server-only';

import type { Campaign } from '@/lib/instantly/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  iterateInstantlyCampaignPages,
  type InstantlyCampaignItem,
} from '@/lib/tools/autoReportBuilder';

/** Интервал, после которого фоново перезапрашиваем каталог у Instantly (мс). */
export const INSTANTLY_CATALOG_STALE_MS = 12 * 60 * 1000;

const NAME_MAX_LEN = 2000;

function sortCampaigns(a: InstantlyCampaignItem, b: InstantlyCampaignItem): number {
  const at = a.timestamp_created ?? a.timestamp_updated ?? '';
  const bt = b.timestamp_created ?? b.timestamp_updated ?? '';
  const an = at ? Date.parse(at) : NaN;
  const bn = bt ? Date.parse(bt) : NaN;
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return bn - an;
  if (at && bt && at !== bt) return bt.localeCompare(at);
  return (b.name ?? '').localeCompare(a.name ?? '', 'ru');
}

export function isCatalogStale(lastSyncedAtIso: string | null, nowMs = Date.now()): boolean {
  if (!lastSyncedAtIso) return true;
  const t = Date.parse(lastSyncedAtIso);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > INSTANTLY_CATALOG_STALE_MS;
}

type CatalogRow = {
  id: string;
  name: string;
  status: number | null;
  timestamp_created: string | null;
  timestamp_updated: string | null;
  synced_at: string;
};

/**
 * Читает кэш каталога из БД. Без service role возвращает пусто (вызывающий делает fallback на API).
 */
export async function readInstantlyCampaignCatalog(): Promise<{
  campaigns: InstantlyCampaignItem[];
  lastSyncedAt: string | null;
}> {
  if (!supabaseAdmin) {
    return { campaigns: [], lastSyncedAt: null };
  }

  const PAGE_SIZE = 1000;
  const allRows: CatalogRow[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('instantly_campaign_catalog')
      .select('id,name,status,timestamp_created,timestamp_updated,synced_at')
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(error.message);
    if (!data?.length) break;

    allRows.push(...(data as CatalogRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (!allRows.length) {
    return { campaigns: [], lastSyncedAt: null };
  }

  let maxSyncMs = 0;
  const campaigns: InstantlyCampaignItem[] = [];

  for (const raw of allRows) {
    if (raw.synced_at) {
      const m = Date.parse(raw.synced_at);
      if (Number.isFinite(m) && m > maxSyncMs) maxSyncMs = m;
    }
    campaigns.push({
      id: raw.id,
      name: raw.name ?? '',
      status: raw.status ?? undefined,
      timestamp_created: raw.timestamp_created ?? undefined,
      timestamp_updated: raw.timestamp_updated ?? undefined,
    });
  }

  campaigns.sort(sortCampaigns);

  return {
    campaigns,
    lastSyncedAt: maxSyncMs > 0 ? new Date(maxSyncMs).toISOString() : null,
  };
}

/**
 * Полная синхронизация с Instantly: постранично upsert, затем удаление строк не из этого прохода.
 */
export async function syncInstantlyCampaignCatalog(apiKey: string): Promise<{
  pages: number;
  rows: number;
}> {
  if (!supabaseAdmin) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY не настроен — синхронизация каталога недоступна');
  }

  const syncMarker = new Date().toISOString();
  let pages = 0;
  let rows = 0;

  for await (const page of iterateInstantlyCampaignPages(apiKey)) {
    pages += 1;
    const batch = page.map((c) => ({
      id: c.id,
      name: String(c.name ?? '').slice(0, NAME_MAX_LEN),
      status: typeof c.status === 'number' ? c.status : null,
      timestamp_created: c.timestamp_created ?? null,
      timestamp_updated: c.timestamp_updated ?? null,
      synced_at: syncMarker,
    }));

    rows += batch.length;
    const { error } = await supabaseAdmin.from('instantly_campaign_catalog').upsert(batch, {
      onConflict: 'id',
    });
    if (error) {
      throw new Error(error.message);
    }
  }

  // Кампании, которых больше нет в Instantly (удалены в UI Instantly или API), исчезают из каталога.
  const { error: delError } = await supabaseAdmin
    .from('instantly_campaign_catalog')
    .delete()
    .lt('synced_at', syncMarker);

  if (delError) {
    throw new Error(delError.message);
  }

  return { pages, rows };
}

/**
 * Запись/обновление одной кампании в каталоге автоотчётов после операций через портал (создание, PATCH, pause/activate).
 * Не бросает — только логирует, чтобы сбой БД не ломал ответ Instantly.
 */
export async function upsertInstantlyCatalogFromCampaign(
  campaign: Pick<Campaign, 'id' | 'name' | 'status'> &
    Partial<Pick<Campaign, 'timestamp_created' | 'timestamp_updated'>>,
): Promise<void> {
  if (!supabaseAdmin) return;

  const row = {
    id: campaign.id,
    name: String(campaign.name ?? '').slice(0, NAME_MAX_LEN),
    status: typeof campaign.status === 'number' ? campaign.status : null,
    timestamp_created: campaign.timestamp_created ?? null,
    timestamp_updated: campaign.timestamp_updated ?? null,
    synced_at: new Date().toISOString(),
  };

  const { error } = await supabaseAdmin.from('instantly_campaign_catalog').upsert(row, {
    onConflict: 'id',
  });
  if (error) {
    console.error('[instantly-catalog] upsert from portal campaign failed', error.message);
  }
}

/** Удаление строки каталога после DELETE кампании через API портала. */
export async function deleteInstantlyCatalogCampaignById(id: string): Promise<void> {
  if (!supabaseAdmin) return;

  const { error } = await supabaseAdmin.from('instantly_campaign_catalog').delete().eq('id', id);
  if (error) {
    console.error('[instantly-catalog] delete by id failed', error.message);
  }
}
