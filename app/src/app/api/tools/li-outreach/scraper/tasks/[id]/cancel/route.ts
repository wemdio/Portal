import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.scraper.tasks.cancel' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;

    // Любой специалист может отменить задачу скрапера: задачи общие для команды.
    const { error } = await supabaseAdmin
      .from('li_tasks')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', ['pending', 'running']);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
