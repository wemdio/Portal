import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { blockDemo } from '@/lib/auth/blockDemo';
import { encryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getClientTariffUsage, isClientToolAccessAllowed, isAwaitingFirstPayment, TOOL_ACCESS_DENIED_MESSAGE, AWAITING_PAYMENT_MESSAGE } from '@/lib/tariffs';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { data: jobs, error } = await supabase
    .from('yandex_maps_jobs')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const demo = await blockDemo(supabase, user.id);
  if (demo) return demo;

  try {
    const body = await req.json();
    const search_urls = Array.isArray(body?.search_urls) ? body.search_urls.filter((x: unknown) => typeof x === 'string').map((s: string) => s.trim()).filter(Boolean) : [];
    if (!search_urls.length) return jsonError('Missing or empty search_urls', 400);

    const max_results = Math.max(1, Math.min(5000, Number(body?.max_results ?? 5000) || 5000));
    const headless = body?.headless !== false;

    let tariffUsage: Awaited<ReturnType<typeof getClientTariffUsage>> | null = null;
    if (supabaseAdmin) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();

      if (profile?.role === 'client') {
        tariffUsage = await getClientTariffUsage(user.id);
        if (!isClientToolAccessAllowed(tariffUsage.status)) {
          return jsonError(TOOL_ACCESS_DENIED_MESSAGE, 403);
        }
        if (isAwaitingFirstPayment(tariffUsage)) {
          return jsonError(AWAITING_PAYMENT_MESSAGE, 403);
        }
        if (max_results > tariffUsage.usage.max_rows.remaining) {
          return jsonError(
            `Осталось ${tariffUsage.usage.max_rows.remaining.toLocaleString('ru-RU')} запросов по вашему тарифу. Уменьшите максимум результатов.`,
            400,
          );
        }
      }
    }

    const proxy = body?.proxy ?? null;
    const proxy_enabled = Boolean(proxy?.enabled);
    const proxy_protocol = (proxy?.protocol ?? 'http') as string;
    const proxy_host = typeof proxy?.host === 'string' ? proxy.host.trim() : '';
    const proxy_port = typeof proxy?.port === 'string' || typeof proxy?.port === 'number' ? String(proxy.port).trim() : '';

    let proxy_credentials_encrypted: string | null = null;
    if (proxy_enabled && proxy?.username && proxy?.password) {
      const key = (process.env.YANDEXMAPS_PROXY_ENCRYPTION_KEY ?? '').trim();
      if (!key) return jsonError('Proxy encryption key not configured', 500);
      proxy_credentials_encrypted = encryptJsonAes256Gcm({ username: String(proxy.username), password: String(proxy.password) }, key);
    }

    const { data: job, error } = await supabase
      .from('yandex_maps_jobs')
      .insert({
        user_id: user.id,
        status: 'pending',
        config: { search_urls, max_results, headless },
        progress_stage: 'pending',
        proxy_enabled,
        proxy_protocol: proxy_enabled ? proxy_protocol : null,
        proxy_host: proxy_enabled ? proxy_host : null,
        proxy_port: proxy_enabled ? proxy_port : null,
        proxy_credentials_encrypted,
      })
      .select()
      .single();

    if (error || !job) throw new Error(error?.message || 'Failed to create job');
    return NextResponse.json({ job, tariff_usage: tariffUsage });
  } catch (e) {
    console.error('Create yandexmaps job error:', e);
    return jsonError('Internal Server Error', 500);
  }
}

