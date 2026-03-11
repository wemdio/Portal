import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import type { EmailSequenceBrief } from '@/types';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.email-sequence.runs.get' },
    async () => {
      
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);
      
        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);
      
        const { data, error } = await supabase
          .from('email_sequence_runs')
          .select('id,user_id,status,brief,segments,created_at,updated_at,error_message')
          .order('created_at', { ascending: false })
          .limit(20);
      
        if (error) return jsonError(error.message, 500);
        return NextResponse.json({ runs: data ?? [] });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.email-sequence.runs.post' },
    async () => {
      
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);
      
        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);
      
        let body: { brief?: EmailSequenceBrief };
        try {
          body = (await req.json()) as { brief?: EmailSequenceBrief };
        } catch {
          return jsonError('Invalid JSON body', 400);
        }
      
        const brief = (body.brief ?? {}) as EmailSequenceBrief;
        const { data, error } = await supabase
          .from('email_sequence_runs')
          .insert({ user_id: user.id, status: 'draft', brief, segments: null })
          .select('id,user_id,status,brief,segments,created_at,updated_at,error_message')
          .single();
      
        if (error) return jsonError(error.message, 500);
        return NextResponse.json({ run: data });
    },
  );
}

