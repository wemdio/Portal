import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { scrapePostReactions } from '@/lib/liOutreach/scraperLogic';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.scraper.reactions' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json()) as {
      post_url?: string;
      account_id?: string;
      lead_list_id?: string;
      max_results?: number;
    };
    if (!body.post_url) return jsonError('post_url is required', 400);
    if (!body.account_id) return jsonError('account_id is required', 400);

    const { data: task, error } = await auth.supabase
      .from('li_tasks')
      .insert({
        user_id: auth.user.id,
        type: 'post_reactions',
        status: 'pending',
        params: { post_url: body.post_url, account_id: body.account_id, lead_list_id: body.lead_list_id, max_results: body.max_results ?? 100 },
      })
      .select()
      .single<{ id: string }>();
    if (error || !task) return jsonError(error?.message ?? 'Failed to create task', 500);

    void scrapePostReactions(
      task.id,
      auth.user.id,
      body.post_url,
      body.account_id,
      body.lead_list_id ?? null,
      body.max_results ?? 100,
    );

    return NextResponse.json({ task_id: task.id });
  });
}
