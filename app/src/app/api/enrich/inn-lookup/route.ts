import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { fetchInnFromWebsite } from '@/lib/enrich/websiteParser';
import { findByInn, hasDadataKey } from '@/lib/enrich/dadataClient';

export const dynamic = 'force-dynamic';
const MAX_ITEMS = 5;

type RequestItem = { url?: string };
type ResultItem = {
  inn: string | null;
  companyName: string | null;
  error?: string;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  let body: { items?: RequestItem[] };
  try {
    body = (await req.json()) as { items?: RequestItem[] };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return jsonError('Missing or empty required field: items', 400);
  }
  if (items.length > MAX_ITEMS) {
    return jsonError(`Maximum ${MAX_ITEMS} items per request`, 400);
  }

  const results: ResultItem[] = [];

  for (const item of items) {
    const url = typeof item.url === 'string' ? item.url.trim() : '';

    if (!url) {
      results.push({ inn: null, companyName: null, error: 'empty URL' });
      continue;
    }

    try {
      const inn = await fetchInnFromWebsite(url, { timeout: 15_000 });
      if (!inn) {
        console.warn(`[inn-lookup] ${url} — no INN found on site`);
        results.push({ inn: null, companyName: null, error: 'no INN found on site' });
        continue;
      }
      let companyName: string | null = null;
      if (hasDadataKey()) {
        try {
          const suggestion = await findByInn(inn);
          companyName = suggestion?.data.name?.short_with_opf ?? suggestion?.value ?? null;
        } catch (err) {
          console.warn(`[inn-lookup] DaData lookup failed for ${inn}:`, (err as Error).message);
        }
      }
      results.push({ inn, companyName });
    } catch (err) {
      const msg = (err as Error).message || 'unknown error';
      console.warn(`[inn-lookup] ${url} — ${msg}`);
      results.push({ inn: null, companyName: null, error: msg });
    }
  }

  return NextResponse.json({ results });
}
