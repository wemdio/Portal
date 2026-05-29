import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, userOwnsAccount } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { scrapeLinkedInSearch } from '@/lib/liOutreach/scraperLogic';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.scraper.search' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json()) as {
      search_url?: string;
      account_id?: string;
      lead_list_id?: string;
      max_results?: number;
    };
    if (!body.search_url) return jsonError('search_url is required', 400);
    if (!body.account_id) return jsonError('account_id is required', 400);
    // Accounts are visible cross-specialist but only usable by their owner —
    // don't let someone scrape through another specialist's LinkedIn account.
    if (!(await userOwnsAccount(auth.user.id, body.account_id))) {
      return jsonError('Нельзя запускать скрапинг через LinkedIn-аккаунт другого специалиста', 403);
    }

    // Create task
    const { data: task, error } = await auth.supabase
      .from('li_tasks')
      .insert({
        user_id: auth.user.id,
        type: 'search',
        status: 'pending',
        params: { search_url: body.search_url, account_id: body.account_id, lead_list_id: body.lead_list_id, max_results: body.max_results ?? 100 },
      })
      .select()
      .single<{ id: string }>();
    if (error || !task) return jsonError(error?.message ?? 'Failed to create task', 500);

    // Run async (fire-and-forget)
    void scrapeLinkedInSearch(
      task.id,
      auth.user.id,
      body.search_url,
      body.account_id,
      body.lead_list_id ?? null,
      body.max_results ?? 100,
    );

    return NextResponse.json({ task_id: task.id });
  });
}
