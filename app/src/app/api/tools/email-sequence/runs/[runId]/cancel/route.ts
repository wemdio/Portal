import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.email-sequence.runs.by-runid.cancel.post' },
    async () => {
      
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);
      
        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);
      
        const { runId } = await params;
        if (!runId) return jsonError('Missing runId', 400);
      
        const { data: run, error: runErr } = await supabase
          .from('email_sequence_runs')
          .select('id,user_id,status')
          .eq('id', runId)
          .single();
        if (runErr) return jsonError(runErr.message, runErr.code === 'PGRST116' ? 404 : 500);
        if (run.user_id !== user.id) return jsonError('Forbidden', 403);
      
        if (String(run.status ?? '').toLowerCase() === 'cancelled') {
          return NextResponse.json({ ok: true, status: 'cancelled' });
        }
      
        const { error: updErr } = await supabase
          .from('email_sequence_runs')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', runId)
          .eq('user_id', user.id);
        if (updErr) return jsonError(updErr.message, 500);
      
        return NextResponse.json({ ok: true, status: 'cancelled' });
    },
  );
}

