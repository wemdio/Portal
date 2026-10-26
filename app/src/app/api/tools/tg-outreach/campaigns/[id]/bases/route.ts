import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.bases.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data, error } = await auth.supabase
        .from('tg_outreach_campaign_bases')
        .select('base_id, position, stage, tg_outreach_bases(id, name)')
        .eq('campaign_id', id)
        .order('position', { ascending: true });
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ items: data ?? [] });
    },
  );
}

/**
 * Полная замена набора баз кампании: так UI не нужно вычислять дельту.
 * `items` — базы по порядку и с этапом (`stage`): базы одного этапа рассылаются
 * параллельно, следующий этап стартует, когда предыдущий выдал всё.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.bases.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => null)) as { items?: unknown } | null;
      if (!Array.isArray(body?.items)) return jsonError('items должен быть массивом', 400);

      const seen = new Set<string>();
      const items: Array<{ base_id: string; stage: number }> = [];
      for (const raw of body.items as Array<{ base_id?: unknown; stage?: unknown }>) {
        const baseId = typeof raw?.base_id === 'string' ? raw.base_id.trim() : '';
        const stage = Number(raw?.stage);
        if (!baseId || seen.has(baseId)) continue;
        if (!Number.isInteger(stage) || stage < 0 || stage > 1000) return jsonError('stage — целое число от 0 до 1000', 400);
        seen.add(baseId);
        items.push({ base_id: baseId, stage });
      }

      // Не «удалить всё и вставить»: два быстрых клика по галочкам шлют два PUT
      // параллельно, оба удаляют и оба вставляют — второй падал на уникальном
      // ключе (campaign_id, base_id). Upsert + удаление лишних от гонки защищён.
      if (items.length) {
        const { error: upError } = await auth.supabase
          .from('tg_outreach_campaign_bases')
          .upsert(
            items.map((item, position) => ({ campaign_id: id, base_id: item.base_id, position, stage: item.stage })),
            { onConflict: 'campaign_id,base_id' },
          );
        if (upError) return jsonError(upError.message, 500);
      }

      let delQuery = auth.supabase.from('tg_outreach_campaign_bases').delete().eq('campaign_id', id);
      if (items.length) delQuery = delQuery.not('base_id', 'in', `(${items.map((i) => i.base_id).join(',')})`);
      const { error: delError } = await delQuery;
      if (delError) return jsonError(delError.message, 500);

      return NextResponse.json({ ok: true, count: items.length });
    },
  );
}
