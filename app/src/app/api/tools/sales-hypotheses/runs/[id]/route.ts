import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { RUN_DETAIL_COLUMNS, serializeRun } from '@/lib/salesHypotheses/run';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// GET — полный прогон (сайт, статус, гипотезы, уточняющие вопросы). Бриф не отдаём.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.sales-hypotheses.runs.by-id.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { supabase } = authed.auth;

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data, error } = await supabase
        .from('sales_hypotheses_runs')
        .select(RUN_DETAIL_COLUMNS)
        .eq('id', id)
        .single();
      if (error) return jsonError(error.message, error.code === 'PGRST116' ? 404 : 500);
      return NextResponse.json({ run: serializeRun(data) });
    },
  );
}

// DELETE — удалить прогон из истории.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.sales-hypotheses.runs.by-id.delete' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { supabase, userId } = authed.auth;

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { error } = await supabase
        .from('sales_hypotheses_runs')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true });
    },
  );
}
