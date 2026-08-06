import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.by-id.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: base } = await auth.supabase
        .from('tg_outreach_bases')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (!base) return jsonError('База не найдена', 404);

      const { data: contacts } = await auth.supabase
        .from('tg_outreach_base_contacts')
        .select('id, username, message, status, skip_reason, sent_at')
        .eq('base_id', id)
        .order('created_at', { ascending: true })
        .limit(1000);

      return NextResponse.json({ base, contacts: contacts ?? [] });
    },
  );
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.by-id.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      // Контакты и привязки к кампаниям уходят каскадом (on delete cascade).
      const { error } = await auth.supabase.from('tg_outreach_bases').delete().eq('id', id);
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ok: true });
    },
  );
}
