import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const params = new URL(req.url).searchParams;
      const campaignId = params.get('campaign_id');
      if (!campaignId) return jsonError('campaign_id обязателен', 400);
      // По умолчанию — только аккаунты в работе: этим списком пользуются и
      // выбор аккаунтов для баз, и прогрев, архивным там не место.
      // ?archived=1 — содержимое архива, свежие уходы сверху.
      const archived = params.get('archived') === '1';

      const query = auth.supabase
        .from('tg_outreach_accounts')
        .select('*')
        .eq('campaign_id', campaignId);
      const { data, error } = archived
        ? await query.not('archived_at', 'is', null).order('archived_at', { ascending: false })
        : await query.is('archived_at', null).order('created_at', { ascending: true });

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ items: data ?? [] });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.create' },
    async () => {
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
          // Цена: пусто — null, а не ноль (см. миграцию 20260910_0001).
          price:
            body.price === undefined || body.price === null || body.price === ''
              ? null
              : Number(body.price),
          session_data: (body.session_data as string) ?? '',
          is_active: body.is_active !== false,
        })
        .select()
        .single();

      if (error) return jsonError(error.message, 500);
      return NextResponse.json(data, { status: 201 });
    },
  );
}
