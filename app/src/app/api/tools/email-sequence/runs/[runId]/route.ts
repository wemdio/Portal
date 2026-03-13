import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.email-sequence.runs.by-runid.get' },
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
          .select('id,user_id,status,brief,segments,created_at,updated_at,error_message')
          .eq('id', runId)
          .single();
        if (runErr) return jsonError(runErr.message, runErr.code === 'PGRST116' ? 404 : 500);
      
        const [{ data: segments, error: segErr }, { data: letters, error: letErr }] = await Promise.all([
          supabase
            .from('email_sequence_segments')
            .select('*')
            .eq('run_id', runId)
            .order('segment_index', { ascending: true }),
          supabase
            .from('email_sequence_letters')
            .select('*')
            .eq('run_id', runId)
            .order('segment_index', { ascending: true })
            .order('letter_index', { ascending: true }),
        ]);
      
        if (segErr) return jsonError(segErr.message, 500);
        if (letErr) return jsonError(letErr.message, 500);
      
        return NextResponse.json({ run, segments: segments ?? [], letters: letters ?? [] });
    },
  );
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.email-sequence.runs.by-runid.delete' },
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
      
        const status = String(run.status ?? '').toLowerCase();
        if (status === 'running') return jsonError('Нельзя удалить: запуск выполняется. Дождитесь окончания или нажмите «Остановить».', 409);
      
        // Delete derived data first, then the run itself.
        const [{ error: delLettersErr }, { error: delSegmentsErr }] = await Promise.all([
          supabase.from('email_sequence_letters').delete().eq('run_id', runId),
          supabase.from('email_sequence_segments').delete().eq('run_id', runId),
        ]);
        if (delLettersErr) return jsonError(delLettersErr.message, 500);
        if (delSegmentsErr) return jsonError(delSegmentsErr.message, 500);
      
        const { error } = await supabase.from('email_sequence_runs').delete().eq('id', runId).eq('user_id', user.id);
        if (error) return jsonError(error.message, 500);
        return NextResponse.json({ ok: true });
    },
  );
}

