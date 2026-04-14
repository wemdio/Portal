import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { applyBriefScoringResults, applyEnrichmentResults } from '@/lib/spreadsheet/applyJobResults';

export const dynamic = 'force-dynamic';

/**
 * POST /api/spreadsheet/reconcile
 * Finds recently completed jobs that have spreadsheet metadata
 * and applies any missing results to the user's spreadsheet state.
 * Called on page load as a safety net.
 */
export async function POST(req: NextRequest) {
  try {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

    const supabase = createAuthedSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    let applied = 0;

    const { data: scoringJobs } = await supabaseAdmin
      .from('brief_scoring_jobs')
      .select('id, spreadsheet_tab_id, score_col_index, reason_col_index')
      .eq('user_id', user.id)
      .eq('status', 'completed')
      .not('spreadsheet_tab_id', 'is', null)
      .gte('completed_at', since)
      .order('completed_at', { ascending: false })
      .limit(5);

    for (const job of scoringJobs ?? []) {
      if (job.spreadsheet_tab_id && job.score_col_index != null && job.reason_col_index != null) {
        const ok = await applyBriefScoringResults(
          user.id, job.id, job.spreadsheet_tab_id, job.score_col_index, job.reason_col_index,
        );
        if (ok) applied++;
      }
    }

    const { data: enrichJobs } = await supabaseAdmin
      .from('website_enrichment_jobs')
      .select('id, spreadsheet_tab_id, result_col_index, result_col_header')
      .eq('user_id', user.id)
      .eq('status', 'completed')
      .not('spreadsheet_tab_id', 'is', null)
      .gte('completed_at', since)
      .order('completed_at', { ascending: false })
      .limit(5);

    for (const job of enrichJobs ?? []) {
      if (job.spreadsheet_tab_id && job.result_col_index != null) {
        const ok = await applyEnrichmentResults(
          user.id, job.id, job.spreadsheet_tab_id, job.result_col_index, job.result_col_header ?? undefined,
        );
        if (ok) applied++;
      }
    }

    return NextResponse.json({ applied });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
