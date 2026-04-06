import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.refetch.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase, user } = auth;
      const { id } = await ctx.params;

      const { data: campaign } = await supabase
        .from('tg_outreach_campaigns')
        .select('id, status')
        .eq('id', id)
        .single();

      if (!campaign) return jsonError('Кампания не найдена', 404);
      if (campaign.status === 'running') return jsonError('Нельзя refetch пока кампания запущена', 409);

      const { data: dialogs, error: dErr } = await supabase
        .from('tg_outreach_dialogs')
        .select('id, messages')
        .eq('campaign_id', id);

      if (dErr) return jsonError(dErr.message, 500);

      const emptyCount = (dialogs ?? []).filter(
        d => !d.messages || (Array.isArray(d.messages) && d.messages.length === 0),
      ).length;

      if (emptyCount === 0) {
        return NextResponse.json({ message: 'Нет диалогов с пустыми сообщениями', empty_count: 0 });
      }

      const { data, error } = await supabase
        .from('tg_outreach_jobs')
        .insert({ campaign_id: id, user_id: user.id, action: 'refetch_messages' })
        .select()
        .single();

      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ...data, empty_count: emptyCount }, { status: 201 });
    },
  );
}
