import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
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
      account_name?: string | null;
      lead_list_id?: string;
      lead_list_name?: string | null;
      max_results?: number;
    };
    if (!body.search_url) return jsonError('search_url is required', 400);
    if (!body.account_id) return jsonError('account_id is required', 400);
    // Shared Unipile workspace: any team member can scrape via any account.

    // Create task. account_name / lead_list_name — снимки для UI, чтобы
    // подпись под задачей не сваливалась к «аккаунт удалён», если строку
    // li_accounts позже удалили (например, дедуп в 20260709_0002).
    const { data: task, error } = await auth.supabase
      .from('li_tasks')
      .insert({
        user_id: auth.user.id,
        type: 'search',
        status: 'pending',
        params: {
          search_url: body.search_url,
          account_id: body.account_id,
          account_name: body.account_name ?? null,
          lead_list_id: body.lead_list_id,
          lead_list_name: body.lead_list_name ?? null,
          max_results: body.max_results ?? 100,
        },
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
