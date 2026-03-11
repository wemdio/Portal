import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;

  const campaignId = new URL(req.url).searchParams.get('campaign_id');
  if (!campaignId) return jsonError('campaign_id обязателен', 400);

  const { data, error } = await auth.supabase
    .from('tg_outreach_accounts')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: true });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError('Неверный JSON', 400);
  }

  const campaignId = body.campaign_id as string;
  if (!campaignId) return jsonError('campaign_id обязателен', 400);

  const sessionName = (body.session_name as string)?.trim();
  if (!sessionName) return jsonError('session_name обязателен', 400);

  const apiId = Number(body.api_id);
  const apiHash = (body.api_hash as string)?.trim();
  if (!apiId || !apiHash) return jsonError('api_id и api_hash обязательны', 400);

  const { data, error } = await auth.supabase
    .from('tg_outreach_accounts')
    .insert({
      campaign_id: campaignId,
      session_name: sessionName,
      api_id: apiId,
      api_hash: apiHash,
      phone: (body.phone as string) ?? '',
      proxy_id: (body.proxy_id as string) || null,
      session_data: (body.session_data as string) ?? '',
      is_active: body.is_active !== false,
    })
    .select()
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}
