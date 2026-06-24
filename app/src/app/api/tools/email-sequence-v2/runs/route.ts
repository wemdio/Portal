import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';
import { normalizeOutputLanguage } from '@/lib/emailSequenceV2/prompts';
import { blockDemo } from '@/lib/auth/blockDemo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.email-sequence-v2.runs.get' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      const { data, error } = await supabase
        .from('email_sequence_v2_runs')
        .select('id,user_id,status,company_name,brief_file_name,values_generated_at,values_model,writer_model,error_message,created_at,updated_at')
        .order('created_at', { ascending: false })
        .limit(30);

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ runs: data ?? [] });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.email-sequence-v2.runs.post' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      const demo = await blockDemo(supabase, user.id);
      if (demo) return demo;

      let body: {
        company_name?: string;
        values_model?: string;
        writer_model?: string;
        output_language?: string;
      } = {};
      try {
        body = await req.json();
      } catch {
        body = {};
      }

      const insertData = {
        user_id: user.id,
        status: 'draft' as const,
        company_name: body.company_name?.slice(0, 200) ?? null,
        values_model: body.values_model?.slice(0, 120) ?? null,
        writer_model: body.writer_model?.slice(0, 120) ?? null,
        output_language: normalizeOutputLanguage(body.output_language),
      };

      const { data, error } = await supabase
        .from('email_sequence_v2_runs')
        .insert(insertData)
        .select('*')
        .single();

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ run: data });
    },
  );
}
