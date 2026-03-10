import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;

  const campaignId = new URL(req.url).searchParams.get('campaign_id');
  if (!campaignId) return jsonError('campaign_id обязателен', 400);

  const { data, error } = await auth.supabase
    .from('tg_outreach_proxies')
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

  const url = (body.url as string)?.trim();
  if (!url) return jsonError('url обязателен', 400);

  const { data, error } = await auth.supabase
    .from('tg_outreach_proxies')
    .insert({
      campaign_id: campaignId,
      url,
      name: (body.name as string) ?? '',
      is_active: body.is_active !== false,
    })
    .select()
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;

  const campaignId = new URL(req.url).searchParams.get('campaign_id');
  if (!campaignId) return jsonError('campaign_id обязателен', 400);

  const { error } = await auth.supabase
    .from('tg_outreach_proxies')
    .delete()
    .eq('campaign_id', campaignId);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}
