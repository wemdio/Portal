import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { flattenHhAreas, searchHhAreas, type HhAreaHit, type HhAreaNode } from '@/lib/parsers/hhArchive/hhAreasLive';
import { searchRegions } from '@/lib/parsers/hhArchive/regions';

export const dynamic = 'force-dynamic';

export type HhAreasResponse = {
  items: HhAreaHit[];
  /** 'hh' = live HH dictionary; 'static' = curated fallback (HH unreachable). */
  source: 'hh' | 'static';
};

// Module-level cache of the flattened HH areas tree (~14k nodes). One fetch per
// 24h serves every keystroke across all clients — no per-request HH call.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let cache: { flat: HhAreaHit[]; at: number } | null = null;

async function loadAreas(): Promise<HhAreaHit[] | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.flat;
  try {
    const res = await fetch('https://api.hh.ru/areas/113', {
      headers: { 'User-Agent': 'polza-portal/areas-picker' },
    });
    if (!res.ok) return cache?.flat ?? null;
    const root = (await res.json()) as HhAreaNode;
    const flat = flattenHhAreas(root);
    if (flat.length > 0) cache = { flat, at: Date.now() };
    return flat.length > 0 ? flat : (cache?.flat ?? null);
  } catch {
    // Network/HH failure: serve stale cache if we have it, else null → fallback.
    return cache?.flat ?? null;
  }
}

/** Search the HH areas dictionary by query. Auth-gated (client portal). */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 2) return NextResponse.json({ items: [], source: 'hh' } satisfies HhAreasResponse);

  const flat = await loadAreas();
  if (flat) {
    return NextResponse.json({ items: searchHhAreas(flat, q, 25), source: 'hh' } satisfies HhAreasResponse);
  }

  // HH unreachable and nothing cached → degrade to the curated static list so
  // the picker still works (it just won't have the long tail of small cities).
  const items: HhAreaHit[] = searchRegions(q, 25).map((r) => ({ id: r.id, name: r.name, region: '' }));
  return NextResponse.json({ items, source: 'static' } satisfies HhAreasResponse);
}
