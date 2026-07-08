import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/parsers/googleParsersRouteAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { encryptJsonAes256Gcm } from '@/lib/cryptoGcm';

export const dynamic = 'force-dynamic';

const PROXY_KEY = process.env.GOOGLEPARSERS_PROXY_ENCRYPTION_KEY ?? '';

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (auth.error) return auth.error;
  const { user, supabase } = auth;

  const { data: jobs, error } = await supabase
    .from('google_maps_jobs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ jobs: jobs ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  if (!supabaseAdmin) return jsonError('Service unavailable', 503);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const inputLinesRaw = Array.isArray(body.inputLines) ? (body.inputLines as unknown[]) : [];
  const inputLines = inputLinesRaw
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
  if (inputLines.length === 0) {
    return jsonError('inputLines is required and must be non-empty', 400);
  }

  const limitPerQuery = Number.isFinite(Number(body.limitPerQuery)) ? Number(body.limitPerQuery) : 100;
  const language = typeof body.language === 'string' && body.language.length > 0 ? body.language : 'ru';
  const region = typeof body.region === 'string' && body.region.length > 0 ? body.region : 'RU';
  const minDelayMs = Number.isFinite(Number(body.minDelayMs)) ? Number(body.minDelayMs) : 1200;
  const maxDelayMs = Number.isFinite(Number(body.maxDelayMs)) ? Number(body.maxDelayMs) : 2800;
  const enrichContacts = body.enrichContacts !== false;

  const proxiesRaw = Array.isArray(body.proxies) ? (body.proxies as unknown[]) : [];
  const proxies = proxiesRaw
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.trim())
    .filter(Boolean);

  let proxy_encrypted: string | null = null;
  if (proxies.length > 0) {
    if (!PROXY_KEY) return jsonError('Proxy encryption key not configured', 500);
    proxy_encrypted = encryptJsonAes256Gcm(proxies, PROXY_KEY);
  }

  const config = {
    inputLines,
    limitPerQuery,
    language,
    region,
    minDelayMs,
    maxDelayMs,
    enrichContacts,
  };

  const { data, error } = await supabaseAdmin
    .from('google_maps_jobs')
    .insert({
      user_id: user.id,
      status: 'queued',
      config,
      total_targets: inputLines.length,
      proxy_enabled: proxies.length > 0,
      proxy_encrypted,
    })
    .select('*')
    .single();

  if (error || !data) return jsonError(error?.message ?? 'Failed to create job', 500);
  return NextResponse.json({ job: data }, { status: 201 });
}
