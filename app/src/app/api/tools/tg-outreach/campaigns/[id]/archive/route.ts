import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Статусы, из которых кампанию можно убрать в архив: ничего не крутится. */
const ARCHIVABLE_STATUSES = ['stopped', 'error'];

/**
 * Убрать кампанию в архив. Только остановленную и без идущего прогрева:
 * архивная кампания не должна молча продолжать писать людям или греть
 * аккаунты, а из списка её уже не видно.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.archive.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase } = auth;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 3) return jsonError('Укажите причину архивации', 400);
      if (reason.length > 500) return jsonError('Причина длиннее 500 символов', 400);

      const { data: campaign } = await supabase
        .from('tg_outreach_campaigns')
        .select('id, status, archived_at')
        .eq('id', id)
        .single();
      if (!campaign) return jsonError('Кампания не найдена', 404);
      if (campaign.archived_at) return jsonError('Кампания уже в архиве', 409);
      if (!ARCHIVABLE_STATUSES.includes(campaign.status)) {
        return jsonError('Сначала остановите кампанию: в архив убирается только остановленная', 409);
      }

      // Незакрытые задачи — кампания стартует или сворачивается прямо сейчас.
      const { data: activeJobs } = await supabase
        .from('tg_outreach_jobs')
        .select('id')
        .eq('campaign_id', id)
        .in('status', ['pending', 'running'])
        .limit(1);
      if ((activeJobs ?? []).length > 0) {
        return jsonError('У кампании есть незавершённые задачи — дождитесь их окончания', 409);
      }

      const { data: warmup } = await supabase
        .from('tg_outreach_warmup_runs')
        .select('id')
        .eq('campaign_id', id)
        .in('status', ['pending', 'running'])
        .limit(1)
        .maybeSingle();
      if (warmup) return jsonError('Идёт прогрев — остановите его, прежде чем убирать кампанию в архив', 409);

      const { error } = await supabase
        .from('tg_outreach_campaigns')
        .update({ archived_at: new Date().toISOString(), archive_reason: reason })
        .eq('id', id)
        .in('status', ARCHIVABLE_STATUSES);
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true });
    },
  );
}

/** Достать кампанию из архива. Статус не трогаем — она остаётся остановленной. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.archive.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase } = auth;
      const { id } = await ctx.params;

      const { data, error } = await supabase
        .from('tg_outreach_campaigns')
        .update({ archived_at: null, archive_reason: null })
        .eq('id', id)
        .select('id');
      if (error) return jsonError(error.message, 500);
      if (!data?.length) return jsonError('Кампания не найдена', 404);
      return NextResponse.json({ ok: true });
    },
  );
}
