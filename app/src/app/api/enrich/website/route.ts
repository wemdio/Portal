import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { fetchAndExtract, normalizeUrl } from '@/lib/enrich/websiteParser';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  // --- Auth ---
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  // --- Parse body ---
  let body: { url?: string };
  try {
    body = (await req.json()) as { url?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const rawUrl = body.url;
  if (!rawUrl || typeof rawUrl !== 'string') {
    return jsonError('Missing required field: url', 400);
  }

  // --- Validate URL ---
  let normalized: string;
  try {
    normalized = normalizeUrl(rawUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Невалидный URL';
    return jsonError(message, 400);
  }

  // --- Fetch & extract ---
  try {
    const text = await fetchAndExtract(normalized, { timeout: 15_000 });
    return NextResponse.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось получить данные с сайта';
    return NextResponse.json({ text: '', error: message }, { status: 200 });
  }
}
