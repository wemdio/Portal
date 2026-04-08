import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Returns exportable candidates (auto_export + accepted review) as rows
 * ready for pendingImport into DatabaseSpreadsheet.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { jobId } = await params;

  const { data: job } = await supabase
    .from('reputation_jobs')
    .select('id')
    .eq('id', jobId)
    .single();
  if (!job) return jsonError('Job not found', 404);

  const { data: candidates, error } = await supabase
    .from('reputation_candidates')
    .select('*')
    .eq('job_id', jobId)
    .or('classification.eq.auto_export,review_decision.eq.accept')
    .order('pain_score', { ascending: false });

  if (error) return jsonError(error.message, 500);

  const header = [
    'Компания', 'Город', 'Категория', 'Рейтинг', 'Отзывов',
    'Pain Score', 'Confidence', 'Режим', 'Сайт',
    'Темы проблем', 'Proof URLs', 'Proof Snippets',
    'Источник URL', 'Job ID', 'Source',
  ];

  const rows = (candidates ?? []).map((c) => [
    c.company ?? '',
    c.city ?? '',
    c.category ?? '',
    c.rating != null ? String(c.rating) : '',
    String(c.reviews_count ?? 0),
    String(c.pain_score ?? 0),
    String(c.confidence_score ?? 0),
    c.source_mode ?? '',
    c.website ?? '',
    (c.issue_themes ?? []).join('; '),
    (c.proof_urls ?? []).join('; '),
    (c.proof_snippets ?? []).join(' | '),
    c.primary_source_url ?? '',
    jobId,
    'reputation-finder',
  ]);

  return NextResponse.json({ header, rows, total: rows.length });
}
