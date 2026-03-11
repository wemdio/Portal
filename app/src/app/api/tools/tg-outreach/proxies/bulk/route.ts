import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;

  let body: { campaign_id?: string; proxies_text?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError('Неверный JSON', 400);
  }

  const campaignId = body.campaign_id;
  if (!campaignId) return jsonError('campaign_id обязателен', 400);

  const lines = (body.proxies_text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return jsonError('Нет прокси для добавления', 400);

  const rows = lines.map((url, i) => ({
    campaign_id: campaignId,
    url,
    name: `Прокси ${i + 1}`,
    is_active: true,
  }));

  const { data, error } = await auth.supabase
    .from('tg_outreach_proxies')
    .insert(rows)
    .select();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ items: data ?? [], count: data?.length ?? 0 }, { status: 201 });
}
