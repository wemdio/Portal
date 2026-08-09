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
        .select('base_id, tg_outreach_bases(id, name)')
        .eq('campaign_id', id);
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ items: data ?? [] });
    },
  );
}

/** Полная замена набора баз кампании: так UI не нужно вычислять дельту. */
export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.bases.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => null)) as { base_ids?: unknown } | null;
      if (!Array.isArray(body?.base_ids)) return jsonError('base_ids должен быть массивом', 400);

      const baseIds = Array.from(
        new Set(body.base_ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '')),
      );

      const { error: delError } = await auth.supabase
        .from('tg_outreach_campaign_bases')
        .delete()
        .eq('campaign_id', id);
      if (delError) return jsonError(delError.message, 500);

      if (baseIds.length) {
        const { error: insError } = await auth.supabase
          .from('tg_outreach_campaign_bases')
          .insert(baseIds.map((baseId) => ({ campaign_id: id, base_id: baseId })));
        if (insError) return jsonError(insError.message, 500);
      }

      return NextResponse.json({ ok: true, count: baseIds.length });
    },
  );
}
