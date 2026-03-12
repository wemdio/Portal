import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { fetchAndExtract, extractInnFromText, normalizeUrl } from '@/lib/enrich/websiteParser';

export const dynamic = 'force-dynamic';

const MAX_URLS_PER_REQUEST = 10;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  let body: { urls?: string[] };
  try {
    body = (await req.json()) as { urls?: string[] };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const rawUrls = body.urls;
  if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
    return jsonError('Missing or empty required field: urls (array of strings)', 400);
  }
  if (rawUrls.length > MAX_URLS_PER_REQUEST) {
    return jsonError(`Maximum ${MAX_URLS_PER_REQUEST} URLs per request`, 400);
  }

  const results: Array<{ url: string; inn: string | null }> = [];
  const processed = new Set<string>();

  for (const raw of rawUrls) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!url) continue;

    let key: string;
    try {
      key = normalizeUrl(url);
    } catch {
      results.push({ url, inn: null });
      continue;
    }

    if (processed.has(key)) {
      const existing = results.find((r) => normalizeUrl(r.url) === key);
      results.push({ url, inn: existing?.inn ?? null });
      continue;
    }
    processed.add(key);

    try {
      const text = await fetchAndExtract(key, { timeout: 15_000 });
      const inn = extractInnFromText(text);
      results.push({ url, inn });
    } catch {
      results.push({ url, inn: null });
    }
  }

  return NextResponse.json({ results });
}
