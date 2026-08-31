import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, normalizeProxyUrl } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxies.get' },
    async () => {
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

      /**
       * Адреса прокси, уже занятые аккаунтами — по всему порталу, а не по этой
       * кампании.
       *
       * Занятость раньше считалась по id строки и только внутри кампании, и это
       * ломалось двумя способами сразу. Один и тот же адрес заведён в базе
       * несколькими строками: 598 записей на 532 уникальных адреса, причём
       * дубли есть и внутри одной кампании. Назначил первую строку — вторая
       * оставалась «свободной» и тут же предлагалась следующему аккаунту.
       * И отдельно: 66 адресов заведены в двух кампаниях, так что занятый в
       * соседней кампании прокси здесь числился свободным.
       *
       * Для Telegram это один IP и одно устройство: два аккаунта на нём — прямой
       * повод для блокировки, ради экономии одного запроса такое допускать
       * нельзя. Поэтому ключ занятости — нормализованный адрес.
       */
      const { data: assignedRows } = await auth.supabase
        .from('tg_outreach_accounts')
        .select('proxy_id')
        .not('proxy_id', 'is', null);
      const assignedIds = [
        ...new Set((assignedRows ?? []).map((r) => (r as { proxy_id: string }).proxy_id)),
      ];

      let takenUrls: string[] = [];
      if (assignedIds.length) {
        const { data: takenRows } = await auth.supabase
          .from('tg_outreach_proxies')
          .select('url')
          .in('id', assignedIds);
        takenUrls = [
          ...new Set(
            (takenRows ?? [])
              .map((r) => normalizeProxyUrl(((r as { url: string }).url ?? '').trim()))
              .filter(Boolean),
          ),
        ];
      }

      return NextResponse.json({ items: data ?? [], taken_urls: takenUrls });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxies.create' },
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

      const rawUrl = (body.url as string)?.trim();
      if (!rawUrl) return jsonError('url обязателен', 400);
      const url = normalizeProxyUrl(rawUrl);

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
    },
  );
}

export async function DELETE(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxies.delete' },
    async () => {
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
    },
  );
}
