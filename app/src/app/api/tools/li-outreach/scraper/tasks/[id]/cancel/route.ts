import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.scraper.tasks.cancel' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;

    const { error } = await auth.supabase
      .from('li_tasks')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .in('status', ['pending', 'running']);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
