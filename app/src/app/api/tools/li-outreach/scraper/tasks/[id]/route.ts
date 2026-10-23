import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** Удалить задачу скрапера из списка. Собранные контакты остаются в базе. Любой специалист, не идущую задачу. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.scraper.tasks.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;

    const { data: task } = await supabaseAdmin.from('li_tasks').select('id, status').eq('id', id).maybeSingle();
    if (!task) return jsonError('Задача не найдена', 404);
    if (task.status === 'pending' || task.status === 'running') return jsonError('Сначала отмените задачу', 409);

    const { error } = await supabaseAdmin.from('li_tasks').delete().eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
