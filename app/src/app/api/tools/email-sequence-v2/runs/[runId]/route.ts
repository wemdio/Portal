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

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.email-sequence-v2.runs.by-id.get' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      const { runId } = await params;
      if (!runId) return jsonError('Missing runId', 400);

      const { data: run, error: runErr } = await supabase
        .from('email_sequence_v2_runs')
        .select('*')
        .eq('id', runId)
        .single();
      if (runErr) return jsonError(runErr.message, runErr.code === 'PGRST116' ? 404 : 500);

      const { data: letters, error: letErr } = await supabase
        .from('email_sequence_v2_letters')
        .select('*')
        .eq('run_id', runId)
        .order('letter_index', { ascending: true });
      if (letErr) return jsonError(letErr.message, 500);

      return NextResponse.json({ run, letters: letters ?? [] });
    },
  );
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.email-sequence-v2.runs.by-id.patch' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      const demo = await blockDemo(supabase, user.id);
      if (demo) return demo;

      const { runId } = await params;
      if (!runId) return jsonError('Missing runId', 400);

      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return jsonError('Invalid JSON body', 400);
      }

      // Whitelist editable fields. Status can only be reset to drafty values manually.
      const allowed: Record<string, unknown> = {};
      const passthrough: Array<keyof typeof body> = [
        'company_name',
        'segment_text',
        'customer_edits',
        'personalization_operators',
        'values_text',
        'values_model',
        'writer_model',
      ];
      for (const key of passthrough) {
        if (key in body) {
          const value = body[key];
          if (value === null || typeof value === 'string') {
            allowed[String(key)] = value;
          }
        }
      }

      // Язык вывода: всегда приводим к поддерживаемому значению (ru/en/pl).
      if ('output_language' in body) {
        allowed.output_language = normalizeOutputLanguage(body.output_language);
      }

      if (Object.keys(allowed).length === 0) {
        return jsonError('Нет полей для обновления', 400);
      }

      const { data, error } = await supabase
        .from('email_sequence_v2_runs')
        .update(allowed)
        .eq('id', runId)
        .eq('user_id', user.id)
        .select('*')
        .single();
      if (error) return jsonError(error.message, error.code === 'PGRST116' ? 404 : 500);
      return NextResponse.json({ run: data });
    },
  );
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.email-sequence-v2.runs.by-id.delete' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      const demo = await blockDemo(supabase, user.id);
      if (demo) return demo;

      const { runId } = await params;
      if (!runId) return jsonError('Missing runId', 400);

      const { error } = await supabase
        .from('email_sequence_v2_runs')
        .delete()
        .eq('id', runId)
        .eq('user_id', user.id);
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true });
    },
  );
}
