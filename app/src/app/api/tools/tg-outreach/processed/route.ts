import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.processed.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const url = new URL(req.url);
      const campaignId = url.searchParams.get('campaign_id');
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 1000);
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);

      const { data, error, count } = await auth.supabase
        .from('tg_outreach_processed')
        .select('*', { count: 'exact' })
        .eq('campaign_id', campaignId)
        .order('processed_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ items: data ?? [], total: count ?? 0 });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.processed.create' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      let body: { campaign_id?: string; tg_user_id?: number; tg_username?: string };
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const campaignId = body.campaign_id;
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const tgUserId = Number(body.tg_user_id);
      if (!tgUserId) return jsonError('tg_user_id обязателен', 400);

      const { data, error } = await auth.supabase
        .from('tg_outreach_processed')
        .upsert(
          {
            campaign_id: campaignId,
            tg_user_id: tgUserId,
            tg_username: body.tg_username ?? null,
          },
          { onConflict: 'campaign_id,tg_user_id' }
        )
        .select()
        .single();

      if (error) return jsonError(error.message, 500);
      return NextResponse.json(data, { status: 201 });
    },
  );
}

export async function DELETE(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.processed.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const url = new URL(req.url);
      const id = url.searchParams.get('id');
      if (!id) return jsonError('id обязателен', 400);

      const { error } = await auth.supabase
        .from('tg_outreach_processed')
        .delete()
        .eq('id', id);

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true });
    },
  );
}
