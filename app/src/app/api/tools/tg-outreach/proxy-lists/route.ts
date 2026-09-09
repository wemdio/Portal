import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxy-lists.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const campaignId = new URL(req.url).searchParams.get('campaign_id');
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const { data, error } = await auth.supabase
        .from('tg_outreach_proxy_lists')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: true });

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ items: data ?? [] });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxy-lists.create' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const campaignId = (body.campaign_id as string)?.trim();
      if (!campaignId) return jsonError('campaign_id обязателен', 400);
      const name = ((body.name as string) ?? '').trim();
      if (!name) return jsonError('name обязателен', 400);

      const { data, error } = await auth.supabase
        .from('tg_outreach_proxy_lists')
        .insert({ campaign_id: campaignId, name })
        .select()
        .single();

      if (error) return jsonError(error.message, 500);
      return NextResponse.json(data, { status: 201 });
    },
  );
}
