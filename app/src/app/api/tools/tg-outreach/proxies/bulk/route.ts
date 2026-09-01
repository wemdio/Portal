import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, buildProxyImportRows } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { parseBulkDeleteBody } from '@/lib/tgOutreach/bulkDelete';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxies.bulk.post' },
    async () => {
      
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
      
        // Дубли отсекает общий помощник: и против уже заведённых в кампании
        // адресов, и внутри самого списка.
        const { data: existingRows } = await auth.supabase
          .from('tg_outreach_proxies')
          .select('url')
          .eq('campaign_id', campaignId);
        const { rows, skipped } = buildProxyImportRows(
          lines,
          (existingRows ?? []).map((r) => (r as { url: string }).url),
          campaignId,
        );
        if (rows.length === 0) {
          return NextResponse.json({ items: [], count: 0, skipped }, { status: 200 });
        }

        const { data, error } = await auth.supabase
          .from('tg_outreach_proxies')
          .insert(rows)
          .select();
      
        if (error) return jsonError(error.message, 500);
        return NextResponse.json(
          { items: data ?? [], count: data?.length ?? 0, skipped },
          { status: 201 },
        );
    },
  );
}

/**
 * Массовое удаление прокси кампании.
 *
 * Отвязка аккаунтов идёт первой — тем же порядком, что в /proxies/[id] DELETE:
 * proxy_id у аккаунта — внешний ключ, и если сначала снести прокси, удаление
 * упрётся в ссылку. Оба запроса ограничены campaign_id, чтобы список id из
 * одной кампании не задел соседнюю.
 */
export async function DELETE(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxies.bulk.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const body = await req.json().catch(() => null);
      const parsed = parseBulkDeleteBody(body);
      if (!parsed.ok) return jsonError(parsed.error, 400);

      const { error: unlinkError } = await auth.supabase
        .from('tg_outreach_accounts')
        .update({ proxy_id: null })
        .eq('campaign_id', parsed.campaignId)
        .in('proxy_id', parsed.ids);
      if (unlinkError) return jsonError(unlinkError.message, 500);

      const { data, error } = await auth.supabase
        .from('tg_outreach_proxies')
        .delete()
        .eq('campaign_id', parsed.campaignId)
        .in('id', parsed.ids)
        .select('id');

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true, count: data?.length ?? 0 });
    },
  );
}
