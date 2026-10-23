import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_LEADS = 1000;

/**
 * Что собрала задача: у задачи нет списка своих лидов, поэтому берём лидов её
 * списка, добавленных за время работы задачи (от создания до завершения, а у
 * идущей — до сих пор). Если в тот же список за это время что-то добавлялось
 * ещё, оно попадёт сюда же — это приближение.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.scraper.tasks.leads' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;

    const { data: task } = await supabaseAdmin
      .from('li_tasks')
      .select('id, params, created_at, completed_at')
      .eq('id', id)
      .maybeSingle<{ id: string; params: Record<string, unknown> | null; created_at: string; completed_at: string | null }>();
    if (!task) return jsonError('Задача не найдена', 404);
    const listId = typeof task.params?.lead_list_id === 'string' ? task.params.lead_list_id : null;
    if (!listId) return NextResponse.json({ leads: [], total: 0, listMissing: true });

    // Небольшой запас в конце: лиды пишутся чуть позже отметки завершения.
    const until = task.completed_at ? new Date(Date.parse(task.completed_at) + 2 * 60_000).toISOString() : new Date().toISOString();
    const { data, count, error } = await supabaseAdmin
      .from('li_leads')
      .select('id, name, position, company, profile_url, status', { count: 'exact' })
      .eq('lead_list_id', listId)
      .gte('created_at', task.created_at)
      .lte('created_at', until)
      .order('created_at', { ascending: true })
      .limit(MAX_LEADS);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ leads: data ?? [], total: count ?? 0 });
  });
}
