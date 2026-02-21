
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { id } = await params;
  const after = req.nextUrl.searchParams.get('after')?.trim() || null;
  
  // Ensure the job belongs to the current user.
  const { data: job, error: jobError } = await supabase
    .from('search_parser_jobs')
    .select('id,user_id')
    .eq('id', id)
    .single();
  if (jobError || !job) return jsonError('Not found', 404);
  if (job.user_id !== user.id) return jsonError('Forbidden', 403);

  let query = supabase.from('search_results').select('*').eq('job_id', id);
  if (after) {
    // incremental mode: return only rows created after the last seen timestamp
    query = query.gt('created_at', after);
  }
  const { data: results, error } = await query.order('created_at', { ascending: true });

  if (error) {
    return jsonError(error.message, 500);
  }

  return NextResponse.json({ results });
}
